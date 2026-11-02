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
  const picked = new Set();
  const reviewed = jobs.filter((j) => j.status === 'succeeded' && j.review_status !== 'pending').slice(0, 30);

  root.innerHTML = `
    ${pageHead({
      title: '审核队列',
      sub: '通过后的结果才计入导出包；驳回必须写明原因，便于重新生成时修正。',
      actions: `<span class="badge warn no-dot">待审 ${pending.length}</span>`,
    })}
    ${pending.length ? `<div class="row mb-12" style="gap:8px">
      <label class="small row" style="gap:6px;cursor:pointer">
        <input type="checkbox" id="pick-all-pending"> 全选待审
      </label>
      <span class="grow"></span>
      <span class="muted small" id="pick-count"></span>
      <button class="btn sm danger" id="batch-reject" disabled>批量驳回</button>
      <button class="btn sm primary" id="batch-approve" disabled>批量通过</button>
    </div>
    <div class="grid three mb-24">
      ${pending.map((j) => {
        const a = j.output_asset_id ? assetMap[j.output_asset_id] : null;
        const s = skuMap[j.sku_id];
        return `<div class="card pad-sm">
          <div class="thumb" style="aspect-ratio:4/3">
            ${a ? `<img src="${api.assetURL(a.id)}" loading="lazy" alt="">` : '<div class="empty" style="border:none">无输出图</div>'}
            <label class="t-check" style="background:rgba(0,0,0,.55);border-radius:6px;padding:2px 4px;cursor:pointer">
              <input type="checkbox" data-pick="${j.id}" aria-label="选择该结果">
            </label>
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

  // 批量选择：勾选状态只影响批量按钮，不触发重渲染。
  function syncPick() {
    const count = document.getElementById('pick-count');
    if (count) count.textContent = picked.size ? `已选 ${picked.size}` : '';
    const approve = document.getElementById('batch-approve');
    const reject = document.getElementById('batch-reject');
    if (approve) approve.disabled = picked.size === 0;
    if (reject) reject.disabled = picked.size === 0;
    const all = document.getElementById('pick-all-pending');
    if (all) all.checked = pending.length > 0 && pending.every((j) => picked.has(j.id));
  }

  const allBox = document.getElementById('pick-all-pending');
  if (allBox) {
    allBox.onchange = () => {
      pending.forEach((j) => (allBox.checked ? picked.add(j.id) : picked.delete(j.id)));
      root.querySelectorAll('[data-pick]').forEach((el) => {
        el.checked = picked.has(el.dataset.pick);
      });
      syncPick();
    };
  }
  root.querySelectorAll('[data-pick]').forEach((el) => {
    el.onchange = () => {
      if (el.checked) picked.add(el.dataset.pick);
      else picked.delete(el.dataset.pick);
      syncPick();
    };
  });
  syncPick();

  // batch 批量提交审核；成功后重渲染刷新队列。
  async function submitBatch(status, reason) {
    const ids = [...picked];
    if (!ids.length) return;
    const approveBtn = document.getElementById('batch-approve');
    const rejectBtn = document.getElementById('batch-reject');
    if (approveBtn) approveBtn.disabled = true;
    if (rejectBtn) rejectBtn.disabled = true;
    try {
      const out = await api.post(api.w('/jobs/review-batch'), { ids, status, reason });
      const tone = out.success === out.total ? 'good' : 'warn';
      ui.toast(`${status === 'approved' ? '通过' : '驳回'} ${out.success}/${out.total} 条`, tone);
      rerender();
    } catch (err) {
      ui.toast(err.message, 'bad');
      syncPick();
    }
  }

  const approveAll = document.getElementById('batch-approve');
  if (approveAll) approveAll.onclick = () => submitBatch('approved');

  const rejectAll = document.getElementById('batch-reject');
  if (rejectAll) {
    rejectAll.onclick = () => {
      const body = document.createElement('div');
      body.innerHTML = `<p class="muted small">将对已选的 ${picked.size} 条结果统一驳回，原因会写入每条记录。</p>
        <div class="field mt-12"><label for="batch-reason">驳回原因</label>
          <textarea class="textarea" id="batch-reason" placeholder="例如：背景出现品牌 logo，需要重新生成"></textarea></div>`;
      ui.modal({
        title: `批量驳回 ${picked.size} 条`,
        body,
        footer: [
          { label: '取消', kind: 'ghost', onClick: (close) => close() },
          { label: '确认驳回', kind: 'danger', onClick: async (close) => {
            const reason = body.querySelector('#batch-reason').value.trim();
            if (!reason) return ui.toast('驳回必须填写原因', 'bad');
            close();
            await submitBatch('rejected', reason);
          } },
        ],
      });
    };
  }

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
