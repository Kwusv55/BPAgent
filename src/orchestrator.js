// 编排器：组长规划 → 按依赖并发派活 → 组长逐个审查（通过/返工/换人/跳过/追加）→ 组长汇总
// 另外负责：额度用尽时挂起、到点续跑；git worktree 隔离与合并；中断后续跑
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createSession } from './adapters/index.js';
import * as P from './prompts.js';
import * as G from './git.js';
import { now, uid, extractJson, hhmm } from './util.js';
import { pressureOf } from './usage.js';

const lsDir = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };
const inside = (root, p) => { const r = path.relative(root, p); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };
// 子进程可能还占着文件，稍等再删，删不掉就留给「清理残留」
const rmLater = (p) => setTimeout(() => fs.rm(p, { recursive: true, force: true, maxRetries: 4, retryDelay: 500 }, () => {}), 2500);
// worktree 目录里的 .git 是个文件：gitdir: <仓库>/.git/worktrees/<名字>
function repoOfWorktree(dir) {
  try { return path.resolve(fs.readFileSync(path.join(dir, '.git'), 'utf8').match(/gitdir:\s*(.+?)[\\/]\.git[\\/]worktrees[\\/]/)[1]); } catch { return null; }
}
// 目标里写的已存在目录（例："D:\projects\my-app"，优化…）。带引号的先认，可以含空格
function dirInGoal(goal) {
  const cands = [...goal.matchAll(/["“']([A-Za-z]:[\\/][^"”'\r\n]+)["”']/g), ...goal.matchAll(/[A-Za-z]:[\\/][^\s，,。；;:："'“”、（）()]+/g)].map(m => m[1] ?? m[0]);
  for (const c of cands) {
    const p = c.replace(/[\\/.]+$/, '');
    try { if (fs.statSync(p).isDirectory()) return p; } catch { /* 不存在 */ }
  }
  return null;
}

// 前置任务只要结束（不论成败）就放行，成败写进队员的提示词里，避免整条链卡死
const TERMINAL = ['done', 'failed', 'skipped', 'cancelled', 'interrupted'];
const ACTIVE_RUN = ['planning', 'running', 'summarizing'];
const RESUMABLE = ['interrupted', 'failed'];
const MAX_RETRIES = 2;
const TRANSIENT_RETRIES = 2;
const TRANSIENT = /\b(429|500|502|503|504|529)\b|retryable|temporarily|overloaded|rate.?limit|connection error|network error|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up/i;

export class Orchestrator extends EventEmitter {
  // routing：hub.json 的分工阈值；usage()：Claude 订阅额度（见 usage.js）
  constructor({ registry, store, approvals, hub, dataDir, workspaceRoot, worktreeRoot, routing = {}, usage = null }) {
    super();
    Object.assign(this, { registry, store, approvals, hub, workspaceRoot, worktreeRoot, routing, usage });
    this.tmpDir = path.join(dataDir, 'tmp');
    fs.mkdirSync(this.tmpDir, { recursive: true });
    this.rt = new Map(); // runId → 运行时（会话、组长队列），不落盘
    this.asks = new Map(); // 队员向组长的提问：id → { done, answer, waiters }
    registry.on('unblocked', () => this._scheduleAll());
  }

  // ───── 对外接口 ─────

  create(opts) {
    const leader = this.registry.usable(opts.leaderId);
    if (!leader) throw new Error(`组长 ${opts.leaderId} 不可用（未启用或找不到命令）`);
    const memberIds = [...new Set(opts.memberIds ?? [])].filter(id => this.registry.usable(id));
    if (!memberIds.length) throw new Error('至少要选一个可用的队员');
    const goal = String(opts.goal ?? '').trim();
    if (!goal) throw new Error('目标不能为空');

    const id = uid('r');
    // 工作目录留空时，目标里写了已存在的目录就用它，否则自动新建一个空目录
    const fromGoal = opts.workdir?.trim() ? null : dirInGoal(goal);
    const picked = opts.workdir?.trim() || fromGoal;
    const autoWorkdir = !picked;
    const workdir = autoWorkdir ? path.join(this.workspaceRoot, id) : path.resolve(picked);
    fs.mkdirSync(workdir, { recursive: true });
    const run = {
      id, goal, workdir, autoWorkdir, leaderId: leader.id, memberIds,
      guidance: String(opts.guidance ?? '').trim() || null,
      templateId: opts.templateId || null,
      isolation: ['auto', 'worktree', 'shared'].includes(opts.isolation) ? opts.isolation : 'auto',
      policy: opts.policy === 'ask' ? 'ask' : 'auto',
      maxRounds: clampInt(opts.maxRounds, 0, 5, 2),
      maxParallel: clampInt(opts.maxParallel, 1, 8, 3),
      finalReview: opts.finalReview !== false, finalReviewTask: null,
      status: 'planning', createdAt: now(), tasks: [], git: null,
      analysis: null, summary: null, error: null, leaderSessionId: null, leaderWaitUntil: null,
    };
    this._save(run);
    if (fromGoal) this._ev(run, 'leader', { kind: 'info', text: `工作目录留空，按目标里的路径使用 ${workdir}` });
    this._drive(run).catch(e => this._fail(run, e));
    return run;
  }

  async message(runId, text) {
    const run = this._get(runId);
    if (!['planning', 'running'].includes(run.status)) throw new Error('编排已结束，不能再插话');
    this._ev(run, 'leader', { kind: 'user', text });
    const d = await this._askJson(run, P.userMessage(run, text), o => this._checkNew(run, o));
    for (const tid of d.cancel ?? []) {
      const t = run.tasks.find(x => x.id === tid);
      if (t?.status === 'pending') t.status = 'cancelled';
    }
    if (d.newTasks?.length) this._addTasks(run, d.newTasks);
    this._save(run);
    this._schedule(run);
    return d.reply ?? '';
  }

  // 对某个队员插话：一次性调用的会话中途插不进去，存进任务收件箱，在它下一轮开头送达；
  // 本轮就交付的，组长审查时会看到这些话，据此决定是否返工
  messageAgent(runId, agentId, text) {
    const run = this._get(runId);
    if (!['planning', 'running'].includes(run.status)) throw new Error('编排已结束，不能再插话');
    const list = run.tasks.filter(t => t.assignee === agentId && !TERMINAL.includes(t.status));
    if (!list.length) throw new Error('这个队员当前没有未完成的任务');
    const name = this.registry.get(agentId)?.name ?? agentId;
    for (const t of list) {
      (t.inbox ??= []).push(text);
      this._ev(run, t.id, { kind: 'user', text: `${text}（${t.status === 'running' ? '本轮结束后送达' : '开工时送达'}）` });
    }
    this._ev(run, 'leader', { kind: 'info', text: `你对 ${name} 说：${text}（任务 ${list.map(t => t.id).join('、')}，审查时会一并转给组长）` });
    this._save(run);
    return { tasks: list.map(t => t.id) };
  }

  // 队员经 ask_leader 工具提问：排进组长队列，回答出来前队员那边长轮询等待
  ask({ runId, taskId, question }) {
    const run = this.store.runs.get(runId);
    if (!run || !ACTIVE_RUN.includes(run.status)) return { done: true, answer: '编排已经结束，请按最合理的假设收尾。' };
    const t = run.tasks.find(x => x.id === taskId);
    const id = uid('q');
    const q = { done: false, answer: null, waiters: new Set() };
    this.asks.set(id, q);
    this._ev(run, taskId, { kind: 'ask', text: question });
    this._ev(run, 'leader', { kind: 'ask', text: question, from: taskId });
    this._leader(run, leader => this._prompt(run, 'leader', leader, P.memberQuestion(run, t, question)))
      .then(res => res.text || '（组长没有给出内容）', e => `组长暂时无法回答（${e.message}），请按最合理的假设继续，并在汇报里说明。`)
      .then((answer) => {
        Object.assign(q, { done: true, answer });
        this._ev(run, taskId, { kind: 'answer', text: answer });
        for (const w of q.waiters) w();
        setTimeout(() => this.asks.delete(id), 10 * 60_000);
      });
    return { id, done: false };
  }

  waitAsk(id) {
    const q = this.asks.get(id);
    if (!q) return { done: true, answer: '这个问题已经过期，请按最合理的假设继续。' };
    if (q.done) return { done: true, answer: q.answer };
    return new Promise((resolve) => {
      const wake = () => { clearTimeout(timer); resolve({ done: true, answer: q.answer }); };
      const timer = setTimeout(() => { q.waiters.delete(wake); resolve({ done: false }); }, 25_000);
      q.waiters.add(wake);
    });
  }

  // 随时换组长：等组长手上这一轮结束，关掉旧会话，新组长接手（附目标和当前进度）
  switchLeader(runId, leaderId) {
    const run = this._get(runId);
    if (leaderId === run.leaderId) return;
    const agent = this.registry.usable(leaderId);
    if (!agent) throw new Error(`${leaderId} 不可用（未启用或找不到命令）`);
    if (!agent.roles.includes('leader')) throw new Error(`${agent.name} 没有组长角色`);
    if (!ACTIVE_RUN.includes(run.status)) {
      // 没在跑：改了下次「继续运行」时用新组长
      Object.assign(run, { leaderId, leaderSessionId: null });
      this._save(run);
      return;
    }
    const rt = this._rt(run);
    const from = this.registry.get(run.leaderId)?.name ?? run.leaderId;
    this._ev(run, 'leader', { kind: 'info', text: `正在把组长从 ${from} 换成 ${agent.name}（等当前这一轮结束）` });
    this._leader(run, async (old) => {
      old?.close();
      rt.leader = await this._session(run, 'leader', agent, null, this.leaderCwd(run));
      Object.assign(run, { leaderId, leaderSessionId: rt.leader.sessionId ?? null, leaderWaitUntil: null });
      this._save(run);
      this._ev(run, 'leader', { kind: 'info', text: `组长已换成 ${agent.name}` });
      await this._prompt(run, 'leader', rt.leader, P.handover(run, this._members(run), this._budget(run)));
    }).catch(e => this._ev(run, 'leader', { kind: 'error', text: `换组长失败：${e.message}` }));
  }

  cancel(runId) {
    const run = this._get(runId);
    if (!ACTIVE_RUN.includes(run.status)) return;
    this._rt(run).cancelled = true;
    for (const t of run.tasks) if (!TERMINAL.includes(t.status)) t.status = 'cancelled';
    this.approvals.denyWhere(i => i.runId === runId, '编排已取消');
    this._teardown(run);
    run.status = 'cancelled';
    run.endedAt = now();
    this._save(run);
    this._dropAllWorktrees(run);
  }

  cancelTask(runId, taskId) {
    const run = this._get(runId);
    const t = run.tasks.find(x => x.id === taskId);
    if (!t || TERMINAL.includes(t.status)) return;
    t.status = 'cancelled';
    t.endedAt = now();
    this.approvals.denyWhere(i => i.runId === runId && i.taskId === taskId, '任务已取消');
    this._closeTask(run, t);
    this._dropWorktree(run, t);
    this._save(run);
    this._schedule(run);
  }

  // 已中断（服务重启）或失败（组长出错）的编排：恢复任务状态，尽量续接原会话
  resume(runId) {
    const run = this._get(runId);
    if (!RESUMABLE.includes(run.status)) throw new Error('只有已中断或失败的编排可以继续');
    if (!this.registry.usable(run.leaderId)) throw new Error(`组长 ${run.leaderId} 当前不可用`);
    if (this.rt.has(run.id)) this._teardown(run);
    this.rt.delete(run.id);
    for (const t of run.tasks) {
      if (t.status !== 'interrupted') continue;
      t.status = t.prevStatus === 'review' && (t.result || t.error) ? 'review' : 'pending';
      t.resumed = t.status === 'pending';
      t.waitUntil = null;
      delete t.prevStatus;
    }
    Object.assign(run, { status: run.tasks.length ? 'running' : 'planning', error: null, endedAt: null, leaderWaitUntil: null });
    this._ev(run, 'leader', { kind: 'info', text: '编排继续运行' });
    this._save(run);
    this._resumeDrive(run).catch(e => this._fail(run, e));
  }

  // 把集成分支合并进用户工作目录的当前分支（自建目录在结束时自动做）
  async mergeToWorkdir(runId, internal = false) {
    const run = this._get(runId);
    const g = run.git;
    if (!g) throw new Error('这个编排没有使用 worktree 隔离');
    if (g.merged) return;
    if (!internal && ACTIVE_RUN.includes(run.status)) throw new Error('编排还在进行，结束后再合并');
    if (await G.isDirty(g.top)) throw new Error('工作目录有未提交的改动，请先提交或暂存后再合并');
    const r = await G.merge(g.top, g.branch, `合并编排 ${run.id}：${run.goal.slice(0, 50)}`, { ffFirst: true });
    if (!r.ok) throw new Error(`合并冲突（${r.files.join('、') || '未知文件'}），已放弃合并，请手动处理分支 ${g.branch}`);
    g.merged = true;
    g.mergedInto = await G.currentBranch(g.top);
    this._ev(run, 'leader', { kind: 'info', text: `成果已合并到 ${g.top}（${g.mergedInto}）` });
    this._save(run);
    // 编排结束时自动合并：组长还要在集成工作区里写汇总，清理推迟到会话关闭之后
    if (!internal) await this._cleanupGit(run);
  }

  // 拆掉已合并的集成工作区和分支，删掉空目录。进程占着目录时删不掉，所以要在会话关闭后调用
  async _cleanupGit(run) {
    const g = run.git;
    if (!g) return;
    if (g.merged) {
      await G.removeWorktree(g.top, g.main);
      await G.deleteBranch(g.top, g.branch);
    }
    for (const dir of [g.main, path.join(this.worktreeRoot, run.id)]) {
      try {
        if (fs.existsSync(dir) && !fs.readdirSync(dir).length) fs.rmdirSync(dir);
      } catch { /* 还被占用就留着 */ }
    }
  }

  remove(runId) {
    const run = this._get(runId);
    if (ACTIVE_RUN.includes(run.status)) throw new Error('编排还在进行，先取消');
    if (run.autoWorkdir && inside(this.workspaceRoot, run.workdir)) {
      // 自动新建的目录只属于这条编排：连同它的 worktree 整个删掉（仓库都没了，不用再逐个 git worktree remove）
      for (const t of run.tasks) t.worktree = null;
      rmLater(run.workdir);
      rmLater(path.join(this.worktreeRoot, run.id));
    } else {
      // 用户自己的仓库：没合并的集成分支保留，只拆掉工作区，用户仍可手动合并
      if (run.git && !run.git.merged) G.removeWorktree(run.git.top, run.git.main).then(() => this._cleanupGit(run)).catch(() => {});
      this._dropAllWorktrees(run);
    }
    this._rmTmp(runId);
    this.rt.delete(runId);
    this.store.remove(runId);
    this.emit('removed', runId);
  }

  _rmTmp(runId) {
    for (const f of lsDir(this.tmpDir)) if (f.startsWith(`mcp-${runId}-`)) fs.rm(path.join(this.tmpDir, f), { force: true }, () => {});
  }

  // ───── 残留清理 ─────
  // 找出编排台留下、已经没用的东西：没有编排记录的自动工作目录、已结束编排没拆掉的 worktree、
  // 记录已删的编排在用户仓库里留下的 hub/ 分支、临时 MCP 配置。进行中 / 可继续运行的编排一概不碰
  async scanResidue() {
    const runs = new Map(this.store.list().map(r => [r.id, r]));
    const keep = (r) => r && (ACTIVE_RUN.includes(r.status) || RESUMABLE.includes(r.status));
    const items = [], repos = new Set(); // 要查残留 hub/ 分支的仓库
    for (const r of runs.values()) if (r.git?.top) repos.add(r.git.top);
    for (const name of lsDir(this.workspaceRoot)) {
      if (runs.get(name)?.autoWorkdir) continue;
      items.push({ kind: 'workspace', path: path.join(this.workspaceRoot, name), desc: '自动工作目录，编排记录已删除' });
    }
    for (const name of lsDir(this.worktreeRoot)) {
      const r = runs.get(name), dir = path.join(this.worktreeRoot, name);
      if (keep(r)) continue;
      const trees = lsDir(dir).map(sub => ({ dir: path.join(dir, sub), repo: repoOfWorktree(path.join(dir, sub)) }));
      for (const t of trees) if (t.repo) repos.add(t.repo);
      items.push({ kind: 'worktree', path: dir, trees, desc: r ? `编排已${r.status === 'done' ? '完成' : '取消'}，worktree 没拆掉` : '编排记录已删除' });
    }
    const doomed = items.filter(i => i.kind === 'workspace').map(i => i.path.toLowerCase());
    for (const repo of repos) {
      if (!fs.existsSync(repo) || doomed.includes(repo.toLowerCase())) continue;
      const out = await G.git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/hub/']).catch(() => '');
      for (const branch of out.split(/\r?\n/).filter(Boolean)) {
        const id = branch.match(/^hub\/(r[0-9a-f]+)/)?.[1];
        if (id && !runs.has(id)) items.push({ kind: 'branch', repo, branch, path: `${repo} → ${branch}`, desc: '编排记录已删除留下的分支（可能有没合并的成果）' });
      }
    }
    for (const f of lsDir(this.tmpDir)) {
      const id = f.match(/^mcp-(r[0-9a-f]+)-/)?.[1];
      if (id && !ACTIVE_RUN.includes(runs.get(id)?.status)) items.push({ kind: 'tmp', path: path.join(this.tmpDir, f), desc: '临时 MCP 配置' });
    }
    return { items, workspaceRoot: this.workspaceRoot, worktreeRoot: this.worktreeRoot };
  }

  async cleanResidue() {
    const { items } = await this.scanResidue();
    const failed = [], pruned = new Set();
    for (const it of items) {
      try {
        if (it.kind === 'worktree') {
          for (const t of it.trees) if (t.repo && fs.existsSync(t.repo)) { await G.removeWorktree(t.repo, t.dir); pruned.add(t.repo); }
          await fs.promises.rm(it.path, { recursive: true, force: true, maxRetries: 4, retryDelay: 500 });
        } else if (it.kind === 'branch') await G.deleteBranch(it.repo, it.branch);
        else await fs.promises.rm(it.path, { recursive: true, force: true, maxRetries: 4, retryDelay: 500 });
      } catch (e) { failed.push({ path: it.path, error: e.message }); }
    }
    for (const repo of pruned) await G.git(repo, ['worktree', 'prune']).catch(() => {});
    return { removed: items.length - failed.length, failed };
  }

  // 审批入口：MCP 服务（HTTP）和 ACP 适配器都走这里
  openApproval(req) {
    const run = this.store.runs.get(req.runId);
    if (!run || !ACTIVE_RUN.includes(run.status)) return { decided: true, allow: false, message: '编排已结束' };
    // 向组长提问不算危险操作，不打扰用户
    if (run.policy === 'auto' || /ask_leader$/.test(req.title ?? '')) {
      this._ev(run, req.taskId, { kind: 'info', text: `已自动批准：${req.title}` });
      return { decided: true, allow: true };
    }
    const item = this.approvals.open(req);
    this._ev(run, req.taskId, { kind: 'info', text: `等待你审批：${req.title}` });
    return { decided: false, id: item.id, item };
  }

  async approve(req) {
    const r = this.openApproval(req);
    if (r.decided) return r.allow;
    return (await r.item.promise).allow;
  }

  leaderCwd(run) {
    return run.git && !run.git.merged && fs.existsSync(run.git.main) ? path.join(run.git.main, run.git.rel) : run.workdir;
  }

  taskCwd(run, t) {
    return t.worktree && fs.existsSync(t.worktree) ? path.join(t.worktree, run.git?.rel ?? '') : run.workdir;
  }

  // ───── 主流程 ─────

  async _drive(run) {
    const rt = this._rt(run);
    await this._prepareGit(run);
    rt.leader = await this._session(run, 'leader', this._usable(run.leaderId), null, this.leaderCwd(run));
    await this._plan(run, rt);
  }

  async _resumeDrive(run) {
    const rt = this._rt(run);
    if (!run.tasks.length && !run.git) await this._prepareGit(run);
    rt.leader = await this._session(run, 'leader', this._usable(run.leaderId), run.leaderSessionId, this.leaderCwd(run));
    this._ev(run, 'leader', { kind: 'info', text: rt.leader.restored ? '已续接组长原会话' : '组长使用新会话继续（之前的对话上下文不可用）' });
    if (!run.tasks.length) return this._plan(run, rt);
    for (const t of run.tasks) if (t.status === 'review') this._review(run, t);
    this._schedule(run);
  }

  async _plan(run, rt) {
    const plan = await this._askJson(run, P.plan(run, this._members(run), this.leaderCwd(run), this._budget(run)), o => this._checkTasks(run, o.tasks, true));
    if (!this._alive(run, rt)) return;
    run.analysis = plan.analysis ?? null;
    this._addTasks(run, plan.tasks);
    run.status = 'running';
    this._save(run);
    this._schedule(run);
  }

  _schedule(run) {
    const rt = this._rt(run);
    if (run.status !== 'running' || !this._alive(run, rt)) return;
    const byId = new Map(run.tasks.map(t => [t.id, t]));
    let active = run.tasks.filter(t => t.status === 'running').length;
    let changed = false;
    for (const t of run.tasks) {
      if (t.status !== 'pending') continue;
      if (active >= run.maxParallel) break;
      if (!t.deps.every(d => TERMINAL.includes(byId.get(d)?.status ?? 'done'))) continue;
      const agent = this.registry.usable(t.assignee);
      if (!agent) {
        t.status = 'review';
        t.error = `队员 ${t.assignee} 不可用（未启用或找不到命令）`;
        changed = true;
        this._review(run, t);
        continue;
      }
      // 额度用尽 / 到了暂停阈值：任务留在待开始，标上恢复时间，解封时 registry 会触发重新调度
      const until = this.registry.blockedUntil(agent.id);
      if (until) {
        if (t.waitUntil !== until) { t.waitUntil = until; changed = true; }
        continue;
      }
      if (!this.registry.hasCapacity(agent.id)) continue;
      active++;
      this._runTask(run, t, agent);
    }
    if (changed) this._save(run);
    if (run.tasks.length && run.tasks.every(t => TERMINAL.includes(t.status)) && !rt.finishing) {
      if (this._addFinalReview(run)) {
        this._save(run);
        return this._schedule(run);
      }
      rt.finishing = true;
      this._finish(run, rt);
    }
  }

  // agent 并发名额是全局的，一个任务结束后所有在跑的编排都要重新排一次
  _scheduleAll() {
    for (const run of this.store.runs.values()) if (run.status === 'running') this._schedule(run);
  }

  async _runTask(run, t, agent) {
    const rt = this._rt(run);
    t.status = 'running';
    t.startedAt ??= now();
    t.error = null;
    t.waitUntil = null;
    this.registry.inc(agent.id);
    this._save(run);
    try {
      if (run.git) await this._ensureWorktree(run, t);
      let s = rt.sessions.get(t.id);
      if (!s || s.closed || s.agentId !== agent.id) {
        s?.close();
        const resumeId = t.resumed && t.agentSessionId && t.lastAgent === agent.id ? t.agentSessionId : null;
        s = await this._session(run, t.id, agent, resumeId, this.taskCwd(run, t));
        rt.sessions.set(t.id, s);
        t.lastAgent = agent.id;
        if (s.sessionId) t.agentSessionId = s.sessionId;
        this._save(run);
      }
      let text;
      if (t.resumed && s.restored) text = P.continueTask(t);
      else if (s.used) text = P.revise(t);
      else {
        const byId = new Map(run.tasks.map(x => [x.id, x]));
        text = P.task(run, t, agent, t.deps.map(d => byId.get(d)).filter(Boolean), this.taskCwd(run, t))
          + (t.feedback ? `\n\n## 组长补充说明\n${t.feedback}` : '')
          + (t.resumed ? P.RESUMED_NOTE : '');
      }
      t.resumed = false;
      if (t.inbox?.length) {
        text += `\n\n## 用户插话\n${t.inbox.map(x => `- ${x}`).join('\n')}`;
        t.userNotes = [...(t.userNotes ?? []), ...t.inbox];
        t.inbox = [];
      }
      const res = await this._prompt(run, t.id, s, text);
      s.used = true;
      t.result = res.text;
      t.agentSessionId = s.sessionId;
      if (res.cost) t.cost = (t.cost ?? 0) + res.cost;
    } catch (e) {
      t.error = e.message;
    } finally {
      this.registry.dec(agent.id);
    }
    if (!this._alive(run, rt) || t.status !== 'running') return this._scheduleAll();
    t.status = 'review';
    this._save(run);
    this._review(run, t);
    this._scheduleAll();
  }

  async _review(run, t) {
    const rt = this._rt(run);
    try {
      if (t.error) await this._reviewFailure(run, t);
      else await this._reviewDelivery(run, t);
    } catch (e) {
      if (!this._alive(run, rt)) return;
      return this._fail(run, new Error(`组长审查 ${t.id} 时出错：${e.message}`));
    }
    if (!this._alive(run, rt)) return;
    this._save(run);
    this._schedule(run);
  }

  async _reviewDelivery(run, t) {
    const d = await this._askJson(run, P.review(run, t) + inboxNote(t), o =>
      ['accept', 'revise'].includes(o.decision) ? this._checkNew(run, o) : 'decision 只能是 accept 或 revise');
    if (t.status !== 'review') return;
    if (d.decision === 'accept' && t.inbox?.length) { t.userNotes = [...(t.userNotes ?? []), ...t.inbox]; t.inbox = []; }
    if (d.newTasks?.length) this._addTasks(run, d.newTasks);
    if (d.decision === 'revise' && t.rounds < run.maxRounds) {
      t.rounds++;
      t.feedback = d.feedback || '请完善后重新汇报';
      t.status = 'pending';
      return;
    }
    if (d.decision === 'revise') t.note = '已到返工上限，按现状接受';
    if (run.git) {
      const m = await this._mergeTask(run, t);
      if (!m.ok) {
        // 合并冲突：交回给队员解决（额外给一轮，不占返工次数上限）
        if ((t.conflicts ?? 0) < 2) {
          t.conflicts = (t.conflicts ?? 0) + 1;
          t.rounds++;
          t.feedback = P.conflict(t, m.files, run.git.branch);
          t.status = 'pending';
          this._ev(run, t.id, { kind: 'info', text: `合并冲突：${m.files.join('、')}，已交回队员解决` });
          return;
        }
        t.status = 'failed';
        t.note = `合并冲突多次未解决（${m.files.join('、')}）`;
        t.endedAt = now();
        this._closeTask(run, t);
        return;
      }
      if (m.empty) t.note = [t.note, '没有文件改动'].filter(Boolean).join('；');
    }
    t.status = 'done';
    t.endedAt = now();
    this._closeTask(run, t);
    this._dropWorktree(run, t);
  }

  async _reviewFailure(run, t) {
    const d = await this._askJson(run, P.reviewFailure(run, t, this._members(run)) + inboxNote(t), o => {
      if (!['retry', 'skip'].includes(o.decision)) return 'decision 只能是 retry 或 skip';
      if (o.decision === 'retry' && o.assignee && !run.memberIds.includes(o.assignee)) return `assignee ${o.assignee} 不在队员里`;
      return this._checkNew(run, o);
    });
    if (t.status !== 'review') return;
    if (d.newTasks?.length) this._addTasks(run, d.newTasks);
    t.retries = (t.retries ?? 0) + 1;
    if (d.decision === 'retry' && t.retries <= MAX_RETRIES) {
      if (d.assignee && d.assignee !== t.assignee) {
        this._closeTask(run, t); // 换人：worktree 保留，新队员接着别人做到一半的成果干
        t.assignee = d.assignee;
      }
      t.feedback = d.feedback || `上次执行失败：${t.error}`;
      t.status = 'pending';
      return;
    }
    t.status = d.decision === 'skip' ? 'skipped' : 'failed';
    if (d.decision === 'retry') t.note = '重试次数用完';
    t.endedAt = now();
    this._closeTask(run, t);
    this._dropWorktree(run, t);
  }

  async _finish(run, rt) {
    run.status = 'summarizing';
    this._save(run);
    if (run.git) {
      try {
        if (run.autoWorkdir) await this.mergeToWorkdir(run.id, true);
      } catch (e) {
        this._ev(run, 'leader', { kind: 'error', text: `自动合并到工作目录失败：${e.message}` });
      }
    }
    try {
      const res = await this._leader(run, leader => this._prompt(run, 'leader', leader, P.summary(run)));
      run.summary = res.text;
    } catch (e) {
      if (!this._alive(run, rt)) return;
      run.summary = `（组长汇总失败：${e.message}）`;
    }
    if (!this._alive(run, rt)) return;
    run.status = 'done';
    run.endedAt = now();
    this._teardown(run);
    this._save(run);
    if (run.git) {
      await new Promise(r => setTimeout(r, 1500)); // 等组长进程退出、释放工作目录
      await this._cleanupGit(run).catch(() => {});
    }
  }

  _fail(run, e) {
    const rt = this._rt(run);
    if (!this._alive(run, rt) || !ACTIVE_RUN.includes(run.status)) return;
    run.status = 'failed';
    run.error = e.message;
    run.endedAt = now();
    // 未结束的任务记下原状态，之后可以「继续运行」；worktree 也保留
    for (const t of run.tasks) {
      if (TERMINAL.includes(t.status)) continue;
      t.prevStatus = t.status;
      t.status = 'interrupted';
      t.waitUntil = null;
    }
    this._ev(run, 'leader', { kind: 'error', text: e.message });
    this.approvals.denyWhere(i => i.runId === run.id, '编排失败');
    this._teardown(run);
    this._save(run);
  }

  // ───── 组长：所有请求串行排队，保证同一会话里一问一答 ─────

  _leader(run, fn) {
    const rt = this._rt(run);
    const job = rt.queue.then(() => {
      if (!this._alive(run, rt)) throw new Error('已取消');
      return fn(rt.leader);
    });
    rt.queue = job.catch(() => {});
    return job;
  }

  _askJson(run, prompt, validate) {
    const rt = this._rt(run);
    return this._leader(run, async () => {
      const attempt = async (text) => {
        const res = await this._prompt(run, 'leader', rt.leader, text);
        const obj = extractJson(res.text);
        return { obj, err: obj ? validate(obj) : '没有找到 JSON 代码块' };
      };
      let obj, err;
      try {
        ({ obj, err } = await attempt(prompt));
      } catch (e) {
        // 组长的上游挂了（重试也没用）：换一个能当组长的队员接手，再问一次
        const next = this._backupLeader(run, e);
        if (!next) throw e;
        await this._takeOver(run, next, e);
        ({ obj, err } = await attempt(prompt));
      }
      if (err) ({ obj, err } = await attempt(P.fixJson(err)));
      if (err) throw new Error(`组长输出无法解析：${err}`);
      return obj;
    });
  }

  // 自动换组长的人选：只在上游故障 / 进程崩溃时换，每个编排最多换 2 次；从队员里按 主力 → 经济型 → 专家 挑
  _backupLeader(run, e) {
    if (!this._alive(run, this._rt(run)) || (run.autoHandovers ?? 0) >= 2) return null;
    if (!TRANSIENT.test(e.message) && !/退出（code=|exited|spawn/i.test(e.message)) return null;
    const pool = this._members(run).filter(m => m.id !== run.leaderId && m.roles.includes('leader')
      && this.registry.usable(m.id) && !this.registry.blockedUntil(m.id));
    for (const tier of ['main', 'cheap', 'expert']) {
      const m = pool.find(x => (x.tier ?? 'main') === tier);
      if (m) return m;
    }
    return null;
  }

  // 在组长队列里直接交接（已经占着队列，不能再走 _leader 排队）
  async _takeOver(run, agent, why) {
    const rt = this._rt(run);
    const from = this.registry.get(run.leaderId)?.name ?? run.leaderId;
    run.autoHandovers = (run.autoHandovers ?? 0) + 1;
    this._ev(run, 'leader', { kind: 'info', text: `组长 ${from} 出错（${why.message.slice(0, 120)}），自动换成 ${agent.name} 接手` });
    rt.leader?.close();
    rt.leader = await this._session(run, 'leader', agent, null, this.leaderCwd(run));
    Object.assign(run, { leaderId: agent.id, leaderSessionId: rt.leader.sessionId ?? null, leaderWaitUntil: null });
    this._save(run);
    await this._prompt(run, 'leader', rt.leader, P.handover(run, this._members(run), this._budget(run)));
  }

  // ───── 发一轮对话：额度等待 + 临时故障退避 ─────

  async _prompt(run, taskId, session, text) {
    const rt = this._rt(run);
    this._ev(run, taskId, { kind: 'prompt', text });
    let transient = 0;
    for (;;) {
      // 额度用尽：先睡到恢复，再带上「接着做」的说明重发
      const until = this.registry.blockedUntil(session.agentId, true);
      if (until) {
        await this._waitQuota(run, taskId, session.agentId, until);
        text = P.quotaResume(text);
      }
      const t0 = now();
      session.outChars = 0;
      try {
        const res = await session.prompt(text);
        const tokens = this._addTokens(run, taskId, session, text, res);
        this._ev(run, taskId, { kind: 'turn', ms: now() - t0, cost: res.cost ?? null, tokens });
        return res;
      } catch (e) {
        if (session.closed || !this._alive(run, rt)) throw e;
        if (e.code === 'QUOTA') {
          this.registry.block(session.agentId, e.resetsAt, true);
          continue;
        }
        if (transient >= TRANSIENT_RETRIES || !TRANSIENT.test(e.message)) throw e;
        transient++;
        const wait = 15_000 * transient;
        this._ev(run, taskId, { kind: 'info', text: `上游临时故障，${wait / 1000}s 后自动重试（${transient}/${TRANSIENT_RETRIES}）：${e.message.slice(0, 160)}` });
        await this._sleep(rt, wait);
        if (!this._alive(run, rt)) throw new Error('已取消');
      }
    }
  }

  // Claude 有真实用量（含缓存读写）；ACP 只报上下文占用，输入取它、输出按流式字数估算，标 est
  _addTokens(run, taskId, session, text, res) {
    const u = res.usage;
    const tk = u
      ? { in: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), out: u.output_tokens ?? 0, est: false }
      : { in: session.lastUsage?.used ?? Math.ceil(text.length / 3), out: Math.ceil((session.outChars ?? 0) / 3), est: true };
    const add = (o) => ({ in: (o?.in ?? 0) + tk.in, out: (o?.out ?? 0) + tk.out, est: !!(o?.est || tk.est) });
    if (taskId === 'leader') run.leaderTokens = add(run.leaderTokens);
    else { const t = run.tasks.find(x => x.id === taskId); if (t) t.tokens = add(t.tokens); }
    this._save(run);
    return tk;
  }

  async _waitQuota(run, taskId, agentId, until) {
    const rt = this._rt(run);
    const name = this.registry.get(agentId)?.name ?? agentId;
    this._ev(run, taskId, { kind: 'info', text: `${name} 额度已用尽，${hhmm(until)} 恢复后自动继续` });
    this._setWait(run, taskId, until);
    await this._sleep(rt, until - now() + 30_000);
    this._setWait(run, taskId, null);
    if (!this._alive(run, rt)) throw new Error('已取消');
    this._ev(run, taskId, { kind: 'info', text: `${name} 额度已恢复，继续执行` });
  }

  _setWait(run, taskId, until) {
    if (taskId === 'leader') run.leaderWaitUntil = until;
    else {
      const t = run.tasks.find(x => x.id === taskId);
      if (t) t.waitUntil = until;
    }
    this._save(run);
  }

  // 可被取消打断的 sleep
  _sleep(rt, ms) {
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); rt.sleepers.delete(done); resolve(); };
      const timer = setTimeout(done, Math.max(0, ms));
      rt.sleepers.add(done);
    });
  }

  // ───── git worktree ─────

  async _prepareGit(run) {
    if (run.isolation === 'shared') return;
    const wd = run.workdir;
    if (!(await G.isRepo(wd))) {
      if (fs.readdirSync(wd).length) {
        if (run.isolation === 'worktree') throw new Error('工作目录不是 git 仓库，无法用 worktree 隔离。请先 git init 并提交，或改用「共享目录」');
        run.isolation = 'shared';
        this._ev(run, 'leader', { kind: 'info', text: '工作目录不是 git 仓库，本次改用共享目录（不隔离）' });
        this._save(run);
        return;
      }
      await G.init(wd);
    }
    const top = await G.topLevel(wd);
    const base = await G.ensureCommit(top);
    if (await G.isDirty(top)) {
      this._ev(run, 'leader', { kind: 'info', text: '注意：工作目录有未提交的改动，队员基于最新提交工作，看不到这些改动' });
    }
    const branch = `hub/${run.id}`;
    const main = path.join(this.worktreeRoot, run.id, '_main');
    await G.addWorktree(top, main, branch, base);
    run.isolation = 'worktree';
    run.git = { top, rel: path.relative(top, wd), base, branch, main, merged: false, mergedInto: null };
    this._ev(run, 'leader', { kind: 'info', text: `已启用 worktree 隔离：集成分支 ${branch}` });
    this._save(run);
  }

  async _ensureWorktree(run, t) {
    if (t.worktree && fs.existsSync(t.worktree)) return;
    t.branch = `${run.git.branch}-${t.id}`;
    t.worktree = path.join(this.worktreeRoot, run.id, t.id);
    await G.addWorktree(run.git.top, t.worktree, t.branch, run.git.branch);
    this._save(run);
  }

  // 提交队员的改动 → 合进集成分支；冲突时把集成分支反向合进队员工作区，留冲突标记给它解决
  async _mergeTask(run, t) {
    const wt = t.worktree;
    const left = await G.conflictMarkers(wt);
    if (left.length) return { ok: false, files: left };
    await G.commitAll(wt, `${t.id}: ${t.title}`);
    if (!(await G.ahead(run.git.main, run.git.branch, t.branch))) return { ok: true, empty: true };
    await G.cleanTree(run.git.main);
    const r = await G.merge(run.git.main, t.branch, `合并 ${t.id}：${t.title}（${t.assignee}）`);
    if (r.ok) return r;
    await G.mergeNoCommit(wt, run.git.branch);
    return r;
  }

  async _dropWorktree(run, t) {
    if (!run.git || !t.worktree) return;
    const { worktree, branch } = t;
    t.worktree = null;
    this._save(run);
    await new Promise(r => setTimeout(r, 1000)); // 等子进程退出、释放文件
    await G.removeWorktree(run.git.top, worktree);
    await G.deleteBranch(run.git.top, branch);
  }

  _dropAllWorktrees(run) {
    for (const t of run.tasks) if (t.worktree) this._dropWorktree(run, t).catch(() => {});
  }

  // ───── 工具方法 ─────

  async _session(run, taskId, agent, resumeId, cwd) {
    const ctx = { runId: run.id, taskId, agentId: agent.id };
    const s = createSession(agent, {
      cwd, hub: this.hub, ctx, dataDir: this.tmpDir, resumeId,
      fresh: () => this.registry.get(agent.id), // 每轮取最新配置：切换模型后下一轮生效
      overrides: () => this._overrides(run, taskId, agent.id),
      approve: (req) => this.approve({ ...ctx, ...req }),
    });
    s.agentId = agent.id;
    s.on('event', (ev) => {
      if (ev.chunk) s.outChars = (s.outChars ?? 0) + (ev.text?.length ?? 0);
      this._ev(run, taskId, ev);
    });
    s.on('quota', q => this.registry.setQuota(agent.id, q));
    s.on('options', o => this.registry.acpOptions.set(agent.id, o));
    s.on('usage', (u) => { s.lastUsage = u; this.emit('usage', { runId: run.id, taskId, ...u }); });
    // 会话 id 一拿到就记下，「在原生界面打开」和续跑都要用
    s.on('session', sid => {
      if (taskId === 'leader') run.leaderSessionId = sid;
      else { const t = run.tasks.find(x => x.id === taskId); if (t) t.agentSessionId = sid; }
      this._save(run);
    });
    await s.start();
    if (taskId === 'leader' && s.sessionId) run.leaderSessionId = s.sessionId;
    return s;
  }

  _checkTasks(run, tasks, required) {
    if (!Array.isArray(tasks) || (required && !tasks.length)) return 'tasks 必须是非空数组';
    for (const t of tasks) {
      if (!t.title || !t.prompt) return '每个任务都要有 title 和 prompt';
      if (!run.memberIds.includes(t.assignee)) return `assignee「${t.assignee}」不是可用队员，只能从 ${run.memberIds.join(' / ')} 里选`;
    }
    return null;
  }

  _checkNew(run, o) {
    return o.newTasks?.length ? this._checkTasks(run, o.newTasks, false) : null;
  }

  _addTasks(run, list) {
    const ids = new Set(run.tasks.map(t => t.id));
    const map = {};
    const fresh = list.map(raw => {
      let id = raw.id && !ids.has(String(raw.id)) ? String(raw.id) : null;
      for (let n = run.tasks.length + 1; !id || ids.has(id); n++) id = `t${n}`;
      ids.add(id);
      if (raw.id) map[raw.id] = id;
      return { raw, id };
    });
    const budget = this._budget(run);
    for (const { raw, id } of fresh) {
      const t = {
        id, title: String(raw.title), assignee: raw.assignee, prompt: String(raw.prompt),
        level: ['easy', 'normal', 'hard'].includes(raw.level) ? raw.level : 'normal',
        deps: (raw.deps ?? []).map(d => map[d] ?? String(d)).filter(d => d !== id && ids.has(d)),
        status: 'pending', rounds: 0, retries: 0, result: null, error: null, feedback: null, note: null,
        agentSessionId: null, lastAgent: null, worktree: null, branch: null, waitUntil: null,
        createdAt: now(), startedAt: null, endedAt: null,
      };
      // 专家额度紧张时，非困难任务不占它的额度，改派给主力 / 经济型队员
      if (budget?.tight && t.assignee === budget.agent.id && t.level !== 'hard') {
        const alt = this._fallback(run, t.assignee, t.level);
        if (alt) {
          t.note = `专家额度紧张，由 ${t.assignee} 改派给 ${alt}`;
          this._ev(run, 'leader', { kind: 'info', text: `${id}「${t.title}」${t.note}` });
          t.assignee = alt;
        }
      }
      run.tasks.push(t);
    }
  }

  // ───── 分工与额度 ─────

  // 专家（tier=expert）的额度状态；Claude 用订阅额度，其他专家只看是否被封锁
  _budget(run) {
    const ex = this._members(run).find(m => m.tier === 'expert');
    if (!ex) return null;
    const until = this.registry.blockedUntil(ex.id);
    if (until) return { agent: ex, blocked: hhmm(until), tight: true, pressure: 100, text: '额度已用尽' };
    const u = ex.type === 'claude' && !ex.custom ? this.usage?.() : null;
    const pressure = pressureOf(u);
    const text = u?.source ? `5 小时已用 ${u.fiveHour?.pct ?? '?'}%，7 天已用 ${u.sevenDay?.pct ?? '?'}%` : '';
    return { agent: ex, pressure, tight: pressure >= (this.routing.tightAt ?? 70), text };
  }

  // 改派对象：简单任务先找经济型，其余先找主力；跳过不可用和额度封锁的
  _fallback(run, exclude, level) {
    const order = level === 'easy' ? ['cheap', 'main'] : ['main', 'cheap'];
    const pool = this._members(run).filter(m => m.id !== exclude && this.registry.usable(m.id) && !this.registry.blockedUntil(m.id));
    for (const tier of order) {
      const m = pool.find(x => (x.tier ?? 'main') === tier);
      if (m) return m.id;
    }
    return null;
  }

  // 全部任务结束后追加一次专家终审（每个编排最多一次）。额度紧张、没有改动、成果全是专家自己做的就跳过
  _addFinalReview(run) {
    if (!run.finalReview || run.finalReviewTask) return false;
    const b = this._budget(run);
    const skip = (why) => {
      run.finalReviewTask = 'skipped';
      if (why) this._ev(run, 'leader', { kind: 'info', text: `跳过专家终审：${why}` });
      return false;
    };
    if (!b) return skip(null);
    const done = run.tasks.filter(t => t.status === 'done');
    if (!this.registry.usable(b.agent.id)) return skip(`${b.agent.name} 不可用`);
    if (b.blocked) return skip(`${b.agent.name} 额度已用尽`);
    if (b.pressure >= (this.routing.finalReviewSkipAt ?? 85)) return skip(`${b.agent.name} 额度紧张（${b.text}）`);
    if (!done.length) return skip('没有完成的任务');
    if (done.every(t => t.assignee === b.agent.id)) return skip('成果都是专家自己做的');
    if (run.git && done.every(t => /没有文件改动/.test(t.note ?? ''))) return skip('没有文件改动');
    this._addTasks(run, [{ title: '专家终审', assignee: b.agent.id, level: 'hard', prompt: P.finalReview(run) }]);
    const t = run.tasks[run.tasks.length - 1];
    t.kind = 'final';
    run.finalReviewTask = t.id;
    this._ev(run, 'leader', { kind: 'info', text: `所有任务已完成，安排 ${b.agent.name} 做整体终审（${t.id}）` });
    return true;
  }

  // 每轮调用前决定是否临时换模型：困难任务且额度充足时用 claude.hard 里的强模型；终审只提高思考强度
  _overrides(run, taskId, agentId) {
    const a = this.registry.get(agentId);
    const hard = a?.claude?.hard;
    const t = taskId === 'leader' ? null : run.tasks.find(x => x.id === taskId);
    if (!hard || t?.level !== 'hard') return null;
    if (t.kind === 'final') return hard.effort ? { effort: hard.effort } : null;
    const p = a.type === 'claude' && !a.custom ? pressureOf(this.usage?.()) : 0;
    if (p >= (this.routing.strongModelBelow ?? 50)) return hard.effort ? { effort: hard.effort } : null;
    return { model: hard.model, effort: hard.effort, reason: '困难任务，额度充足' };
  }

  _closeTask(run, t) {
    const rt = this._rt(run);
    rt.sessions.get(t.id)?.close();
    rt.sessions.delete(t.id);
  }

  // 拆掉这个运行时：关会话、叫醒所有 sleep；之后这个 rt 上的异步流程都会自行退出
  _teardown(run) {
    const rt = this._rt(run);
    rt.dead = true;
    rt.leader?.close();
    for (const s of rt.sessions.values()) s.close();
    rt.sessions.clear();
    for (const wake of [...rt.sleepers]) wake();
  }

  _alive(run, rt) {
    return this.rt.get(run.id) === rt && !rt.cancelled && !rt.dead;
  }

  _usable(id) {
    const a = this.registry.usable(id);
    if (!a) throw new Error(`${id} 不可用（未启用或找不到命令）`);
    return a;
  }

  _members(run) {
    return run.memberIds.map(id => this.registry.get(id)).filter(Boolean);
  }

  _rt(run) {
    if (!this.rt.has(run.id)) {
      this.rt.set(run.id, { leader: null, queue: Promise.resolve(), sessions: new Map(), sleepers: new Set(), cancelled: false, dead: false, finishing: false });
    }
    return this.rt.get(run.id);
  }

  _get(runId) {
    const run = this.store.runs.get(runId);
    if (!run) throw new Error('编排不存在');
    return run;
  }

  _save(run) {
    this.store.save(run);
    this.emit('run', run);
  }

  _ev(run, taskId, ev) {
    const e = { ts: now(), ...ev };
    this.store.addEvent(run.id, taskId, e);
    this.emit('ev', { runId: run.id, taskId, ev: e });
  }
}

// 队员执行期间用户插的话（队员还没看到），审查时交给组长判断
function inboxNote(t) {
  if (!t.inbox?.length) return '';
  return `\n\n## 用户在队员执行期间的补充要求（队员还没看到）\n${t.inbox.map(x => `- ${x}`).join('\n')}\n交付没有满足这些要求时请选 revise / retry，并把要求写进 feedback。`;
}

function clampInt(v, min, max, dflt) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
}
