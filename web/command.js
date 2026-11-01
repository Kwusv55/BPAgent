'use strict';
// 指挥中心（工程蓝图版）：左侧是按工作区折叠的编排记录，每次打开都是一个新对话；主区自上而下是顶栏、阶段流水线、
// 中部（左：作战编组 + 工具调用；中：任务晶格；右：调度队列 / 依赖图 / 审查 / Token 曲线）、底部三联和指令台。
// 背景是会漂移的毫米网格，面板之间有电路板式走线，数据沿走线流动。点卡片 / 晶格 / 任务行，在右侧抽屉里看实时输出。数据全部来自 /api/state + SSE

Object.assign(S, {
  run: null,            // 当前显示的编排（完整）
  sel: null,            // 抽屉：'leader' / 任务 id / 'agent:<id>'
  events: new Map(),    // `${runId}:${taskId}` → 合并后的事件
});

const ACTIVE = ['planning', 'running', 'summarizing'];
const RESUMABLE = ['interrupted', 'failed'];
const TERMINAL = ['done', 'failed', 'skipped', 'cancelled', 'interrupted'];
const fmt = (n) => Math.round(n || 0).toLocaleString('en-US');
const kfmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1000)}K` : n >= 1e3 ? `${(n / 1000).toFixed(1)}K` : fmt(n));
const hms = (t) => new Date(t).toTimeString().slice(0, 8);
const mmss = (ms) => {
  const s = Math.max(0, ms / 1000 | 0), h = s / 3600 | 0;
  const m = String((s % 3600) / 60 | 0).padStart(2, '0'), ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${m}:${ss}` : `${m}:${ss}`;
};
const short = (id) => { const a = agentOf(id); return a.name.length <= 8 ? a.name : (a.id.length <= 6 ? a.id.toUpperCase() : a.name.split(/\s+/)[0]); };
const prettyModel = (m) => String(m || '').replace(/^deepseek-/i, '').split(/[-_]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
const isActive = (run) => !!run && ACTIVE.includes(run.status);
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// ───── 实时活动：每个任务流最近在干什么 + 吞吐估算 ─────
const live = {};          // taskId → { at, text, chars }（chars：本轮已流出的字数，turn 结束清零）
const tools = new Map();  // toolId → 遥测条目，用于把 … 改成 ✓ / ✗
const firstChunk = new Set();
let log = [], rateIn = 0, rateOut = 0, rateHist = Array(48).fill(0), secIn = 0, secOut = 0;
let lastTasks = new Map(), lastRunStatus = null;
let leaderFocus = null; // 组长手上的事：{ text, task }，从发给它的提示词识别
let coreFlash = 0, coreAct = 0;
// 图表的原始数据，打开编排时按历史事件重建
let samples = [];         // { ts, task, w, k }：k = msg / tool / err / go（派发）
let toolCells = [];       // 每次工具调用一格：{ status, agent, shade }
let tokPts = [], tokIn = 0, tokOut = 0, lastGain = null, talk = 0; // tokPts：[时间, 累计输入, 累计输出]

function focusFromPrompt(text) {
  let m;
  if ((m = text.match(/^队员 \S+ 交付了任务 (\S+)「(.*?)」/))) return { text: `审查 ${m[1]}「${m[2]}」`, task: m[1] };
  if ((m = text.match(/^任务 (\S+)「(.*?)」在队员/))) return { text: `处理失败 ${m[1]}「${m[2]}」`, task: m[1] };
  if (text.startsWith('用户插话了')) return { text: '处理你的插话' };
  if ((m = text.match(/^队员 \S+ 在执行任务 (\S+)「(.*?)」时遇到阻塞/))) return { text: `回答 ${m[1]} 的提问`, task: m[1], ask: true };
  if (text.startsWith('你接替前任组长')) return { text: '接手编排，熟悉进度' };
  if (text.includes('【组长】')) return { text: '拆分任务、制定计划' };
  return null; // 汇总、修正 JSON 之类沿用上一个，或按编排状态推断
}

// 组长的「当前任务」
function coreTask() {
  const run = S.run;
  if (!run) return null;
  const done = run.tasks.filter(t => t.status === 'done').length;
  if (run.leaderWaitUntil) return `额度等待中 · ${tm(run.leaderWaitUntil)} 恢复后继续`;
  if (run.status === 'planning') return leaderFocus?.text ?? '拆分任务、制定计划';
  if (run.status === 'summarizing') return '撰写最终汇报';
  if (!isActive(run)) return run.status === 'done' ? `全部完成 ${done}/${run.tasks.length}` : null;
  const f = leaderFocus?.task && run.tasks.find(t => t.id === leaderFocus.task);
  if (f && (f.status === 'review' || (leaderFocus.ask && Date.now() - coreAct < 8000))) return leaderFocus.text;
  if (leaderFocus?.text === '处理你的插话' && Date.now() - coreAct < 5000) return leaderFocus.text;
  const review = run.tasks.find(t => t.status === 'review');
  if (review) return `审查 ${review.id}「${review.title}」`;
  const running = run.tasks.filter(t => t.status === 'running');
  if (running.length) return `督导 ${running.map(t => t.id).join('、')} · ${running.length} 个进行中`;
  return `等待调度 · 已完成 ${done}/${run.tasks.length}`;
}

function pushLog(who, text, mark = '…', cls = '', ts = Date.now()) {
  const e = { ts, who, text: String(text).replace(/\s+/g, ' ').slice(0, 160), mark, cls, born: Date.now() - ts < 3000 ? performance.now() : 0 };
  log.push(e);
  if (log.length > 80) log.shift();
  if (S.run && Date.now() - ts < 3000 && every('log', 250)) sendTo('log', { col: cls === 'err' ? P.red : P.teal });
  return e;
}
const whoOf = (run, taskId) => (taskId === 'leader' ? '组长' : short(run.tasks.find(t => t.id === taskId)?.assignee ?? taskId));
const toolArg = (inp) => (inp ? String(inp.command ?? inp.file_path ?? inp.path ?? inp.pattern ?? inp.url ?? inp.description ?? '') : '');
const ownerOf = (run, taskId) => (taskId === 'leader' ? run.leaderId : run.tasks.find(t => t.id === taskId)?.assignee);

// 把一个原始事件翻译成遥测、图表数据和丝带。seed=true 是打开编排时回放历史，不放丝带
function absorb(run, taskId, ev, seed) {
  const who = whoOf(run, taskId), ts = ev.ts ?? Date.now();
  const L = (live[taskId] ??= { at: 0, text: '', chars: 0 });
  const len = (ev.text?.length ?? 0) + (ev.output?.length ?? 0);
  let k = null, w = 0;
  if (!seed) {
    L.at = Date.now();
    if (ev.kind === 'message' || ev.kind === 'thought') secOut += ev.text?.length ?? 0;
    else secIn += len;
  }
  if (ev.chunk) L.chars += ev.text?.length ?? 0;
  switch (ev.kind) {
    case 'prompt':
      if (taskId !== 'leader') { const t = run.tasks.find(x => x.id === taskId); L.text = `接到任务 ${taskId}`; pushLog(who, `开始执行 ${taskId}「${t?.title ?? ''}」`, '→', '', ts); if (!seed) burst(taskId, true, 40); k = 'go'; w = 1; }
      else { L.text = '思考中'; leaderFocus = focusFromPrompt(ev.text ?? '') ?? leaderFocus; k = 'msg'; w = 1; }
      break;
    case 'thought': {
      L.text = '思考中';
      const key = `${taskId}:t:${ev.mid}`;
      if (!firstChunk.has(key)) { firstChunk.add(key); pushLog(who, '思考…', '…', '', ts); }
      k = 'msg'; w = len / 60;
      break;
    }
    case 'message': {
      L.text = '输出中';
      const key = `${taskId}:m:${ev.mid}`;
      if (!firstChunk.has(key)) { firstChunk.add(key); pushLog(who, `回复：${ev.text ?? ''}`, '…', '', ts); }
      k = 'msg'; w = len / 60;
      break;
    }
    case 'tool': {
      const known = tools.get(ev.toolId);
      if (!known) {
        const e = pushLog(who, `${ev.title ?? '工具'} ${toolArg(ev.input)}`, '…', '', ts);
        e.cell = { status: ev.status ?? 'running', agent: ownerOf(run, taskId), shade: .25 + Math.random() * .75 };
        toolCells.push(e.cell);
        if (!seed && every(`tool:${taskId}`, 120)) sendTool(e.cell.agent);
        if (ev.toolId) tools.set(ev.toolId, e);
        L.text = `${ev.title ?? '工具'} ${toolArg(ev.input)}`;
        k = 'tool'; w = 2;
      }
      const e = tools.get(ev.toolId);
      if (e && ev.status === 'completed') { e.mark = '✓'; e.cell.status = 'completed'; }
      if (e && ev.status === 'failed') { e.mark = '✗'; e.cls = 'err'; e.cell.status = 'failed'; }
      break;
    }
    case 'turn':
      L.chars = 0;
      L.text = taskId === 'leader' ? '' : '本轮结束';
      pushLog(who, `本轮 ${dur(ev.ms ?? 0)}${ev.tokens ? ` · ${ev.tokens.est ? '≈' : ''}${kfmt(ev.tokens.in + ev.tokens.out)} tok` : ''}`, '✓', '', ts);
      if (ev.tokens) {
        const n = ev.tokens.in + ev.tokens.out;
        tokIn += ev.tokens.in; tokOut += ev.tokens.out;
        tokPts.push([ts, tokIn, tokOut]);
        lastGain = { who, task: taskId, n, est: !!ev.tokens.est, at: ts };
        if (!seed) sendTo('curve', { n: clamp(Math.round(n / 4000), 1, 6), col: P.orange, gap: 40 });
      }
      break;
    case 'user': pushLog('你', ev.text, '›', 'cmdr', ts); talk++; break;
    case 'ask':
      if (taskId !== 'leader') { pushLog(who, `向组长提问：${ev.text}`, '?', 'cmdr', ts); L.text = '等组长回答'; talk++; if (!seed) burst(taskId, false, 40, P.blue); }
      break;
    case 'answer':
      pushLog('组长', `回答 ${taskId}：${ev.text}`, '✓', '', ts);
      if (!seed) { burst(taskId, true, 40, P.blue); coreFlash = Math.max(coreFlash, 1.1); }
      break;
    case 'error': pushLog(who, ev.text, '✗', 'err', ts); k = 'err'; w = 2; break;
    case 'info': if (!/^会话(已建立|将在)|^已续接会话|^续接原会话/.test(ev.text ?? '')) pushLog(who, ev.text, 'i', '', ts); break;
  }
  if (k) {
    samples.push({ ts, task: taskId, w: Math.max(.3, w), k });
    if (samples.length > 24000) samples.splice(0, 4000);
  }
  if (!seed && taskId !== 'leader' && (ev.chunk || ev.kind === 'tool')) burst(taskId, false, Math.min(6, 1 + (len / 120 | 0)));
  if (!seed && taskId === 'leader') coreAct = Date.now();
}

// 任务 / 编排状态的变化 → 遥测 + 仪式感（派发、交付、通过）
function diffRun(run) {
  if (lastRunStatus && lastRunStatus !== run.status) {
    const M = { running: `拆分完成：${run.tasks.length} 个任务`, summarizing: '全部任务结束，组长开始汇总', done: '编排完成 ✓', failed: `编排失败：${run.error ?? ''}`, cancelled: '编排已取消' };
    if (M[run.status]) pushLog('组长', M[run.status], run.status === 'failed' ? '✗' : '✓', run.status === 'failed' ? 'err' : '');
    if (run.status === 'done') coreFlash = 1.4;
  }
  lastRunStatus = run.status;
  for (const t of run.tasks) {
    const prev = lastTasks.get(t.id);
    if (prev && prev !== t.status) {
      if (t.status === 'running') { pushLog('组长', `派发 ${t.id}「${t.title}」→ ${short(t.assignee)}`, '→'); coreFlash = Math.max(coreFlash, 1.1); sendQueue(t.id, P.orange, 2); }
      if (t.status === 'review') { pushLog(short(t.assignee), `交付 ${t.id}，等组长审查`, '✓'); burst(t.id, false, 60, P.navy); }
      if (t.status === 'done') { sendQueue(t.id, P.green, 4); flashRow(t.id); }
      if (t.status === 'done') { pushLog('组长', `通过 ${t.id}${t.worktree === null && S.run?.git ? '，已合并到集成分支' : ''}`, '✓'); coreFlash = 1.25; }
      if (t.status === 'pending' && prev === 'review') pushLog('组长', `${t.id} 返工（第 ${t.rounds} 轮）`, '↻');
      if (t.status === 'failed') pushLog('组长', `${t.id} 失败${t.note ? `：${t.note}` : ''}`, '✗', 'err');
      if (t.status === 'skipped') pushLog('组长', `跳过 ${t.id}`, '○');
    }
  }
  lastTasks = new Map(run.tasks.map(t => [t.id, t.status]));
}

// ───── 成员状态 ─────
function agentState(id) {
  const a = agentOf(id);
  if (!a.enabled) return { kind: 'off', label: '未启用' };
  if (!a.available) return { kind: 'off', label: '找不到命令' };
  const run = S.run, inRun = !!run?.memberIds.includes(id);
  const tasks = inRun ? run.tasks.filter(t => t.assignee === id) : [];
  const running = tasks.filter(t => t.status === 'running');
  const waitT = running.find(t => t.waitUntil) ?? tasks.find(t => t.status === 'pending' && t.waitUntil);
  if (a.blocked || waitT) return { kind: 'quota', until: a.blocked?.until ?? waitT.waitUntil, hard: a.blocked ? a.blocked.hard : true, tasks, running };
  if (running.length && isActive(run)) return { kind: 'run', tasks, running };
  if (tasks.some(t => t.status === 'review') && isActive(run)) return { kind: 'review', tasks, running };
  return { kind: inRun ? 'idle' : 'spare', tasks, running };
}
const ST_TEXT = { run: '执行中', quota: '额度等待', review: '待审查', idle: '待命', spare: '未编入', empty: '空位' };

function leaderState() {
  const run = S.run;
  if (!run) return { text: '待命', busy: false };
  if (run.leaderWaitUntil) return { text: `额度等待 ${mmss(run.leaderWaitUntil - Date.now())}`, busy: false, quota: true };
  const M = { planning: '规划中', summarizing: '汇总中', done: '编排完成', failed: '编排失败', cancelled: '已取消', interrupted: '已中断' };
  if (M[run.status]) return { text: M[run.status], busy: ['planning', 'summarizing'].includes(run.status) };
  if (run.tasks.some(t => t.status === 'review')) return { text: '审查中', busy: true };
  return { text: '监控进度', busy: Date.now() - coreAct < 3000 };
}

// 卡片顺序：组长、本次队员，再排其他 AI
function cardIds() {
  const run = S.run, ids = run ? [run.leaderId, ...run.memberIds] : [];
  for (const a of S.agents) ids.push(a.id);
  return [...new Set(ids)];
}

// ───── 配色：几套图纸预设 + 夜间，存在本机浏览器。画布从 CSS 变量取色 ─────
const THEMES = [
  { id: 'jade', name: '青绿图纸', bg: '#e3ece7', ac: '#1f5a4c' },
  { id: 'paper', name: '蓝图', bg: '#e8eef8', ac: '#2b3d8f' },
  { id: 'sand', name: '米黄', bg: '#eeeae1', ac: '#2f5a48' },
  { id: 'night', name: '夜间', bg: '#08130f', ac: '#6fe0b6' },
];
const P = {};
let FX = .6;
const THEME0 = { id: 'jade', fx: 60, q: 'auto' };
let theme = { ...THEME0 };
try { Object.assign(theme, JSON.parse(localStorage.getItem('hub.theme3') || '{}')); } catch { /* 隐私模式等读不到就用默认 */ }
const rgba = (hex, a) => { const n = parseInt(String(hex).slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };
const AGENT_PAL = ['navy', 'teal', 'orange', 'indigo', 'green', 'slate'];
const agentColor = (id) => P[AGENT_PAL[Math.max(0, S.agents.findIndex(a => a.id === id)) % AGENT_PAL.length]];

function applyTheme() {
  const th = THEMES.find(x => x.id === theme.id) ?? THEMES[0];
  if (th.id === 'jade') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = th.id;
  const cs = getComputedStyle(document.documentElement);
  for (const k of ['paper', 'card', 'card2', 'ink', 'ink2', 'mute', 'faint', 'frame', 'frame2', 'navy', 'blue', 'slate', 'teal', 'orange', 'red', 'green', 'indigo', 'glow1', 'glow2', 'glow3']) P[k] = cs.getPropertyValue(`--${k}`).trim();
  FX = theme.fx / 100;
  document.body.classList.toggle('calm', FX < .05);
  $('#themeSw').innerHTML = THEMES.map(x => `<button data-theme="${x.id}" class="${x.id === th.id ? 'on' : ''}" style="background:${x.bg};color:${x.ac}">${x.name}</button>`).join('');
  $('#bgFx').value = theme.fx;
  $('#quality').value = theme.q;
  $('#cards').dataset.key = ''; // 卡片里的 SVG 颜色要重画
  gridTile();
  staticSig = ''; G.dirty = true;
  setQuality();
  try { localStorage.setItem('hub.theme3', JSON.stringify(theme)); } catch { /* 存不了就只在本次生效 */ }
}
$('#btnTheme').addEventListener('click', (e) => { e.stopPropagation(); $('#themeBox').hidden = !$('#themeBox').hidden; });
$('#themeBox').addEventListener('click', (e) => {
  e.stopPropagation();
  const b = e.target.closest('[data-theme]');
  if (b) { theme.id = b.dataset.theme; applyTheme(); panels(); }
  if (e.target.id === 'themeReset') { theme = { ...THEME0 }; qs.auto = 0; applyTheme(); panels(); }
});
$('#bgFx').addEventListener('input', (e) => { theme.fx = +e.target.value; applyTheme(); });
$('#quality').addEventListener('change', (e) => { theme.q = e.target.value; qs.auto = 0; applyTheme(); });
document.addEventListener('click', () => { $('#themeBox').hidden = true; });

// 侧栏收起 / 展开 / 拖动改宽度（存本机，双击恢复默认）
function setSide(open) {
  document.body.classList.toggle('noside', !open);
  $('#sideToggle').title = open ? '收起侧栏（Ctrl+B）' : '展开侧栏（Ctrl+B）';
  try { localStorage.setItem('hub.side', open ? '1' : '0'); } catch { /* 忽略 */ }
  G.dirty = true;
}
$('#sideToggle').addEventListener('click', () => setSide(document.body.classList.contains('noside')));
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') { e.preventDefault(); setSide(document.body.classList.contains('noside')); }
});
const setSideW = (w) => { if (w) document.documentElement.style.setProperty('--sideW', `${w}px`); else document.documentElement.style.removeProperty('--sideW'); };
try { setSideW(+localStorage.getItem('hub.sideW') || 0); } catch { /* 忽略 */ }
$('#sideDrag').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const drag = e.currentTarget, x0 = e.clientX, w0 = $('#side').getBoundingClientRect().width;
  drag.setPointerCapture(e.pointerId);
  document.body.classList.add('dragging');
  let w = w0;
  const move = (ev) => { w = Math.round(Math.max(180, Math.min(520, w0 + ev.clientX - x0))); setSideW(w); };
  const up = () => {
    document.body.classList.remove('dragging');
    drag.removeEventListener('pointermove', move); drag.removeEventListener('pointerup', up); drag.removeEventListener('pointercancel', up);
    try { localStorage.setItem('hub.sideW', String(w)); } catch { /* 忽略 */ }
    G.dirty = true;
  };
  drag.addEventListener('pointermove', move); drag.addEventListener('pointerup', up); drag.addEventListener('pointercancel', up);
});
$('#sideDrag').addEventListener('dblclick', () => { setSideW(0); try { localStorage.removeItem('hub.sideW'); } catch { /* 忽略 */ } G.dirty = true; });
try { if (localStorage.getItem('hub.side') === '0') setSide(false); } catch { /* 忽略 */ }

