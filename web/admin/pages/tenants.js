/* 租户列表：#/tenants
 * 搜索 + 状态筛选 + 配额进度 + 成本；筛选状态在模块内保留，切页返回不丢。
 */

import { ui, $, $$, debounce } from '../../assets/core.js';
import {
  adminApi,
  errorHTML,
  bindRetry,
  planBadge,
  statusBadge,
  quotaCell,
  fmt,
} from '../admin-core.js';

const state = { q: '', status: '', items: [], total: 0, page: 1, size: 50 };

const STATUS_OPTIONS = [
  ['', '全部状态'],
  ['active', '正常'],
  ['readonly', '只读'],
  ['suspended', '已暂停'],
  ['deleted', '已删除'],
];

function shellHTML() {
  return `<div class="page-head">
    <div class="ph-main">
      <h1>租户</h1>
      <p class="page-sub" id="t-summary">加载中…</p>
    </div>
    <div class="ph-actions">
      <button class="btn sm" id="t-refresh" type="button">刷新</button>
    </div>
  </div>

  <div class="grid four mb-16" id="t-overview"></div>

  <div class="toolbar">
    <div class="tb-search">
      <span class="tb-icon">⌕</span>
      <input class="input" id="t-search" type="search" placeholder="搜索租户名称或 slug" autocomplete="off" />
    </div>
    <select class="select tb-select" id="t-status" aria-label="按状态筛选">
      ${STATUS_OPTIONS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}
    </select>
    <div class="grow"></div>
    <span class="chip" id="t-count">—</span>
  </div>

  <div id="t-list">${ui.loading('正在加载租户…')}</div>`;
}

function rowHTML(t) {
  return `<tr class="clickable" data-id="${ui.esc(t.id)}">
    <td>
      <div class="cell-title">${ui.esc(t.name || '—')}</div>
      <div class="mono muted small">${ui.esc(t.slug || '—')}</div>
    </td>
    <td class="hide-sm"><span class="small">${ui.esc(t.owner_email || '—')}</span></td>
    <td>${planBadge(t.plan)}</td>
    <td>${statusBadge(t.status)}</td>
    <td class="q-cell">${quotaCell(t.sku_used, t.sku_quota)}</td>
    <td class="q-cell">${quotaCell(t.export_used, t.export_quota)}</td>
    <td class="num">${fmt.money(t.cost_cents)}</td>
    <td class="hide-sm muted small">${ui.esc(t.created_at || '—')}</td>
    <td class="shrink"><a class="btn sm ghost" href="#/tenants/${encodeURIComponent(t.id)}">详情</a></td>
  </tr>`;
}

function listHTML(items) {
  if (!items.length) {
    return ui.empty({
      icon: '▤',
      title: '没有符合条件的租户',
      sub: '试试更换关键词，或把状态筛选切回“全部状态”。',
      action: '<button class="btn sm mt-8" data-clear>清空筛选</button>',
    });
  }
  const more = state.items.length < state.total
    ? `<div class="row mt-12" style="justify-content:center">
        <button class="btn sm" data-more type="button">加载更多（${fmt.num(state.items.length)} / ${fmt.num(state.total)}）</button>
      </div>`
    : '';
  return `<div class="table-wrap"><table class="table dense">
    <thead><tr>
      <th>租户</th><th class="hide-sm">Owner</th><th>套餐</th><th>状态</th>
      <th>SKU 配额</th><th>导出配额</th><th class="right">累计成本</th>
      <th class="hide-sm">创建</th><th class="shrink"></th>
    </tr></thead>
    <tbody>${items.map(rowHTML).join('')}</tbody>
  </table></div>${more}`;
}

export async function page({ root }) {
  root.innerHTML = shellHTML();

  const search = $('#t-search');
  const statusSel = $('#t-status');
  const summary = $('#t-summary');
  const countEl = $('#t-count');
  const list = $('#t-list');

  search.value = state.q;
  statusSel.value = state.status;

  const clearFilters = () => {
    state.q = '';
    state.status = '';
    search.value = '';
    statusSel.value = '';
    load({ reset: true });
  };

  $('#t-refresh').onclick = () => load({ reset: true });
  search.oninput = debounce(() => {
    state.q = search.value.trim();
    load({ reset: true });
  }, 300);
  statusSel.onchange = () => {
    state.status = statusSel.value;
    load({ reset: true });
  };

  async function load({ reset = true } = {}) {
    if (reset) {
      state.page = 1;
      list.innerHTML = ui.loading('正在加载租户…');
      summary.textContent = '加载中…';
      countEl.textContent = '—';
    }
    const qs = new URLSearchParams({ page: String(state.page), size: String(state.size) });
    if (state.q) qs.set('q', state.q);
    if (state.status) qs.set('status', state.status);

    try {
      const data = await adminApi.get(`/v1/admin/tenants?${qs.toString()}`);
      const items = data.items || [];
      state.total = Number(data.total) || items.length;
      state.items = reset ? items : state.items.concat(items);
      render();
    } catch (err) {
      summary.textContent = '加载失败';
      countEl.textContent = '—';
      list.innerHTML = errorHTML(err);
      bindRetry(list, () => load({ reset: true }));
    }
  }

  function render() {
    list.innerHTML = listHTML(state.items);
    countEl.textContent = `已加载 ${fmt.num(state.items.length)} / 共 ${fmt.num(state.total)} 个`;
    summary.textContent = state.total
      ? `按创建时间倒序，分页加载；共 ${fmt.num(state.total)} 个租户。`
      : '按创建时间倒序。';

    list.querySelector('[data-more]')?.addEventListener('click', (e) => {
      e.currentTarget.disabled = true;
      state.page += 1;
      load({ reset: false });
    });

    list.querySelector('[data-clear]')?.addEventListener('click', clearFilters);
    $$('#t-list tbody tr[data-id]', document).forEach((tr) => {
      tr.onclick = (e) => {
        if (e.target.closest('a')) return;
        location.hash = `#/tenants/${encodeURIComponent(tr.dataset.id)}`;
      };
    });
  }

  await Promise.all([load(), loadOverview()]);

  async function loadOverview() {
    const box = $('#t-overview');
    try {
      const ov = await adminApi.get('/v1/admin/overview');
      const t = ov.tenants || {};
      const j = ov.jobs || {};
      box.innerHTML = `<div class="kpi">
          <div class="k-label">租户总数</div>
          <div class="k-value">${fmt.num(t.total)}</div>
          <div class="k-note">正常 ${fmt.num(t.active)} · 只读 ${fmt.num(t.readonly)}</div>
        </div>
        <div class="kpi">
          <div class="k-label">已暂停租户</div>
          <div class="k-value">${fmt.num(t.suspended)}</div>
          <div class="k-note"><a href="#/risk">前往风控页查看</a></div>
        </div>
        <div class="kpi">
          <div class="k-label">失败任务</div>
          <div class="k-value">${fmt.num(j.failed)}</div>
          <div class="k-note">排队 ${fmt.num(j.queued)} · 进行中 ${fmt.num(j.running)}</div>
        </div>
        <div class="kpi">
          <div class="k-label">待处理</div>
          <div class="k-value">${fmt.num(ov.pending_orders)} / ${fmt.num(ov.open_risks)}</div>
          <div class="k-note">待支付订单 / 未结风控</div>
        </div>`;
    } catch {
      box.classList.add('hidden');
    }
  }
}
