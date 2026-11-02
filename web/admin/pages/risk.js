/* 风控：#/risk
 * 已暂停租户（租户接口真实数据）+ 风控事件（GET/POST /v1/admin/risk、结案可同时冻结）。
 */

import { ui, $ } from '../../assets/core.js';
import {
  adminApi,
  errorHTML,
  bindRetry,
  confirmAction,
  planBadge,
  statusBadge,
  riskStatusBadge,
  severityBadge,
  riskKindLabel,
  fmt,
} from '../admin-core.js';

const state = { suspended: [], cases: [], status: '', tenants: [] };

const KINDS = [
  ['complaint', '投诉'],
  ['copyright', '侵权'],
  ['abuse', '滥用'],
  ['quality', '质量'],
  ['other', '其他'],
];

const SEVERITIES = [
  ['low', '低'],
  ['medium', '中'],
  ['high', '高'],
];

function shellHTML() {
  return `<div class="page-head">
    <div class="ph-main">
      <h1>风控</h1>
      <p class="page-sub">已暂停租户、风控事件与人工结案。冻结通过“暂停租户”生效。</p>
    </div>
    <div class="ph-actions"><button class="btn sm" id="r-refresh" type="button">刷新</button></div>
  </div>

  <div class="card mb-16">
    <div class="card-head">
      <h2>已暂停租户</h2>
      <span class="chip">status=suspended</span>
      <div class="grow"></div>
      <span class="chip" id="r-sus-count">—</span>
    </div>
    <div id="r-sus-list">${ui.loading('正在加载…')}</div>
  </div>

  <div class="card mb-16">
    <div class="card-head">
      <h2>风控事件</h2>
      <span class="chip" id="r-count">—</span>
      <div class="grow"></div>
      <button class="btn sm primary" id="r-new" type="button">新建事件</button>
    </div>
    <div class="toolbar slim mb-16">
      <select class="select tb-select" id="r-status" aria-label="按状态筛选">
        <option value="">全部状态</option>
        <option value="open">待处理</option>
        <option value="resolved">已结案</option>
        <option value="frozen">已冻结</option>
      </select>
      <button class="btn sm ghost" id="r-reload" type="button">刷新</button>
    </div>
    <div id="r-list">${ui.loading('正在加载风控事件…')}</div>
  </div>

  <div class="callout warn">
    <b>自动风控规则未接入</b>
    <p class="muted small mt-8">
      目前只能人工登记事件并结案/冻结；规则引擎、投诉自动汇总、封禁原因与工单追溯还没有后端。
    </p>
    <div class="nw-apis">
      <code class="code-inline">GET /v1/admin/risk/rules</code>
      <code class="code-inline">POST /v1/admin/risk/rules</code>
      <code class="code-inline">GET /v1/admin/risk/events</code>
    </div>
  </div>`;
}

function susRow(t) {
  return `<tr>
    <td><div class="cell-title">${ui.esc(t.name)}</div><div class="mono muted small">${ui.esc(t.slug)}</div></td>
    <td class="hide-sm small">${ui.esc(t.owner_email || '—')}</td>
    <td>${planBadge(t.plan)}</td>
    <td>${statusBadge(t.status)}</td>
    <td class="num">${fmt.money(t.cost_cents)}</td>
    <td class="shrink"><button class="btn sm" data-restore="${ui.esc(t.id)}" type="button">恢复</button></td>
  </tr>`;
}

function susHTML(items) {
  if (!items.length) {
    return ui.empty({
      icon: '⚑',
      title: '当前没有被暂停的租户',
      sub: '在租户详情页暂停租户，或结案风控事件时勾选“同时暂停”，会出现在这里。',
      action: '<a class="btn sm mt-8" href="#/tenants">前往租户列表</a>',
    });
  }
  return `<div class="table-wrap"><table class="table dense">
    <thead><tr><th>租户</th><th class="hide-sm">Owner</th><th>套餐</th><th>状态</th><th class="right">累计成本</th><th class="shrink"></th></tr></thead>
    <tbody>${items.map(susRow).join('')}</tbody>
  </table></div>`;
}

