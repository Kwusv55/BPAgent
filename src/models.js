// 切换模型：按 agent 类型给出可选项（模型 / 思考强度），选好后写回 agents.json，对之后新开的任务生效
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AcpSession } from './adapters/acp.js';
import { fetchModels } from './custom.js';

const CLAUDE_MODELS = [
  { value: '', label: '默认（跟随 Claude Code 设置）' },
  { value: 'opus', label: 'Opus', desc: '最强，额度消耗最大' },
  { value: 'sonnet', label: 'Sonnet', desc: '均衡，适合大多数任务' },
  { value: 'haiku', label: 'Haiku', desc: '最快最省，适合简单活' },
];
const CODEX_EFFORT = ['low', 'medium', 'high', 'xhigh'];
const EFFORTS = { codex: CODEX_EFFORT, claude: ['low', 'medium', 'high'] };

const codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function codexTop() {
  try { return fs.readFileSync(path.join(codexHome(), 'config.toml'), 'utf8').split(/^\s*\[/m)[0]; } catch { return ''; }
}
const tomlStr = (top, key) => top.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, 'm'))?.[1] ?? null;

// 返回 [{ id, name, current, options: [{ value, label, group?, desc? }] }]
export async function listChoices(agent, registry) {
  // 自定义模型：候选来自反代的 /models；拉不到就只留当前值，抽屉里照样能看
  if (agent.custom) {
    const c = agent.custom;
    let models = [];
    try { models = await fetchModels({ ...c, apiKey: registry.opts.secrets?.get(agent.id) ?? '' }); } catch { /* 反代不提供列表 */ }
    const out = [{ id: 'model', name: '模型', current: c.model, options: withCurrent(models.map(m => ({ value: m, label: m })), c.model) }];
    if (EFFORTS[c.driver]) out.push({ id: 'effort', name: '思考强度', current: c.effort ?? '', options: [{ value: '', label: '默认' }, ...EFFORTS[c.driver].map(v => ({ value: v, label: v }))] });
    return out;
  }
  if (agent.type === 'claude') {
    return [{ id: 'model', name: '模型', current: agent.claude?.model ?? '', options: withCurrent(CLAUDE_MODELS, agent.claude?.model) }];
  }
  if (agent.type === 'codex') {
    const top = codexTop(), def = tomlStr(top, 'model'), defEffort = tomlStr(top, 'model_reasoning_effort');
    const seen = new Set(), models = [{ value: '', label: `默认（config.toml：${def ?? '未设置'}）` }];
    const add = (value, label, desc) => { if (value && !seen.has(value)) { seen.add(value); models.push({ value, label: label || value, desc }); } };
    add(def, def, '当前 config.toml 里的模型');
    for (const m of readJson(path.join(codexHome(), 'models_cache.json'))?.models ?? []) add(m.slug, m.display_name, m.description);
    for (const m of readJson(path.join(codexHome(), 'cc-switch-model-catalog.json'))?.models ?? []) add(m.slug, m.display_name);
    return [
      { id: 'model', name: '模型', current: agent.codex?.model ?? '', options: withCurrent(models, agent.codex?.model) },
      { id: 'effort', name: '思考强度', current: agent.codex?.effort ?? '', options: [{ value: '', label: `默认（${defEffort ?? '未设置'}）` }, ...CODEX_EFFORT.map(v => ({ value: v, label: v }))] },
    ];
  }
  // ACP：用会话自报的 configOptions；还没跑过任务就临时开一个会话问一下（不发提示词，不花钱）
  let opts = registry.acpOptions.get(agent.id);
  if (!opts) {
    const s = new AcpSession({ ...agent, acp: { ...agent.acp, configOptions: {} } }, { cwd: os.tmpdir(), approve: async () => false });
    try { await s.start(); opts = s.configOptions ?? []; registry.acpOptions.set(agent.id, opts); } finally { s.close(); }
  }
  const cfg = agent.acp?.configOptions ?? {};
  return opts.filter(o => o.type === 'select').map(o => ({
    id: o.id,
    name: o.category === 'model' ? '模型' : o.category === 'thought_level' ? '思考强度' : o.name,
    current: cfg[o.id] ?? o.currentValue ?? '',
    options: withCurrent((o.options ?? []).flatMap(x => (x.options ? x.options.map(y => ({ value: y.value, label: y.name, group: x.name, desc: y.description })) : [{ value: x.value, label: x.name, desc: x.description }])), cfg[o.id]),
  }));
}

// 配置里写着、但候选列表里没有的值（手填的、或旧值）也保留在选项里
function withCurrent(options, cur) {
  return cur && !options.some(o => o.value === cur) ? [...options, { value: cur, label: `${cur}（当前配置）` }] : options;
}

// values: { [choiceId]: value }，空字符串表示恢复默认
export function applyChoices(cfg, id, values) {
  const a = cfg.agents.find(x => x.id === id);
  if (!a) throw new Error(`没有这个 AI：${id}`);
  const set = (obj, key, v) => { if (v) obj[key] = v; else delete obj[key]; };
  if (a.custom) {
    if (values.model) a.custom.model = values.model;
    if ('effort' in values) set(a.custom, 'effort', values.effort);
  } else if (a.type === 'claude') { a.claude ??= {}; if ('model' in values) set(a.claude, 'model', values.model); }
  else if (a.type === 'codex') {
    a.codex ??= {};
    if ('model' in values) set(a.codex, 'model', values.model);
    if ('effort' in values) set(a.codex, 'effort', values.effort);
  } else {
    a.acp ??= {};
    a.acp.configOptions ??= {};
    for (const [k, v] of Object.entries(values)) set(a.acp.configOptions, k, v);
  }
  return cfg;
}