// ───── Tokens：记账值来自服务端（每轮结束更新），本轮进行中的输出按流式字数估算。输入 / 输出分开记 ─────
function tokOf(obj, taskId) {
  const pend = (live[taskId]?.chars ?? 0) / 3, i = obj?.in ?? 0, o = (obj?.out ?? 0) + pend;
  return { n: i + o, in: i, out: o, est: !!obj?.est || pend > 0 };
}
function tokens() {
  const run = S.run, by = {};
  if (!run) return { leader: { n: 0, in: 0, out: 0 }, by, total: 0, inT: 0, outT: 0, est: false };
  const leader = tokOf(run.leaderTokens, 'leader');
  let inT = leader.in, outT = leader.out, est = leader.est;
  for (const id of run.memberIds) by[id] = { n: 0, in: 0, out: 0, est: false };
  for (const t of run.tasks) {
    const k = tokOf(t.tokens, t.id), b = (by[t.assignee] ??= { n: 0, in: 0, out: 0, est: false });
    b.n += k.n; b.in += k.in; b.out += k.out; b.est ||= k.est;
    inT += k.in; outT += k.out; est ||= k.est;
  }
  return { leader, by, total: inT + outT, inT, outT, est };
}

// ───── 任务晶格：一束闭合的 3D 丝带（WebGL 管状渲染），按编排阶段在四种形态间变形 ─────
// 绕柱 = 规划，球壳 = 并行执行，扁环 = 审查 / 汇总，开环 = 完成。橙色执行带的条数跟随进行中的任务数；
// 丝带上流动的光点跟随吞吐，派发 / 通过时整束外扩并放出冲击波。画布铺满中部整行，晶格居中在左右两列之间
const FORMS = [
  { name: '绕柱', what: '组长规划中：丝带缠绕成柱，任务尚未展开' },
  { name: '球壳', what: '队员并行执行：丝带在两极汇合，晶格闭合' },
  { name: '扁环', what: '组长审查与汇总：晶格压扁收拢，逐条核对' },
  { name: '开环', what: '编排完成：晶格展开成环，产出流出面板' },
];
const cv = $('#core'), g = cv.getContext('2d'), glc = $('#gl'), wrap = $('#lat');
let W = 0, H = 0, CX = 0, CY = 0, LR = 0, PRX = 0, PRY = 0, dpr = 1, VW = 0, VH = 0, MM = 20;

const NS = 56, NP = 160, CORE_N = 15, D = 3.6;
const rnd = (i, k) => { const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453; return x - Math.floor(x); };
const strands = Array.from({ length: NS }, (_, i) => ({
  i, a: rnd(i, 1) * 6.2832, b: (rnd(i, 2) * 2 - 1) * 1.38, ph: rnd(i, 3) * 6.2832,
  y: -1 + 2 * (((i * 37) % NS) + .5) / NS, k: 2 + (i % 3), wob: rnd(i, 4) * 6.2832, dr: (rnd(i, 5) - .5) * .5,
}));

// 形态公式：JS 版只算少量锚点（流出丝带的起点、标注引线），和着色器里的 formPt / world 保持一致
function formPt(f, s, u, t, out) {
  const th = u * 6.2832 + s.ph;
  if (f === 0) {
    const r = .42 + .05 * Math.sin(th * 3 + s.wob + t * .8);
    out[0] = r * Math.cos(th); out[1] = s.y * 1.1 + .07 * Math.sin(th * 2 + s.wob + t * .6); out[2] = r * Math.sin(th);
    return;
  }
  if (f === 3) {
    const phi = s.ph * 3 + u * 6.2832 * s.k + t * s.dr * 2, rr = 1.12 + .2 * Math.cos(phi);
    out[0] = rr * Math.cos(th); out[1] = .22 * Math.sin(phi); out[2] = rr * Math.sin(th);
    return;
  }
  const flat = f === 2, b = (flat ? s.b * .26 : s.b) + .12 * Math.sin(t * .35 + s.ph), a = s.a + t * s.dr * .4;
  const cx = Math.cos(th), cz = Math.sin(th), y1 = -cz * Math.sin(b), z1 = cz * Math.cos(b), ca = Math.cos(a), sa = Math.sin(a);
  out[0] = cx * ca + z1 * sa; out[1] = y1; out[2] = -cx * sa + z1 * ca;
  if (flat) { out[0] *= 1.34; out[1] *= .55; out[2] *= 1.34; }
}
const A3 = [0, 0, 0], B3 = [0, 0, 0];
const strandMix = (s, raw) => { const v = Math.min(1, Math.max(0, raw * 1.6 - s.i / NS * .6)); return v * v * (3 - 2 * v); };
function place(s, u, st, out) { // → 屏幕像素 x, y + 深度 z
  formPt(st.from, s, u, st.t, A3); formPt(st.to, s, u, st.t, B3);
  const m = strandMix(s, st.raw), k = st.amp * (1 + st.wob * (s.i < st.nBand ? 3 : 1) * Math.sin(u * 18.85 + st.t * 3 + s.ph));
  const x = (A3[0] + (B3[0] - A3[0]) * m) * k, y = (A3[1] + (B3[1] - A3[1]) * m) * k, z = (A3[2] + (B3[2] - A3[2]) * m) * k;
  const x1 = x * st.cr + z * st.sr, z1 = -x * st.sr + z * st.cr, y2 = y * st.ct - z1 * st.st, z2 = y * st.st + z1 * st.ct, sc = st.scale * D / (D + z2);
  out[0] = CX + x1 * sc; out[1] = CY + y2 * sc; out[2] = z2;
}

const VS = `#version 300 es
precision highp float;
in float a_u; in float a_side; in vec4 a_s; in vec4 a_t;   // a_s = a, b, ph, y；a_t = k, wob, dr, idx
uniform float u_from, u_to, u_raw, u_time, u_scale, u_amp, u_wob, u_nBand, u_nCore, u_n, u_width;
uniform vec4 u_rt; uniform vec2 u_center, u_res;
out float v_side, v_light, v_depth, v_u, v_ph; flat out int v_role;
const float D = ${D.toFixed(1)};
vec3 formPt(float f, float u) {
  float th = u * 6.2832 + a_s.z;
  if (f < .5) { float r = .42 + .05 * sin(th * 3. + a_t.y + u_time * .8); return vec3(r * cos(th), a_s.w * 1.1 + .07 * sin(th * 2. + a_t.y + u_time * .6), r * sin(th)); }
  if (f > 2.5) { float phi = a_s.z * 3. + u * 6.2832 * a_t.x + u_time * a_t.z * 2.; float rr = 1.12 + .2 * cos(phi); return vec3(rr * cos(th), .22 * sin(phi), rr * sin(th)); }
  bool fl = f > 1.5;
  float b = (fl ? a_s.y * .26 : a_s.y) + .12 * sin(u_time * .35 + a_s.z), a = a_s.x + u_time * a_t.z * .4;
  float cx = cos(th), cz = sin(th), y1 = -cz * sin(b), z1 = cz * cos(b), ca = cos(a), sa = sin(a);
  vec3 p = vec3(cx * ca + z1 * sa, y1, -cx * sa + z1 * ca);
  return fl ? p * vec3(1.34, .55, 1.34) : p;
}
vec3 world(float u, float m, float band) {
  vec3 p = mix(formPt(u_from, u), formPt(u_to, u), m);
  return p * u_amp * (1. + u_wob * (band > .5 ? 3. : 1.) * sin(u * 18.85 + u_time * 3. + a_s.z));
}
vec3 view(vec3 p) { float x1 = p.x * u_rt.x + p.z * u_rt.y, z1 = -p.x * u_rt.y + p.z * u_rt.x; return vec3(x1, p.y * u_rt.z - z1 * u_rt.w, p.y * u_rt.w + z1 * u_rt.z); }
vec2 scr(vec3 q) { return u_center + q.xy * (u_scale * D / (D + q.z)); }
void main() {
  float idx = a_t.w;
  int role = idx < u_nBand ? 2 : idx < u_nBand + u_nCore ? 1 : 0;   // 0 环绕 1 主线 2 执行带
  float band = role == 2 ? 1. : 0.;
  float v = clamp(u_raw * 1.6 - idx / u_n * .6, 0., 1.), m = v * v * (3. - 2. * v);
  vec3 w0 = world(a_u, m, band), w1 = world(a_u + .004, m, band);
  vec3 q0 = view(w0);
  vec2 p0 = scr(q0), p1 = scr(view(w1));
  vec2 tg = normalize(p1 - p0 + vec2(1e-5)), nrm = vec2(-tg.y, tg.x);
  float wpx = u_width * D / (D + q0.z) * (role == 2 ? 1.3 : role == 1 ? 1.1 : .85);
  vec2 p = p0 + nrm * a_side * wpx * .5;
  gl_Position = vec4(p.x / u_res.x * 2. - 1., 1. - p.y / u_res.y * 2., q0.z / 3., 1.);
  bool col = u_from < .5 && u_to < .5;
  vec3 n = normalize(view(col ? vec3(w0.x, 0., w0.z) : w0) + vec3(1e-5));
  v_light = .3 + .7 * max(dot(n, normalize(vec3(-.45, -.6, -.66))), 0.);
  v_side = a_side; v_depth = clamp((q0.z + 1.3) / 2.6, 0., 1.); v_u = a_u; v_ph = a_s.z; v_role = role;
}`;
const FS = `#version 300 es
precision highp float;
in float v_side, v_light, v_depth, v_u, v_ph; flat in int v_role;
uniform vec3 u_c0, u_c1, u_c2, u_bg, u_pc;
uniform float u_time, u_pulse, u_glow, u_fade;
out vec4 o;
void main() {
  float e = abs(v_side), tube = 1. - e * e;
  vec3 base = v_role == 2 ? u_c2 : v_role == 1 ? u_c1 : u_c0;
  float sp = v_role == 2 ? 1.5 : .42;
  float pl = smoothstep(.95, 1., fract(v_u * 2. + v_ph - u_time * sp)) * u_pulse * (v_role == 2 ? 1. : .6);
  if (u_glow > 0.) { vec3 gc = (base * .7 + u_pc * pl * 2.) * u_glow * (1. - e); o = vec4(gc, max(gc.r, max(gc.g, gc.b))); return; }
  vec3 c = base * (.45 + .75 * tube * v_light) + vec3(pow(tube, 6.) * .38 * v_light);
  c = mix(c, u_pc, pl);
  c = mix(c, u_bg, smoothstep(.58, 1., e) * (1. - pl));   // 丝带边缘描一圈底色，层层叠起来像管子
  c = mix(c, u_bg, v_depth * u_fade);                     // 远处的丝带淡出
  o = vec4(c, 1.);
}`;

function initGL() {
  const gl = glc.getContext('webgl2', { antialias: true, alpha: true, premultipliedAlpha: true });
  if (!gl) return null;
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  const per = 10, data = new Float32Array(NS * (NP + 1) * 2 * per), idx = new Uint16Array(NS * NP * 6);
  let o = 0, n = 0;
  for (const s of strands) {
    const v0 = s.i * (NP + 1) * 2;
    for (let j = 0; j <= NP; j++) for (const side of [-1, 1]) { data.set([j / NP, side, s.a, s.b, s.ph, s.y, s.k, s.wob, s.dr, s.i], o); o += per; }
    for (let j = 0; j < NP; j++) { const a = v0 + j * 2; idx.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], n); n += 6; }
  }
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
  for (const [name, size, off] of [['a_u', 1, 0], ['a_side', 1, 1], ['a_s', 4, 2], ['a_t', 4, 6]]) {
    const l = gl.getAttribLocation(prog, name);
    gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, size, gl.FLOAT, false, per * 4, off * 4);
  }
  const U = {};
  for (let i = 0, c = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS); i < c; i++) { const nm = gl.getActiveUniform(prog, i).name; U[nm] = gl.getUniformLocation(prog, nm); }
  return { gl, prog, vao, count: idx.length, U };
}
// 粒子云：环绕晶格的轨道尘埃 + 从外圈螺旋落进晶格的数据流（吞吐越大点亮越多、落得越快）
const NDUST = 1700, NFLOW = 1500;
const PVS = `#version 300 es
precision highp float;
in vec4 a_p; in vec2 a_q;   // a_p = 半径, 角度, 倾角 / 高度, 相位；a_q = 速度, 种类
uniform float u_time, u_heat, u_rate, u_scale, u_amp, u_ss, u_flash;
uniform vec4 u_rt; uniform vec2 u_center, u_res;
out float v_a, v_k;
const float D = ${D.toFixed(1)};
vec3 view(vec3 p) { float x1 = p.x * u_rt.x + p.z * u_rt.y, z1 = -p.x * u_rt.y + p.z * u_rt.x; return vec3(x1, p.y * u_rt.z - z1 * u_rt.w, p.y * u_rt.w + z1 * u_rt.z); }
void main() {
  vec3 p; float a;
  if (a_q.y < .5) {
    float th = a_p.y + u_time * a_q.x * (.18 + .5 * u_heat), r = a_p.x * (1. + u_flash * .3);
    float ci = cos(a_p.z), si = sin(a_p.z);
    p = vec3(r * cos(th), -r * sin(th) * si + .05 * sin(u_time * 1.3 + a_p.w * 6.28), r * sin(th) * ci);
    a = .5 + .3 * sin(u_time * 2. + a_p.w * 30.);
  } else {
    float pr = fract(u_time * a_q.x * (.05 + .22 * u_rate) + a_p.w);
    float r = mix(2.6, .9, pr), th = a_p.y + pr * 5.5;
    p = vec3(r * cos(th), (1. - pr) * a_p.z, r * sin(th));
    a = smoothstep(0., .18, pr) * (1. - smoothstep(.8, 1., pr)) * step(a_p.w, .2 + .8 * u_rate);
  }
  vec3 q = view(p * u_amp);
  float k = D / (D + q.z);
  vec2 sp = u_center + q.xy * (u_scale * k);
  gl_Position = vec4(sp.x / u_res.x * 2. - 1., 1. - sp.y / u_res.y * 2., q.z / 3., 1.);
  gl_PointSize = (a_q.y < .5 ? 2.4 : 3.4) * u_ss * k;
  v_a = a * (1. - clamp((q.z + 1.6) / 3.2, 0., 1.) * .55); v_k = a_q.y;
}`;
const PFS = `#version 300 es
precision highp float;
in float v_a, v_k; uniform vec3 u_cd, u_cf; out vec4 o;
void main() {
  float r = length(gl_PointCoord - .5);
  if (r > .5) discard;
  float a = smoothstep(.5, .12, r) * v_a;
  vec3 c = v_k < .5 ? u_cd : u_cf;
  o = vec4(c * a, a);
}`;
function initParticles(gl) {
  const sh = (type, src) => { const x = gl.createShader(type); gl.shaderSource(x, src); gl.compileShader(x); if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x)); return x; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, PVS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, PFS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  const n = NDUST + NFLOW, data = new Float32Array(n * 6);
  for (let i = 0; i < n; i++) {
    const dust = i < NDUST, r = Math.random;
    data.set(dust
      ? [1.25 + Math.pow(r(), .7) * .95, r() * 6.2832, (r() - .5) * .5 + (r() < .3 ? 1.1 : 0), r(), .3 + r() * .9, 0]
      : [0, r() * 6.2832, (r() - .5) * 1.6, r(), .6 + r() * .8, 1], i * 6);
  }
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  for (const [name, size, off] of [['a_p', 4, 0], ['a_q', 2, 4]]) {
    const l = gl.getAttribLocation(prog, name);
    gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, size, gl.FLOAT, false, 24, off * 4);
  }
  const U = {};
  for (let i = 0, c = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS); i < c; i++) { const nm = gl.getActiveUniform(prog, i).name; U[nm] = gl.getUniformLocation(prog, nm); }
  return { prog, vao, n, U };
}
let GLR = null;
try { GLR = initGL(); GLR.pts = initParticles(GLR.gl); } catch (err) { console.error('WebGL 初始化失败，改用 2D：', err); GLR = null; }
const hex3 = (h) => { const n = parseInt(String(h).slice(1), 16); return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };

