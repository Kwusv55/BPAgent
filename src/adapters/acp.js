// 通用 ACP（Agent Client Protocol）客户端：一个任务一个子进程，stdio 上跑换行分隔的 JSON-RPC
import readline from 'node:readline';
import { EventEmitter } from 'node:events';
import { buildEnv, expand, killTree, spawnAgent, hubMcpServer, VERSION } from '../util.js';

const textOf = (content) => {
  if (!content) return '';
  if (Array.isArray(content)) return content.map(textOf).filter(Boolean).join('\n');
  if (content.type === 'content') return textOf(content.content);
  if (content.type === 'text') return content.text ?? '';
  if (content.type === 'diff') return `[diff] ${content.path ?? ''}\n${content.newText ?? ''}`;
  return '';
};

export class AcpSession extends EventEmitter {
  constructor(agent, { cwd, approve, resumeId, hub, ctx, fresh }) {
    super();
    this.agent = agent;
    this.fresh = fresh;
    this.applied = {};         // 已经设到会话上的 configOptions，切换模型时只补发变化的项
    // 编排台的 ask_leader 工具，按 ACP 的 McpServer 格式（env 是 name/value 数组）
    const m = hub && ctx ? hubMcpServer(hub, ctx, 'ask_leader') : null;
    this.mcpServers = m ? [{ name: 'hub', command: m.command, args: m.args, env: Object.entries(m.env).map(([name, value]) => ({ name, value })) }] : [];
    this.cwd = cwd;
    this.approve = approve;
    this.resumeId = resumeId ?? null;
    this.restored = false;
    this.sessionId = null;
    this.pending = new Map();
    this.nextId = 1;
    this.stderrTail = [];
    this.closed = false;
    this.messages = new Map(); // mid → 文本，用来取本轮最后一条回复
    this.tools = new Map();    // toolCallId → {title, input}，授权请求里常常只带 id
  }

  async start() {
    const a = this.agent;
    this.proc = spawnAgent(a.command, (a.args ?? []).map(expand), {
      cwd: this.cwd, env: buildEnv(a), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    this.proc.on('error', (e) => this._failAll(e));
    this.proc.on('exit', (code) => {
      this.closed = true;
      this._failAll(new Error(`${a.name} 进程退出（code=${code}）${this.stderrTail.length ? '：' + this.stderrTail.join(' | ').slice(-600) : ''}`));
    });
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (d) => {
      this.stderrTail.push(...d.split(/\r?\n/).filter(Boolean));
      this.stderrTail = this.stderrTail.slice(-12);
    });
    readline.createInterface({ input: this.proc.stdout }).on('line', (l) => this._onLine(l));

    await this._call('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'agent-hub', version: VERSION },
    });
    // 中断后续跑：先尝试续接原会话（ACP session/resume），不支持或失败就开新会话
    if (this.resumeId) {
      try {
        await this._withMcp(mcpServers => this._call('session/resume', { sessionId: this.resumeId, cwd: this.cwd, mcpServers }));
        this.sessionId = this.resumeId;
        this.restored = true;
      } catch (e) {
        this.emit('event', { kind: 'info', text: `原会话无法续接（${e.message}），改用新会话` });
      }
    }
    if (!this.sessionId) {
      const s = await this._withMcp(mcpServers => this._call('session/new', { cwd: this.cwd, mcpServers }));
      this.sessionId = s.sessionId;
      // 可选的模型 / 思考强度等配置项，编排台的「切换模型」用它当候选列表
      if (s.configOptions) { this.configOptions = s.configOptions; this.emit('options', s.configOptions); }
    }
    this.emit('session', this.sessionId);
    await this._applyConfig(a);
    this.emit('event', { kind: 'info', text: `${this.restored ? '已续接会话' : '会话已建立'} ${this.sessionId}` });
  }

