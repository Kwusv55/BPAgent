'use strict';
// 侧栏底部的两个设置：自定义模型（接反代 / 中转）、清理残留。依赖 common.js 的 S / $ / esc / api / toast

const ICON = {
  edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
};

document.body.insertAdjacentHTML('beforeend', `<dialog id="dlgModels">
  <h2>自定义模型 <small>接入反代 / 中转站</small></h2>
  <div id="cmView">
    <p class="muted small">填请求地址、API Key 和模型名，套在现成的 CLI 上跑（工具调用、改文件、续接会话都能用）。Key 存在本机 config\\secrets.json，不进 git。</p>
    <div id="cmList" class="cm-list"></div>
    <div class="actions"><button type="button" data-close>关闭</button><button type="button" class="primary" id="cmAdd">＋ 新增模型</button></div>
  </div>
  <form id="cmForm" hidden autocomplete="off">
    <div class="row">
      <label>名称<input name="name" placeholder="例：反代 Claude"></label>
      <label>接口协议<select name="protocol"></select></label>
      <label>驱动<select name="driver" title="用哪个 CLI 来跑这个模型"></select></label>
    </div>
    <p class="muted small" id="cmDrvHint"></p>
    <label>请求地址<input name="baseUrl" required placeholder="https://example.com/v1"></label>
    <label>API Key<input name="apiKey" type="password" placeholder="sk-..."></label>
    <div class="row">
      <label>模型<input name="model" required list="cmModelList" placeholder="例：claude-sonnet-4-6 / gpt-5.1"></label>
      <button type="button" class="small" id="cmFetch" title="向反代请求 /models，顺便测一下地址和 Key 通不通">获取列表</button>
      <label id="cmEffortL">思考强度<select name="effort"></select></label>
    </div>
    <datalist id="cmModelList"></datalist>
    <p class="small" id="cmFetchMsg"></p>
    <div class="row">
      <label>档位<select name="tier"><option value="cheap">经济型（简单活）</option><option value="main" selected>主力（常规实现）</option><option value="expert">专家（只接难题 + 终审）</option></select></label>
      <label>同时任务数<input name="maxConcurrent" type="number" min="1" max="8" value="2"></label>
    </div>
    <div class="picks"><label><input type="checkbox" name="roleLeader" checked>可当组长</label><label><input type="checkbox" name="roleMember" checked>可当队员</label></div>
    <label>说明（组长派活时会看，可留空）<textarea name="description" rows="2" placeholder="例：便宜量大，适合机械改动和补测试"></textarea></label>
    <p class="err" id="cmErr"></p>
    <div class="actions"><button type="button" id="cmBack">返回</button><button type="submit" class="primary">保存</button></div>
  </form>
</dialog>
<dialog id="dlgClean">
  <h2>清理残留</h2>
  <p class="muted small" id="clRoots"></p>
  <div id="clList" class="cl-list"></div>
  <p class="err" id="clErr"></p>
  <div class="actions"><button type="button" data-close>关闭</button><button type="button" class="primary danger-fill" id="clGo" disabled>全部清理</button></div>
</dialog>`);

// ───── 自定义模型 ─────
let cmMeta = null, cmEditing = null;
const EFFORT = { codex: ['low', 'medium', 'high', 'xhigh'], claude: ['low', 'medium', 'high'] };
const DRV_HINT = {
  claude: 'Claude Code：地址填到域名即可（末尾的 /v1 会自动去掉），Key 以 Authorization: Bearer 发送。',
  codex: 'Codex：只支持 Responses 协议；只填域名时自动补 /v1。',
  dsh: 'DeepSeek Harness：三种协议都支持，Chat Completions 类的反代只能用它；只填域名时自动补 /v1。',
};

async function openModels() {
  cmMeta ??= await api('GET', '/api/custom/meta');
  const f = $('#cmForm');
  f.protocol.innerHTML = Object.entries(cmMeta.protocols).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('');
  showModelList();
  if (!$('#dlgModels').open) $('#dlgModels').showModal();
}