function drawGL(st) {
  const { gl, prog, vao, count, U } = GLR, night = theme.id === 'night';
  gl.viewport(0, 0, glc.width, glc.height);
  gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.useProgram(prog); gl.bindVertexArray(vao);
  const f1 = { u_from: st.from, u_to: st.to, u_raw: st.raw, u_time: st.t, u_scale: st.scale, u_amp: st.amp, u_wob: st.wob, u_nBand: st.nBand, u_nCore: CORE_N, u_n: NS, u_pulse: st.pulse, u_fade: night ? .62 : .5 };
  for (const [k, v] of Object.entries(f1)) gl.uniform1f(U[k], v);
  gl.uniform4f(U.u_rt, st.cr, st.sr, st.ct, st.st);
  gl.uniform2f(U.u_center, CX, CY); gl.uniform2f(U.u_res, W, H);
  gl.uniform3fv(U.u_c0, hex3(P.blue)); gl.uniform3fv(U.u_c1, hex3(P.navy)); gl.uniform3fv(U.u_c2, hex3(st.quota ? P.red : P.orange));
  gl.uniform3fv(U.u_bg, hex3(P.glow1 || P.card)); gl.uniform3fv(U.u_pc, night ? [.75, 1, 1] : hex3(P.teal).map(v => v * .55 + .45));
  const width = Math.max(3.5, LR / 27);
  if (night) { // 辉光：更宽、加法混合、不写深度，垫在丝带下面
    gl.disable(gl.DEPTH_TEST); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    gl.uniform1f(U.u_width, width * 3.4); gl.uniform1f(U.u_glow, .13 + .1 * st.heat);
    gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_SHORT, 0);
  }
  gl.disable(gl.BLEND); gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS);
  gl.uniform1f(U.u_width, width); gl.uniform1f(U.u_glow, 0);
  gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_SHORT, 0);
  // 粒子：参与深度测试（被丝带挡住），不写深度，预乘 alpha 混合；夜间用加法更亮
  const pp = GLR.pts;
  gl.useProgram(pp.prog); gl.bindVertexArray(pp.vao);
  gl.depthMask(false); gl.enable(gl.BLEND);
  if (night) gl.blendFunc(gl.ONE, gl.ONE); else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  for (const [k, v] of Object.entries({ u_time: st.t, u_heat: st.heat, u_rate: st.rate, u_scale: st.scale, u_amp: st.amp, u_ss: glc.width / W, u_flash: Math.max(0, coreFlash - .3) })) gl.uniform1f(pp.U[k], v);
  gl.uniform4f(pp.U.u_rt, st.cr, st.sr, st.ct, st.st);
  gl.uniform2f(pp.U.u_center, CX, CY); gl.uniform2f(pp.U.u_res, W, H);
  gl.uniform3fv(pp.U.u_cd, night ? [.55, .68, 1] : hex3(P.blue));
  gl.uniform3fv(pp.U.u_cf, hex3(st.quota ? P.red : P.teal));
  const qp = QUAL[qLevel].pts;
  gl.drawArrays(gl.POINTS, 0, NDUST * qp | 0); gl.drawArrays(gl.POINTS, NDUST, NFLOW * qp | 0);
  gl.depthMask(true); gl.disable(gl.BLEND);
}
const PT = [0, 0, 0];
function draw2D(st) { // 退路：没有 WebGL2 时画线框
  const colOf = (i) => (i < st.nBand ? (st.quota ? P.red : P.orange) : i < st.nBand + CORE_N ? P.navy : P.blue);
  g.lineWidth = Math.max(1, LR / 120);
  for (const s of strands) {
    g.strokeStyle = colOf(s.i); g.globalAlpha = .55; g.beginPath();
    for (let j = 0; j <= 64; j++) { place(s, j / 64, st, PT); j ? g.lineTo(PT[0], PT[1]) : g.moveTo(PT[0], PT[1]); }
    g.stroke();
  }
  g.globalAlpha = 1;
}

let form = { from: 0, to: 0, t0: 0 };
function targetForm() {
  const run = S.run;
  if (!run) return null; // 新对话：四种形态轮播
  if (run.status === 'planning') return 0;
  if (run.status === 'summarizing') return 2;
  if (run.status === 'done') return 3;
  if (!isActive(run)) return 0;
  return run.tasks.some(t => t.status === 'review') && !run.tasks.some(t => t.status === 'running') ? 2 : 1;
}
const curForm = () => form.to;
const quotaNow = () => !!S.run && (!!S.run.leaderWaitUntil || S.run.memberIds.some(id => agentState(id).kind === 'quota'));

// ───── 图纸布局快照：走线和粒子都用页面坐标。布局变了（或每 1.5 秒）量一次，帧循环里不读 DOM ─────
const G = { ok: false, dirty: true, card: [], rows: new Map(), sz: new Map(), pL: [], pR: [], pB: [] };
const LAND = { tool: null, curve: null, ring: null };
const R_ = (el) => { const b = el.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height, cx: (b.left + b.right) / 2, cy: (b.top + b.bottom) / 2 }; };
const snap = (v) => Math.round(v) + .5;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const rr = (a, b) => a + Math.random() * (b - a);
const CHARTS = ['#cTools', '#cReview', '#cCurve', '#cTrace', '#cDag', '#spark'].map(s => $(s));
let cardOrder = [], coRects = [];
const cardIndex = (id) => cardOrder.indexOf(id);
function sizeCanvas(c, w, h, s) { const a = Math.round(w * s), b = Math.round(h * s); if (c.width !== a || c.height !== b) { c.width = a; c.height = b; } }
function measure() {
  dpr = Math.min(2, devicePixelRatio || 1); VW = innerWidth; VH = innerHeight;
  MM = parseFloat(getComputedStyle($('#app')).paddingLeft) || 20;
  G.lat = R_(wrap); G.lc = R_($('#lcol')); G.rc = R_($('#rcol'));
  const cards = [...document.querySelectorAll('#cards .card')];
  cardOrder = cards.map(el => el.dataset.card);
  G.card = cards.map(el => { const r = R_(el), b = el.querySelector('.bars')?.getBoundingClientRect(); r.ey = b?.height ? b.top + b.height * .55 : r.cy; return r; });
  for (const [k, sel] of [['tools', '#tools'], ['queue', '#queueBox'], ['review', '#reviewBox'], ['curve', '#curveBox'], ['trace', '#traceBox'], ['log', '#logBox'], ['led', '#ledBox'], ['tok', '#hOut'], ['cmd', '#cmd']]) G[k] = R_($(sel));
  G.stg = [...document.querySelectorAll('#pipe .stg')].map(R_);
  G.rows = new Map([...document.querySelectorAll('#queue tr[data-task]')].map(tr => { const b = tr.getBoundingClientRect(); return [tr.dataset.task, b.top + b.height / 2]; }));
  for (const c of CHARTS) { const p = c.parentElement; G.sz.set(c, [p.clientWidth, p.clientHeight]); }
  G.cvTools = R_($('#cTools')); G.cvCurve = R_($('#cCurve'));
  const rv = R_($('#cReview')), dw = Math.min(rv.h - 6, rv.w * .38);
  LAND.ring = [rv.r - dw / 2, rv.cy];
  G.gap = parseFloat(getComputedStyle($('#main')).rowGap) || 8;
  W = G.lat.w; H = G.lat.h;
  const ui = $('#latui');
  G.ui = R_(ui);
  const l = G.ui.l - G.lat.l, r = G.ui.r - G.lat.l, freeW = r - l;
  ui.classList.toggle('tight', freeW < 430 || H < 300);
  CX = (l + r) / 2; CY = H / 2 - 8;
  const lv = Math.min(CY - 14, H - CY - 58) / 1.18, lh = (freeW / 2 + 10) / 1.62;
  LR = clamp(Math.min(lv, lh), 46, 330);
  PRX = LR * 1.62; PRY = Math.max(40, Math.min(LR * 1.32, CY - 10, H - CY - 36));
  const px = G.lat.l + CX, py = G.lat.t + CY, n = Math.max(1, G.card.length);
  G.c = [px, py];
  // 接口环上的焊盘：左边对着成员卡，右边对着队列 / 审查 / 曲线，下边对着底部三联，上边对着顶栏
  G.pL = G.card.map((_, k) => { const dy = (k - (n - 1) / 2) * PRY * Math.min(.34, 1.3 / n); return [px - PRX * Math.sqrt(1 - (dy / PRY) ** 2), py + dy]; });
  G.pR = [0, 1, 2].map(j => { const dy = (j - 1) * PRY * .46; return [px + PRX * Math.sqrt(1 - (dy / PRY) ** 2), py + dy]; });
  G.pB = [1, 2, 4, 5].map(i => { const dx = clamp(l + i * (freeW / 6) - CX, -PRX * .95, PRX * .95); return [px + dx, py + PRY * Math.sqrt(1 - (dx / PRX) ** 2)]; });
  G.pT = [px, py - PRY];
  coRects = [...ui.querySelectorAll('.co[data-anchor]')].filter(el => el.offsetParent).map(el => { const b = R_(el); return { x: b.l - G.lat.l, y: b.t - G.lat.t, w: b.w, h: b.h, anchor: +el.dataset.anchor }; });
  sizeCanvas(cv, W, H, dpr);
  sizeGL();
  sizeCanvas(fxc, VW, VH, dpr);
  G.ok = W > 0 && H > 0; G.dirty = false;
  if (G.ok) drawStatic();
}
addEventListener('resize', () => { G.dirty = true; });
new ResizeObserver(() => { G.dirty = true; }).observe($('#main'));

// 画质：超采样倍数 + 粒子数量。自动档根据实际帧间隔降级（掉帧多就降一档，不会自己升回去）
const QUAL = [
  { ss: () => Math.max(2, dpr), pts: 1 },
  { ss: () => Math.max(1.25, dpr), pts: .6 },
  { ss: () => Math.max(1, dpr * .75), pts: .35 },
];
let qLevel = 0;
const qs = { n: 0, slow: 0, min: 1, t: 0, auto: 0, hold: performance.now() + 5000 };
function sizeGL() { if (W) sizeCanvas(glc, W, H, QUAL[qLevel].ss()); }
function setQuality() { qLevel = theme.q === 'auto' ? qs.auto : clamp(+theme.q || 0, 0, 2); sizeGL(); }
function qualityTick(now, dt) {
  if (theme.q !== 'auto' || now < qs.hold) return;
  qs.n++; qs.t += dt; qs.min = Math.min(qs.min, dt);
  if (dt > qs.min * 1.6 + .002) qs.slow++;
  if (qs.t < 2.5) return;
  if (qs.slow / qs.n > .18 && qs.auto < 2) { qs.auto++; setQuality(); qs.hold = now + 3000; }
  qs.n = qs.slow = 0; qs.t = 0; qs.min = 1;
}

// ───── 背景：漂移的毫米网格（平铺图 + 合成器动画）、静态图框 / 标尺 / 套准标 / 走线（布局变了才重画） ─────
const bgc = $('#bg'), bgx = bgc.getContext('2d'), fxc = $('#fx'), fxg = fxc.getContext('2d');
function gridTile() {
  const s = Math.min(2, devicePixelRatio || 1), T = Math.round(200 * s), c = document.createElement('canvas');
  c.width = c.height = T;
  const x = c.getContext('2d'), px = (v) => Math.round(v * s) + .5;
  const lines = (fn, a) => { x.beginPath(); for (let k = 0; k < 25; k++) if (fn(k)) { x.moveTo(px(k * 8), 0); x.lineTo(px(k * 8), T); x.moveTo(0, px(k * 8)); x.lineTo(T, px(k * 8)); } x.strokeStyle = rgba(P.frame, a); x.lineWidth = 1; x.stroke(); };
  const night = theme.id === 'night';
  lines(k => k % 5, night ? .1 : .065); lines(k => k && k % 5 === 0, night ? .17 : .12); lines(k => k === 0, night ? .3 : .22);
  x.beginPath(); // 粗网格交点的小十字（瓦片四角拼起来）
  const L = Math.round(4 * s);
  for (const [cx, cy] of [[0, 0], [T, 0], [0, T], [T, T]]) { x.moveTo(cx - L, cy + .5); x.lineTo(cx + L, cy + .5); x.moveTo(cx + .5, cy - L); x.lineTo(cx + .5, cy + L); }
  x.strokeStyle = rgba(P.frame, night ? .6 : .5); x.stroke();
  $('#grid').style.backgroundImage = `url(${c.toDataURL()})`;
}
const laneY = (j) => G.trace.t - G.gap * (.22 + .2 * j);
// 走线都是横平竖直的折线 [[x, y], ...]（页面坐标）
const route = {
  cardLat(k) { const c = G.card[k], p = G.pL[k], xb = G.lc.r + 10 + (G.card.length - 1 - k) * 6; return [[c.r, c.ey], [xb, c.ey], [xb, p[1]], p]; },
  latQ(y) { const p = G.pR[0], q = G.queue, xb = G.rc.l - 12; return [p, [xb, p[1]], [xb, y], [q.l + 14, y]]; },
  latRev() { const p = G.pR[1], q = G.review, xb = G.rc.l - 19, e = [p, [xb, p[1]], [xb, q.cy], [q.l, q.cy]]; if (LAND.ring) e.push([LAND.ring[0], q.cy]); return e; },
  latCur(tip) { const p = G.pR[2], q = G.curve, xb = G.rc.l - 26, e = [p, [xb, p[1]], [xb, q.cy], [q.l, q.cy]]; if (tip) e.push([tip[0], q.cy], [tip[0], tip[1]]); return e; },
  cardTool(k, tip) {
    const c = G.card[k], tl = G.tools, xl = G.lc.l - 3 - k * 2.4, e = [[c.l, c.ey], [xl, c.ey], [xl, tl.cy], [tl.l, tl.cy]];
    if (tip) e.push([tip[0], tl.cy], [tip[0], tip[1]]);
    return e;
  },
  latTok() { const p = G.pT, y = G.lat.t - G.gap * .5, tk = G.tok; return [p, [p[0], y], [tk.cx, y], [tk.cx, tk.b]]; },
  latPipe(i) { const p = G.pT, y = G.lat.t - G.gap * .5 - 2, s = G.stg[i]; return s ? [p, [p[0], y], [s.cx, y], [s.cx, s.b]] : null; },
  latBot(j, x, yEnd) { const p = G.pB[j], ly = laneY(j); return [p, [p[0], ly], [x, ly], [x, yEnd]]; },
  cmdLat() { const c = G.cmd, x = (G.trace.r + G.log.l) / 2, ly = laneY(3), p = G.pB[3]; return [[x, c.t], [x, ly], [p[0], ly], p]; },
};
const rev = (pts) => pts.slice().reverse();
// 起点 / 终点落在卡片里，粒子像是从卡片的活动里冒出来的
const withStart = (pts, c) => [[c.l + c.w * rr(.42, .72), c.ey], ...pts];
const withEnd = (pts, c) => [...pts, [c.l + c.w * rr(.42, .72), c.ey]];
let TR = [], staticSig = '';
function staticRoutes() {
  const out = [];
  cardOrder.forEach((id, k) => {
    out.push({ pts: route.cardLat(k), col: agentColor(id), k });
    out.push({ pts: route.cardTool(k), col: agentColor(id), k, tool: true });
  });
  out.push({ pts: route.latQ(G.queue.t + G.queue.h * .45), col: P.teal });
  out.push({ pts: route.latRev(), col: P.green });
  out.push({ pts: route.latCur(null), col: P.orange });
  out.push({ pts: route.latTok(), col: P.navy });
  G.stg.forEach((_, i) => out.push({ pts: route.latPipe(i), col: P.navy, faint: true }));
  out.push({ pts: route.latBot(0, G.trace.cx, G.trace.t + 2), col: P.teal });
  out.push({ pts: route.latBot(1, G.log.cx, G.log.t + 2), col: P.teal });
  out.push({ pts: route.latBot(2, G.led.cx, G.led.t + 2), col: P.green });
  out.push({ pts: route.cmdLat(), col: P.orange });
  return out;
}
function drawStatic() {
  const sig = JSON.stringify([VW, VH, dpr, theme.id, cardOrder, G.card.map(c => [c.l | 0, c.r | 0, c.ey | 0]), G.pL.concat(G.pR, G.pB).map(p => p.map(Math.round)), G.stg.map(s => [s.cx | 0, s.b | 0]),
    [G.queue.t, G.review.cy, G.curve.cy, G.trace.t, G.tools.cy, G.tok.cx, G.cmd.t, G.lc.l, G.rc.l].map(Math.round)]);
  if (sig === staticSig) return;
  staticSig = sig;
  TR = staticRoutes().map(r => ({ ...r, pts: r.pts.map(p => [snap(p[0]), snap(p[1])]) }));
  sizeCanvas(bgc, VW, VH, dpr);
  const x = bgx;
  x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, VW, VH);
  const [px, py] = G.c, night = theme.id === 'night';
  document.body.style.setProperty('--gx', `${px | 0}px`); document.body.style.setProperty('--gy', `${py | 0}px`);
  // 晶格背后的一团底光 + 落地阴影
  const rg = x.createRadialGradient(px, py, 0, px, py, LR * 2.3);
  rg.addColorStop(0, rgba(night ? P.teal : P.blue, night ? .16 : .12)); rg.addColorStop(.55, rgba(P.teal, .05)); rg.addColorStop(1, rgba(P.teal, 0));
  x.fillStyle = rg; x.fillRect(px - LR * 2.3, py - LR * 2.3, LR * 4.6, LR * 4.6);
  if (!night) {
    x.save(); x.translate(px, py + LR * 1.3); x.scale(1, .16);
    const sh = x.createRadialGradient(0, 0, 0, 0, 0, LR * 1.3);
    sh.addColorStop(0, rgba(P.ink, .2)); sh.addColorStop(.6, rgba(P.ink, .06)); sh.addColorStop(1, rgba(P.ink, 0));
    x.fillStyle = sh; x.fillRect(-LR * 1.4, -LR * 1.4, LR * 2.8, LR * 2.8); x.restore();
  }
  // 数据走线：淡淡的铜线 + 拐角过孔 + 两端焊盘
  for (const r of TR) {
    x.strokeStyle = rgba(r.col, r.faint ? .18 : .42); x.lineWidth = 1; x.beginPath();
    r.pts.forEach((p, i) => (i ? x.lineTo(p[0], p[1]) : x.moveTo(p[0], p[1]))); x.stroke();
    x.fillStyle = rgba(r.col, r.faint ? .2 : .45);
    for (let i = 1; i < r.pts.length - 1; i++) x.fillRect(r.pts[i][0] - 1.5, r.pts[i][1] - 1.5, 3, 3);
    for (const p of [r.pts[0], r.pts[r.pts.length - 1]]) { x.beginPath(); x.arc(p[0], p[1], 3, 0, 6.29); x.strokeStyle = rgba(r.col, .6); x.stroke(); x.beginPath(); x.arc(p[0], p[1], 1.1, 0, 6.29); x.fill(); }
  }
  drawFrame(x);
}
function arrow(x, ax, ay, dx, dy, s = 5) { // 以 (ax, ay) 为尖，朝 (dx, dy) 方向
  x.beginPath(); x.moveTo(ax, ay); x.lineTo(ax + dx * s * 1.7 - dy * s * .5, ay + dy * s * 1.7 + dx * s * .5); x.lineTo(ax + dx * s * 1.7 + dy * s * .5, ay + dy * s * 1.7 - dx * s * .5); x.closePath(); x.fill();
}
function drawFrame(x) {
  const m = MM, e = m - 6, ink = P.frame;
  // 四边标尺：每 8px 一小格，40px 中刻度，200px 大刻度带数字
  x.beginPath();
  for (let v = 0; v <= Math.max(VW, VH); v += 8) {
    const len = v % 200 === 0 ? 10 : v % 40 === 0 ? 6 : 3;
    if (v >= m && v <= VW - m) { x.moveTo(v + .5, e); x.lineTo(v + .5, e - len); x.moveTo(v + .5, VH - e); x.lineTo(v + .5, VH - e + len); }
    if (v >= m && v <= VH - m) { x.moveTo(e, v + .5); x.lineTo(e - len, v + .5); x.moveTo(VW - e, v + .5); x.lineTo(VW - e + len, v + .5); }
  }
  x.strokeStyle = rgba(ink, .7); x.lineWidth = 1; x.stroke();
  if (m >= 18) {
    x.fillStyle = rgba(ink, .8); x.font = `7px ${FONT}`; x.textBaseline = 'alphabetic'; x.textAlign = 'left';
    for (let v = 200; v < VW - m - 40; v += 200) if (Math.abs(v - VW / 2) > 110) x.fillText(String(v), v + 2.5, e - 3);
    for (let v = 200; v < VH - m - 6; v += 200) if (Math.abs(v - VH / 2) > 50) { x.save(); x.translate(e - 3, v - 2.5); x.rotate(-Math.PI / 2); x.fillText(String(v), 0, 0); x.restore(); }
  }
  x.strokeStyle = rgba(ink, .85); x.lineWidth = 1.2;
  x.strokeRect(m - 5.5, m - 5.5, VW - 2 * m + 11, VH - 2 * m + 11);
  // 四角套准十字
  const k = (m - 6) / 2, c0 = k + .5;
  x.strokeStyle = rgba(P.red, .9); x.lineWidth = 1;
  for (const [cx, cy] of [[c0, c0], [VW - c0, c0], [c0, VH - c0], [VW - c0, VH - c0]]) {
    x.beginPath(); x.arc(cx, cy, k * .52, 0, 6.29); x.moveTo(cx - k, cy); x.lineTo(cx + k, cy); x.moveTo(cx, cy - k); x.lineTo(cx, cy + k); x.stroke();
  }
  // 图幅尺寸标注
  if (m >= 18) {
    x.strokeStyle = rgba(ink, .8); x.fillStyle = rgba(ink, .9); x.lineWidth = 1;
    const lab = `图幅 ${VW} × ${VH}　比例 1 : 1`;
    x.font = `8px ${FONT}`; x.textAlign = 'center'; x.textBaseline = 'middle';
    const tw = x.measureText(lab).width + 14, y = 3.5, x1 = m + 4, x2 = VW - m - 4, mx = VW / 2;
    x.beginPath(); x.moveTo(x1, y); x.lineTo(mx - tw / 2, y); x.moveTo(mx + tw / 2, y); x.lineTo(x2, y); x.stroke();
    arrow(x, x1, y, 1, 0); arrow(x, x2, y, -1, 0);
    x.fillText(lab, mx, y + .5);
    const xx = 3.5, y1 = m + 4, y2 = VH - m - 4, my = VH / 2, lab2 = `H ${VH}`, tw2 = x.measureText(lab2).width + 12;
    x.beginPath(); x.moveTo(xx, y1); x.lineTo(xx, my - tw2 / 2); x.moveTo(xx, my + tw2 / 2); x.lineTo(xx, y2); x.stroke();
    arrow(x, xx, y1, 0, 1); arrow(x, xx, y2, 0, -1);
    x.save(); x.translate(xx, my); x.rotate(-Math.PI / 2); x.fillText(lab2, 0, .5); x.restore();
  }
}

