/* 审核队列：待审结果集中处理 */

import { api, ui } from '../../assets/core.js';
import { setCrumb } from '../shell.js';
import { pageHead, loadJobs, loadSKUs, loadAssets, openReview, templateChip } from '../common.js';

export async function render({ root }) {
  setCrumb(['工作台', '审核队列']);
  root.innerHTML = ui.loading();

  let jobs, skus, assets;
  try {
    [jobs, skus, assets] = await Promise.all([loadJobs(), loadSKUs(), loadAssets({ kind: 'output' })]);
  } catch (err) {
    root.innerHTML = ui.empty({ icon: '⚠', title: '加载失败', sub: err.message });
    return;
  }
  const skuMap = Object.fromEntries(skus.map((s) => [s.id, s]));
  const assetMap = Object.fromEntries(assets.map((a) => [a.id, a]));
  const pending = jobs.filter((j) => j.status === 'succeeded' && j.review_status === 'pending');
  const reviewed = jobs.filter((j) => j.status === 'succeeded' && j.review_status !== 'pending').slice(0, 30);

  root.innerHTML = `
    ${pageHead({
      title: '审核队列',
      sub: '通过后的结果才计入导出包；驳回必须写明原因，便于重新生成时修正。',
      actions: `<span class="badge warn no-dot">待审 ${pending.length}</span>`,
    })}
    ${pending.length ? `<div class="grid three mb-24">
      ${pending.map((j) => {
        const a = j.output_asset_id ? assetMap[j.output_asset_id] : null;
        const s = skuMap[j.sku_id];
        return `<div class="card pad-sm">
          <div class="thumb" style="aspect-ratio:4/3">
            ${a ? `<img src="${api.assetURL(a.id)}" loading="lazy" alt="">` : '<div class="empty" style="border:none">无输出图</div>'}
            <div class="t-meta"><span>${ui.esc(TPL(j.template))}</span><span style="margin-left:auto">${ui.esc(ui.fmt.ago(j.updated_at || j.created_at))}</span></div>
          </div>
          <div class="row between mt-8">
            <a class="mono small" href="#/skus/${j.sku_id}">${ui.esc(s ? s.code : j.sku_id.slice(0, 8))}</a>
            ${ui.badge('pending')}
          </div>
          <div class="row mt-8">
            <button class="btn sm danger grow" data-reject="${j.id}">驳回</button>
            <button class="btn sm primary grow" data-approve="${j.id}">通过</button>
          </div>
        </div>`;
      }).join('')}
    </div>` : ui.empty({ icon: '✓', title: '没有待审核结果', sub: '生成完成的结果会自动进入这里。', })}

    <section class="card">
      <div class="card-head"><h2>最近审核记录</h2>
        <a class="btn sm ghost" href="#/jobs">全部任务</a></div>
      ${reviewed.length ? `<div class="table-wrap"><table class="table">
        <thead><tr><th>SKU</th><th>模板</th><th>结论</th><th>原因</th><th>时间</th></tr></thead>
        <tbody>${reviewed.map((j) => `<tr>
          <td><a class="mono" href="#/skus/${j.sku_id}">${ui.esc(skuMap[j.sku_id] ? skuMap[j.sku_id].code : j.sku_id.slice(0, 8))}</a></td>
          <td>${templateChip(j.template)}</td>
          <td>${ui.badge(j.review_status)}</td>
          <td class="muted small truncate" style="max-width:320px">${ui.esc(j.review_reason || '—')}</td>
          <td class="muted small">${ui.esc(ui.fmt.dt(j.updated_at))}</td>
        </tr>`).join('')}</tbody>
      </table></div>` : '<p class="muted small">还没有审核记录。</p>'}
    </section>`;

  const findJob = (id) => jobs.find((j) => j.id === id);
  const rerender = () => render({ root });

  root.querySelectorAll('[data-approve]').forEach((b) => {
    b.onclick = async () => {
      const j = findJob(b.dataset.approve);
      b.disabled = true;
      try {
        await api.post(api.w(`/jobs/${j.id}/review`), { status: 'approved' });
        ui.toast('已通过', 'good');
        rerender();
      } catch (err) {
        ui.toast(err.message, 'bad');
        b.disabled = false;
      }
    };
  });
  root.querySelectorAll('[data-reject]').forEach((b) => {
    b.onclick = () => {
      const j = findJob(b.dataset.reject);
      openReview({ job: j, outputAsset: j.output_asset_id ? assetMap[j.output_asset_id] : null, onDone: rerender });
    };
  });

  function TPL(t) {
    return { main: '主图', scene: '场景图', selling_point: '卖点图' }[t] || t;
  }
}
