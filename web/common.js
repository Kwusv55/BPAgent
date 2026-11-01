'use strict';
// 指挥中心的通用部分：通用函数、事件渲染、新建编排对话框

// 共享状态：各视图再往里加自己的字段
const S = { agents: [], runs: [], approvals: [], defaults: {}, workspaceRoot: '', templates: [] };

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TIER = { cheap: '经济型', main: '主力', expert: '专家' };
const STATUS = { planning: '规划中', running: '进行中', summarizing: '汇总中', done: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断', pending: '待开始', review: '组长审查中', skipped: '已跳过' };

// ───── 通用 ─────
async function api(method, url, body) {
  const r = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
  return data;
}
let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}
const agentOf = (id) => S.agents.find(a => a.id === id) ?? { id, name: id, color: '#888', native: [] };
const badge = (id) => { const a = agentOf(id); return `<span class="badge" style="background:${esc(a.color)}">${esc(a.name)}</span>`; };
const dur = (ms) => ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m${Math.round(ms % 60_000 / 1000)}s`;
const ago = (ts) => new Date(ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
// 恢复时间：今天只显示时分，跨天带日期
const tm = (ms) => {
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return d.toLocaleString('zh-CN', sameDay ? { hour: '2-digit', minute: '2-digit' } : { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

// 简易 markdown：代码块、行内代码、粗体、标题
function md(src) {
  const parts = String(src ?? '').split(/```[^\n]*\n?/);
  return parts.map((p, i) => {
    if (i % 2) return `<pre>${esc(p.replace(/\n$/, ''))}</pre>`;
    return esc(p).split(/\n{2,}/).map(par => {
      // 段内连续的 | 行渲染成表格，其余行按普通文本
      const out = [];
      let text = [], table = [];
      const flushText = () => {
        if (!text.length) return;
        const s = text.join('\n');
        const h = s.match(/^#{1,6}\s+(.*)$/);
        out.push(h && text.length === 1 ? `<h4>${inline(h[1])}</h4>` : `<p>${inline(s).replace(/^#{1,6}\s+(.*)$/gm, '<b>$1</b>').replace(/\n/g, '<br>')}</p>`);
        text = [];
      };
      const flushTable = () => {
        if (table.length >= 2) out.push(mdTable(table)); else text.push(...table);
        table = [];
      };
      for (const line of par.split('\n')) {
        if (line.trim().startsWith('|')) { flushText(); table.push(line); } else { flushTable(); text.push(line); }
      }
      flushTable();
      flushText();
      return out.join('');
    }).join('');
  }).join('');
}