// 打开应用时扫一遍：光带横扫全屏，经过的网格和走线被点亮。每个窗口只放一次（刷新不重放）
let scanT0 = 0;
try { if (!sessionStorage.getItem('hub.scanned')) { scanT0 = performance.now() + 600; sessionStorage.setItem('hub.scanned', '1'); } } catch { scanT0 = performance.now() + 600; }
const SCAN_MS = 4200;
function drawScan(x, now) {
  if (!scanT0) return;
  const ph = (now - scanT0) / SCAN_MS;
  if (ph < 0) return;
  if (ph >= 1) { scanT0 = 0; return; }
  const e = 1 - (1 - ph) ** 1.6, pos = e * (VW + 400) - 200, fade = Math.min(1, ph * 8, (1 - ph) * 8);
  x.save(); x.globalAlpha = fade;
  x.save(); x.beginPath(); x.rect(pos - 150, 0, 150, VH); x.clip();
  const an = $('#grid').getAnimations?.()[0], p = an ? ((Number(an.currentTime) || 0) % 160000) / 160000 : 0, ox = -400 * p, oy = -200 * p;
  x.beginPath();
  for (let gx = ox + Math.ceil((pos - 150 - ox) / 8) * 8; gx <= pos; gx += 8) { x.moveTo(snap(gx), 0); x.lineTo(snap(gx), VH); }
  for (let gy = oy; gy <= VH; gy += 8) { x.moveTo(pos - 150, snap(gy)); x.lineTo(pos, snap(gy)); }
  x.strokeStyle = rgba(P.teal, .32); x.lineWidth = 1; x.stroke();
  x.lineWidth = 1.6;
  for (const r of TR) { x.strokeStyle = rgba(r.col, .7); x.beginPath(); r.pts.forEach((q, i) => (i ? x.lineTo(q[0], q[1]) : x.moveTo(q[0], q[1]))); x.stroke(); }
  x.restore();
  const gr = x.createLinearGradient(pos - 220, 0, pos, 0);
  gr.addColorStop(0, rgba(P.teal, 0)); gr.addColorStop(1, rgba(P.teal, .16));
  x.fillStyle = gr; x.fillRect(pos - 220, 0, 220, VH);
  x.fillStyle = rgba(P.teal, .75); x.fillRect(pos - 1, 0, 1.5, VH);
  const eh = MM - 6;
  x.fillStyle = rgba(P.paper, .92); x.fillRect(pos - 86, 0, 82, eh - 1);
  x.font = `7px ${FONT}`; x.fillStyle = P.teal; x.textAlign = 'right'; x.textBaseline = 'middle'; x.fillText(`扫描 ▸ X ${Math.round(pos)}`, pos - 7, eh / 2);
  x.restore();
}

// ───── 数据粒子：沿走线流动的小方块（fx 层，页面坐标），到站时有一圈涟漪 ─────
const PTS = [], ripples = [], lastPk = {};
const every = (key, ms) => { const now = performance.now(); if (now - (lastPk[key] ?? 0) < ms) return false; lastPk[key] = now; return true; };
function send(pts, o = {}) {
  if (!G.ok || !pts || document.hidden || FX < .02) return;
  const sp = pts.map(p => [snap(p[0]), snap(p[1])]);
  const cum = [0];
  for (let i = 1; i < sp.length; i++) cum.push(cum[i - 1] + Math.abs(sp[i][0] - sp[i - 1][0]) + Math.abs(sp[i][1] - sp[i - 1][1]));
  const len = cum[cum.length - 1];
  if (len < 4) return;
  const n = o.n || 1, v = o.v || rr(140, 200);
  for (let i = 0; i < n && PTS.length < 500; i++) PTS.push({ p: sp, cum, len, s: -i * (o.gap || 60) * v / 100 - rr(0, 8), v: v * rr(.92, 1.08), tail: o.tail || rr(22, 40), col: o.col || P.teal, sz: o.sz || 1.2, done: false });
}
function at(p, s, out) {
  s = clamp(s, 0, p.len);
  let i = 1;
  while (i < p.cum.length - 1 && p.cum[i] < s) i++;
  const a = p.p[i - 1], b = p.p[i], u = (s - p.cum[i - 1]) / Math.max(1e-6, p.cum[i] - p.cum[i - 1]);
  out[0] = a[0] + (b[0] - a[0]) * u; out[1] = a[1] + (b[1] - a[1]) * u;
}
function trail(x, p, s0, s1) { // 沿折线画 s0..s1 一段
  const o = [0, 0];
  at(p, s0, o); x.moveTo(o[0], o[1]);
  for (let i = 1; i < p.cum.length - 1; i++) if (p.cum[i] > s0 && p.cum[i] < s1) x.lineTo(p.p[i][0], p.p[i][1]);
  at(p, s1, o); x.lineTo(o[0], o[1]);
}
const TMP = [0, 0];
// 每条走线上都有成列的小方点匀速流过（方向 = 数据流向），干活的成员那几条更亮
function drawFlowDots(x, t) {
  x.save(); x.lineCap = 'butt'; x.lineWidth = 2.6; x.setLineDash([2.4, 12]);
  const sp = .4 + .6 * FX;
  TR.forEach((r, i) => {
    let a = r.faint ? .2 : .45;
    if (r.k != null) { const st = agentState(cardOrder[r.k]).kind; a = st === 'run' ? .9 : st === 'review' ? .5 : .14; }
    x.strokeStyle = rgba(r.col, a); x.lineDashOffset = -(t * (30 + (i % 4) * 7) * sp + i * 5);
    x.beginPath(); r.pts.forEach((p, j) => (j ? x.lineTo(p[0], p[1]) : x.moveTo(p[0], p[1]))); x.stroke();
  });
  x.restore();
}
function drawFx(now, dt) {
  const x = fxg;
  x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, VW, VH);
  drawScan(x, now);
  if (FX >= .02) drawFlowDots(x, now / 1000);
  x.lineCap = 'butt';
  for (let i = PTS.length - 1; i >= 0; i--) {
    const q = PTS[i];
    q.s += q.v * dt;
    if (!q.done && q.s >= q.len) { q.done = true; at(q, q.len, TMP); if (ripples.length < 60) ripples.push({ x: TMP[0], y: TMP[1], t0: now, c: q.col }); }
    if (q.s - q.tail > q.len) { PTS.splice(i, 1); continue; }
    if (q.s < 0) continue;
    const s1 = Math.min(q.s, q.len), s0 = Math.max(0, q.s - q.tail);
    if (s1 - s0 < .5) continue;
    x.strokeStyle = rgba(q.col, .3); x.lineWidth = 1.8 * q.sz; x.beginPath(); trail(x, q, s0, s1); x.stroke();
    x.strokeStyle = q.col; x.lineWidth = 2.4 * q.sz; x.beginPath(); trail(x, q, Math.max(s0, s1 - q.tail * .35), s1); x.stroke();
    if (q.s <= q.len) { at(q, s1, TMP); x.fillStyle = rgba(q.col, .22); x.fillRect(TMP[0] - 5, TMP[1] - 5, 10, 10); x.fillStyle = q.col; x.fillRect(TMP[0] - 1.8 * q.sz, TMP[1] - 1.8 * q.sz, 3.6 * q.sz, 3.6 * q.sz); }
  }
  for (let i = ripples.length - 1; i >= 0; i--) {
    const r = ripples[i], u = (now - r.t0) / 520;
    if (u >= 1) { ripples.splice(i, 1); continue; }
    x.strokeStyle = rgba(r.c, (1 - u) * .7); x.lineWidth = 1.4 * (1 - u) + .4; x.beginPath(); x.arc(r.x, r.y, 3 + u * 11, 0, 6.29); x.stroke();
  }
}
// 持续的信号：干活的成员不停往晶格送数据，晶格往各面板回送结果；没在编排时只有零星心跳
function ambient(dt) {
  if (!G.ok || document.hidden) return;
  const run = S.run, act = isActive(run), K = (act ? 2.2 : .5) * (.3 + FX), ls = leaderState();
  cardOrder.forEach((id, k) => {
    const st = agentState(id).kind, lead = run?.leaderId === id, busy = st === 'run' || (lead && ls.busy);
    if (Math.random() < (busy ? 2.2 : st === 'review' ? .8 : .1) * dt * (.3 + FX)) send(withStart(route.cardLat(k), G.card[k]), { col: agentColor(id), tail: rr(26, 48), sz: 1.25 });
    if (st === 'run' && !lead && Math.random() < 1.1 * dt) send(route.cardTool(k, LAND.tool), { col: agentColor(id), v: 160 });
  });
  if (Math.random() < .8 * K * dt) send(route.latQ(G.queue.t + G.queue.h * rr(.25, .8)), { col: P.teal });
  if (Math.random() < .45 * K * dt) send(route.latRev(), { col: P.green });
  if (Math.random() < .5 * K * dt) send(route.latCur(LAND.curve), { col: P.orange });
  if (Math.random() < .3 * K * dt) send(route.latTok(), { col: P.navy });
  if (Math.random() < .55 * K * dt) send(route.latBot(0, G.trace.cx, G.trace.t + 2), { col: P.teal });
  if (Math.random() < .4 * K * dt) send(route.latBot(1, G.log.cx, G.log.t + 2), { col: P.teal });
  if (Math.random() < .35 * K * dt) send(route.latBot(2, G.led.cx, G.led.t + 2), { col: P.green });
  if (Math.random() < .3 * K * dt) send(route.latPipe(Math.max(0, stageOf(run).i)), { col: P.navy });
}
// 事件触发的数据流
function flowsTo(agentId, out, count, color) {
  const k = cardIndex(agentId);
  if (k < 0 || !G.ok || (count < 10 && !every(`f:${agentId}:${out}`, 160))) return; // 流式输出很密，限一下频
  const r = route.cardLat(k), n = clamp(Math.round(count / 8), 1, 7);
  if (out) send(withEnd(rev(r), G.card[k]), { n, col: color || P.teal, gap: 45 });
  else send(withStart(r, G.card[k]), { n, col: color || agentColor(agentId), gap: 45 });
}
function burst(taskId, out, count, color) {
  const t = S.run?.tasks.find(x => x.id === taskId);
  if (t) flowsTo(t.assignee, out, count, color);
}
function sendTool(agentId) { const k = cardIndex(agentId); if (k >= 0 && G.ok) send(route.cardTool(k, LAND.tool), { col: agentColor(agentId), v: 170 }); }
function sendQueue(taskId, col, n = 1) { if (G.ok) send(route.latQ(G.rows.get(taskId) ?? G.queue.cy), { col, n, gap: 40 }); }
function sendTo(what, opt = {}) {
  if (!G.ok) return;
  const r = what === 'log' ? route.latBot(1, G.log.cx, G.log.t + 2) : what === 'curve' ? route.latCur(LAND.curve) : what === 'cmd' ? route.cmdLat() : what === 'tok' ? route.latTok() : null;
  send(r, opt);
}
const flashRows = new Map();
const flashRow = (id) => flashRows.set(id, performance.now() + 800);

