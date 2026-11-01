// 自定义模型：用户自己的反代 / 中转（请求地址 + API Key + 模型名）。
// 不另写对话循环，而是套在现成的 CLI 上跑，工具调用、改文件、续接会话、ask_leader 都沿用该 CLI：
//   Anthropic Messages → Claude Code（ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN）
//   OpenAI Responses   → Codex（-c model_providers.*，Codex 0.16x 起不再支持 chat 协议）
//   三种协议都可以     → DeepSeek Harness（pi-ai 内核，按协议生成 --patch 文件）
// API Key 存在 config/secrets.json（已加进 .gitignore），agents.json 里只有地址和模型名。
import fs from 'node:fs';
import path from 'node:path';

export const PROTOCOLS = {
  'anthropic-messages': { label: 'Anthropic Messages', path: '/v1/messages', drivers: ['claude', 'dsh'] },
  'openai-responses': { label: 'OpenAI Responses', path: '/v1/responses', drivers: ['codex', 'dsh'] },
  'openai-completions': { label: 'OpenAI Chat Completions', path: '/v1/chat/completions', drivers: ['dsh'] },
};
export const DRIVERS = { claude: 'Claude Code', codex: 'Codex', dsh: 'DeepSeek Harness' };
const KEY_ENV = 'BPHUB_API_KEY';

// 用户填的地址统一规整：Anthropic 不带 /v1（SDK 自己拼）；OpenAI 只填了域名时补 /v1，带了路径的原样用
export function normalizeBase(url, protocol) {
  let u = String(url ?? '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(u)) throw new Error('请求地址要以 http:// 或 https:// 开头');
  if (protocol === 'anthropic-messages') return u.replace(/\/v1$/i, '');
  return new URL(u).pathname.replace(/\/+$/, '') ? u : `${u}/v1`;
}

export function validateCustom(a) {
  const c = a.custom;
  const p = PROTOCOLS[c.protocol];
  if (!p) return `${a.id}: custom.protocol 只能是 ${Object.keys(PROTOCOLS).join(' / ')}`;
  if (!p.drivers.includes(c.driver)) return `${a.id}: ${c.protocol} 只能用 ${p.drivers.join(' / ')} 驱动`;
  if (!c.baseUrl) return `${a.id}: 缺少请求地址 custom.baseUrl`;
  try { normalizeBase(c.baseUrl, c.protocol); } catch (e) { return `${a.id}: ${e.message}`; }
  if (!c.model) return `${a.id}: 缺少模型名 custom.model`;
  return null;
}

// ───── 密钥 ─────
export class Secrets {
  constructor(file) { this.file = file; }
  all() { try { return JSON.parse(fs.readFileSync(this.file, 'utf8')).keys ?? {}; } catch { return {}; } }
  get(id) { return this.all()[id] ?? ''; }
  set(id, key) {
    const keys = this.all();
    if (key) keys[id] = key; else delete keys[id];
    fs.writeFileSync(this.file, JSON.stringify({ keys }, null, 2) + '\n');
  }
}

// 把 agents.json 里的自定义条目展开成适配器认识的完整配置。驱动的可执行文件借用同类型的内置 AI
export function materialize(a, all, { secrets, dataDir }) {
  const c = a.custom, key = secrets.get(a.id);
  const tpl = (type) => all.find(x => x.type === type && !x.custom);
  const base = { ...a, native: [] };
  if (c.driver === 'claude') {
    const url = normalizeBase(c.baseUrl, c.protocol);
    return {
      ...base, type: 'claude', command: tpl('claude')?.command ?? 'claude', args: [],
      claude: { model: c.model, ...(c.effort && { effort: c.effort }), permissionMode: 'acceptEdits', strictMcp: true, lean: true },
      env: {
        ANTHROPIC_BASE_URL: url, ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_MODEL: c.model,
        // 后台的小模型调用（标题、摘要等）也走同一个模型，反代上不一定有 haiku
        ANTHROPIC_DEFAULT_OPUS_MODEL: c.model, ANTHROPIC_DEFAULT_SONNET_MODEL: c.model, ANTHROPIC_DEFAULT_HAIKU_MODEL: c.model, ANTHROPIC_SMALL_FAST_MODEL: c.model,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
      unsetEnv: ['ANTHROPIC_API_KEY'],
    };
  }
  if (c.driver === 'codex') {
    const url = normalizeBase(c.baseUrl, c.protocol), q = JSON.stringify, pid = `bphub_${a.id.replace(/\W/g, '_')}`;
    return {
      ...base, type: 'codex', command: tpl('codex')?.command ?? '${env:LOCALAPPDATA}\\OpenAI\\Codex\\bin\\*\\codex.exe', args: [],
      codex: {
        model: c.model, ...(c.effort && { effort: c.effort }),
        config: [`model_provider=${q(pid)}`, `model_providers.${pid}.name=${q(a.name ?? a.id)}`, `model_providers.${pid}.base_url=${q(url)}`,
          `model_providers.${pid}.env_key=${q(KEY_ENV)}`, `model_providers.${pid}.wire_api="responses"`],
      },
      env: { [KEY_ENV]: key },
    };
  }
  // dsh：生成一份只含这个 provider 的 patch（JSON 也是合法 YAML），key 走环境变量
  const t = tpl('acp') ?? {};
  const args = [...(t.args ?? [])];
  const pi = args.indexOf('--patch');
  if (pi >= 0) args.splice(pi, 2);
  const dir = path.join(dataDir, 'custom');
  fs.mkdirSync(dir, { recursive: true });
  const patch = path.join(dir, `${a.id}.patch.yml`);
  fs.writeFileSync(patch, JSON.stringify([
    { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: { bphub: { apiKeyEnv: KEY_ENV, api: c.protocol, baseURL: normalizeBase(c.baseUrl, c.protocol), models: [{ id: c.model, name: c.model }] } } } },
    { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model', config: { provider: 'bphub', model: c.model } },
  ], null, 2));
  return {
    ...base, type: 'acp', command: t.command ?? 'dsh', args: [...args, '--patch', patch],
    env: { ...(t.env ?? {}), [KEY_ENV]: key }, unsetEnv: ['DEEPSEEK_API_KEY'], acp: {},
  };
}

// 向反代要模型列表（OpenAI 和 Anthropic 都是 GET …/models），顺便当连通性测试
export async function fetchModels({ protocol, baseUrl, apiKey }) {
  const url = normalizeBase(baseUrl, protocol);
  const list = protocol === 'anthropic-messages' ? `${url}/v1/models?limit=1000` : `${url}/models`;
  const r = await fetch(list, {
    headers: { authorization: `Bearer ${apiKey}`, 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    signal: AbortSignal.timeout(15_000),
  }).catch(e => { throw new Error(`连不上 ${list}：${e.cause?.code ?? e.message}`); });
  const text = await r.text();
  if (!r.ok) throw new Error(`${list} 返回 ${r.status}：${text.slice(0, 200)}`);
  let j;
  try { j = JSON.parse(text); } catch { throw new Error(`${list} 返回的不是 JSON：${text.slice(0, 120)}`); }
  return (j.data ?? j.models ?? []).map(m => (typeof m === 'string' ? m : m.id ?? m.name)).filter(Boolean).sort();
}