function caseRow(c) {
  const detail = c.detail ? ui.esc(c.detail) : '—';
  return `<tr>
    <td><span class="chip">${ui.esc(riskKindLabel(c.kind))}</span></td>
    <td><div class="cell-title">${ui.esc(c.tenant_name || '未关联租户')}</div>
      ${c.workspace_id ? `<div class="mono muted small">${fmt.shortId(c.workspace_id)}</div>` : ''}</td>
    <td>${severityBadge(c.severity)}</td>
    <td>${riskStatusBadge(c.status)}</td>
    <td><div class="detail-cell" title="${detail}">${detail}</div></td>
    <td class="muted small nowrap">${ui.fmt.dt(c.created_at)}</td>
    <td class="shrink">${c.status === 'open'
      ? `<button class="btn sm" data-resolve="${ui.esc(c.id)}" type="button">结案</button>`
      : `<span class="muted small">${c.resolved_at ? ui.fmt.date(c.resolved_at) : '—'}</span>`}</td>
  </tr>`;
}

function casesHTML(items) {
  if (!items.length) {
    return ui.empty({
      icon: '⚑',
      title: state.status ? '该状态下没有风控事件' : '还没有风控事件',
      sub: state.status ? '切换状态筛选看看。' : '收到投诉、侵权或滥用反馈时，在这里登记并跟进结案。',
      action: '<button class="btn sm mt-8" data-new>新建事件</button>',
    });
  }
  return `<div class="table-wrap"><table class="table dense">
    <thead><tr><th>类型</th><th>租户</th><th>严重</th><th>状态</th><th>详情</th><th>创建</th><th class="shrink"></th></tr></thead>
    <tbody>${items.map(caseRow).join('')}</tbody>
  </table></div>`;
}