const inline = (s) => s.replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
function mdTable(lines) {
  const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map(c => inline(c.trim()));
  const rows = lines.filter(l => !/^\s*\|[\s|:-]+\|\s*$/.test(l)).map(cells);
  const [head, ...body] = rows;
  return `<table><thead><tr>${head.map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>${body.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

// 与服务端 util.mergeEvent 保持一致
function mergeEvent(list, ev) {
  const last = list[list.length - 1];
  if (ev.chunk && last && last.kind === ev.kind && last.mid === ev.mid) { last.text += ev.text; return; }
  if (ev.kind === 'tool' && ev.toolId) {
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].kind === 'tool' && list[i].toolId === ev.toolId) {
        for (const [k, v] of Object.entries(ev)) if (v !== undefined && v !== null) list[i][k] = v;
        return;
      }
    }
  }
  list.push({ ...ev });
}


function renderEvent(e) {
  switch (e.kind) {
    case 'prompt': return `<div class="ev"><details><summary>📤 编排台发给它的指令</summary><div class="md">${md(e.text)}</div></details></div>`;
    case 'user': return `<div class="ev user">🙋 你：${esc(e.text)}</div>`;
    case 'ask': return `<div class="ev user">❓ ${e.from ? `${esc(e.from)} ` : ''}向组长提问：${esc(e.text)}</div>`;
    case 'answer': return `<div class="ev message md"><b>组长回答：</b>${md(e.text)}</div>`;
    case 'thought': return e.text?.trim() ? `<div class="ev thought"><details><summary>思考</summary><pre>${esc(e.text)}</pre></details></div>` : '';
    case 'message': return `<div class="ev message md">${md(e.text)}</div>`;
    case 'tool': {
      const arg = e.input ? (e.input.command ?? e.input.file_path ?? e.input.path ?? e.input.pattern ?? e.input.url ?? JSON.stringify(e.input)) : '';
      const icon = { completed: '✓', failed: '✗' }[e.status] ?? '…';
      return `<div class="ev"><details><summary><span class="tool-line" style="display:inline-flex;max-width:95%"><span class="st ${esc(e.status)}">${icon}</span><span class="tname">${esc(e.title ?? '工具')}</span><span class="targ">${esc(String(arg).slice(0, 160))}</span></span></summary>
        ${e.input ? `<pre>${esc(JSON.stringify(e.input, null, 2)).slice(0, 6000)}</pre>` : ''}
        ${e.output ? `<pre>${esc(e.output).slice(0, 6000)}</pre>` : ''}</details></div>`;
    }
    case 'plan': return `<div class="ev"><b class="small">计划</b><ul class="small">${(e.entries ?? []).map(p => `<li>${p.status === 'completed' ? '✓' : '○'} ${esc(p.text)}</li>`).join('')}</ul></div>`;
    case 'turn': return `<div class="ev turn">本轮用时 ${dur(e.ms)}${e.cost ? ` · $${e.cost.toFixed(3)}` : ''}</div>`;
    case 'error': return `<div class="ev error">⚠ ${esc(e.text)}</div>`;
    default: return `<div class="ev info">${esc(e.text ?? '')}</div>`;
  }
}


// ───── 新建编排对话框：页面里没有时注入 ─────
if (!document.getElementById('dlgNew')) document.body.insertAdjacentHTML('beforeend', `<dialog id="dlgNew">
  <form id="formNew" method="dialog">
    <h2>新建编排</h2>
    <div class="row tpl-row">
      <label>模板<select name="template"><option value="">（不用模板）</option></select></label>
      <button type="button" class="ghost small" id="btnSaveTpl" title="把当前的组长、队员、约定等设置存成模板">存为模板</button>
      <button type="button" class="ghost small danger" id="btnDelTpl" hidden>删除模板</button>
    </div>
    <p id="tplDesc" class="muted small"></p>
    <label>目标<textarea name="goal" rows="5" required placeholder="例：在工作目录里做一个命令行记账工具，支持增删查和按月统计，带单元测试"></textarea></label>
    <label>团队约定（可选）<textarea name="guidance" rows="2" placeholder="写给组长的派活规则，例：实现交给 dsh，审查交给 claude；最后必须跑一遍全部测试"></textarea></label>
    <label>工作目录<input name="workdir" placeholder="留空则自动新建"></label>
    <div class="row">
      <label>组长<select name="leaderId" required title="组长每审一个任务都要说一轮话，建议用 Codex，Claude 的额度留给难题"></select></label>
      <label>审批<select name="policy">
        <option value="auto">全自动批准</option>
        <option value="ask">每次都问我</option>
      </select></label>
      <label>隔离<select name="isolation" title="worktree：每个任务在独立的 git 工作区里做，验收后自动合并">
        <option value="auto" title="git 仓库或空目录用 worktree，否则共享目录">自动</option>
        <option value="worktree">git worktree</option>
        <option value="shared">共享目录</option>
      </select></label>
    </div>
    <p class="hint" id="leaderHint" hidden>Claude 当组长：规划、每个任务的审查、汇总都会消耗订阅额度。建议让 Codex 当组长，Claude 只当专家队员。</p>
    <fieldset><legend>队员（按档位派活：经济型做简单活，主力做常规实现，专家只接难题）</legend><div id="memberPicks" class="picks"></div></fieldset>
    <label class="check" title="全部任务完成后，让专家档位的队员（Claude）一次性审查整体改动：小问题顺手修，大问题交组长派人修。额度紧张时自动跳过"><input type="checkbox" name="finalReview">完成后让专家做一次整体终审</label>
    <div class="row">
      <label>最多返工轮数<input name="maxRounds" type="number" min="0" max="5"></label>
      <label>同时进行的任务数<input name="maxParallel" type="number" min="1" max="8"></label>
    </div>
    <p id="newErr" class="err"></p>
    <div class="actions">
      <button type="button" class="ghost" data-close>取消</button>
      <button type="submit" class="primary">开始</button>
    </div>
  </form>
</dialog>`);
if (!document.getElementById('toast')) document.body.insertAdjacentHTML('beforeend', '<div id="toast" class="toast" hidden></div>');
let newRunCreated = async () => {};
function setupNewRun(fn) { newRunCreated = fn; }

// ───── 新建 ─────
async function openNew(preset = {}) {
  const f = $('#formNew');
  const ok = S.agents.filter(a => a.enabled && a.available);
  f.leaderId.innerHTML = ok.filter(a => a.roles.includes('leader')).map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join('');
  $('#memberPicks').innerHTML = ok.filter(a => a.roles.includes('member')).map(a =>
    `<label title="${esc(a.description)}"><input type="checkbox" name="member" value="${a.id}" checked>${badge(a.id)}<span class="muted small">${TIER[a.tier] ?? '主力'}</span></label>`).join('') || '<span class="muted">没有可用队员</span>';
  f.workdir.placeholder = `留空：目标里写了已有目录就用它，否则自动新建在 ${S.workspaceRoot}\\ 下`;
  applyForm({ ...S.defaults, guidance: '' });
  if (preset.goal) f.goal.value = preset.goal;
  await loadTemplates();
  f.template.value = '';
  showTplDesc();
  showLeaderHint();
  $('#newErr').textContent = '';
  $('#dlgNew').showModal();
  // 从指令台带着目标进来：焦点放在「开始」上，再按一次回车就开跑（工作目录留空：目标里有路径就用它，否则自动新建）
  if (preset.goal) f.querySelector('button[type=submit]').focus();
}

function showLeaderHint() {
  const L = agentOf($('#formNew').leaderId.value);
  $('#leaderHint').hidden = L.type !== 'claude' || !!L.custom;
}

function formValues() {
  const f = $('#formNew');
  return {
    goal: f.goal.value, guidance: f.guidance.value, workdir: f.workdir.value, leaderId: f.leaderId.value,
    policy: f.policy.value, isolation: f.isolation.value,
    memberIds: [...f.querySelectorAll('input[name=member]:checked')].map(x => x.value),
    maxRounds: f.maxRounds.value, maxParallel: f.maxParallel.value, finalReview: f.finalReview.checked,
  };
}

function applyForm(v) {
  const f = $('#formNew');
  const has = (sel, val) => [...sel.options].some(o => o.value === val);
  if (v.goal) f.goal.value = v.goal;
  if (v.guidance !== undefined) f.guidance.value = v.guidance;
  if (v.leaderId && has(f.leaderId, v.leaderId)) f.leaderId.value = v.leaderId;
  f.policy.value = v.policy ?? 'auto';
  f.isolation.value = v.isolation ?? 'auto';
  f.maxRounds.value = v.maxRounds ?? 2;
  f.maxParallel.value = v.maxParallel ?? 3;
  f.finalReview.checked = v.finalReview !== false;
  showLeaderHint();
  if (v.memberIds) for (const cb of f.querySelectorAll('input[name=member]')) cb.checked = v.memberIds.includes(cb.value);
}

async function loadTemplates() {
  S.templates = await api('GET', '/api/templates');
  const sel = $('#formNew').template;
  const cur = sel.value;
  sel.innerHTML = '<option value="">（不用模板）</option>' + S.templates.map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
  sel.value = S.templates.some(t => t.id === cur) ? cur : '';
}

function showTplDesc() {
  const t = S.templates?.find(x => x.id === $('#formNew').template.value);
  const missing = t ? [...new Set([t.leaderId, ...(t.memberIds ?? [])])].filter(id => id && !S.agents.some(a => a.id === id && a.enabled && a.available)) : [];
  $('#tplDesc').textContent = t ? `${t.description ?? ''}${missing.length ? `（注意：${missing.join('、')} 当前不可用）` : ''}` : '';
  $('#btnDelTpl').hidden = !t;
}

$('#formNew').template.addEventListener('change', () => {
  const t = S.templates.find(x => x.id === $('#formNew').template.value);
  if (t) applyForm({ ...S.defaults, ...t, guidance: t.guidance ?? '' });
  showTplDesc();
});
$('#formNew').leaderId.addEventListener('change', showLeaderHint);
$('#btnSaveTpl').addEventListener('click', async () => {
  const cur = S.templates?.find(x => x.id === $('#formNew').template.value);
  const name = prompt('模板名称（同名会覆盖）', cur?.name ?? '');
  if (!name?.trim()) return;
  const description = prompt('一句话说明（可选）', cur?.description ?? '') ?? '';
  const { goal, workdir, ...rest } = formValues(); // 目标和目录每次不同，不进模板
  try {
    await api('POST', '/api/templates', { ...rest, name: name.trim(), description });
    await loadTemplates();
    const saved = S.templates.find(t => t.name === name.trim());
    if (saved) $('#formNew').template.value = saved.id;
    showTplDesc();
    toast('模板已保存');
  } catch (err) { $('#newErr').textContent = err.message; }
});
$('#btnDelTpl').addEventListener('click', async () => {
  const id = $('#formNew').template.value;
  const t = S.templates.find(x => x.id === id);
  if (!t || !confirm(`删除模板「${t.name}」？`)) return;
  await api('DELETE', `/api/templates/${encodeURIComponent(id)}`);
  await loadTemplates();
  showTplDesc();
});

$('#formNew').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    const run = await api('POST', '/api/runs', { ...formValues(), templateId: f.template.value || null });
    $('#dlgNew').close();
    f.goal.value = '';
    await newRunCreated(run);
  } catch (err) {
    $('#newErr').textContent = err.message;
  }
});

