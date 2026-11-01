// Claude Code 适配器：每轮起一个 `claude -p --output-format stream-json`，靠 --resume 串起同一个会话。
// 授权请求经 --permission-prompt-tool 交给 hub-mcp.js，再转回编排台网页审批；hub-mcp 同时提供 ask_leader（队员向组长提问）。
// 每轮都读最新的 agent 配置，所以在编排台切换模型后，下一轮立即生效。
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { buildEnv, expand, killTree, spawnAgent, hubMcpServer, QuotaError } from '../util.js';

const blockText = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => x.text ?? '').join('\n') : '');
const LIMIT_TEXT = /usage limit|hit your limit|limit reached|limit will reset|out of (extra )?usage/i;

// 判断一次失败是不是订阅额度用尽，是的话算出恢复时间
function quotaFrom(msg, lim) {
  if (lim?.status !== 'rejected' && !LIMIT_TEXT.test(msg)) return null;
  const m = String(msg).match(/\|(\d{10})\b/);
  let reset = m ? Number(m[1]) * 1000 : null;
  if (!reset && lim) {
    const wins = Object.values(lim.unifiedWindows ?? {}).filter(w => w.utilization >= 1).map(w => w.resetsAt);
    const cands = [lim.status === 'rejected' ? lim.resetsAt : null, ...wins].filter(Boolean);
    if (cands.length) reset = Math.max(...cands) * 1000;
  }
  return new QuotaError(`Claude 额度已用尽：${String(msg).slice(0, 200)}`, reset);
}

// 精简模式默认给的内置工具（-p 模式下 Windows 的 shell 工具叫 PowerShell）。编排台的 MCP 工具（approve / ask_leader）不受影响
const LEAN_TOOLS = {
  leader: 'Read,Grep,Glob,PowerShell,Bash',
  member: 'Read,Edit,Write,Grep,Glob,PowerShell,Bash',
};

export class ClaudeSession extends EventEmitter {
  constructor(agent, { cwd, hub, ctx, dataDir, resumeId, fresh, overrides }) {
    super();
    this.agent = agent;
    this.fresh = fresh;
    this.overrides = overrides; // 每轮由编排器决定的临时覆盖（难题换强模型等）
    this.role = ctx.taskId === 'leader' ? 'leader' : 'member';
    this.cwd = cwd;
    this.sessionId = resumeId ?? null;
    this.restored = !!resumeId;
    this.proc = null;
    this.closed = false;
    this.lastLimit = null;
    // 每个会话一份 MCP 配置，告诉审批服务这是哪个编排、哪个任务
    this.mcpConfigPath = path.join(dataDir, `mcp-${ctx.runId}-${ctx.taskId}.json`);
    fs.writeFileSync(this.mcpConfigPath, JSON.stringify({ mcpServers: { hub: hubMcpServer(hub, ctx) } }));
  }

  async start() {
    this.emit('event', { kind: 'info', text: this.restored ? `续接原会话 ${this.sessionId}` : '会话将在第一轮对话时创建' });
  }

  prompt(text) {
    const agent = this.fresh?.() ?? this.agent;
    const c = agent.claude ?? {};
    const o = this.overrides?.() ?? {};
    const model = o.model ?? c.model, effort = o.effort ?? c.effort;
    const args = ['-p', '--output-format', 'stream-json', '--verbose'];
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    if (c.permissionMode) args.push('--permission-mode', c.permissionMode);
    args.push('--mcp-config', this.mcpConfigPath, '--permission-prompt-tool', 'mcp__hub__approve');
    if (c.strictMcp) args.push('--strict-mcp-config');
    // 精简模式：不加载技能清单、只给必要的内置工具，每轮固定开销从约 2.8 万 token 降到约 7 千（Pro 额度主要省在这）
    if (c.lean !== false) {
      args.push('--disable-slash-commands', '--exclude-dynamic-system-prompt-sections');
      args.push('--tools', c.tools?.[this.role] ?? LEAN_TOOLS[this.role]);
    }
    if (o.model && o.model !== c.model) this.emit('event', { kind: 'info', text: `这一轮用 ${o.model}${o.reason ? `（${o.reason}）` : ''}` });
    if (this.sessionId) args.push('--resume', this.sessionId);
    args.push(...(agent.args ?? []).map(expand));

    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('会话已关闭'));
      const proc = this.proc = spawnAgent(agent.command, args, {
        cwd: this.cwd, env: { ...buildEnv(agent), ...(c.lean !== false && { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' }) }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      });
      let result = null;
      const stderr = [];
      proc.on('error', reject);
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', d => { stderr.push(d); });
      proc.stdin.end(text);
      readline.createInterface({ input: proc.stdout }).on('line', (line) => {
        let m;
        try { m = JSON.parse(line); } catch { return; }
        if (m.type === 'result') result = m;
        else this._onMessage(m);
      });
      proc.on('close', (code) => {
        this.proc = null;
        const out = (result?.result ?? '').trim();
        // 额度用尽时有的版本会把提示当正常结果返回，短文本命中关键词也按额度处理
        if (result && !result.is_error && !(out.length < 300 && LIMIT_TEXT.test(out))) {
          return resolve({ text: out, stopReason: result.subtype, cost: result.total_cost_usd, usage: result.usage ?? null });
        }
        const msg = result
          ? (out || `Claude 返回错误：${result.subtype}`)
          : (this.closed ? '已取消' : `claude 退出（code=${code}）${stderr.join('').slice(-600)}`);
        reject((!this.closed && quotaFrom(msg, this.lastLimit)) || new Error(msg));
      });
    });
  }

  _onMessage(m) {
    if (m.session_id && m.session_id !== this.sessionId) {
      this.sessionId = m.session_id;
      this.emit('session', this.sessionId);
      this.emit('event', { kind: 'info', text: `会话已建立 ${this.sessionId}` });
    }
    if (m.type === 'assistant') {
      const msg = m.message ?? {};
      (msg.content ?? []).forEach((b, i) => {
        if (b.type === 'text' && b.text) this.emit('event', { kind: 'message', mid: `${msg.id}:${i}`, text: b.text });
        else if (b.type === 'thinking' && b.thinking) this.emit('event', { kind: 'thought', mid: `${msg.id}:${i}`, text: b.thinking });
        else if (b.type === 'tool_use') this.emit('event', { kind: 'tool', toolId: b.id, title: b.name, input: b.input, status: 'in_progress' });
      });
    } else if (m.type === 'user') {
      for (const b of m.message?.content ?? []) {
        if (b.type === 'tool_result') {
          this.emit('event', { kind: 'tool', toolId: b.tool_use_id, status: b.is_error ? 'failed' : 'completed', output: blockText(b.content) });
        }
      }
    } else if (m.type === 'rate_limit_event') {
      this.lastLimit = m.rate_limit_info;
      this.emit('quota', m.rate_limit_info);
    } else if (m.type === 'system' && m.subtype === 'permission_denied') {
      this.emit('event', { kind: 'info', text: `权限被拒：${m.message}` });
    }
  }

  cancel() {
    killTree(this.proc?.pid);
  }

  close() {
    this.closed = true;
    killTree(this.proc?.pid);
    fs.rm(this.mcpConfigPath, { force: true }, () => {});
  }
}
