import { spawn, execFile, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

export const uid = (prefix = '') => prefix + crypto.randomBytes(4).toString('hex');
export const now = () => Date.now();

// 读用户级环境变量：服务进程可能是在 setx 之前启动的终端里起的，进程环境里没有
const regCache = new Map();
function userEnv(name) {
  if (regCache.has(name)) return regCache.get(name);
  let v;
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', name], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    v = out.match(new RegExp(`${name}\\s+REG_(?:EXPAND_)?SZ\\s+(.*)`))?.[1]?.trim();
  } catch { /* 不存在 */ }
  regCache.set(name, v);
  return v;
}

// ${root} → 项目根目录；${env:A|B} → 依次取环境变量 A、B
export function expand(str) {
  return String(str)
    .replace(/\$\{root\}/g, ROOT)
    .replace(/\$\{env:([A-Za-z0-9_|]+)\}/g, (_, names) => {
      for (const n of names.split('|')) {
        const v = process.env[n] ?? userEnv(n);
        if (v) return v;
      }
      return '';
    });
}

// {cwd} {sessionId} {title} 之类的占位符
export const fill = (str, ctx) => String(str).replace(/\{(\w+)\}/g, (m, k) => (ctx[k] ?? m));

export function buildEnv(agent) {
  const env = { ...process.env };
  for (const [k, v] of Object.entries(agent.env ?? {})) env[k] = expand(v);
  for (const k of agent.unsetEnv ?? []) delete env[k];
  return env;
}

// 命令解析：先展开 ${env:..}；绝对路径直接查文件（目录名可以含 *，取最新的那个），裸命令走 where；结果缓存
const whereCache = new Map();
export function resolveCommand(cmd) {
  cmd = expand(cmd);
  if (path.isAbsolute(cmd)) return cmd.includes('*') ? globNewest(cmd) : fs.existsSync(cmd) ? cmd : null;
  if (whereCache.has(cmd)) return whereCache.get(cmd);
  let found = null;
  try {
    found = execFileSync('where', [cmd], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/).find(Boolean) ?? null;
  } catch { /* 没找到 */ }
  whereCache.set(cmd, found);
  return found;
}
export const clearCommandCache = () => whereCache.clear();

// 逐级展开路径里的 *（如 Codex 桌面版的 bin\<hash>\codex.exe，hash 随升级变化），多个命中取修改时间最新的
function globNewest(pattern) {
  const parts = pattern.split(/[\\/]+/);
  let cands = [parts.shift() + path.sep];
  for (const seg of parts) {
    const next = [];
    for (const dir of cands) {
      if (!seg.includes('*')) { const p = path.join(dir, seg); if (fs.existsSync(p)) next.push(p); continue; }
      const re = new RegExp(`^${seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');
      try { for (const n of fs.readdirSync(dir)) if (re.test(n)) next.push(path.join(dir, n)); } catch { /* 读不了就跳过 */ }
    }
    cands = next;
    if (!cands.length) return null;
  }
  return cands.map(p => [p, fs.statSync(p).mtimeMs]).sort((a, b) => b[1] - a[1])[0][0];
}

const quoteArg = (a) => (/[\s"&|<>^]/.test(a) || a === '' ? `"${a.replace(/"/g, '""')}"` : a);

// Node 20+ 不允许不经 shell 直接 spawn .cmd/.bat（npm 装的 CLI 多半是这种），这里统一转 cmd.exe
export function spawnAgent(command, args, opts) {
  const resolved = resolveCommand(command) ?? command;
  if (/\.(cmd|bat)$/i.test(resolved)) {
    const line = [resolved, ...args].map(quoteArg).join(' ');
    return spawn('cmd.exe', ['/d', '/s', '/c', `"${line}"`], { ...opts, windowsVerbatimArguments: true });
  }
  return spawn(resolved, args, opts);
}

// 编排台 MCP 服务（src/hub-mcp.js）的启动参数，三种适配器各自换成自己的配置格式
export function hubMcpServer(hub, ctx, tools = 'approve,ask_leader') {
  return {
    command: process.execPath,
    args: [path.join(ROOT, 'src', 'hub-mcp.js')],
    env: { HUB_URL: hub.url, HUB_TOKEN: hub.token, HUB_CTX: JSON.stringify(ctx), HUB_TOOLS: tools },
  };
}

export function killTree(pid) {
  if (!pid) return;
  execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
}

// 订阅额度用尽：resetsAt 为恢复时间（毫秒），编排器据此挂起任务、到点自动续跑
export class QuotaError extends Error {
  constructor(message, resetsAt) {
    super(message);
    this.code = 'QUOTA';
    this.resetsAt = resetsAt ?? null;
  }
}

export const hhmm = (ms) => new Date(ms).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export const clip =(s, n) => (s && s.length > n ? s.slice(0, n) + `\n…（已截断，共 ${s.length} 字）` : s ?? '');

// 从模型输出里抠 JSON：优先取最后一个能解析的 ```json 代码块，退而求其次取首尾大括号
export function extractJson(text) {
  const blocks = [...String(text).matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map(m => m[1]);
  for (const b of blocks.reverse()) {
    try { return JSON.parse(b); } catch { /* 下一个 */ }
  }
  const i = text.indexOf('{'), j = text.lastIndexOf('}');
  if (i >= 0 && j > i) {
    try { return JSON.parse(text.slice(i, j + 1)); } catch { /* 放弃 */ }
  }
  return null;
}

// 事件合并：流式分片按 mid 拼接，工具调用按 toolId 原地更新（前端有一份同样的逻辑）
export function mergeEvent(list, ev) {
  const last = list[list.length - 1];
  if (ev.chunk && last && last.kind === ev.kind && last.mid === ev.mid) {
    last.text += ev.text;
    return;
  }
  if (ev.kind === 'tool' && ev.toolId) {
    const prev = list.findLast(e => e.kind === 'tool' && e.toolId === ev.toolId);
    if (prev) {
      for (const [k, v] of Object.entries(ev)) if (v !== undefined && v !== null) prev[k] = v;
      return;
    }
  }
  list.push({ ...ev });
}