// 鼠标视差 + 打开时的展开动画 + 冲击波
const mouse = { x: 0, y: 0, sx: 0, sy: 0 };
wrap.addEventListener('mousemove', (e) => { mouse.x = (e.clientX - G.lat.l - CX) / (W / 2); mouse.y = (e.clientY - G.lat.t - CY) / (H / 2); });
wrap.addEventListener('mouseleave', () => { mouse.x = mouse.y = 0; });
let introT0 = performance.now(), lastFlash = 0, rot = 0;
const waves = [], ST = {};
function frameLat(now, dt) {
  const t = now / 1000;
  const tf = targetForm() ?? (Math.floor(now / 7000) % 4);
  if (tf !== form.to) form = { from: form.to, to: tf, t0: now };
  const run = S.run, ls = leaderState();
  const working = isActive(run) ? run.tasks.filter(x => x.status === 'running').length : 0;
  const heat = !run ? .45 : !isActive(run) ? .3 : Math.min(1.5, .55 + (ls.busy ? .3 : 0) + working * .2);
  rot += dt * (.06 + .2 * heat) * (.3 + FX);
  mouse.sx += (mouse.x - mouse.sx) * Math.min(1, dt * 4); mouse.sy += (mouse.y - mouse.sy) * Math.min(1, dt * 4);
  if (coreFlash > lastFlash + .05) waves.push({ t0: now, k: coreFlash });
  lastFlash = coreFlash;
  coreFlash *= Math.pow(.95, dt * 60);
  const intro = Math.min(1, (now - introT0) / 1500), ie = 1 - (1 - intro) ** 3;
  const tilt = .36 + .06 * Math.sin(t * .3) + clamp(mouse.sy, -1, 1) * .22, r2 = rot + clamp(mouse.sx, -1, 1) * .45;
  Object.assign(ST, {
    from: form.from, to: form.to, raw: Math.min(1, (now - form.t0) / 2200), t,
    cr: Math.cos(r2), sr: Math.sin(r2), ct: Math.cos(tilt), st: Math.sin(tilt),
    scale: LR, amp: (1 + coreFlash * .07 + .012 * Math.sin(t * 1.4)) * (.12 + .88 * ie),
    wob: .015 * heat, nBand: isActive(run) ? Math.min(20, working * 5 + (ls.busy ? 2 : 0)) : 0,
    pulse: (!run ? .55 : isActive(run) ? Math.min(1, .4 + heat * .35 + rateOut / 300) : .22) * (.4 + .6 * FX) * ie,
    quota: quotaNow(), heat,
  });
  ST.rate = Math.min(1, (!run ? .35 : isActive(run) ? .2 : .05) + rateOut / 350);
  if (GLR) drawGL(ST);

  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  if (!GLR) draw2D(ST);
  const tl = Math.abs(ST.st), orbit = LR * 1.62, hot = ST.quota ? P.red : P.teal;
  // 接口环：走线在这里和晶格对接（焊盘 P1…）
  g.strokeStyle = rgba(P.frame, .36); g.lineWidth = 1; g.setLineDash([2, 4]);
  g.beginPath(); g.ellipse(CX, CY, PRX, PRY, 0, 0, 6.2832); g.stroke(); g.setLineDash([]);
  g.strokeStyle = rgba(P.frame, .85);
  for (const p of [...G.pL, ...G.pR, ...G.pB, G.pT]) {
    const x = p[0] - G.lat.l, y = p[1] - G.lat.t;
    g.fillStyle = P.card; g.fillRect(x - 3.5, y - 3.5, 7, 7); g.strokeRect(x - 3.5, y - 3.5, 7, 7);
  }
  // 外圈轨道 + 十字线 + 轨道上转动的两段亮弧
  g.strokeStyle = P.faint; g.lineWidth = 1;
  g.beginPath(); g.ellipse(CX, CY, orbit, orbit * tl, 0, 0, 6.2832); g.stroke();
  g.strokeStyle = rgba(P.frame, .22); g.setLineDash([3, 5]);
  g.beginPath(); g.moveTo(CX, CY - LR * 1.5); g.lineTo(CX, CY + LR * 1.5); g.moveTo(CX - PRX * 1.04, CY); g.lineTo(CX + PRX * 1.04, CY); g.stroke();
  if (FX >= .02) {
    g.lineWidth = 2.2; g.setLineDash([26, 300]);
    g.strokeStyle = rgba(hot, .85); g.lineDashOffset = -t * 70 * (.4 + .6 * FX);
    g.beginPath(); g.ellipse(CX, CY, orbit, orbit * tl, 0, 0, 6.2832); g.stroke();
    g.strokeStyle = rgba(P.orange, .8); g.lineDashOffset = t * 55 * (.4 + .6 * FX) + 150;
    g.beginPath(); g.ellipse(CX, CY, orbit, orbit * tl, 0, 0, 6.2832); g.stroke();
  }
  g.setLineDash([]); g.lineDashOffset = 0;
  // 雷达式扫掠：贴着轨道面转的一片楔形，前沿最亮
  if (FX >= .02) {
    const sw = t * 1.15 * (.4 + .6 * FX), ry = orbit * tl;
    for (let i = 0; i < 10; i++) { const a1 = sw - i * .07; g.fillStyle = rgba(hot, .14 * (1 - i / 10) ** 2); g.beginPath(); g.moveTo(CX, CY); g.ellipse(CX, CY, orbit, ry, 0, a1 - .07, a1 + .005); g.closePath(); g.fill(); }
    g.strokeStyle = rgba(hot, .55); g.lineWidth = 1; g.beginPath(); g.moveTo(CX, CY); g.lineTo(CX + orbit * Math.cos(sw), CY + ry * Math.sin(sw)); g.stroke();
  }
  // 冲击波：派发 / 通过 / 插话时从晶格往外扩
  for (let i = waves.length - 1; i >= 0; i--) {
    const w = waves[i], p = (now - w.t0) / 1400;
    if (p >= 1) { waves.splice(i, 1); continue; }
    const e = 1 - (1 - p) ** 3, rad = LR * (1 + e * 1.1);
    g.globalAlpha = (1 - p) * .8; g.strokeStyle = hot; g.lineWidth = 2.5 * (1 - p) + .5;
    g.beginPath(); g.ellipse(CX, CY, rad, rad * tl, 0, 0, 6.2832); g.stroke();
    g.lineWidth = 1; g.beginPath(); g.ellipse(CX, CY, rad * .82, rad * .82 * tl, 0, 0, 6.2832); g.stroke();
  }
  g.globalAlpha = 1;
  // 标注卡片的引线：先横后斜，指向某条丝带上的点，随旋转移动
  g.strokeStyle = rgba(P.ink2, .6); g.lineWidth = 1;
  for (const c of coRects) {
    place(strands[c.anchor % NS], .25, ST, PT);
    const ax = PT[0], ay = PT[1], ex = c.x + (ax > c.x + c.w / 2 ? c.w : 0), ey = c.y + Math.min(c.h - 4, 10);
    g.beginPath(); g.moveTo(ex, ey); g.lineTo(ex + (ax - ex) * .5, ey); g.lineTo(ax, ay); g.stroke();
    g.fillStyle = P.navy; g.fillRect(ex - 3, ey - 3, 6, 6);
    g.beginPath(); g.arc(ax, ay, 2.5, 0, 6.29); g.fill();
  }
}

let lastT = 0, measAcc = 0, chartAcc = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(.05, lastT ? (now - lastT) / 1000 : .016);
  lastT = now;
  if (!P.navy) return;
  if (G.dirty || (measAcc += dt) > 1.5) { measAcc = 0; measure(); }
  if (!G.ok) return;
  qualityTick(now, dt);
  if ((chartAcc += dt) > .1) { chartAcc = 0; charts(); }
  frameLat(now, dt);
  ambient(dt);
  drawFx(now, dt);
}

// 点击晶格 → 组长
function hit(e) {
  const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  return S.run && Math.hypot(x - CX, y - CY) < LR * 1.15 ? 'leader' : null;
}
cv.addEventListener('mousemove', e => cv.classList.toggle('hover', !!hit(e)));
cv.addEventListener('click', e => { const h = hit(e); if (h) openDrawer(h); });

// ───── 小图表：画布铺满父容器，尺寸用布局快照里量好的，不在绘制时读 DOM ─────
const FONT = '"Cascadia Mono", Consolas, "Microsoft YaHei UI", monospace';
function prep(c) {
  const [w, h] = G.sz.get(c) ?? [c.parentElement.clientWidth, c.parentElement.clientHeight];
  sizeCanvas(c, w, h, dpr);
  const x = c.getContext('2d');
  x.setTransform(dpr, 0, 0, dpr, 0, 0);
  x.clearRect(0, 0, w, h);
  return [x, w, h];
}
// 动的图（工具格闪烁、审查格、依赖图上的信号）10 帧 / 秒；其余跟面板一起 2 次 / 秒
function charts() { drawTools(); drawReview(); drawDag(); }
// 某个 AI 的活跃度：进行中看最近 2 分钟，结束了看整场
function activity(agentId, n) {
  const run = S.run, out = new Array(n).fill(0);
  if (!run) return out;
  const now = Date.now(), end = isActive(run) ? now : (run.endedAt ?? now);
  const span = isActive(run) ? 120_000 : Math.max(10_000, end - run.createdAt), start = end - span;
  const owner = new Map(run.tasks.map(t => [t.id, t.assignee]));
  owner.set('leader', run.leaderId);
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i];
    if (s.ts < start) { if (isActive(run)) break; continue; }
    if (s.ts > end || owner.get(s.task) !== agentId) continue;
    out[Math.min(n - 1, (s.ts - start) / span * n | 0)] += s.w;
  }
  const mx = Math.max(...out, 1e-9);
  return out.map(v => (v ? Math.sqrt(v / mx) : 0));
}

function drawSpark() {
  const [x, w, h] = prep($('#spark'));
  const mx = Math.max(1, ...rateHist), bw = w / rateHist.length;
  rateHist.forEach((v, i) => { const bh = Math.max(1, v / mx * (h - 2)); x.fillStyle = rgba(P.navy, .3 + .7 * i / rateHist.length); x.fillRect(i * bw, h - bh, Math.max(1, bw - 1), bh); });
}

function drawTools() {
  const c = $('#cTools'), [x, w, h] = prep(c);
  const sz = clamp(Math.floor(Math.sqrt(w * h / 120)) - 3, 8, 14), gap = 3, cols = Math.max(1, (w + gap) / (sz + gap) | 0), rows = Math.max(1, (h + gap) / (sz + gap) | 0), cap = cols * rows;
  const list = toolCells.slice(-cap), ox = (w - (cols * (sz + gap) - gap)) / 2, act = isActive(S.run), now = Date.now();
  for (let i = 0; i < cap; i++) {
    const cx = ox + (i % cols) * (sz + gap), cy = (i / cols | 0) * (sz + gap), cell = list[i];
    if (!cell) { x.strokeStyle = P.faint; x.lineWidth = 1; x.strokeRect(cx + .5, cy + .5, sz - 1, sz - 1); continue; }
    if (cell.status === 'failed') { x.strokeStyle = P.orange; x.lineWidth = 1.5; x.strokeRect(cx + .75, cy + .75, sz - 1.5, sz - 1.5); }
    else if (cell.status === 'completed' || !act) { x.fillStyle = rgba(agentColor(cell.agent) || P.navy, .3 + .7 * cell.shade); x.fillRect(cx, cy, sz, sz); }
    else { x.fillStyle = rgba(P.teal, .55 + .45 * Math.sin(now / 220 + i)); x.fillRect(cx, cy, sz, sz); }
  }
  // 下一格的位置：工具调用的粒子落在这里
  const k = Math.min(list.length, cap - 1), g0 = G.cvTools;
  if (g0) LAND.tool = [g0.l + ox + (k % cols) * (sz + gap) + sz / 2, g0.t + (k / cols | 0) * (sz + gap) + sz / 2];
  const ok = toolCells.filter(t => t.status === 'completed').length, bad = toolCells.filter(t => t.status === 'failed').length;
  setText('#toolChip', ok + bad ? `成功 ${(ok / (ok + bad) * 100).toFixed(0)}%` : '成功 —');
  setText('#toolFoot1', `${toolCells.length} 次调用${toolCells.length > cap ? ` · 显示最近 ${cap}` : ''}`);
  setText('#toolFoot2', `失败 ${bad}`);
}

function drawReview() {
  const [x, w, h] = prep($('#cReview')), run = S.run, all = run?.tasks ?? [];
  const tasks = all.slice(-8), dw = Math.min(h - 6, w * .38), gridW = w - dw - 14;
  const nR = Math.max(5, tasks.length), rowH = Math.min(22, (h - 2) / nR), cw = 22, cg = 4, maxCells = Math.max(1, (gridW - 34) / (cw + cg) | 0);
  x.font = `10px ${FONT}`; x.textBaseline = 'middle';
  for (let r = 0; r < nR; r++) {
    const t = tasks[r], y = r * rowH + 2, ch = rowH - 5;
    x.fillStyle = P.mute; x.fillText(t ? t.id : '··', 0, y + ch / 2);
    const attempts = t ? (t.rounds ?? 0) + 1 : 0;
    for (let k = 0; k < maxCells; k++) {
      const cx = 30 + k * (cw + cg);
      if (k >= attempts) { x.strokeStyle = P.faint; x.lineWidth = 1; x.setLineDash([2, 2]); x.strokeRect(cx + .5, y + .5, cw - 1, ch - 1); x.setLineDash([]); continue; }
      const last = k === attempts - 1;
      if (!last) { x.strokeStyle = P.orange; x.lineWidth = 1.5; x.setLineDash([3, 2]); x.strokeRect(cx + .75, y + .75, cw - 1.5, ch - 1.5); x.setLineDash([]); continue; }
      const fill = t.status === 'done' ? P.navy : t.status === 'running' ? rgba(P.teal, .55 + .45 * Math.sin(Date.now() / 250)) : t.status === 'review' ? P.blue : null;
      if (fill) { x.fillStyle = fill; x.fillRect(cx, y, cw, ch); }
      else { x.strokeStyle = TERMINAL.includes(t.status) ? P.red : P.frame2; x.lineWidth = 1.5; x.strokeRect(cx + .75, y + .75, cw - 1.5, ch - 1.5); }
    }
  }
  const done = all.filter(t => t.status === 'done'), first = done.filter(t => !t.rounds).length;
  const pct = done.length ? first / done.length : null;
  const R = Math.max(4, dw / 2 - 8), cx = w - dw / 2, cy = h / 2;
  x.lineWidth = 7; x.strokeStyle = P.faint; x.beginPath(); x.arc(cx, cy, R, 0, 6.29); x.stroke();
  if (pct) {
    x.strokeStyle = P.green; x.beginPath(); x.arc(cx, cy, R, -1.5708, -1.5708 + pct * 6.2832); x.stroke();
    const ea = -1.5708 + pct * 6.2832; x.fillStyle = P.green; x.beginPath(); x.arc(cx + Math.cos(ea) * R, cy + Math.sin(ea) * R, 4.5, 0, 6.29); x.fill();
  }
  x.textAlign = 'center'; x.fillStyle = P.ink; x.font = `700 ${Math.max(13, R * .42) | 0}px ${FONT}`;
  x.fillText(pct == null ? '—' : `${Math.round(pct * 100)}%`, cx, cy - 2);
  if (R > 30) { x.font = `9.5px ${FONT}`; x.fillStyle = P.mute; x.fillText('一次通过', cx, cy + R * .42); }
  x.textAlign = 'left';
  setText('#revChip', `一次通过 ${pct == null ? '—' : `${Math.round(pct * 100)}%`}`);
  setText('#revFoot1', `返工 ${all.reduce((s, t) => s + (t.rounds ?? 0), 0)} 次`);
  setText('#revFoot2', `${done.length}/${all.length} 已通过`);
}

// 依赖图：节点 = 任务，按依赖深度分列；肘形连线 = 依赖，依赖满足后连线上有信号流过去
function drawDag() {
  const [x, w, h] = prep($('#cDag')), run = S.run, tasks = run?.tasks ?? [];
  x.font = `9.5px ${FONT}`; x.textBaseline = 'middle'; x.textAlign = 'left'; x.fillStyle = P.mute;
  if (h < 40) return;
  if (!tasks.length) { x.fillText(run ? '组长拆完任务后显示依赖关系' : '依赖图 · 下达目标后显示', 0, 8); return; }
  x.fillText('依赖图 · 实线 = 依赖已满足', 0, 6);
  const byId = new Map(tasks.map(t => [t.id, t])), depth = new Map();
  const dep = (t, seen = new Set()) => {
    if (depth.has(t.id)) return depth.get(t.id);
    if (seen.has(t.id)) return 0;
    seen.add(t.id);
    const d = t.deps.filter(id => byId.has(id)).reduce((m, id) => Math.max(m, dep(byId.get(id), seen) + 1), 0);
    depth.set(t.id, d);
    return d;
  };
  tasks.forEach(t => dep(t));
  const cols = [];
  for (const t of tasks) (cols[depth.get(t.id)] ??= []).push(t);
  const nC = cols.length, nR = Math.max(...cols.map(c => c.length));
  const pl = 4, pr = 4, pt = 15, pb = 4, nw = clamp((w - pl - pr) / nC - 14, 18, 40), nh = clamp((h - pt - pb) / nR - 5, 8, 20);
  const pos = new Map();
  cols.forEach((col, c) => col.forEach((t, r) => pos.set(t.id, [pl + (nC > 1 ? c * (w - pl - pr - nw) / (nC - 1) : (w - nw) / 2), pt + (h - pt - pb) * (r + .5) / col.length - nh / 2])));
  const now = Date.now();
  for (const t of tasks) for (const d of t.deps) {
    const a = pos.get(d), b = pos.get(t.id);
    if (!a || !b) continue;
    const ax = a[0] + nw, ay = a[1] + nh / 2, bx = b[0], by = b[1] + nh / 2, mx = (ax + bx) / 2;
    const ok = byId.get(d).status === 'done';
    x.beginPath(); x.moveTo(ax, ay); x.lineTo(mx, ay); x.lineTo(mx, by); x.lineTo(bx, by);
    x.strokeStyle = ok ? rgba(P.teal, .8) : P.frame2; x.lineWidth = 1.2; x.setLineDash(ok ? [] : [3, 3]); x.stroke(); x.setLineDash([]);
    if (ok && t.status !== 'done') { x.strokeStyle = P.teal; x.lineWidth = 2.6; x.setLineDash([2.4, 12]); x.lineDashOffset = -now / 28; x.stroke(); x.setLineDash([]); x.lineDashOffset = 0; }
    x.fillStyle = ok ? P.teal : P.frame2; x.beginPath(); x.moveTo(bx, by); x.lineTo(bx - 5, by - 3); x.lineTo(bx - 5, by + 3); x.fill();
  }
  x.textAlign = 'center';
  for (const t of tasks) {
    const [nx, ny] = pos.get(t.id), st = t.status;
    const blocked = st === 'pending' && !t.deps.every(d => TERMINAL.includes(byId.get(d)?.status ?? 'done'));
    x.lineWidth = 1.2;
    let solid = true;
    if (st === 'done') { x.fillStyle = P.navy; x.fillRect(nx, ny, nw, nh); }
    else if (st === 'running') { x.fillStyle = rgba(P.teal, .5 + .4 * Math.sin(now / 220)); x.fillRect(nx, ny, nw, nh); }
    else if (st === 'review') { x.fillStyle = P.blue; x.fillRect(nx, ny, nw, nh); }
    else { solid = false; x.strokeStyle = ['failed', 'cancelled'].includes(st) ? P.red : blocked ? P.frame2 : P.ink2; if (blocked) x.setLineDash([3, 2]); x.strokeRect(nx + .5, ny + .5, nw - 1, nh - 1); x.setLineDash([]); }
    if (nh >= 10) { x.fillStyle = solid ? P.card : P.ink2; x.fillText(t.id + (st === 'done' && nw > 30 ? ' ✓' : ''), nx + nw / 2, ny + nh / 2 + .5); }
  }
  x.textAlign = 'left';
}

