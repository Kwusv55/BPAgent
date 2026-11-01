// AI 编排台入口：本机 HTTP 服务 = 静态网页 + REST + SSE 实时推送
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { Registry } from './registry.js';
import { Store } from './store.js';
import { Approvals } from './approvals.js';
import { Orchestrator } from './orchestrator.js';
import { openNative } from './native.js';
import { Templates } from './templates.js';
import { listChoices, applyChoices } from './models.js';
import { claudeUsage } from './usage.js';
import { Secrets, PROTOCOLS, DRIVERS, fetchModels } from './custom.js';
import { ROOT, VERSION, expand } from './util.js';

const hubCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'hub.json'), 'utf8'));
const PORT = Number(process.env.HUB_PORT || hubCfg.port || 7788);
const HOST = '127.0.0.1';
// 环境变量覆盖用于起隔离的测试实例
const DATA = process.env.HUB_DATA || path.join(ROOT, 'data');
const AGENTS_FILE = process.env.HUB_AGENTS || path.join(ROOT, 'config', 'agents.json');
const TOKEN = crypto.randomBytes(16).toString('hex'); // 只给审批 MCP 子进程用

const secrets = new Secrets(path.join(path.dirname(AGENTS_FILE), 'secrets.json'));
const registry = new Registry(AGENTS_FILE, { secrets, dataDir: DATA });
const store = new Store(DATA);
const approvals = new Approvals();
const orch = new Orchestrator({
  registry, store, approvals, dataDir: DATA,
  hub: { url: `http://${HOST}:${PORT}`, token: TOKEN },
  workspaceRoot: process.env.HUB_WORKSPACES || expand(hubCfg.workspaceRoot || '${root}\\workspaces'),
  worktreeRoot: process.env.HUB_WORKTREES || expand(hubCfg.worktreeRoot || '${root}\\worktrees'),
  routing: hubCfg.routing ?? {},
  usage: () => claudeUsage(registry, hubCfg),
});
const templates = new Templates(path.join(ROOT, 'config', 'templates.json'));

// ───── SSE ─────
const clients = new Set();
const failedLogged = new Set();
const broadcast = (type, data) => {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
};
registry.on('change', () => broadcast('agents', registry.snapshot()));
approvals.on('change', () => broadcast('approvals', approvals.pending()));
orch.on('run', (run) => {
  broadcast('run', run);
  // 失败原因同时打到控制台 / data\server.log，网页上没看到时也能查
  if (run.status === 'failed' && run.error && !failedLogged.has(run.id)) {
    failedLogged.add(run.id);
    console.error(`[${new Date().toLocaleString('zh-CN')}] 编排 ${run.id} 失败：${run.error}`);
  }
});
orch.on('ev', e => broadcast('ev', e));
orch.on('removed', id => broadcast('removed', { id }));
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 20_000);

// ───── 路由 ─────
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), fn });

const runSummary = (r) => ({
  id: r.id, goal: r.goal, status: r.status, createdAt: r.createdAt, leaderId: r.leaderId, workdir: r.workdir, autoWorkdir: r.autoWorkdir,
  total: r.tasks.length, done: r.tasks.filter(t => t.status === 'done').length,
});