  // 带上编排台 MCP 建会话；agent 不认这个 MCP 配置时退回不带，ask_leader 就不可用
  async _withMcp(fn) {
    if (!this.mcpServers.length) return fn([]);
    try { return await fn(this.mcpServers); } catch (e) {
      this.emit('event', { kind: 'info', text: `挂载 ask_leader 工具失败（${e.message ?? e}），本会话不能向组长提问` });
      this.mcpServers = [];
      return fn([]);
    }
  }

  async _applyConfig(agent) {
    for (const [configId, value] of Object.entries(agent.acp?.configOptions ?? {})) {
      if (this.applied[configId] === value) continue;
      try {
        await this._call('session/set_config_option', { sessionId: this.sessionId, configId, value });
        this.applied[configId] = value;
      } catch (e) {
        this.emit('event', { kind: 'info', text: `设置 ${configId} 失败：${e.message ?? e}` });
      }
    }
  }

  async prompt(text) {
    if (this.fresh) await this._applyConfig(this.fresh() ?? this.agent); // 编排台切换了模型：下一轮生效
    this.messages.clear();
    this.lastMid = null;
    const r = await this._call('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text }] });
    const reply = (this.lastMid && this.messages.get(this.lastMid)) || [...this.messages.values()].join('\n');
    return { text: reply.trim(), stopReason: r?.stopReason };
  }

  cancel() {
    if (this.sessionId && !this.closed) this._send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: this.sessionId } });
  }

  close() {
    this.closed = true;
    killTree(this.proc?.pid);
  }

  _send(msg) {
    if (!this.closed) this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  _call(method, params) {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('会话已关闭'));
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this._send({ jsonrpc: '2.0', id, method, params });
    });
  }

  _failAll(err) {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  _onLine(line) {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.id != null && !m.method) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message ?? JSON.stringify(m.error))) : p.resolve(m.result);
      return;
    }
    if (m.method === 'session/update') return this._onUpdate(m.params?.update ?? {});
    if (m.method === 'session/request_permission') return this._onPermission(m);
    if (m.id != null) this._send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `agent-hub 不支持 ${m.method}` } });
  }

  _onUpdate(u) {
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        const mid = u.messageId ?? 'm';
        const t = textOf(u.content);
        this.messages.set(mid, (this.messages.get(mid) ?? '') + t);
        this.lastMid = mid;
        return this.emit('event', { kind: 'message', mid, text: t, chunk: true });
      }
      case 'agent_thought_chunk':
        return this.emit('event', { kind: 'thought', mid: u.messageId ?? 't', text: textOf(u.content), chunk: true });
      case 'tool_call':
        this.tools.set(u.toolCallId, { title: u.title, input: u.rawInput });
        return this.emit('event', { kind: 'tool', toolId: u.toolCallId, title: u.title, toolKind: u.kind, input: u.rawInput, status: u.status ?? 'in_progress', output: textOf(u.content) || undefined });
      case 'tool_call_update':
        return this.emit('event', { kind: 'tool', toolId: u.toolCallId, title: u.title ?? undefined, status: u.status ?? undefined, output: textOf(u.content) || undefined });
      case 'plan':
        return this.emit('event', { kind: 'plan', entries: (u.entries ?? []).map(e => ({ text: e.content, status: e.status })) });
      case 'usage_update':
        return this.emit('usage', { used: u.used, size: u.size });
      default:
        return undefined;
    }
  }

  async _onPermission(m) {
    const { toolCall = {}, options = [] } = m.params ?? {};
    const known = this.tools.get(toolCall.toolCallId) ?? {};
    let allow = false;
    try {
      allow = await this.approve({ title: toolCall.title ?? known.title ?? '工具调用', input: toolCall.rawInput ?? known.input, toolKind: toolCall.kind });
    } catch { allow = false; }
    const pick = (kinds) => options.find(o => kinds.includes(o.kind));
    const opt = allow ? pick(['allow_once', 'allow_always']) : pick(['reject_once', 'reject_always']);
    const outcome = opt ? { outcome: 'selected', optionId: opt.optionId } : { outcome: 'cancelled' };
    this._send({ jsonrpc: '2.0', id: m.id, result: { outcome } });
  }
}