// Token 曲线：输入、输出两条累计线
function drawCurve() {
  const [x, w, h] = prep($('#cCurve')), run = S.run;
  const pl = 6, pr = 10, pt = 12, pb = 6, iw = w - pl - pr, ih = h - pt - pb;
  x.strokeStyle = P.faint; x.lineWidth = 1; x.setLineDash([2, 4]);
  for (let i = 0; i <= 3; i++) { const y = pt + ih * i / 3; x.beginPath(); x.moveTo(pl, y); x.lineTo(w - pr, y); x.stroke(); }
  x.setLineDash([]);
  if (!run) {
    for (const [col, k] of [[P.frame2, .85], [P.faint, .45]]) {
      x.strokeStyle = col; x.lineWidth = 2; x.beginPath();
      for (let i = 0; i <= 40; i++) { const u = i / 40, px = pl + u * iw, py = pt + ih - (1 - Math.exp(-u * 4)) * ih * k; i ? x.lineTo(px, py) : x.moveTo(px, py); }
      x.stroke();
    }
    setText('#curveChip', '入 0 · 出 0'); setText('#curveFoot1', '开始'); setText('#curveFoot2', '现在');
    LAND.curve = null;
    return;
  }
  const tk = tokens(), t0 = run.createdAt, t1 = isActive(run) ? Date.now() : (run.endedAt ?? Date.now()), span = Math.max(1000, t1 - t0);
  const pts = [[t0, 0, 0], ...tokPts.filter(p => p[0] >= t0)];
  const lastP = pts[pts.length - 1];
  if (isActive(run) || lastP[1] < tk.inT || lastP[2] < tk.outT) pts.push([t1, Math.max(lastP[1], tk.inT), Math.max(lastP[2], tk.outT)]);
  const mY = Math.max(1, ...pts.map(p => Math.max(p[1], p[2])));
  const X = (ts) => pl + Math.min(1, (ts - t0) / span) * iw, Y = (v) => pt + ih - v / mY * ih;
  if (isActive(run)) { x.fillStyle = rgba(P.teal, .08); x.fillRect(X(t0 + span * .8), pt, iw * .2, ih); }
  for (const [k, col, fill] of [[1, P.blue, .1], [2, P.teal, .12]]) {
    x.beginPath(); pts.forEach((p, i) => (i ? x.lineTo(X(p[0]), Y(p[k])) : x.moveTo(X(p[0]), Y(p[k]))));
    x.lineTo(X(pts[pts.length - 1][0]), pt + ih); x.lineTo(pl, pt + ih); x.closePath();
    x.fillStyle = rgba(col, fill); x.fill();
    x.strokeStyle = col; x.lineWidth = 2; x.beginPath(); pts.forEach((p, i) => (i ? x.lineTo(X(p[0]), Y(p[k])) : x.moveTo(X(p[0]), Y(p[k])))); x.stroke();
    x.fillStyle = col; for (const p of pts.slice(1, -1)) { x.beginPath(); x.arc(X(p[0]), Y(p[k]), 1.8, 0, 6.29); x.fill(); }
  }
  const end = pts[pts.length - 1];
  if (G.cvCurve) LAND.curve = [G.cvCurve.l + X(end[0]), G.cvCurve.t + Y(end[2])];
  if (lastGain && lastGain.at >= t0) {
    const p = tokPts.find(q => q[0] === lastGain.at) ?? end, gx = X(lastGain.at), gy = Y(p[2]);
    x.strokeStyle = P.orange; x.lineWidth = 1; x.setLineDash([3, 3]); x.beginPath(); x.moveTo(gx, pt); x.lineTo(gx, pt + ih); x.stroke(); x.setLineDash([]);
    x.lineWidth = 1.5; x.beginPath(); x.arc(gx, gy, 5, 0, 6.29); x.stroke();
    x.fillStyle = P.orange; x.font = `700 10px ${FONT}`; x.textBaseline = 'bottom';
    const lab = `+${kfmt(lastGain.n)} tok`, lw = x.measureText(lab).width;
    x.fillText(lab, Math.min(gx + 8, w - pr - lw), Math.max(pt + 12, gy - 6));
  }
  x.fillStyle = P.mute; x.font = `10px ${FONT}`; x.textBaseline = 'top'; x.fillText(kfmt(mY), pl + 2, 0);
  const e = tk.est ? '≈' : '';
  setText('#curveChip', `入 ${kfmt(tk.inT)} · 出 ${e}${kfmt(tk.outT)}`);
  setText('#curveFoot1', `开始 ${hms(t0)}`);
  setText('#curveFoot2', `${isActive(run) ? '现在' : '结束'} ${hms(t1)}`);
}

function drawTrace() {
  const [x, w, h] = prep($('#cTrace')), run = S.run;
  const ids = run ? ['leader', ...run.tasks.map(t => t.id)] : [];
  const nR = Math.max(7, ids.length), labW = 40, gw = w - labW, C = Math.max(20, gw / 9 | 0), cw = gw / C, rh = h / nR;
  for (let r = 0; r < nR; r++) for (let c = 0; c < C; c++) {
    x.fillStyle = rgba(P.blue, .05 + ((r * 7 + c * 13) % 5) * .018);
    x.fillRect(labW + c * cw + .5, r * rh + .5, cw - 1, rh - 1);
  }
  if (!run) { setText('#traceN', '0'); return; }
  const t0 = run.createdAt, t1 = isActive(run) ? Date.now() : (run.endedAt ?? Date.now()), span = Math.max(1000, t1 - t0);
  const idx = new Map(ids.map((id, i) => [id, i]));
  const grid = new Float32Array(nR * C), kinds = new Uint8Array(nR * C), col = new Float32Array(C), go = [];
  let n = 0;
  for (const s of samples) {
    const r = idx.get(s.task);
    if (r === undefined || s.ts < t0) continue;
    n++;
    const c = Math.min(C - 1, (s.ts - t0) / span * C | 0);
    grid[r * C + c] += s.w; col[c] += s.w;
    if (s.k === 'tool') kinds[r * C + c] |= 1;
    if (s.k === 'err') kinds[r * C + c] |= 2;
    if (s.k === 'go') go.push(s.ts);
  }
  let mx = 1e-9;
  for (const v of grid) if (v > mx) mx = v;
  for (let i = 0; i < grid.length; i++) {
    if (!grid[i]) continue;
    const a = Math.sqrt(grid[i] / mx), kd = kinds[i];
    x.fillStyle = kd & 2 ? P.orange : kd & 1 ? rgba(P.navy, .45 + .55 * a) : rgba(P.blue, .2 + .5 * a);
    x.fillRect(labW + (i % C) * cw + .5, (i / C | 0) * rh + .5, cw - 1, rh - 1);
  }
  if (isActive(run)) run.tasks.forEach((t, i) => { if (t.status === 'running') { x.fillStyle = P.teal; x.fillRect(labW + (C - 1) * cw + .5, (i + 1) * rh + .5, cw - 1, rh - 1); } });
  x.strokeStyle = rgba(P.orange, .75); x.lineWidth = 1;
  for (const ts of go) { const gx = labW + (ts - t0) / span * gw; x.beginPath(); x.moveTo(gx, 0); x.lineTo(gx, h); x.stroke(); }
  let cm = 1e-9;
  for (const v of col) if (v > cm) cm = v;
  x.strokeStyle = P.ink; x.lineWidth = 1.2; x.beginPath();
  for (let c = 0; c < C; c++) { const px = labW + (c + .5) * cw, py = h * .6 - Math.sqrt(col[c] / cm) * h * .28; c ? x.lineTo(px, py) : x.moveTo(px, py); }
  x.stroke();
  x.font = `10px ${FONT}`; x.textBaseline = 'middle'; x.fillStyle = P.ink2;
  ids.forEach((id, r) => { if (rh >= 9) x.fillText(id === 'leader' ? '组长' : id, 2, r * rh + rh / 2); });
  setText('#traceN', fmt(n));
}

// ───── Claude 额度：和命令行 claude-hud 显示的同一份数据 ─────
let usage = null, usageAt = 0;
function ensureUsage() {
  if (Date.now() - usageAt > 60_000) {
    usageAt = Date.now();
    api('GET', '/api/usage/claude').then(u => { usage = u; if (S.sel) renderDrawer(); }, () => {});
  }
  return usage;
}
function usageRow(name, w) {
  if (!w || w.pct == null) return `<div class="ub"><span>${name}</span><i class="bar"><i style="width:0"></i></i><span>—</span></div>`;
  const cls = w.pct >= 90 ? 'bad' : w.pct >= 70 ? 'warn' : '';
  return `<div class="ub ${cls}"><span>${name}</span><i class="bar"><i style="width:${Math.min(100, w.pct)}%"></i></i><span>${w.pct}%</span><em>${w.resetsAt ? `${tm(w.resetsAt)} 重置` : ''}</em></div>`;
}
function usageBox() {
  const u = ensureUsage();
  if (!u) return '<div class="d-box muted">正在读取 Claude 额度…</div>';
  if (!u.source) return `<div class="d-box"><b>订阅额度</b><div class="muted small">还没有数据：在命令行里用一下 Claude Code（claude-hud 会写出 ${esc(u.file)}），或者让编排台跑一轮 Claude。</div></div>`;
  const age = u.updatedAt ? Math.round((Date.now() - u.updatedAt) / 60000) : null;
  return `<div class="d-box"><b>订阅额度</b>${usageRow('5 小时', u.fiveHour)}${usageRow('7 天', u.sevenDay)}
    <div class="muted small">${u.source === 'hud' ? '来自命令行 claude-hud' : '来自编排台最近一次运行'}${age != null ? ` · ${age < 1 ? '刚刚' : `${age} 分钟前`}更新` : ''}</div></div>`;
}

// ───── 面板 ─────
const TS = { pending: '待开始', running: '运行中', review: '组长审查', done: '完成', failed: '失败', skipped: '已跳过', cancelled: '已取消', interrupted: '已中断' };
const STAGES = ['规划', '派发', '执行', '审查', '终审', '汇总'];
function stageOf(run) {
  if (!run) return { i: -1 };
  if (run.status === 'planning') return { i: 0 };
  if (run.status === 'summarizing') return { i: 5 };
  if (run.status === 'done') return { i: 5, ok: true };
  if (!isActive(run)) return { i: !run.tasks.length ? 0 : run.summary ? 5 : 2, bad: true };
  const t = run.tasks;
  if (t.some(x => x.kind === 'final' && ['running', 'review'].includes(x.status))) return { i: 4 };
  if (t.some(x => x.status === 'review')) return { i: 3 };
  if (t.some(x => x.status === 'running')) return { i: 2 };
  return { i: 1 };
}
const setText = (sel, v) => { const el = typeof sel === 'string' ? $(sel) : sel; if (el.textContent !== v) el.textContent = v; };
const setHtml = (el, html) => { if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; } };
const setCls = (el, c) => { if (el.className !== c) el.className = c; };

// 流水线骨架只建一次，之后只改 class / 文字，进行中那段的流动动画不会被打断
$('#pipe').innerHTML = `<span class="pm" id="pipeM"></span><div class="stages">${STAGES.map((s, i) => `<div class="stg"><i class="no">0${i + 1}</i><span>${s}</span></div>${i < STAGES.length - 1 ? '<i class="conn"></i>' : ''}`).join('')}</div><span class="pt">用时 <b id="pipeT">00:00</b></span>`;

function panels() {
  const run = S.run, now = Date.now(), tk = tokens(), ls = leaderState();
  const tasks = run?.tasks ?? [], done = tasks.filter(t => t.status === 'done').length, e = tk.est ? '≈' : '';

  // 吞吐（按字数估算，3 字符 ≈ 1 token）
  rateIn = rateIn * .5 + secIn / 3 * 2 * .5; rateOut = rateOut * .5 + secOut / 3 * 2 * .5;
  secIn = secOut = 0;
  rateHist.push(rateIn + rateOut); rateHist.shift();

  // 顶栏：输入 / 输出分开显示
  setText('#clock', hms(now));
  setText('#ttlState', run ? (STATUS[run.status] ?? run.status) : '新对话');
  setText('#goal', run ? oneLine(run.goal) : '组长拆分 · 队员执行 · 组长审查 · 一个目标，一条主线');
  $('#goal').title = run?.goal ?? '';
  setText('#hIn', kfmt(tk.inT));
  setText('#hOut', `${e}${kfmt(tk.outT)}`);
  $('#hIn').parentElement.title = `输入 ${fmt(tk.inT)} tokens（提示词、上下文、工具结果）`;
  $('#hOut').parentElement.title = `输出 ${fmt(tk.outT)} tokens${tk.est ? '，含进行中按字数估算的部分' : ''}`;
  setText('#hTasks', `${done}/${tasks.length}`);
  setText('#hRate', `≈${fmt(rateOut)}`);
  const tag = $('#hTag');
  setText(tag, run ? `耗时 ${mmss((run.endedAt ?? now) - run.createdAt)}` : '待命');
  setCls(tag, `chip ${!run || isActive(run) ? 'teal' : run.status === 'done' ? 'green' : 'red'}`);
  drawSpark();

  // 阶段流水线
  const sg = stageOf(run), pipe = $('#pipe');
  setHtml($('#pipeM'), run ? `编排 <b>${esc(run.id.toUpperCase())}</b> · 任务 <b>${tasks.length}</b> · 入 <b>${kfmt(tk.inT)}</b> · 出 <b>${e}${kfmt(tk.outT)}</b>` : '新对话 · 等待目标');
  pipe.querySelectorAll('.stg').forEach((el, i) => setCls(el, `stg ${i < sg.i || (sg.ok && i <= sg.i) ? 'done' : ''} ${i === sg.i ? (sg.ok ? 'cur ok' : sg.bad ? 'cur bad' : 'cur') : ''}`));
  pipe.querySelectorAll('.conn').forEach((el, i) => setCls(el, `conn ${i < sg.i ? 'done' : i === sg.i && isActive(run) ? 'cur' : ''}`));
  setText('#pipeT', run ? mmss((run.endedAt ?? now) - run.createdAt) : '00:00');

  // 作战编组
  renderCards(tk, ls);

  // 晶格标注
  const fi = curForm(), F = FORMS[fi], q = quotaNow();
  const chip = $('#formChip');
  setText(chip, q ? '■ 额度等待' : run ? `■ ${F.name}` : '■ 形态轮播');
  setCls(chip, `chip ${q || (run && !isActive(run) && run.status !== 'done') ? 'red' : run?.status === 'done' ? 'green' : isActive(run) ? 'teal' : ''}`);
  setHtml($('#coLegend'), [[P.navy, '组长主线'], [P.blue, '环绕'], [q ? P.red : P.orange, q ? '额度等待' : '执行带'], [P.teal, '数据流']].map(([c, n]) => `<div><i style="background:${c}"></i>${n}</div>`).join('') + `<p>丝带 ${NS} 束 · 一束 = 一条执行路径<br>走线上的方点 = 流动的数据</p>`);
  setHtml($('#coDesc'), run
    ? `<b>形态 ${fi + 1}/4 · ${F.name} · ${esc(ls.text)}</b><span>${esc(q && run.leaderWaitUntil ? `组长额度用尽，${tm(run.leaderWaitUntil)} 恢复后自动续接` : F.what)}</span>`
    : '<b>新对话 · 待命</b><span>在下方指令台输入目标，回车开始编排；以前的编排按工作区收在左侧</span>');
  const u = ensureUsage(), c5 = u?.fiveHour?.pct;
  if (run) {
    const L = agentOf(run.leaderId), model = prettyModel(L.model);
    setHtml($('#coA'), lastGain ? `<small>最新入账 · ${esc(lastGain.who)}${lastGain.task !== 'leader' ? ` ${esc(lastGain.task)}` : ''}</small><b>+${lastGain.est ? '≈' : ''}${kfmt(lastGain.n)} TOK</b><span class="u"><i style="width:${Math.min(100, lastGain.n / Math.max(1, tk.total) * 300)}%"></i></span>` : '<small>最新入账</small><b>—</b>');
    setHtml($('#coB'), `<small>组长 · ${esc(L.name)}${model ? ` · ${esc(model)}` : ''}</small><b class="s" title="${esc(coreTask() ?? '')}">${esc(coreTask() ?? ls.text)}</b>`);
  } else {
    setHtml($('#coA'), `<small>就绪成员</small><b>${S.agents.filter(a => a.enabled && a.available).length} / ${S.agents.length}</b>`);
    setHtml($('#coB'), `<small>组长席位 · 默认 ${esc(agentOf(S.defaults.leaderId ?? '').name ?? '—')}</small><b>待命</b>`);
  }
  setHtml($('#coC'), `<small>输出吞吐</small><b>≈${fmt(rateOut)} tok/s</b><span class="u"><i style="width:${Math.min(100, rateOut / 2)}%"></i></span>`);
  setHtml($('#coD'), `<small>Claude 5 小时额度</small><b>${c5 == null ? '—' : `${c5}%`}</b><span class="u"><i style="width:${c5 ?? 0}%;background:${c5 >= 90 ? P.red : c5 >= 70 ? P.orange : P.teal}"></i></span>`);

  // 统计条
  setHtml($('#stats'), [
    ['任务', `${done}/${tasks.length}`], ['形态', run ? F.name : '轮播'], ['进度', tasks.length ? `${Math.round(done / tasks.length * 100)}%` : '0%'],
    ['工具调用', fmt(toolCells.length)], ['输入 Tokens', kfmt(tk.inT)], ['输出 Tokens', `${e}${kfmt(tk.outT)}`],
  ].map(([k, v]) => `<div><small>${k}</small><b>${esc(v)}</b></div>`).join(''));

  // 调度队列
  setText('#qCnt', `${done}/${tasks.length}`);
  const waitAppr = new Set(S.approvals.filter(x => x.runId === run?.id).map(x => x.taskId)), pnow = performance.now();
  const qb = $('#queue'), qKey = tasks.map(t => t.id).join(',');
  setHtml(qb, tasks.length ? tasks.map(t => {
    const blocked = t.status === 'pending' && !t.deps.every(d => TERMINAL.includes(run.tasks.find(y => y.id === d)?.status ?? 'done'));
    let label = TS[t.status] ?? t.status, cls = t.status;
    if (t.status === 'running') label = `运行中 ${dur(now - (t.startedAt ?? now))}`;
    if (t.waitUntil) { label = `额度等待 ${tm(t.waitUntil)}`; cls = 'waitq'; }
    else if (blocked) label = '等依赖';
    if (waitAppr.has(t.id)) { label = '待审批'; cls += ' bad'; }
    const lv = t.kind === 'final' ? '<i class="lv final">终审</i>' : t.level === 'hard' ? '<i class="lv hard">难</i>' : t.level === 'easy' ? '<i class="lv easy">易</i>' : '';
    const rw = t.rounds && t.status !== 'done' ? `<i class="lv rw">返${t.rounds}</i>` : '';
    const fl = (flashRows.get(t.id) ?? 0) > pnow ? 'flash' : '';
    return `<tr class="${cls} ${fl} ${S.sel === t.id ? 'sel' : ''}" data-task="${esc(t.id)}"><td>${esc(t.id)}</td><td title="${esc(t.title)}${t.note ? `（${esc(t.note)}）` : ''}">${lv}${rw}${esc(t.title)}</td><td>${esc(short(t.assignee))}</td><td>${esc(t.deps.join(',') || '—')}</td><td>${esc(label)}</td></tr>`;
  }).join('') : `<tr><td colspan="5" class="empty">${run ? (run.status === 'planning' ? '组长正在拆任务…' : '没有任务') : '新对话：下达目标后，组长拆出的任务会排在这里'}</td></tr>`);
  if (qb.dataset.key !== qKey) { qb.dataset.key = qKey; G.dirty = true; }

  drawCurve(); drawTrace();
  const tch = $('#traceChip');
  setText(tch, run ? (STATUS[run.status] ?? run.status) : '待命');
  setCls(tch, `chip ${isActive(run) ? 'teal' : run?.status === 'done' ? 'green' : run ? 'red' : ''}`);

  // 调度日志：放得下几行显示几行，新来的一行浮入
  const nLog = Math.max(3, Math.floor(((G.log?.h ?? 160) - 30) / 16.5));
  setHtml($('#log'), log.length ? log.slice(-nLog).map(l => {
    const mc = l.mark === '✓' ? 'ok' : l.mark === '✗' ? 'bad' : '';
    return `<div class="${l.cls} ${pnow - (l.born ?? 0) < 700 ? 'new' : ''}"><span>${hms(l.ts)}</span><b>${esc(l.who)}</b><em title="${esc(l.text)}">${esc(l.text)}</em><i class="${mc}">${esc(l.mark)}</i></div>`;
  }).join('') : '<span class="empty">等待事件…</span>');

  // 图签
  setText('#tbNo', run ? run.id.toUpperCase() : '—');
  setText('#tbLead', run ? `组长 ${short(run.leaderId)}` : '—');
  setText('#tbDate', new Date(run?.createdAt ?? now).toISOString().slice(5, 10));

  renderLedger(u);
  renderApprovals();
  renderCmd();
}

