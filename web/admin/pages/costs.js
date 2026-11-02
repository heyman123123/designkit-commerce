/* 成本看板：#/costs
 * GET /v1/admin/costs?days= → 按天趋势 + 模板/租户/事件排行；GET /v1/admin/overview → 营收与毛利。
 * 无图表库：趋势用 CSS 柱状，排行用表格 + 内嵌占比条。
 */

import { ui, $ } from '../../assets/core.js';
import { adminApi, errorHTML, bindRetry, notWired, fmt } from '../admin-core.js';

const state = { days: 30, cost: null, overview: null, tenants: new Map() };

const TEMPLATE_LABEL = { main: '主图', scene: '场景图', selling_point: '卖点图', unknown: '未知' };
const EVENT_LABEL = { sku_created: '创建 SKU', export: '导出', generation: '生成', unknown: '未知' };

const DAY_OPTIONS = [
  [7, '近 7 天'],
  [30, '近 30 天'],
  [90, '近 90 天'],
  [365, '近 365 天'],
];

function shellHTML() {
  return `<div class="page-head">
    <div class="ph-main">
      <h1>成本看板</h1>
      <p class="page-sub">来源 usage_ledger；趋势按天聚合，排行为所选区间内累计。</p>
    </div>
    <div class="ph-actions">
      <select class="select" id="c-days" aria-label="选择统计区间">
        ${DAY_OPTIONS.map(([v, l]) => `<option value="${v}" ${v === state.days ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <button class="btn sm" id="c-refresh" type="button">刷新</button>
    </div>
  </div>

  <div class="grid four mb-16">
    <div class="kpi">
      <div class="k-label" id="k-cost-label">区间成本</div>
      <div class="k-value" id="k-cost">—</div>
      <div class="k-note" id="k-cost-note">usage_ledger 求和</div>
    </div>
    <div class="kpi"><div class="k-label">累计营收</div><div class="k-value" id="k-revenue">—</div><div class="k-note">已支付订单总额</div></div>
    <div class="kpi"><div class="k-label">累计毛利</div><div class="k-value" id="k-margin">—</div><div class="k-note">营收 − 累计成本</div></div>
    <div class="kpi"><div class="k-label">待处理</div><div class="k-value" id="k-pending">—</div><div class="k-note">待支付订单 / 未结风控</div></div>
  </div>

  <div id="c-body">${ui.loading('正在汇总成本…')}</div>

  <div class="callout info mt-16">
    <b>成本口径</b>
    <p class="muted small mt-8">
      成本来自生成与导出的 usage_ledger 流水；模板维度只统计 <code class="code-inline">generation</code> 事件。
      毛利为全量营收减全量成本，未计入人工与基础设施开销。
    </p>
  </div>`;
}

function trendHTML() {
  const rows = (state.cost && state.cost.by_day) || [];
  if (!rows.length) {
    return ui.empty({
      icon: '◭',
      title: '区间内没有成本记录',
      sub: '换一个统计区间，或等待租户产生生成/导出用量。',
    });
  }
  const max = Math.max(...rows.map((r) => Number(r.cost_cents) || 0), 1);
  const step = Math.max(1, Math.ceil(rows.length / 10));
  const cols = rows
    .map((r, i) => {
      const v = Number(r.cost_cents) || 0;
      const h = v ? Math.max(2, Math.round((v / max) * 100)) : 0;
      const label = String(r.key || '').slice(5);
      return `<div class="tr-col" title="${ui.esc(r.key)} · ${fmt.money(v)} · ${fmt.num(r.count)} 笔">
        <div class="tr-bar ${v ? '' : 'zero'}" style="height:${h}%"></div>
        <div class="tr-label">${i % step === 0 ? ui.esc(label) : ''}</div>
      </div>`;
    })
    .join('');
  return `<div class="trend-wrap">
    <div class="trend-head">
      <span class="muted small">${ui.esc((rows[0] && rows[0].key) || '')} → ${ui.esc((rows[rows.length - 1] && rows[rows.length - 1].key) || '')}</span>
      <span class="muted small">峰值 ${fmt.money(max)}</span>
    </div>
    <div class="trend">${cols}</div>
  </div>`;
}

function rankHTML(rows, label) {
  if (!rows.length) {
    return ui.empty({ icon: '◭', title: '暂无数据', sub: '该维度在区间内没有成本记录。' });
  }
  const max = Math.max(...rows.map((r) => Number(r.cost_cents) || 0), 1);
  const total = rows.reduce((s, r) => s + (Number(r.cost_cents) || 0), 0) || 1;
  return `<div class="table-wrap"><table class="table dense">
    <thead><tr><th class="shrink">#</th><th>${ui.esc(label)}</th><th>占比</th><th class="right">成本</th><th class="right">笔数</th></tr></thead>
    <tbody>${rows
      .map((r, i) => {
        const v = Number(r.cost_cents) || 0;
        const w = Math.max(1, Math.round((v / max) * 100));
        const share = ((v / total) * 100).toFixed(1);
        return `<tr>
          <td class="muted small">${i + 1}</td>
          <td>
            <div class="cell-title">${ui.esc(r.display || r.key || '—')}</div>
            ${r.sub ? `<div class="muted small">${ui.esc(r.sub)}</div>` : ''}
          </td>
          <td class="rank-bar-cell"><div class="mini-bar"><i style="width:${w}%"></i></div></td>
          <td class="num"><b>${fmt.money(v)}</b><div class="muted small">${share}%</div></td>
          <td class="num muted">${fmt.num(r.count)}</td>
        </tr>`;
      })
      .join('')}</tbody>
  </table></div>`;
}

function bodyHTML() {
  const cost = state.cost || {};
  const byTemplate = (cost.by_template || []).map((r) => ({
    ...r,
    display: TEMPLATE_LABEL[r.key] || r.key,
    sub: r.key,
  }));
  const byTenant = (cost.by_tenant || []).slice(0, 15).map((r) => {
    const t = state.tenants.get(r.key);
    return { ...r, display: r.name || (t && t.name) || '未知租户', sub: t ? t.slug : fmt.shortId(r.key) };
  });
  const byEvent = (cost.by_event || []).map((r) => ({ ...r, display: EVENT_LABEL[r.key] || r.key }));

  return `<div class="grid two mb-16">
      <div class="card">
        <div class="card-head"><h2>成本趋势</h2><span class="chip">${fmt.num(state.days)} 天</span></div>
        ${trendHTML()}
      </div>
      <div class="card">
        <div class="card-head"><h2>模板成本排行</h2><span class="chip">generation</span></div>
        ${rankHTML(byTemplate, '模板')}
      </div>
    </div>

    <div class="card mb-16">
      <div class="card-head"><h2>租户成本排行</h2><span class="chip">Top ${fmt.num(byTenant.length)}</span></div>
      ${rankHTML(byTenant, '租户')}
    </div>

    <div class="grid two">
      <div class="card">
        <div class="card-head"><h2>事件成本</h2></div>
        ${rankHTML(byEvent, '事件')}
      </div>
      <div class="card">
        <div class="card-head"><h2>暂未提供的维度</h2></div>
        ${notWired({
          title: '项目 / SKU / 供应商维度',
          desc: '当前 /v1/admin/costs 只聚合天、模板、租户与事件；usage_ledger 里没有 project_id、sku_id、provider，所以这三个维度暂时无法出数。',
          apis: ['GET /v1/admin/costs?group_by=project', 'GET /v1/admin/costs?group_by=provider'],
        })}
        <p class="hint mt-16">毛利告警阈值与按供应商拆分的成本也尚未接入。</p>
      </div>
    </div>`;
}

export async function page({ root }) {
  root.innerHTML = shellHTML();

  const daysSel = $('#c-days');
  const body = $('#c-body');

  $('#c-refresh').onclick = () => load();
  daysSel.onchange = () => {
    state.days = Number(daysSel.value) || 30;
    load();
  };

  async function load() {
    body.innerHTML = ui.loading('正在汇总成本…');
    ['k-cost', 'k-revenue', 'k-margin', 'k-pending'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.textContent = '—';
    });

    const tenantsPromise = adminApi
      .get('/v1/admin/tenants')
      .then((d) => {
        state.tenants = new Map((d.items || []).map((t) => [t.id, t]));
      })
      .catch(() => {
        state.tenants = new Map();
      });

    try {
      const [cost, overview] = await Promise.all([
        adminApi.get(`/v1/admin/costs?days=${state.days}`),
        adminApi.get('/v1/admin/overview'),
        tenantsPromise,
      ]);
      state.cost = cost;
      state.overview = overview;
      render();
    } catch (err) {
      body.innerHTML = errorHTML(err);
      bindRetry(body, load);
    }
  }

  function render() {
    const cost = state.cost || {};
    const ov = state.overview || {};

    $('#k-cost').textContent = fmt.money(cost.total_cost_cents);
    $('#k-cost-label').textContent = `区间成本（${fmt.num(state.days)} 天）`;
    $('#k-cost-note').textContent = `${fmt.num((cost.by_day || []).length)} 天有流水`;
    $('#k-revenue').textContent = fmt.money(ov.revenue_cents);

    const margin = Number(ov.margin_cents) || 0;
    const marginEl = $('#k-margin');
    marginEl.textContent = fmt.money(margin);
    marginEl.classList.toggle('neg', margin < 0);

    $('#k-pending').textContent = `${fmt.num(ov.pending_orders)} / ${fmt.num(ov.open_risks)}`;

    body.innerHTML = bodyHTML();
    bindRetry(body, load);
  }

  await load();
}
