/* 用量与成本 */

import { api, ui, session } from '../../assets/core.js';
import { setCrumb } from '../shell.js';
import { pageHead, loadUsage } from '../common.js';

const EVENT_LABEL = {
  sku_created: '新建 SKU',
  generation: 'AI 生成',
  export: '高清导出',
};

export async function render({ root }) {
  setCrumb(['工作台', '用量与成本']);
  root.innerHTML = ui.loading();

  let usage;
  try {
    usage = await loadUsage();
  } catch (err) {
    root.innerHTML = ui.empty({ icon: '⚠', title: '加载失败', sub: err.message });
    return;
  }

  const skuPct = Math.min(100, Math.round(((usage.sku_used || 0) / Math.max(1, usage.sku_quota)) * 100));
  const exportPct = Math.min(100, Math.round(((usage.export_used || 0) / Math.max(1, usage.export_quota)) * 100));

  root.innerHTML = `
    ${pageHead({
      title: '用量与成本',
      sub: '所有扣减与成本都来自不可变流水，按租户隔离。',
      actions: '<a class="btn sm" href="#/exports">导出中心</a>',
    })}
    <div class="grid two mb-24">
      <div class="card">
        <div class="row between"><h3>SKU 配额</h3><span class="mono">${usage.sku_used}/${usage.sku_quota}</span></div>
        <div class="progress mt-16"><i style="width:${skuPct}%"></i></div>
        <p class="hint mt-8">${usage.sku_used >= usage.sku_quota ? '已用满，新建 SKU 会被拒绝。' : `还可新建 ${usage.sku_quota - usage.sku_used} 个 SKU。`}</p>
      </div>
      <div class="card">
        <div class="row between"><h3>高清导出</h3><span class="mono">${usage.export_used}/${usage.export_quota}</span></div>
        <div class="progress mt-16"><i style="width:${exportPct}%"></i></div>
        <p class="hint mt-8">${usage.export_used >= usage.export_quota ? '额度已用完，导出会被拒绝。' : `还可导出 ${usage.export_quota - usage.export_used} 次。`}</p>
      </div>
    </div>
    <div class="grid two mb-24">
      <div class="kpi"><div class="k-label">累计生成 / 导出成本</div>
        <div class="k-value">${ui.fmt.cents(usage.cost_cents)}</div>
        <div class="k-note">成本按每次生成与导出的实际计费累加</div></div>
      <div class="kpi"><div class="k-label">流水条数</div>
        <div class="k-value">${(usage.entries || []).length}</div>
        <div class="k-note">最近 50 条</div></div>
    </div>
    <section class="card">
      <div class="card-head"><h2>用量流水</h2><span class="muted small">不可变 · 只追加</span></div>
      ${ (usage.entries || []).length ? `<div class="table-wrap"><table class="table">
        <thead><tr><th>事件</th><th>说明</th><th class="num">数量</th><th class="num">成本</th><th>时间</th></tr></thead>
        <tbody>${usage.entries.map((e) => `<tr>
          <td><span class="chip">${ui.esc(EVENT_LABEL[e.event] || e.event)}</span></td>
          <td class="muted small truncate" style="max-width:360px">${ui.esc(e.note || '—')}</td>
          <td class="num">${e.units}</td>
          <td class="num">${ui.fmt.cents(e.cost_cents)}</td>
          <td class="muted small">${ui.esc(ui.fmt.dt(e.created_at))}</td>
        </tr>`).join('')}</tbody></table></div>` : '<p class="muted small">还没有流水记录。</p>'}
    </section>
    <div class="card mt-24">
      <div class="row between wrap">
        <div><b>需要更多额度？</b>
          <div class="muted small">当前项目处于早期运营阶段，套餐调整由平台运营手工开通。</div></div>
        <span class="badge accent no-dot">${ui.esc(ui.label((window.__dkWs || {}).plan || 'free'))}</span>
      </div>
    </div>`;
}