function renderCards(tk, ls) {
  const run = S.run, ids = cardIds(), box = $('#cards'), key = ids.join(',');
  if (box.dataset.key !== key) {
    // 骨架只在成员变化时重建，之后只改属性，让环和柱子靠 CSS 过渡平滑变化（柱子用 transform，不触发重排）
    box.innerHTML = ids.map(id => `<div class="card" data-card="${esc(id)}"><svg class="ring" viewBox="0 0 46 46"><circle class="bg" cx="23" cy="23" r="18" fill="none" stroke-width="4"/><circle class="fg" cx="23" cy="23" r="18" fill="none" stroke-width="4" transform="rotate(-90 23 23)" stroke-dasharray="0 113.1"/><text x="23" y="27" text-anchor="middle" font-size="12" font-weight="700" font-family="Cascadia Mono, Consolas, monospace"></text></svg>
      <div class="cm"><div class="ch"><b><i></i><span></span></b><span class="tg"></span></div><div class="cs"></div><div class="io"><span>入 <b class="ti">0</b></span><span>出 <b class="to">0</b></span></div>
      <div class="cb"><div class="bars">${'<i></i>'.repeat(24)}</div><div class="cf"></div></div></div></div>`).join('') || '<div class="cap">没有配置任何 AI</div>';
    box.dataset.key = key;
    G.dirty = true;
  }
  const runDone = run?.tasks.filter(t => t.status === 'done').length ?? 0;
  const selAgent = S.sel?.startsWith('agent:') ? S.sel.slice(6) : S.sel === 'leader' ? run?.leaderId : run?.tasks.find(t => t.id === S.sel)?.assignee;
  for (const el of box.querySelectorAll('.card')) {
    const id = el.dataset.card, a = agentOf(id), st = agentState(id), lead = run?.leaderId === id, col = agentColor(id);
    const mine = run?.tasks.filter(t => t.assignee === id) ?? [], done = mine.filter(t => t.status === 'done').length;
    let kind = st.kind, tag;
    if (kind === 'off') tag = st.label;
    else if (kind === 'quota') tag = '额度等待';
    else if (kind === 'run') tag = st.running.length > 1 ? `执行 ×${st.running.length}` : '执行';
    else if (kind === 'review') tag = '待审查';
    else if (lead) { tag = ls.quota ? '额度等待' : ls.busy ? '指挥中' : '组长'; kind = ls.quota ? 'quota' : ls.busy ? 'run' : 'idle'; }
    else tag = ST_TEXT[kind];
    const m = tk.by[id] ?? { n: 0, in: 0, out: 0, est: false }, ti = m.in + (lead ? tk.leader.in : 0), to = m.out + (lead ? tk.leader.out : 0), n = ti + to;
    const share = run && tk.total ? Math.round(n / tk.total * 100) : null;
    setCls(el, `card ${kind} ${lead ? 'lead' : ''} ${selAgent === id ? 'sel' : ''}`);
    el.title = `${a.name} · ${a.description ?? ''}${run ? ` · 输入 ${fmt(ti)} / 输出 ${fmt(to)} tokens` : ''}`;
    el.style.setProperty('--c', col);
    $('.ch i', el).style.background = col;
    setText($('.ch b span', el), `${a.name}${lead ? ' · 组长' : ''}`);
    setText($('.tg', el), tag);
    setText($('.cs', el), `${TIER[a.tier] ?? '主力'} · ${a.model ?? a.type}`);
    setText($('.ti', el), kfmt(ti));
    setText($('.to', el), `${(m.est || (lead && tk.leader.est)) && to ? '≈' : ''}${kfmt(to)}`);
    const c = 2 * Math.PI * 18, vals = activity(id, 24), fg = $('.ring .fg', el), tx = $('.ring text', el);
    $('.ring .bg', el).setAttribute('stroke', P.faint);
    fg.setAttribute('stroke', col);
    fg.style.strokeDasharray = `${((share ?? 0) / 100 * c).toFixed(1)} ${c.toFixed(1)}`;
    tx.setAttribute('fill', P.ink);
    setText(tx, String(share ?? '—'));
    [...$('.bars', el).children].forEach((b, i) => { const v = vals[i]; b.style.transform = `scaleY(${Math.max(.06, v).toFixed(3)})`; b.style.opacity = v ? (.35 + .65 * v).toFixed(2) : '.2'; });
    const [lab, a1, a2] = lead && !mine.length ? ['派发', runDone, run.tasks.length] : ['任务', done, mine.length];
    setHtml($('.cf', el), `${lab} <em>${a1}/${a2}</em>`);
    el.style.setProperty('--pg', a2 ? (a1 / a2).toFixed(3) : '0');
  }
}

function renderLedger(u) {
  const run = S.run, tasks = run?.tasks ?? [];
  const done = tasks.filter(t => t.status === 'done').length, term = tasks.filter(t => TERMINAL.includes(t.status)).length;
  setText('#ledNum', String(done));
  setText('#ledChip', term ? `通过 ${(done / term * 100).toFixed(1)}%` : '通过 —');
  const rows = [
    ['返工轮次', tasks.reduce((s, t) => s + (t.rounds ?? 0), 0), P.orange],
    ['失败任务', tasks.filter(t => t.status === 'failed').length, P.navy],
    ['工具失败', toolCells.filter(c => c.status === 'failed').length, P.teal],
    ['插话与提问', talk, P.blue],
    ['额度等待', tasks.filter(t => t.waitUntil).length + (run?.leaderWaitUntil ? 1 : 0), P.red],
  ];
  const mx = Math.max(4, ...rows.map(r => r[1]));
  setHtml($('#ledBars'), rows.map(([n, v, c]) => `<div class="lb"><div class="lh"><span>${n}</span><span>${v}</span></div><div class="lt"><i style="width:${v / mx * 100}%;background:${c}"></i></div></div>`).join(''));
  setHtml($('#ledUsage'), !u ? '<div class="cap0">读取中…</div>' : !u.source ? '<div class="cap0">还没有数据：用一下 Claude Code 就会有</div>' : usageRow('5 小时', u.fiveHour) + usageRow('7 天', u.sevenDay));
}

function renderApprovals() {
  const html = S.approvals.map(a => {
    const run = S.runs.find(r => r.id === a.runId);
    return `<div class="ap"><div><b>${esc(agentOf(a.agentId).name)} 请求：${esc(a.title)}</b> <span class="small">${esc(a.taskId === 'leader' ? '组长' : a.taskId)} · ${esc(run?.goal?.slice(0, 24) ?? '')}</span><code>${esc(JSON.stringify(a.input ?? {})).slice(0, 300)}</code></div>
      <button data-approve="${a.id}" data-allow="1">允许</button><button class="no" data-approve="${a.id}" data-allow="0">拒绝</button></div>`;
  }).join('');
  setHtml($('#appr'), html);
}