function showModelList() {
  $('#cmView').hidden = false;
  $('#cmForm').hidden = true;
  const list = S.agents.filter(a => a.custom);
  $('#cmList').innerHTML = list.map(a => `<div class="cm-row">
      <i class="dot" style="background:${esc(a.color)}"></i>
      <div class="cm-main"><b>${esc(a.name)}</b>${a.enabled ? '' : ' <em>已停用</em>'}${a.available ? '' : ' <em class="bad">找不到驱动程序</em>'}${a.custom.hasKey ? '' : ' <em>未填 Key</em>'}
        <small>${esc(a.custom.model)} · ${esc(cmMeta.drivers[a.custom.driver] ?? a.custom.driver)} · ${esc(a.custom.baseUrl)}</small></div>
      <button type="button" class="ibtn" data-cm-edit="${esc(a.id)}" title="编辑">${ICON.edit}</button>
      <button type="button" class="ibtn" data-cm-del="${esc(a.id)}" title="删除">${ICON.trash}</button>
    </div>`).join('') || '<p class="muted small cm-empty">还没有自定义模型。</p>';
}

function syncDrivers(keep) {
  const f = $('#cmForm'), p = cmMeta.protocols[f.protocol.value];
  const cur = keep ?? f.driver.value;
  f.driver.innerHTML = p.drivers.map(d => `<option value="${d}">${esc(cmMeta.drivers[d])}</option>`).join('');
  f.driver.value = p.drivers.includes(cur) ? cur : p.drivers[0];
  syncEffort();
}
function syncEffort(keep) {
  const f = $('#cmForm'), list = EFFORT[f.driver.value];
  const cur = keep ?? f.effort.value;
  $('#cmEffortL').hidden = !list;
  f.effort.innerHTML = '<option value="">默认</option>' + (list ?? []).map(v => `<option value="${v}">${v}</option>`).join('');
  f.effort.value = list?.includes(cur) ? cur : '';
  $('#cmDrvHint').textContent = `走 ${cmMeta.protocols[f.protocol.value].path} 接口。${DRV_HINT[f.driver.value] ?? ''}`;
}

function editModel(id) {
  const f = $('#cmForm'), a = id ? S.agents.find(x => x.id === id) : null;
  cmEditing = a?.id ?? null;
  f.reset();
  const c = a?.custom ?? { protocol: 'anthropic-messages' };
  f.name.value = a?.name ?? '';
  f.protocol.value = c.protocol;
  syncDrivers(c.driver);
  syncEffort(c.effort ?? '');
  f.baseUrl.value = c.baseUrl ?? '';
  f.apiKey.value = '';
  f.apiKey.placeholder = a?.custom?.hasKey ? '已保存，留空表示不改' : 'sk-...';
  f.model.value = c.model ?? '';
  f.tier.value = a?.tier ?? 'main';
  f.maxConcurrent.value = a?.maxConcurrent ?? 2;
  f.roleLeader.checked = a ? a.roles.includes('leader') : true;
  f.roleMember.checked = a ? a.roles.includes('member') : true;
  f.description.value = a && !/^自定义模型 /.test(a.description) ? a.description : '';
  $('#cmModelList').innerHTML = '';
  $('#cmFetchMsg').textContent = '';
  $('#cmErr').textContent = '';
  $('#cmView').hidden = true;
  f.hidden = false;
  (a ? f.model : f.name).focus();
}

