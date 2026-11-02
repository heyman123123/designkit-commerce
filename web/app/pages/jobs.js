/* 全部生成任务 */

import { api, ui } from '../../assets/core.js';
import { setCrumb } from '../shell.js';
import { pageHead, loadJobs, loadSKUs, openReview, templateChip, loadAssets } from '../common.js';

const TABS = [
  ['', '全部'],
  ['queued', '排队中'],
  ['running', '生成中'],
  ['succeeded', '已完成'],
  ['failed', '失败'],
];

export async function render({ query, root }) {
  setCrumb(['工作台', '生成任务']);
  root.innerHTML = ui.loading();
  const status = query.status || '';

  let jobs, skus, assets;
  try {
    [jobs, skus, assets] = await Promise.all([
      loadJobs(status ? { status } : {}), loadSKUs(), loadAssets({ kind: 'output' }),
    ]);
  } catch (err) {
    root.innerHTML = ui.empty({ icon: '⚠', title: '加载失败', sub: err.message });
    return;
  }
  const skuMap = Object.fromEntries(skus.map((s) => [s.id, s]));
  const assetMap = Object.fromEntries(assets.map((a) => [a.id, a]));

  root.innerHTML = `
    ${pageHead({
      title: '生成任务',
      sub: '任务由队列消费，失败会自动重试；连续失败需由运营在后台处理。',
      actions: '<button class="btn sm" id="refresh-jobs">刷新</button>',
    })}
    <div class="tabs">
      ${TABS.map(([v, label]) => `<a class="tab ${status === v ? 'active' : ''}" href="#/jobs${v ? `?status=${v}` : ''}">${label}</a>`).join('')}
    </div>
    ${jobs.length ? `<div class="table-wrap"><table class="table">
      <thead><tr><th>SKU</th><th>模板</th><th>状态</th><th>进度 / 错误</th><th>审核</th><th class="num">成本</th><th>创建</th><th class="shrink"></th></tr></thead>
      <tbody>${jobs.map((j) => `<tr>
        <td><a class="mono" href="#/skus/${j.sku_id}">${ui.esc(skuMap[j.sku_id] ? skuMap[j.sku_id].code : j.sku_id.slice(0, 8))}</a></td>
        <td>${templateChip(j.template)}</td>
        <td>${ui.badge(j.status)}</td>
        <td class="shrink" style="min-width:150px">
          ${j.status === 'running' || j.status === 'queued'
            ? `<div class="progress" style="width:110px"><i style="width:${j.progress || 0}%"></i></div>`
            : `<span class="muted small truncate" style="display:inline-block;max-width:200px">${ui.esc(j.error || '—')}</span>`}
        </td>
        <td>${j.status === 'succeeded' ? ui.badge(j.review_status) : '<span class="muted">—</span>'}</td>
        <td class="num">${ui.fmt.cents(j.cost_cents)}</td>
        <td class="muted small">${ui.esc(ui.fmt.ago(j.created_at))}</td>
        <td class="shrink">
          ${j.status === 'succeeded' && j.review_status === 'pending'
            ? `<button class="btn sm" data-review="${j.id}">审核</button>`
            : `<a class="btn sm ghost" href="#/skus/${j.sku_id}">打开</a>`}
        </td>
      </tr>`).join('')}</tbody>
    </table></div>` : ui.empty({ icon: '⚙', title: '没有任务', sub: status ? '该状态下暂无任务。' : '去 SKU 详情页发起生成。' })}`;

  document.getElementById('refresh-jobs').onclick = () => render({ query, root });
  root.querySelectorAll('[data-review]').forEach((b) => {
    b.onclick = () => {
      const j = jobs.find((x) => x.id === b.dataset.review);
      openReview({
        job: j,
        outputAsset: j.output_asset_id ? assetMap[j.output_asset_id] : null,
        onDone: () => render({ query, root }),
      });
    };
  });
}
