import { AcpSession } from './acp.js';
import { ClaudeSession } from './claude.js';
import { CodexSession } from './codex.js';

// 统一接口：start() / prompt(text) → {text} / cancel() / close() / sessionId，
// 事件：'event'（展示用）、'quota'（额度）、'usage'（上下文用量）
export function createSession(agent, opts) {
  switch (agent.type) {
    case 'acp': return new AcpSession(agent, opts);
    case 'claude': return new ClaudeSession(agent, opts);
    case 'codex': return new CodexSession(agent, opts);
    default: throw new Error(`未知的 agent 类型：${agent.type}`);
  }
}