route('GET', '/api/state', () => ({
  version: VERSION, defaults: hubCfg.defaults ?? {}, workspaceRoot: orch.workspaceRoot, ...registry.snapshot(),
  runs: store.list().map(runSummary), approvals: approvals.pending(),
}));
route('GET', '/api/runs/:id', ({ id }) => store.runs.get(id) ?? fail(404, '编排不存在'));
route('GET', '/api/runs/:id/events/:taskId', ({ id, taskId }) => store.getEvents(id, taskId));
route('POST', '/api/runs', (_, body) => orch.create(body));
route('POST', '/api/runs/:id/message', async ({ id }, body) => ({ reply: await orch.message(id, String(body.text ?? '')) }));
route('POST', '/api/runs/:id/agents/:agentId/message', ({ id, agentId }, body) => orch.messageAgent(id, agentId, String(body.text ?? '')));
route('POST', '/api/runs/:id/leader', ({ id }, body) => (orch.switchLeader(id, String(body.leaderId ?? '')), { ok: true }));
route('POST', '/api/runs/:id/cancel', ({ id }) => (orch.cancel(id), { ok: true }));
route('POST', '/api/runs/:id/resume', ({ id }) => (orch.resume(id), { ok: true }));
route('POST', '/api/runs/:id/merge', async ({ id }) => (await orch.mergeToWorkdir(id), { ok: true }));
route('GET', '/api/templates', () => templates.list());
route('POST', '/api/templates', (_, body) => templates.save(body));
route('DELETE', '/api/templates/:id', ({ id }) => (templates.remove(id), templates.list()));
route('DELETE', '/api/runs/:id', ({ id }) => (orch.remove(id), { ok: true }));
route('POST', '/api/runs/:id/tasks/:taskId/cancel', ({ id, taskId }) => (orch.cancelTask(id, taskId), { ok: true }));
route('POST', '/api/runs/:id/tasks/:taskId/open', ({ id, taskId }, body) => {
  const run = store.runs.get(id) ?? fail(404, '编排不存在');
  const isLeader = taskId === 'leader';
  const t = isLeader ? null : run.tasks.find(x => x.id === taskId) ?? fail(404, '任务不存在');
  const agent = registry.get(isLeader ? run.leaderId : t.assignee);
  openNative(agent, body.index, {
    cwd: isLeader ? orch.leaderCwd(run) : orch.taskCwd(run, t),
    sessionId: isLeader ? run.leaderSessionId : t.agentSessionId,
    title: `${agent?.name ?? ''} · ${isLeader ? '组长' : t.title}`.slice(0, 60),
  });
  return { ok: true };
});
// 审批 MCP 子进程专用，带 token。必须注册在 /api/approvals/:id 之前，否则 "request" 会被当成审批 id
route('POST', '/api/approvals/request', (_, body, req) => {
  checkToken(req);
  const r = orch.openApproval({ runId: body.runId, taskId: body.taskId, agentId: body.agentId, title: body.title ?? '工具调用', input: body.input });
  return r.decided ? r : { decided: false, id: r.id };
});
// 队员向组长提问（hub-mcp 的 ask_leader 工具用，带 token）
route('POST', '/api/ask/request', (_, body, req) => { checkToken(req); return orch.ask(body); });
route('GET', '/api/ask/:id/wait', ({ id }, _, req) => { checkToken(req); return orch.waitAsk(id); });
route('GET', '/api/approvals/:id/wait', ({ id }, _, req) => { checkToken(req); return approvals.wait(id); });
route('POST', '/api/approvals/:id', ({ id }, body) => ({ ok: approvals.decide(id, !!body.allow, body.message) }));
route('GET', '/api/agents/:id/choices', ({ id }) => listChoices(registry.get(id) ?? fail(404, '没有这个 AI'), registry));
route('PUT', '/api/agents/:id/choices', ({ id }, body) => {
  registry.save(JSON.stringify(applyChoices(JSON.parse(registry.raw()), id, body.values ?? {}), null, 2));
  return registry.snapshot();
});
// Claude 订阅额度：和命令行 claude-hud 显示的同一份数据（见 usage.js），编排器也据此决定派活
route('GET', '/api/usage/claude', () => claudeUsage(registry, hubCfg));
// 启用 / 停用某个 AI，写回 agents.json
route('PUT', '/api/agents/:id/enabled', ({ id }, body) => {
  const cfg = JSON.parse(registry.raw());
  const a = cfg.agents.find(x => x.id === id) ?? fail(404, '没有这个 AI');
  a.enabled = !!body.enabled;
  registry.save(JSON.stringify(cfg, null, 2));
  return registry.snapshot();
});
// ───── 自定义模型（反代 / 中转）：增删改写回 agents.json，API Key 单独存 secrets.json ─────
const PALETTE = ['#8b5cf6', '#e11d74', '#0ea5e9', '#f59e0b', '#14b8a6', '#64748b', '#ef4444', '#84cc16'];
function saveCustom(id, b) {
  const cfg = JSON.parse(registry.raw());
  const protocol = String(b.protocol ?? ''), model = String(b.model ?? '').trim();
  const driver = String(b.driver || PROTOCOLS[protocol]?.drivers[0] || '');
  let a = id ? cfg.agents.find(x => x.id === id && x.custom) ?? fail(404, '没有这个自定义模型') : null;
  if (!a) {
    const stem = String(b.name || model).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'custom';
    let nid = stem;
    for (let i = 2; cfg.agents.some(x => x.id === nid); i++) nid = `${stem}-${i}`;
    const used = new Set(cfg.agents.map(x => x.color));
    a = { id: nid, color: PALETTE.find(c => !used.has(c)) ?? PALETTE[cfg.agents.length % PALETTE.length], enabled: true };
    cfg.agents.push(a);
  }
  Object.assign(a, {
    name: String(b.name ?? '').trim() || model,
    tier: ['main', 'cheap', 'expert'].includes(b.tier) ? b.tier : 'main',
    roles: ['leader', 'member'].filter(r => (Array.isArray(b.roles) ? b.roles : ['leader', 'member']).includes(r)),
    maxConcurrent: Math.min(8, Math.max(1, Number(b.maxConcurrent) || 2)),
    description: String(b.description ?? '').trim() || `自定义模型 ${model}（${DRIVERS[driver] ?? driver} 驱动，${PROTOCOLS[protocol]?.label ?? protocol}）`,
    custom: { protocol, driver, baseUrl: String(b.baseUrl ?? '').trim(), model, ...(b.effort && { effort: String(b.effort) }) },
  });
  if (!a.roles.length) fail(400, '组长、队员至少勾一个');
  const oldKey = secrets.get(a.id);
  if (b.apiKey?.trim()) secrets.set(a.id, b.apiKey.trim()); // 留空 = 不改原来的 key
  try { registry.save(JSON.stringify(cfg, null, 2)); } catch (e) { secrets.set(a.id, oldKey); throw e; }
  return { id: a.id, ...registry.snapshot() };
}
const inUse = (id) => store.list().some(r => ['planning', 'running', 'summarizing'].includes(r.status) && (r.leaderId === id || r.memberIds.includes(id)));
route('GET', '/api/custom/meta', () => ({ protocols: PROTOCOLS, drivers: DRIVERS }));
// 拉模型列表 / 测连通。编辑已有条目时 key 留空就用存着的
route('POST', '/api/custom/models', async (_, b) => ({ models: await fetchModels({ protocol: b.protocol, baseUrl: b.baseUrl, apiKey: b.apiKey?.trim() || (b.id ? secrets.get(b.id) : '') }) }));
route('POST', '/api/custom', (_, b) => saveCustom(null, b));
route('PUT', '/api/custom/:id', ({ id }, b) => {
  if (inUse(id)) fail(400, '有进行中的编排在用它，结束后再改');
  return saveCustom(id, b);
});
route('DELETE', '/api/custom/:id', ({ id }) => {
  if (inUse(id)) fail(400, '有进行中的编排在用它，结束后再删');
  const cfg = JSON.parse(registry.raw());
  const i = cfg.agents.findIndex(x => x.id === id && x.custom);
  if (i < 0) fail(404, '没有这个自定义模型');
  cfg.agents.splice(i, 1);
  registry.save(JSON.stringify(cfg, null, 2));
  secrets.set(id, '');
  fs.rmSync(path.join(DATA, 'custom', `${id}.patch.yml`), { force: true });
  return registry.snapshot();
});
// 残留清理：先 GET 预览，确认后 POST 执行
route('GET', '/api/cleanup', () => orch.scanResidue());
route('POST', '/api/cleanup', () => orch.cleanResidue());
route('GET', '/api/config/agents', () => ({ text: registry.raw() }));
// 托盘「退出」用：先收尾（关掉在跑的会话，编排标记为中断，之后可继续运行）再退出进程
route('POST', '/api/shutdown', () => { setTimeout(shutdown, 200); return { ok: true }; });
route('PUT', '/api/config/agents', (_, body) => { registry.save(String(body.text ?? '')); return registry.snapshot(); });

