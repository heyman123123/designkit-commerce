/* 成本看板：#/costs
 * 数据来自 GET /v1/admin/usage（usage_ledger 汇总，Top 20）。
 * 后端返回的字段名是 Go 结构体字段（WorkspaceID / Cost），这里两种写法都兼容。
 */

import { ui, $ } from '../../assets/core.js';
import { adminApi, errorHTML, bindRetry, fmt } from '../admin-core.js';

const state = { total: 0, top: [], tenants: new Map() };

function normalizeTop(rows) {
  return (rows || []).map((r) => ({
    workspace_id: r.WorkspaceID || r.workspace_id || '',
    cost_cents: Number(r.Cost != null ? r.Cost : r.cost_cents || 0),
  }));
}

function shellHTML() {
  return `<div class="page-head">
    <div class="ph-main">
      <h1>成本看板</h1>
      <p class="page-sub">来源 usage_ledger 累计成本；仅展示成本最高的 20 个租户。</p>
    </div>
    <div class="ph-actions">
      <button class="btn sm" id="c-refresh" type="button">刷新</button>
    </div>
  </div>

  <div class="grid three mb-16" id="c-kpis">
    <div class="kpi"><div class="k-label">平台累计成本</div><div class="k-value" id="k-total">—</div><div class="k-note">全部租户 usage_ledger 求和</div></div>
    <div class="kpi"><div class="k-label">Top 租户数</div><div class="k-value" id="k-count">—</div><div class="k-note">后端固定取前 20 名</div></div>
    <div class="kpi"><div class="k-label">最大单一租户占比</div><div class="k-value" id="k-share">—</div><div class="k-note">占总成本比例</div></div>
  </div>

  <div id="c-list">${ui.loading('正在汇总成本…')}</div>

  <div class="callout info mt-16">
    <b>更多成本维度待接入</b>
    <p class="muted small mt-8">
      当前只有「按租户累计」。按天趋势、按模板/项目拆分、毛利与阈值告警需要后端聚合接口，页面已预留位置。
    </p>
    <div class="nw-apis">
      <code class="code-inline">GET /v1/admin/usage?group_by=day&amp;from=&amp;to=</code>
      <code class="code-inline">GET /v1/admin/usage?group_by=template</code>
      <code class="code-inline">GET /v1/admin/costs/summary</code>
    </div>
  </div>`;
}

function barListHTML(rows) {
  if (!rows.length) {
    return ui.empty({
      icon: '◭',
      title: '还没有产生任何用量成本',
      sub: '租户创建 SKU、生成或导出后，成本会累计进 usage_ledger 并显示在这里。',
      action: '<button class="btn sm mt-8" data-retry>刷新</button>',
    });
  }
  const total = state.total || rows.reduce((s, r) => s + r.cost_cents, 0);
  const max = Math.max(...rows.map((r) => r.cost_cents), 1);

  const items = rows
    .map((r, i) => {
      const t = state.tenants.get(r.workspace_id);
      const name = t ? t.name : '未知租户';
      const sub = t ? `${t.slug || '—'} · ${ui.label(t.plan)}` : fmt.shortId(r.workspace_id);
      const share = total ? (r.cost_cents / total) * 100 : 0;
      const width = Math.max(2, Math.round((r.cost_cents / max) * 100));
      return `<div class="bar-row">
        <div class="br-rank">${i + 1}</div>
        <div class="br-name">
          <div class="cell-title">${ui.esc(name)}</div>
          <div class="muted small">${ui.esc(sub)}</div>
        </div>
        <div class="br-track"><div class="br-fill" style="width:${width}%"></div></div>
        <div class="br-cost">${fmt.money(r.cost_cents)}</div>
        <div class="br-share">${share ? share.toFixed(1) + '%' : '0%'}</div>
      </div>`;
    })
    .join('');

  return `<div class="card pad-sm">
    <div class="bar-head">
      <span></span><span>租户</span><span>相对最高成本</span><span class="right">成本</span><span class="right">占比</span>
    </div>
    <div class="bar-list">${items}</div>
  </div>`;
}

export async function page({ root }) {
  root.innerHTML = shellHTML();

  const list = $('#c-list');
  $('#c-refresh').onclick = () => load();

  async function load() {
    list.innerHTML = ui.loading('正在汇总成本…');
    const tenantsPromise = adminApi
      .get('/v1/admin/tenants')
      .then((d) => {
        state.tenants = new Map((d.items || []).map((t) => [t.id, t]));
      })
      .catch(() => {
        state.tenants = new Map();
      });

    try {
      const [usage] = await Promise.all([adminApi.get('/v1/admin/usage'), tenantsPromise]);
      state.total = Number(usage.total_cost_cents) || 0;
      state.top = normalizeTop(usage.top);
      render();
    } catch (err) {
      $('#k-total').textContent = '—';
      $('#k-count').textContent = '—';
      $('#k-share').textContent = '—';
      list.innerHTML = errorHTML(err);
      bindRetry(list, load);
    }
  }

  function render() {
    const total = state.total;
    const rows = state.top;
    const maxCost = rows.length ? Math.max(...rows.map((r) => r.cost_cents)) : 0;

    $('#k-total').textContent = fmt.money(total);
    $('#k-count').textContent = fmt.num(rows.length);
    $('#k-share').textContent = total && maxCost ? ((maxCost / total) * 100).toFixed(1) + '%' : '—';

    list.innerHTML = barListHTML(rows);
    bindRetry(list, load);
  }

  await load();
}