$('#cmForm').protocol.addEventListener('change', () => syncDrivers());
$('#cmForm').driver.addEventListener('change', () => syncEffort());
$('#cmAdd').addEventListener('click', () => editModel(null));
$('#cmBack').addEventListener('click', showModelList);
$('#cmFetch').addEventListener('click', async () => {
  const f = $('#cmForm'), msg = $('#cmFetchMsg');
  msg.className = 'small';
  msg.textContent = '正在请求…';
  try {
    const { models } = await api('POST', '/api/custom/models', { id: cmEditing, protocol: f.protocol.value, baseUrl: f.baseUrl.value, apiKey: f.apiKey.value });
    $('#cmModelList').innerHTML = models.map(m => `<option value="${esc(m)}">`).join('');
    msg.className = 'small ok';
    msg.textContent = models.length ? `连通，反代提供 ${models.length} 个模型，点「模型」输入框可以选` : '连通，但反代没有返回模型列表，手动填模型名';
    if (!f.model.value && models.length) f.model.value = models[0];
  } catch (err) {
    msg.className = 'small bad';
    msg.textContent = `${err.message}（有的反代不提供 /models，手动填模型名也能用）`;
  }
});
$('#cmForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {
    name: f.name.value, protocol: f.protocol.value, driver: f.driver.value, baseUrl: f.baseUrl.value, apiKey: f.apiKey.value,
    model: f.model.value, effort: $('#cmEffortL').hidden ? '' : f.effort.value, tier: f.tier.value, maxConcurrent: f.maxConcurrent.value,
    roles: [f.roleLeader.checked && 'leader', f.roleMember.checked && 'member'].filter(Boolean), description: f.description.value,
  };
  try {
    const r = await api(cmEditing ? 'PUT' : 'POST', cmEditing ? `/api/custom/${cmEditing}` : '/api/custom', body);
    S.agents = r.agents;
    toast(cmEditing ? '已保存' : '已添加，新建编排时可以选它');
    showModelList();
  } catch (err) { $('#cmErr').textContent = err.message; }
});
$('#cmList').addEventListener('click', async (e) => {
  const ed = e.target.closest('[data-cm-edit]'), del = e.target.closest('[data-cm-del]');
  if (ed) return editModel(ed.dataset.cmEdit);
  if (!del) return;
  const a = S.agents.find(x => x.id === del.dataset.cmDel);
  if (!a || !confirm(`删除自定义模型「${a.name}」？保存的 Key 也会一起删掉。`)) return;
  try {
    S.agents = (await api('DELETE', `/api/custom/${a.id}`)).agents;
    showModelList();
  } catch (err) { toast(err.message); }
});

// ───── 清理残留 ─────
const CL_KIND = { workspace: '自动工作目录', worktree: 'worktree 工作区', branch: '仓库里的 hub/ 分支', tmp: '临时文件' };
async function openClean() {
  $('#clErr').textContent = '';
  $('#clList').innerHTML = '<p class="muted small">扫描中…</p>';
  $('#clGo').disabled = true;
  if (!$('#dlgClean').open) $('#dlgClean').showModal();
  try {
    const r = await api('GET', '/api/cleanup');
    $('#clRoots').textContent = `自动工作目录在 ${r.workspaceRoot}，worktree 在 ${r.worktreeRoot}。进行中、可继续运行的编排不会动。`;
    const groups = Object.keys(CL_KIND).map(k => [k, r.items.filter(i => i.kind === k)]).filter(([, v]) => v.length);
    $('#clList').innerHTML = groups.map(([k, v]) => `<div class="cl-g"><b>${CL_KIND[k]} · ${v.length}</b>${v.map(i => `<div class="cl-i" title="${esc(i.desc)}"><code>${esc(i.path)}</code><small>${esc(i.desc)}</small></div>`).join('')}</div>`).join('')
      || '<p class="muted small">很干净，没有残留。</p>';
    $('#clGo').disabled = !r.items.length;
  } catch (err) { $('#clErr').textContent = err.message; $('#clList').innerHTML = ''; }
}
$('#clGo').addEventListener('click', async () => {
  if (!confirm('删除上面列出的全部内容？删掉的目录和分支找不回来。')) return;
  $('#clGo').disabled = true;
  try {
    const r = await api('POST', '/api/cleanup');
    toast(r.failed.length ? `清理了 ${r.removed} 项，${r.failed.length} 项删不掉（可能还被占用）` : `清理了 ${r.removed} 项`);
    await openClean();
    if (r.failed.length) $('#clErr').textContent = r.failed.map(x => `${x.path}：${x.error}`).join('\n');
  } catch (err) { $('#clErr').textContent = err.message; }
});

$('#btnModels').addEventListener('click', () => openModels().catch(err => toast(err.message)));
$('#btnClean').addEventListener('click', openClean);