function createForm() {
  return `<div class="field">
      <label for="rf-tenant">关联租户</label>
      <select class="select" id="rf-tenant">
        <option value="">不关联租户</option>
        ${state.tenants.map((t) => `<option value="${ui.esc(t.id)}">${ui.esc(t.name)}（${ui.esc(t.slug)}）</option>`).join('')}
      </select>
    </div>
    <div class="grid two" style="gap:12px">
      <div class="field">
        <label for="rf-kind">类型</label>
        <select class="select" id="rf-kind">
          ${KINDS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label for="rf-severity">严重级别</label>
        <select class="select" id="rf-severity">
          ${SEVERITIES.map(([v, l]) => `<option value="${v}" ${v === 'medium' ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="field">
      <label for="rf-detail">详情</label>
      <textarea class="textarea" id="rf-detail" maxlength="2000" placeholder="投诉渠道、涉及 SKU、证据链接等"></textarea>
    </div>`;
}

async function openCreate(reload) {
  const m = ui.modal({
    title: '新建风控事件',
    wide: true,
    body: createForm(),
    footer: [
      { label: '取消', kind: 'ghost', onClick: (close) => close() },
      {
        label: '登记事件',
        kind: 'primary',
        onClick: async (close) => {
          const el = m.body;
          const workspace_id = el.querySelector('#rf-tenant').value;
          const kind = el.querySelector('#rf-kind').value;
          const severity = el.querySelector('#rf-severity').value;
          const detail = el.querySelector('#rf-detail').value.trim();
          if (!detail) return ui.toast('请填写事件详情', 'bad');

          const btn = m.el.querySelectorAll('.modal-foot .btn')[1];
          btn.disabled = true;
          btn.textContent = '提交中…';
          try {
            await adminApi.post('/v1/admin/risk', { workspace_id, kind, severity, detail });
            close();
            ui.toast('风控事件已登记', 'good');
            await reload();
          } catch (err) {
            btn.disabled = false;
            btn.textContent = '登记事件';
            ui.toast(err.message || '登记失败', 'bad');
          }
        },
      },
    ],
  });
}

async function openResolve(c, reload) {
  const hasTenant = !!c.workspace_id;
  const m = ui.modal({
    title: '结案风控事件',
    body: `<p class="muted small">${ui.esc(riskKindLabel(c.kind))} · ${ui.esc(c.tenant_name || '未关联租户')}</p>
      <div class="field mt-16">
        <label for="rs-resolution">结案说明</label>
        <textarea class="textarea" id="rs-resolution" maxlength="255" placeholder="处理结果、与客户沟通结论等"></textarea>
      </div>
      <label class="check-line ${hasTenant ? '' : 'disabled'}">
        <input type="checkbox" id="rs-freeze" ${hasTenant ? '' : 'disabled'} /> 同时暂停该租户
      </label>
      <p class="hint">${hasTenant ? '暂停后租户成员将无法写入与导出，可在租户页恢复。' : '该事件未关联租户，无法执行冻结。'}</p>`,
    footer: [
      { label: '取消', kind: 'ghost', onClick: (close) => close() },
      {
        label: '确认结案',
        kind: 'primary',
        onClick: async (close) => {
          const el = m.body;
          const resolution = el.querySelector('#rs-resolution').value.trim();
          const freeze = hasTenant && el.querySelector('#rs-freeze').checked;
          if (!resolution) return ui.toast('请填写结案说明', 'bad');

          if (freeze) {
            const ok = await confirmAction({
              title: '确认冻结租户',
              message: `结案将同时暂停「${c.tenant_name || '该租户'}」，其成员会立即失去写入权限。`,
              confirmLabel: '结案并冻结',
              danger: true,
            });
            if (!ok) return;
          }

          const btn = m.el.querySelectorAll('.modal-foot .btn')[1];
          btn.disabled = true;
          btn.textContent = '提交中…';
          try {
            await adminApi.post(`/v1/admin/risk/${encodeURIComponent(c.id)}/resolve`, { resolution, freeze });
            close();
            ui.toast(freeze ? '已结案并暂停租户' : '事件已结案', 'good');
            await reload();
          } catch (err) {
            btn.disabled = false;
            btn.textContent = '确认结案';
            ui.toast(err.message || '结案失败', 'bad');
          }
        },
      },
    ],
  });
}

export async function page({ root }) {
  root.innerHTML = shellHTML();

  const susList = $('#r-sus-list');
  const caseList = $('#r-list');
  const statusSel = $('#r-status');

  if (state.status) statusSel.value = state.status;

  $('#r-refresh').onclick = () => loadAll();
  $('#r-reload').onclick = () => loadCases();
  $('#r-new').onclick = () => openCreate(loadAll);
  statusSel.onchange = () => {
    state.status = statusSel.value;
    loadCases();
  };

  async function loadAll() {
    susList.innerHTML = ui.loading('正在加载已暂停租户…');
    caseList.innerHTML = ui.loading('正在加载风控事件…');
    await Promise.all([loadSuspended(), loadTenants(), loadCases()]);
  }

  async function loadTenants() {
    try {
      const d = await adminApi.get('/v1/admin/tenants');
      state.tenants = d.items || [];
    } catch {
      state.tenants = [];
    }
  }

  async function loadSuspended() {
    try {
      const d = await adminApi.get('/v1/admin/tenants?status=suspended');
      state.suspended = d.items || [];
      renderSuspended();
    } catch (err) {
      susList.innerHTML = errorHTML(err);
      bindRetry(susList, loadSuspended);
    }
  }

  async function loadCases() {
    caseList.innerHTML = ui.loading('正在加载风控事件…');
    const qs = state.status ? `?status=${encodeURIComponent(state.status)}` : '';
    try {
      const d = await adminApi.get(`/v1/admin/risk${qs}`);
      state.cases = d.items || [];
      renderCases();
    } catch (err) {
      caseList.innerHTML = errorHTML(err);
      bindRetry(caseList, loadCases);
    }
  }

  function renderSuspended() {
    susList.innerHTML = susHTML(state.suspended);
    $('#r-sus-count').textContent = `暂停 ${fmt.num(state.suspended.length)} 个`;
    bindRetry(susList, loadSuspended);
    susList.querySelectorAll('[data-restore]').forEach((b) => {
      b.onclick = () => restore(b.dataset.restore, b);
    });
  }

  function renderCases() {
    caseList.innerHTML = casesHTML(state.cases);
    $('#r-count').textContent = `共 ${fmt.num(state.cases.length)} 条`;
    bindRetry(caseList, loadCases);
    caseList.querySelector('[data-new]')?.addEventListener('click', () => openCreate(loadAll));
    caseList.querySelectorAll('[data-resolve]').forEach((b) => {
      b.onclick = () => {
        const c = state.cases.find((x) => x.id === b.dataset.resolve);
        if (c) openResolve(c, loadAll);
      };
    });
  }

  async function restore(id, btn) {
    const t = state.suspended.find((x) => x.id === id);
    if (!t) return;
    const ok = await confirmAction({
      title: '确认恢复租户',
      message: `恢复「${t.name}」后，其成员可立即继续写入与导出。`,
      confirmLabel: '恢复租户',
      html: '<p class="hint mt-8">操作会记入审计日志（admin.tenant.suspend）。</p>',
    });
    if (!ok) return;
    btn.disabled = true;
    btn.textContent = '恢复中…';
    try {
      await adminApi.post(`/v1/admin/tenants/${encodeURIComponent(id)}/suspend`);
      ui.toast('租户已恢复', 'good');
      await loadAll();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = '恢复';
      ui.toast(err.message || '恢复失败', 'bad');
    }
  }

  await loadAll();
}