function fail(status, message) { throw Object.assign(new Error(message), { status }); }
function checkToken(req) { if (req.headers['x-hub-token'] !== TOKEN) fail(403, 'bad token'); }

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const server = http.createServer(async (req, res) => {
  // 只认本机访问，防 DNS rebinding
  const host = (req.headers.host ?? '').toLowerCase();
  if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) {
    res.writeHead(403).end('forbidden');
    return;
  }
  const url = new URL(req.url, `http://${host}`);

  if (url.pathname === '/api/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    // 写操作要求 JSON 请求，挡住跨站表单
    if (req.method !== 'GET' && !String(req.headers['content-type'] ?? '').includes('application/json')) {
      res.writeHead(415).end();
      return;
    }
    for (const r of routes) {
      const m = r.method === req.method && url.pathname.match(r.re);
      if (!m) continue;
      try {
        const body = req.method === 'GET' ? {} : await readBody(req);
        const out = await r.fn(m.groups ?? {}, body, req);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(out ?? null));
      } catch (e) {
        res.writeHead(e.status ?? 400, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    res.writeHead(404).end();
    return;
  }

  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.join(ROOT, 'web', path.normalize(rel));
  if (!file.startsWith(path.join(ROOT, 'web')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
});

// 端口被占：多半是已经有一份在跑（托盘或另一个 start.cmd），直接退出，不报一堆错
// --open（start.cmd 用）：服务就绪后才打开浏览器。以前是先开浏览器再起服务，浏览器抢先一步就显示「无法访问」
const OPEN = process.argv.includes('--open');
const openBrowser = () => new Promise(r => execFile('rundll32.exe', ['url.dll,FileProtocolHandler', `http://${HOST}:${PORT}/`],{ windowsHide: true }, () => r()));
server.on('error', async (e) => {
  if (e.code !== 'EADDRINUSE') throw e;
  console.log(`端口 ${PORT} 已被占用，BPAgent 已经在运行（托盘或另一个 start.cmd），直接打开：http://${HOST}:${PORT}`);
  if (OPEN) await openBrowser();
  process.exit(0);
});
server.listen(PORT, HOST, () => {
  console.log(`BPAgent v${VERSION} 已启动：http://${HOST}:${PORT}`);
  if (registry.error) console.warn(registry.error);
  for (const a of registry.agents) console.log(`  ${a.enabled ? (a.available ? '✓' : '✗ 找不到命令') : '- 未启用'}  ${a.id}  ${a.name}`);
  if (OPEN) {
    console.log('这个窗口就是服务本身，关掉它编排台就停了。别在窗口里点选文字（会冻结输出、卡住服务），要选的话按 Esc 退出选择。');
    openBrowser();
  }
});

const shutdown = () => {
  for (const run of store.list()) if (['planning', 'running', 'summarizing'].includes(run.status)) orch._teardown(run);
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
