// agent 注册表：config/agents.json 热加载 + 运行时状态（命令是否存在、在跑几个、额度）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { resolveCommand, clearCommandCache } from './util.js';
import { materialize, validateCustom } from './custom.js';

const TYPES = ['acp', 'claude', 'codex'];

export function validateAgents(cfg) {
  if (!cfg || !Array.isArray(cfg.agents)) return '顶层必须是 {"agents": [...]}';
  const ids = new Set();
  for (const a of cfg.agents) {
    if (!a.id || !/^[a-z0-9_-]+$/i.test(a.id)) return `agent id 不合法：${a.id}`;
    if (ids.has(a.id)) return `agent id 重复：${a.id}`;
    ids.add(a.id);
    if (a.custom) { const err = validateCustom(a); if (err) return err; continue; }
    if (!TYPES.includes(a.type)) return `${a.id}: type 只能是 ${TYPES.join(' / ')}`;
    if (!a.command) return `${a.id}: 缺少 command`;
  }
  return null;
}

export class Registry extends EventEmitter {
  // opts: { secrets, dataDir }，展开自定义模型时用
  constructor(file, opts = {}) {
    super();
    this.file = file;
    this.opts = opts;
    this.agents = [];
    this.running = new Map();
    this.quota = new Map();
    this.acpOptions = new Map(); // id → ACP 会话自报的可选配置（模型列表等），切换模型时用
    this.blocked = new Map();  // id → {until, hard, reason}；hard=真用尽，否则只是到了 quotaPause 阈值
    this.timers = new Map();
    this.error = null;
    this.load();
    fs.watchFile(file, { interval: 1000 }, () => this.load());
  }

  load() {
    try {
      const cfg = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const err = validateAgents(cfg);
      if (err) throw new Error(err);
      clearCommandCache();
      this.agents = cfg.agents.map(a => (a.custom ? materialize(a, cfg.agents, this.opts) : a)).map(a => ({
        roles: ['leader', 'member'], maxConcurrent: 2, enabled: true, color: '#888', ...a,
        available: !!resolveCommand(a.command),
      }));
      this.error = null;
    } catch (e) {
      // 配置写坏时保留上一份可用配置，只报错
      this.error = `agents.json 加载失败：${e.message}`;
    }
    this.emit('change');
  }

  get(id) { return this.agents.find(a => a.id === id); }

  usable(id) {
    const a = this.get(id);
    return a && a.enabled && a.available ? a : null;
  }

  raw() { return fs.readFileSync(this.file, 'utf8'); }

  save(text) {
    const cfg = JSON.parse(text);
    const err = validateAgents(cfg);
    if (err) throw new Error(err);
    fs.writeFileSync(this.file, JSON.stringify(cfg, null, 2) + '\n');
    this.load();
  }

  inc(id) { this.running.set(id, (this.running.get(id) ?? 0) + 1); this.emit('change'); }
  dec(id) { this.running.set(id, Math.max(0, (this.running.get(id) ?? 1) - 1)); this.emit('change'); }
  hasCapacity(id) { const a = this.get(id); return (this.running.get(id) ?? 0) < (a?.maxConcurrent ?? 1); }
  setQuota(id, q) {
    this.quota.set(id, { ...q, at: Date.now() });
    const five = q?.unifiedWindows?.five_hour;
    const pause = this.get(id)?.quotaPause;
    if (q?.status === 'rejected' && q.resetsAt) this.block(id, q.resetsAt * 1000, true);
    else if (pause && five?.utilization >= pause) this.block(id, five.resetsAt * 1000, false, `5 小时用量已到 ${Math.round(five.utilization * 100)}%，暂停派新任务`);
    else if (this.blocked.has(id) && q?.status === 'allowed') this._unblock(id); // 已经恢复
    this.emit('change');
  }

  // 封锁到 until（毫秒）；到点后自动解封并发出 'unblocked'，编排器据此续跑
  block(id, until, hard, reason = '额度已用尽') {
    if (!until) until = Date.now() + 30 * 60_000; // 拿不到恢复时间：半小时后再试
    if (until <= Date.now()) return;
    const cur = this.blocked.get(id);
    if (cur && cur.until >= until && (cur.hard || !hard)) return;
    this.blocked.set(id, { until, hard: !!hard, reason });
    clearTimeout(this.timers.get(id));
    this.timers.set(id, setTimeout(() => this._unblock(id), until - Date.now() + 20_000));
    this.emit('change');
  }

  _unblock(id) {
    clearTimeout(this.timers.get(id));
    this.blocked.delete(id);
    this.emit('change');
    this.emit('unblocked', id);
  }

  // hardOnly：只看真用尽（组长/在跑的任务据此等待）；否则阈值暂停也算（调度新任务用）
  blockedUntil(id, hardOnly = false) {
    const b = this.blocked.get(id);
    if (!b || (hardOnly && !b.hard)) return 0;
    return b.until + 20_000 > Date.now() ? b.until : 0;
  }

  snapshot() {
    return {
      error: this.error,
      agents: this.agents.map(a => ({
        id: a.id, name: a.name ?? a.id, color: a.color, type: a.type, enabled: a.enabled, available: a.available, model: modelOf(a), effort: a.codex?.effort ?? a.acp?.configOptions?.reasoning_effort ?? null,
        description: a.description ?? '', tier: a.tier ?? 'main', roles: a.roles, maxConcurrent: a.maxConcurrent,
        running: this.running.get(a.id) ?? 0, quota: this.quota.get(a.id) ?? null,
        blocked: this.blocked.get(a.id) ?? null,
        native: (a.native ?? []).map(n => n.label),
        custom: a.custom ? { ...a.custom, hasKey: !!this.opts.secrets?.get(a.id) } : null,
      })),
    };
  }
}

// 展示用的模型名：Claude 取 claude.model；ACP 的 model 配置项形如 '["relay","deepseek-v4.1-flash"]'，取最后一段
function modelOf(a) {
  if (a.custom) return a.custom.model;
  if (a.model) return a.model;
  if (a.claude?.model) return a.claude.model;
  if (a.codex?.model) return a.codex.model;
  if (a.type === 'codex') return codexDefaultModel();
  const m = a.acp?.configOptions?.model;
  if (!m) return null;
  try { const v = JSON.parse(m); return Array.isArray(v) ? v[v.length - 1] : String(v); } catch { return String(m); }
}

// Codex 没在 agents.json 里指定模型时，用 ~/.codex/config.toml 顶层的 model（第一个 [section] 之前）
function codexDefaultModel() {
  try {
    const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    const top = fs.readFileSync(path.join(home, 'config.toml'), 'utf8').split(/^\s*\[/m)[0];
    return top.match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1] ?? null;
  } catch { return null; }
}