// ───── 编排记录（侧栏）：按工作区分组，每组可以折叠 ─────
// 工作区 = 编排的工作目录；自动新建目录的编排，如果目标里写了路径（例：D:\projects\my-app，优化…）就归到那个路径下
let wsFold = {};
try { wsFold = JSON.parse(localStorage.getItem('hub.wsFold') || '{}'); } catch { /* 忽略 */ }
function wsOf(r) {
  if (r.workdir && !r.autoWorkdir) return r.workdir.replace(/[\\/]+$/, '');
  const m = String(r.goal ?? '').match(/[A-Za-z]:[\\/][^\s，,。；;:："'“”、（）()]+/);
  return m ? m[0].replace(/[\\/]+$/, '') : '';
}
function renderSide() {
  const groups = new Map();
  for (const r of S.runs) {
    const path = wsOf(r), key = path.toLowerCase();
    if (!groups.has(key)) groups.set(key, { key, path, runs: [] });
    groups.get(key).runs.push(r);
  }
  const list = [...groups.values()].sort((a, b) => (b.runs.some(isActive) - a.runs.some(isActive)) || (!a.key - !b.key) || (b.runs[0].createdAt - a.runs[0].createdAt));
  const html = list.map((grp, gi) => {
    const live = grp.runs.some(isActive), mineNow = grp.runs.some(r => r.id === S.run?.id);
    const fold = wsFold[grp.key] ?? !(live || mineNow || gi === 0);
    const name = grp.path ? grp.path.split(/[\\/]/).pop() || grp.path : '临时工作区';
    return `<div class="ws ${fold ? 'fold' : ''}"><button class="ws-h" data-ws="${esc(grp.key)}" title="${esc(grp.path || `自动新建的目录（${S.workspaceRoot}）`)}"><svg class="car" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg><i class="fd"></i><b>${esc(name)}</b>${live ? '<i class="lv2"></i>' : ''}<em>${grp.runs.length}</em></button><div class="ws-list">${grp.runs.map(r => {
      const st = isActive(r) ? 'live' : r.status === 'done' ? 'done' : ['failed', 'interrupted', 'cancelled'].includes(r.status) ? 'bad' : '';
      return `<div class="hi ${st} ${r.id === S.run?.id ? 'on' : ''}" data-run="${esc(r.id)}" title="${esc(r.goal)}"><span class="g">${esc(oneLine(r.goal))}</span><span class="m"><i></i>${esc(STATUS[r.status] ?? r.status)} · ${r.done}/${r.total} · ${tm(r.createdAt)} · ${esc(short(r.leaderId))}</span>${isActive(r) ? '' : `<button class="x" data-del="${esc(r.id)}" title="删除这条记录">✕</button>`}</div>`;
    }).join('')}</div></div>`;
  }).join('') || '<div class="none">还没有编排记录。<br>在下方指令台输入目标就会开始第一条。</div>';
  setHtml($('#histList'), html);
  setText('#histCnt', `${list.length} 区 · ${S.runs.length} 条`);
}
$('#histList').addEventListener('click', (e) => {
  const h = e.target.closest('[data-ws]');
  if (!h) return;
  e.stopPropagation();
  const box = h.parentElement, fold = !box.classList.contains('fold');
  box.classList.toggle('fold', fold);
  wsFold[h.dataset.ws] = fold;
  try { localStorage.setItem('hub.wsFold', JSON.stringify(wsFold)); } catch { /* 忽略 */ }
  $('#histList').dataset.html = ''; // 下次重绘按新的折叠状态来
});

// 指令台：有进行中的编排时对组长 / 某个队员插话；否则输入目标开始新编排
function renderCmd() {
  const run = S.run, sel = $('#cmdTo'), inp = $('#cmdIn');
  const can = !!run && ['planning', 'running'].includes(run.status);
  const opts = can ? [['leader', '组长'], ...run.memberIds.map(id => [id, agentOf(id).name])] : [];
  const key = opts.map(o => o[0]).join(',');
  if (sel.dataset.key !== key) {
    const cur = sel.value;
    sel.innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
    if (opts.some(o => o[0] === cur)) sel.value = cur;
    sel.dataset.key = key;
  }
  sel.hidden = !can;
  inp.placeholder = !can ? (run ? '这条编排已结束：输入新目标，回车开始新的编排' : '输入目标，回车开始新编排') : sel.value === 'leader' ? '对组长插话：补充需求、调整方向、取消或追加任务' : '对这个队员插话：它的下一轮开头送达，组长审查时也会看到';
}
$('#cmdTo').addEventListener('change', renderCmd);
$('#cmdMore').addEventListener('click', () => openNew({ goal: $('#cmdIn').value.trim() }).catch(err => toast(err.message)));

$('#cmd').addEventListener('submit', async (e) => {
  e.preventDefault();
  const inp = $('#cmdIn'), text = inp.value.trim();
  if (!text) return;
  const run = S.run, to = $('#cmdTo').value;
  if (!run || !['planning', 'running'].includes(run.status)) { inp.value = ''; return openNew({ goal: text }).catch(err => toast(err.message)); }
  inp.value = '';
  coreFlash = 1;
  sendTo('cmd', { n: 14, col: P.orange, gap: 40, v: 230 }); // 指令化成粒子沿走线送进晶格
  const form = $('#cmd');
  try {
    if (to === 'leader') {
      for (const id of run.memberIds) flowsTo(id, true, 12, P.orange);
      form.classList.add('busy');
      pushLog('你', `→ 组长：${text}`, '›', 'cmdr');
      const { reply } = await api('POST', `/api/runs/${run.id}/message`, { text });
      pushLog('组长', `回复：${reply || '收到'}`, '✓');
      toast(`组长：${reply || '收到'}`);
    } else {
      flowsTo(to, true, 50, P.orange);
      const r = await api('POST', `/api/runs/${run.id}/agents/${to}/message`, { text });
      toast(`已记下，送达 ${r.tasks.join('、')}`);
    }
  } catch (err) {
    toast(err.message);
    inp.value = text;
  } finally { form.classList.remove('busy'); }
});

// ───── 细节抽屉 ─────
// exact：直接看这个 AI 本身（额度、模型、它的任务），不跳到它正在做的任务
async function openDrawer(sel, exact = false) {
  const run = S.run;
  if (sel.startsWith('agent:') && !exact) {
    const id = sel.slice(6), mine = run?.tasks.filter(t => t.assignee === id) ?? [];
    const pick = mine.find(t => t.status === 'running') ?? mine.find(t => t.status === 'review');
    if (pick) sel = pick.id;
  }
  S.sel = sel;
  if (run && !sel.startsWith('agent:')) {
    const key = `${run.id}:${sel}`;
    if (!S.events.has(key)) S.events.set(key, await api('GET', `/api/runs/${run.id}/events/${sel}`));
  }
  renderDrawer(true);
  panels();
}
function closeDrawer() { S.sel = null; renderDrawer(); panels(); }

function mineHtml(agentId) {
  const run = S.run, mine = run?.tasks.filter(t => t.assignee === agentId) ?? [];
  const lead = run?.leaderId === agentId;
  if (!mine.length && !lead) return `<p class="muted small">${run ? '这个 AI 在本次编排里还没有任务。' : '开始编排后可以在这里看它的实时输出。'}</p>`;
  return `<div class="d-box"><b>本次编排里</b><div class="tabs">${lead ? '<button data-task="leader">组长对话</button>' : ''}${mine.map(t => `<button data-task="${esc(t.id)}">${esc(t.id)} ${esc(t.title.slice(0, 14))} · ${esc(TS[t.status] ?? t.status)}</button>`).join('')}</div></div>`;
}

// ───── 切换模型：抽屉里按 AI 显示可选的模型 / 思考强度，改完写回 agents.json，对新开的任务生效 ─────
const choices = new Map(); // agentId → [{ id, name, current, options }]，或 'loading' / Error
function modelPicker(agentId) {
  const a = agentOf(agentId);
  if (!a.enabled || !a.available) return '';
  const c = choices.get(agentId);
  if (!c) {
    choices.set(agentId, 'loading');
    api('GET', `/api/agents/${agentId}/choices`).then(v => choices.set(agentId, v), e => choices.set(agentId, e)).finally(() => renderDrawer());
  }
  if (!c || c === 'loading') return `<div class="d-model muted">正在读取 ${esc(a.name)} 的可选模型…</div>`;
  if (c instanceof Error) return `<div class="d-model muted">读取模型列表失败：${esc(c.message)} <button data-act="reload-models" data-agent="${esc(agentId)}">重试</button></div>`;
  const opt = (o, cur) => `<option value="${esc(o.value)}" ${o.value === cur ? 'selected' : ''} title="${esc(o.desc ?? '')}">${esc(o.label)}</option>`;
  return `<div class="d-model">${c.map(ch => {
    const groups = [...new Set(ch.options.map(o => o.group ?? ''))];
    const body = groups.length > 1 || groups[0]
      ? groups.map(gname => `<optgroup label="${esc(gname || '其他')}">${ch.options.filter(o => (o.group ?? '') === gname).map(o => opt(o, ch.current)).join('')}</optgroup>`).join('')
      : ch.options.map(o => opt(o, ch.current)).join('');
    return `<label>${esc(a.name)} · ${esc(ch.name)}<select data-choice="${esc(ch.id)}" data-agent="${esc(agentId)}">${body}</select></label>`;
  }).join('')}<span class="muted small">改完立即保存，从下一轮对话开始生效</span></div>`;
}
document.addEventListener('change', async (e) => {
  const sw = e.target.closest('select[data-swap-leader]');
  if (sw) {
    const to = sw.value;
    try {
      await api('POST', `/api/runs/${S.run.id}/leader`, { leaderId: to });
      sw.blur();
      toast(isActive(S.run) ? `已安排换组长：${agentOf(to).name} 将在当前这一轮结束后接手` : `组长已改为 ${agentOf(to).name}，继续运行时生效`);
    } catch (err) { toast(err.message); renderDrawer(); }
    return;
  }
  const el = e.target.closest('select[data-choice]');
  if (!el) return;
  const { agent, choice } = el.dataset;
  try {
    await api('PUT', `/api/agents/${agent}/choices`, { values: { [choice]: el.value } });
    const c = choices.get(agent);
    if (Array.isArray(c)) c.find(x => x.id === choice).current = el.value;
    el.blur();
    toast(`${agentOf(agent).name} 已切换为 ${el.selectedOptions[0]?.textContent ?? el.value}，下一轮对话生效`);
  } catch (err) { toast(err.message); choices.delete(agent); renderDrawer(); }
});

const evSig = (e) => `${e.kind}|${e.status ?? ''}|${e.text?.length ?? 0}|${e.output?.length ?? 0}|${e.title ?? ''}|${e.entries?.length ?? 0}`;
let dSigs = [];
function renderDrawer(toEnd) {
  const d = $('#drawer'), run = S.run, sel = S.sel;
  // 正在下拉选模型时不重绘，否则选项会被实时输出冲掉
  if (sel && !d.hidden && document.activeElement?.matches?.('#drawer select')) return;
  if (!sel) { d.hidden = true; return; }
  const body0 = $('.d-body', d), atBottom = !body0 || body0.scrollHeight - body0.scrollTop - body0.clientHeight < 60;
  let html, evs = null;
  if (sel.startsWith('agent:')) {
    const a = agentOf(sel.slice(6)), st = agentState(a.id);
    html = `<div class="d-head"><div class="d-title">${badge(a.id)}<h2>${esc(a.name)}</h2><button class="d-x" data-act="close">✕</button></div>
      <div class="d-meta">${esc(TIER[a.tier] ?? '主力')} · 模型 ${esc(a.model ?? '—')} · ${a.custom ? `自定义 · ${esc(a.custom.baseUrl)}` : esc(a.type)} · 并发 ${a.running}/${a.maxConcurrent} · ${st.kind === 'off' ? st.label : ST_TEXT[st.kind] ?? ''}</div>${modelPicker(a.id)}
      <div class="d-actions"><button data-act="toggle-agent" data-agent="${esc(a.id)}">${a.enabled ? '停用这个 AI' : '启用这个 AI'}</button>${a.custom ? `<button data-act="edit-custom" data-agent="${esc(a.id)}">编辑接入</button>` : ''}</div></div>
      <div class="d-body">${a.type === 'claude' && !a.custom ? usageBox() : ''}
      ${a.blocked ? `<div class="d-box err">${esc(a.blocked.reason)} · ${tm(a.blocked.until)} 恢复</div>` : ''}
      ${mineHtml(a.id)}
      <div class="d-box">${esc(a.description || '（没有说明）')}</div></div>`;
  } else if (!run) { S.sel = null; d.hidden = true; return; }
  else {
    const isLeader = sel === 'leader', t = isLeader ? null : run.tasks.find(x => x.id === sel);
    if (!isLeader && !t) { S.sel = null; d.hidden = true; return; }
    const a = agentOf(isLeader ? run.leaderId : t.assignee), sid = isLeader ? run.leaderSessionId : t.agentSessionId;
    evs = S.events.get(`${run.id}:${sel}`) ?? [];
    const sibs = isLeader ? [] : run.tasks.filter(x => x.assignee === t.assignee);
    const active = isActive(run);
    const leaders = S.agents.filter(x => x.enabled && x.available && x.roles.includes('leader'));
    const swap = isLeader && leaders.length > 1 ? `<div class="d-model"><label>更换组长（等当前这一轮结束后交接，附目标和进度）<select data-swap-leader>${leaders.map(x => `<option value="${esc(x.id)}" ${x.id === run.leaderId ? 'selected' : ''}>${esc(x.name)}${x.model ? ` · ${esc(x.model)}` : ''}</option>`).join('')}</select></label></div>` : '';
    const runActs = isLeader ? `
      ${RESUMABLE.includes(run.status) ? '<button class="primary" data-act="resume-run">继续运行</button>' : ''}
      ${run.git && !run.git.merged && !active ? '<button data-act="merge-run">合并到工作目录</button>' : ''}
      ${active ? '<button class="danger" data-act="cancel-run">取消编排</button>' : '<button class="danger" data-act="delete-run">删除记录</button>'}` : '';
    html = `<div class="d-head">
      <div class="d-title">${badge(a.id)}<h2>${isLeader ? `组长 · ${esc(oneLine(run.goal))}` : `${esc(t.id)} · ${esc(t.title)}`}</h2><span class="pill ${isLeader ? run.status : t.status}">${esc(isLeader ? STATUS[run.status] ?? run.status : TS[t.status] ?? t.status)}</span><button class="d-x" data-act="close">✕</button></div>
      ${swap}${modelPicker(a.id)}
      <div class="d-meta">${sid ? `会话 ${esc(sid)}` : '尚未建立会话'}${t?.tokens ? ` · ${t.tokens.est ? '≈' : ''}${kfmt(t.tokens.in + t.tokens.out)} tok` : ''}${t?.cost ? ` · $${t.cost.toFixed(3)}` : ''}</div>
      <div class="d-meta">目录 ${esc(isLeader ? run.workdir : t.worktree || run.workdir)}${t?.branch ? `（分支 ${esc(t.branch)}）` : ''}</div>
      <div class="d-actions">
        ${(a.native ?? []).map((label, i) => `<button data-open="${i}">${esc(label)}</button>`).join('')}
        <button data-open="folder">打开工作目录</button>
        ${t && ['pending', 'running', 'review'].includes(t.status) ? '<button class="danger" data-act="cancel-task">取消此任务</button>' : ''}
        ${runActs}
      </div>
      ${sibs.length > 1 ? `<div class="tabs">${sibs.map(x => `<button class="${x.id === sel ? 'on' : ''}" data-task="${esc(x.id)}">${esc(x.id)} ${esc(TS[x.status] ?? '')}</button>`).join('')}</div>` : ''}
    </div>
    <div class="d-body">
      ${isLeader && run.error ? `<div class="d-box err">${esc(run.error)}${RESUMABLE.includes(run.status) ? '<br>修好原因后可以点「继续运行」。' : ''}</div>` : ''}
      ${isLeader && run.summary ? `<div class="d-box"><b>组长汇报</b><div class="md">${md(run.summary)}</div></div>` : ''}
      ${isLeader && run.analysis ? `<div class="d-box"><b>拆分思路</b><div>${esc(run.analysis)}</div></div>` : ''}
      ${isLeader && run.guidance ? `<div class="d-box"><b>团队约定</b><div>${esc(run.guidance)}</div></div>` : ''}
      ${t ? `<details class="d-box"><summary>任务说明</summary><div class="md">${md(t.prompt)}</div>${t.feedback ? `<p><b>组长反馈：</b>${esc(t.feedback)}</p>` : ''}${t.note ? `<p class="muted">${esc(t.note)}</p>` : ''}</details>` : ''}
      <div class="stream"></div>
    </div>`;
  }
  d.hidden = false;
  const shell = `${sel}\u0000${html}`, st0 = evs && $('.stream', d);
  if (st0 && d.dataset.shell === shell && evs.length >= dSigs.length) {
    const sigs = evs.map(evSig);
    for (let i = 0; i < sigs.length; i++) if (sigs[i] !== dSigs[i]) {
      const h = `<div class="evw">${renderEvent(evs[i])}</div>`;
      if (st0.children[i]) st0.children[i].outerHTML = h; else st0.insertAdjacentHTML('beforeend', h);
    }
    dSigs = sigs;
  } else {
    d.innerHTML = html;
    d.dataset.shell = evs ? shell : '';
    const st = $('.stream', d);
    if (st) st.innerHTML = evs.length ? evs.map(e => `<div class="evw">${renderEvent(e)}</div>`).join('') : '<div class="ev info">还没有输出</div>';
    dSigs = evs?.length ? evs.map(evSig) : [];
  }
  const b = $('.d-body', d);
  // 组长抽屉在编排结束后先给看汇报，其余跟随最新输出
  if (b && toEnd && sel === 'leader' && run?.summary) b.scrollTop = 0;
  else if (b && (toEnd || atBottom)) b.scrollTop = b.scrollHeight;
}

const delNote = (r) => (r.autoWorkdir ? `\n自动新建的工作目录 ${r.workdir} 会一起删掉。` : '\n你自己的工作目录不会动。');

// ───── 事件委托 ─────
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act],[data-task],[data-card],[data-open],[data-approve],[data-close],[data-del],[data-run]');
  if (!el) return;
  const run = S.run;
  try {
    if (el.dataset.close !== undefined) return el.closest('dialog').close();
    if (el.dataset.approve) return await api('POST', `/api/approvals/${el.dataset.approve}`, { allow: el.dataset.allow === '1' });
    if (el.dataset.del) {
      const r = S.runs.find(x => x.id === el.dataset.del);
      if (!r || !confirm(`删除编排记录「${oneLine(r.goal).slice(0, 30)}」？${delNote(r)}`)) return;
      return await api('DELETE', `/api/runs/${r.id}`);
    }
    if (el.dataset.run) return el.dataset.run !== run?.id && await openRun(el.dataset.run);
    if (el.dataset.task) return await openDrawer(el.dataset.task);
    if (el.dataset.card) return await openDrawer(`agent:${el.dataset.card}`);
    if (el.dataset.open) {
      const index = el.dataset.open === 'folder' ? 'folder' : Number(el.dataset.open);
      await api('POST', `/api/runs/${run.id}/tasks/${S.sel}/open`, { index });
      return toast('已打开');
    }
    switch (el.dataset.act) {
      case 'close': return closeDrawer();
      case 'reload-models': choices.delete(el.dataset.agent); return renderDrawer();
      case 'toggle-agent': {
        const a = agentOf(el.dataset.agent);
        await api('PUT', `/api/agents/${a.id}/enabled`, { enabled: !a.enabled });
        return toast(`${a.name} 已${a.enabled ? '停用' : '启用'}`);
      }
      case 'edit-custom': await openModels(); return editModel(el.dataset.agent);
      case 'cancel-task': if (confirm('取消这个任务？')) await api('POST', `/api/runs/${run.id}/tasks/${S.sel}/cancel`); return;
      case 'cancel-run': if (confirm('取消整个编排？正在干活的 AI 会被停掉。')) await api('POST', `/api/runs/${run.id}/cancel`); return;
      case 'resume-run': await api('POST', `/api/runs/${run.id}/resume`); return toast('已继续运行');
      case 'merge-run':
        if (!confirm(`把分支 ${run.git.branch} 合并进 ${run.workdir} 的当前分支？`)) return;
        await api('POST', `/api/runs/${run.id}/merge`);
        return toast('已合并');
      case 'delete-run':
        if (!confirm(`删除这条编排记录？${delNote(run)}`)) return;
        await api('DELETE', `/api/runs/${run.id}`);
        return;
    }
  } catch (err) { toast(err.message); }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.sel && !document.querySelector('dialog[open]')) closeDrawer(); });
$('#btnNewChat').addEventListener('click', async () => { await openRun(null); $('#cmdIn').focus(); });

// ───── 打开某个编排（id 为空 = 新对话）：拉完整数据，回放历史事件生成遥测和图表 ─────
async function openRun(id) {
  S.run = id ? await api('GET', `/api/runs/${id}`) : null;
  S.sel = null;
  S.events = new Map();
  log = []; tools.clear(); firstChunk.clear(); PTS.length = 0; flashRows.clear();
  samples = []; toolCells = []; tokPts = []; tokIn = tokOut = 0; lastGain = null; talk = 0;
  for (const k of Object.keys(live)) delete live[k];
  lastTasks = new Map(); lastRunStatus = null; leaderFocus = null;
  introT0 = performance.now(); // 切换编排时晶格重新展开一次
  G.dirty = true; qs.hold = performance.now() + 4000;
  // 只在本窗口内记住（刷新还在这条），重新打开应用就是新对话
  try { sessionStorage.setItem('hub.view', id ?? ''); } catch { /* 忽略 */ }
  if (S.run) {
    const run = S.run, all = [];
    for (const tid of ['leader', ...run.tasks.map(t => t.id)]) {
      const evs = await api('GET', `/api/runs/${run.id}/events/${tid}`);
      S.events.set(`${run.id}:${tid}`, evs);
      for (const ev of evs) all.push({ tid, ev });
    }
    all.sort((a, b) => (a.ev.ts ?? 0) - (b.ev.ts ?? 0));
    all.forEach(({ tid, ev }) => absorb(run, tid, ev, true));
    for (const t of run.tasks) if (live[t.id]) live[t.id].chars = t.status === 'running' ? live[t.id].chars : 0;
    diffRun(run);
  }
  renderSide();
  renderDrawer();
  panels();
}

function upsertRunSummary(run) {
  const sum = { id: run.id, goal: run.goal, status: run.status, createdAt: run.createdAt, leaderId: run.leaderId, workdir: run.workdir, autoWorkdir: run.autoWorkdir, total: run.tasks.length, done: run.tasks.filter(t => t.status === 'done').length };
  const i = S.runs.findIndex(r => r.id === run.id);
  if (i >= 0) S.runs[i] = sum; else S.runs.unshift(sum);
  renderSide();
}

setupNewRun(async (run) => { upsertRunSummary(run); await openRun(run.id); });

// ───── 实时更新 ─────
let drawerQueued = false;
function connect() {
  const es = new EventSource('/api/stream');
  es.addEventListener('agents', (m) => { S.agents = JSON.parse(m.data).agents; if (S.sel) renderDrawer(); });
  es.addEventListener('approvals', (m) => { S.approvals = JSON.parse(m.data); renderApprovals(); });
  es.addEventListener('removed', (m) => {
    const { id } = JSON.parse(m.data);
    S.runs = S.runs.filter(r => r.id !== id);
    if (S.run?.id === id) openRun(null); else renderSide();
  });
  es.addEventListener('run', (m) => {
    const run = JSON.parse(m.data);
    upsertRunSummary(run);
    if (S.run?.id !== run.id) return; // 别的编排只更新侧栏，不抢当前视图
    S.run = run;
    diffRun(run);
    if (S.sel && S.sel !== 'leader' && !S.sel.startsWith('agent:')) renderDrawer();
  });
  es.addEventListener('ev', (m) => {
    const { runId, taskId, ev } = JSON.parse(m.data);
    if (S.run?.id !== runId) return;
    const key = `${runId}:${taskId}`;
    if (!S.events.has(key)) S.events.set(key, []);
    mergeEvent(S.events.get(key), ev);
    absorb(S.run, taskId, ev, false);
    if (S.sel === taskId && !drawerQueued) {
      drawerQueued = true;
      setTimeout(() => { drawerQueued = false; renderDrawer(); }, 200); // 流式输出很密，抽屉最多 5 次 / 秒
    }
  });
}

(async function init() {
  const st = await api('GET', '/api/state');
  Object.assign(S, { agents: st.agents, runs: st.runs, approvals: st.approvals, defaults: st.defaults, workspaceRoot: st.workspaceRoot });
  $('#ver').textContent = `v${st.version}`;
  applyTheme();
  let id = '';
  try { id = sessionStorage.getItem('hub.view') ?? ''; } catch { /* 忽略 */ }
  await openRun(S.runs.some(r => r.id === id) ? id : null);
  connect();
  setInterval(panels, 500);
  requestAnimationFrame(frame);
  if (!S.run) $('#cmdIn').focus();
})().catch(err => toast(`加载失败：${err.message}`));
