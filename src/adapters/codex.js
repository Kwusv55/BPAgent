// Codex 适配器：每轮起一个 `codex exec --json`，第二轮起用 `codex exec resume <thread_id>` 续接同一个会话。
// 审批和沙箱沿用 ~/.codex/config.toml（exec 模式没有交互审批，编排台的「每次都问我」对它不生效）。
// 每轮读最新的 agent 配置（切换模型下一轮生效），并用 -c mcp_servers.hub 挂上编排台的 ask_leader 工具。
import readline from 'node:readline';
import { EventEmitter } from 'node:events';
import { buildEnv, expand, killTree, spawnAgent, hubMcpServer, QuotaError } from '../util.js';

const LIMIT_TEXT = /usage limit|hit your limit|quota exceeded|insufficient_quota/i;
const NOISE = /unrecognized configuration|ignoring \d+ unrecognized/i;

export class CodexSession extends EventEmitter {
  constructor(agent, { cwd, resumeId, hub, ctx, fresh }) {
    super();
    this.agent = agent;
    this.fresh = fresh;
    this.mcp = hub && ctx ? hubMcpServer(hub, ctx, 'ask_leader') : null;
    this.cwd = cwd;
    this.sessionId = resumeId ?? null;
    this.restored = !!resumeId;
    this.proc = null;
    this.closed = false;
  }

  async start() {
    this.emit('event', { kind: 'info', text: this.restored ? `续接原会话 ${this.sessionId}` : '会话将在第一轮对话时创建' });
  }

  prompt(text) {
    const agent = this.fresh?.() ?? this.agent;
    const c = agent.codex ?? {};
    const opts = ['--json', '--skip-git-repo-check'];
    if (c.model) opts.push('-m', c.model);
    if (c.profile) opts.push('-p', c.profile);
    if (c.effort) opts.push('-c', `model_reasoning_effort="${c.effort}"`);
    for (const kv of c.config ?? []) opts.push('-c', kv);
    if (this.mcp) {
      // TOML 的基本字符串和 JSON 字符串转义规则兼容，直接用 JSON.stringify
      const q = JSON.stringify;
      opts.push('-c', `mcp_servers.hub.command=${q(this.mcp.command)}`, '-c', `mcp_servers.hub.args=[${this.mcp.args.map(q).join(',')}]`,
        '-c', `mcp_servers.hub.env={${Object.entries(this.mcp.env).map(([k, v]) => `${k}=${q(v)}`).join(',')}}`,
        '-c', 'mcp_servers.hub.tool_timeout_sec=3600'); // 组长可能正忙着审查，回答要等一会儿
    }
    opts.push(...(agent.args ?? []).map(expand));
    // resume 不接受 -C，工作目录统一靠子进程 cwd
    const args = this.sessionId ? ['exec', 'resume', this.sessionId, ...opts, '-'] : ['exec', ...opts, '-'];

    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('会话已关闭'));
      const proc = this.proc = spawnAgent(agent.command, args, {
        cwd: this.cwd, env: buildEnv(agent), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      });
      let usage = null, failed = null, last = '';
      const stderr = [];
      proc.on('error', reject);
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', d => { stderr.push(d); if (stderr.length > 200) stderr.shift(); });
      proc.stdin.end(text);
      readline.createInterface({ input: proc.stdout }).on('line', (line) => {
        let m;
        try { m = JSON.parse(line); } catch { return; }
        if (m.type === 'thread.started' && m.thread_id && m.thread_id !== this.sessionId) {
          this.sessionId = m.thread_id;
          this.emit('session', this.sessionId);
          this.emit('event', { kind: 'info', text: `会话已建立 ${this.sessionId}` });
        } else if (m.type === 'turn.completed') usage = m.usage ?? null;
        else if (m.type === 'turn.failed') failed = m.error?.message ?? 'Codex 本轮失败';
        else if (m.type === 'error') { if (!NOISE.test(m.message ?? '')) this.emit('event', { kind: 'info', text: m.message }); }
        else if (m.item) { const t = this._onItem(m.type, m.item); if (t) last = t; }
      });
      proc.on('close', (code) => {
        this.proc = null;
        if (!failed && code === 0) {
          // Codex 的 input_tokens 已经包含缓存命中部分，只取 input / output 两项
          return resolve({ text: last.trim(), stopReason: 'end_turn', usage: usage && { input_tokens: usage.input_tokens ?? 0, output_tokens: usage.output_tokens ?? 0 } });
        }
        const msg = failed || (this.closed ? '已取消' : `codex 退出（code=${code}）${stderr.join('').slice(-600)}`);
        reject(!this.closed && LIMIT_TEXT.test(msg) ? new QuotaError(`Codex 额度已用尽：${msg.slice(0, 200)}`, null) : new Error(msg));
      });
    });
  }

  // 把 Codex 的 item 映射成编排台的展示事件；返回 agent_message 的文字（最后一条就是本轮回复）
  _onItem(type, it) {
    const done = type === 'item.completed';
    switch (it.type) {
      case 'agent_message':
        this.emit('event', { kind: 'message', mid: it.id, text: it.text ?? '' });
        return it.text ?? '';
      case 'reasoning':
        if (done && it.text) this.emit('event', { kind: 'thought', mid: it.id, text: it.text });
        return null;
      case 'command_execution':
        this.emit('event', {
          kind: 'tool', toolId: it.id, title: 'Shell', input: { command: it.command },
          status: !done ? 'in_progress' : it.exit_code === 0 ? 'completed' : 'failed', output: it.aggregated_output || undefined,
        });
        return null;
      case 'file_change':
        this.emit('event', {
          kind: 'tool', toolId: it.id, title: 'Edit', input: { path: (it.changes ?? []).map(c => `${c.kind} ${c.path}`).join(', ') },
          status: !done ? 'in_progress' : it.status === 'failed' ? 'failed' : 'completed',
        });
        return null;
      case 'mcp_tool_call':
        this.emit('event', {
          kind: 'tool', toolId: it.id, title: `${it.server ?? 'mcp'}.${it.tool ?? ''}`, input: it.arguments,
          status: !done ? 'in_progress' : it.status === 'failed' || it.error ? 'failed' : 'completed',
          output: it.error?.message ?? (it.result ? JSON.stringify(it.result).slice(0, 4000) : undefined),
        });
        return null;
      case 'web_search':
        this.emit('event', { kind: 'tool', toolId: it.id, title: 'WebSearch', input: { pattern: it.query }, status: done ? 'completed' : 'in_progress' });
        return null;
      case 'todo_list':
        this.emit('event', { kind: 'plan', entries: (it.items ?? []).map(x => ({ text: x.text, status: x.completed ? 'completed' : 'pending' })) });
        return null;
      case 'error':
        if (!NOISE.test(it.message ?? '')) this.emit('event', { kind: 'info', text: it.message });
        return null;
      default:
        return null;
    }
  }

  cancel() {
    killTree(this.proc?.pid);
  }

  close() {
    this.closed = true;
    killTree(this.proc?.pid);
  }
}
