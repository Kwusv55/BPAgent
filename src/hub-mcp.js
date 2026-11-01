// 编排台给 AI 用的最小 stdio MCP 服务，两个工具：
// - approve：Claude Code 的 --permission-prompt-tool。授权请求 → 提交给编排台 → 长轮询等网页上的决定 → 回 allow/deny
// - ask_leader：队员遇到阻塞时向组长提问。问题 → 编排台转给组长 → 长轮询等组长回答 → 原样返回
// HUB_TOOLS 控制暴露哪些工具（逗号分隔，默认两个都给；Codex / ACP 只给 ask_leader）
import readline from 'node:readline';

const { HUB_URL, HUB_TOKEN, HUB_CTX, HUB_TOOLS } = process.env;
const ctx = JSON.parse(HUB_CTX || '{}');
const enabled = new Set((HUB_TOOLS || 'approve,ask_leader').split(','));
const headers = { 'content-type': 'application/json', 'x-hub-token': HUB_TOKEN };
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const post = (p, body) => fetch(`${HUB_URL}${p}`, { method: 'POST', headers, body: JSON.stringify(body) }).then(x => x.json());
const get = (p) => fetch(`${HUB_URL}${p}`, { headers }).then(x => x.json());

const TOOLS = {
  approve: {
    description: '向编排台请求工具调用授权',
    inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, required: ['tool_name', 'input'] },
    async call({ tool_name, input }) {
      let decision;
      try {
        const r = await post('/api/approvals/request', { ...ctx, title: tool_name, input });
        let d = r;
        while (!d.decided) d = await get(`/api/approvals/${r.id}/wait`);
        decision = d.allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: d.message || '用户在编排台拒绝了这次操作' };
      } catch (e) {
        decision = { behavior: 'deny', message: `编排台不可达：${e.message}` };
      }
      return JSON.stringify(decision);
    },
  },
  ask_leader: {
    description: '遇到靠自己解决不了的阻塞时（需求有歧义且影响结果、缺少信息或权限、和其他任务冲突），向团队组长提问并等待回答。问题要具体，说明你卡在哪、有哪些备选方案。小事不要问。',
    inputSchema: { type: 'object', properties: { question: { type: 'string', description: '要问组长的问题' } }, required: ['question'] },
    async call({ question }) {
      try {
        const r = await post('/api/ask/request', { ...ctx, question: String(question ?? '') });
        let d = r;
        while (!d.done) d = await get(`/api/ask/${r.id}/wait`);
        return `组长回答：\n${d.answer}`;
      } catch (e) {
        return `编排台不可达（${e.message}），请按最合理的假设继续，并在汇报里说明。`;
      }
    },
  },
};

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') {
    send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'agent-hub', version: '1' } } });
  } else if (m.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: m.id, result: { tools: Object.entries(TOOLS).filter(([n]) => enabled.has(n)).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) } });
  } else if (m.method === 'tools/call') {
    const tool = enabled.has(m.params?.name) ? TOOLS[m.params.name] : null;
    if (!tool) return send({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: `unknown tool ${m.params?.name}` } });
    const text = await tool.call(m.params?.arguments ?? {});
    send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text }] } });
  } else if (m.id != null) {
    send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not found' } });
  }
});
