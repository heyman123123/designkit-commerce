/* 任务详情 + 审核
 *
 * 审核只允许在任务 succeeded 后；驳回必须填原因（后端同样强校验）。
 */

import { router } from '../web/assets/core.js';
import { get, post, wsPath, assetURL } from './api.js';
import {
  esc, toast, loading, setBusy, setCleanup, friendlyError, jobStatus, isActive,
  templateName, confirmSheet, promptSheet,
} from './ui.js';

let poll = null;

function stopPoll() {
  if (poll) {
    clearInterval(poll);
    poll = null;
  }
}

export default async function renderJob({ root, params, query }) {
  stopPoll();
  const jobId = params.id;
  const from = (query && query.from) || '/jobs';

  root.innerHTML = `<div class="screen job-screen">
    <header class="screen-head">
      <div class="head-main">
        <button type="button" class="back-btn" data-back aria-label="返回任务列表">‹ 返回</button>
        <h1 class="screen-title">任务详情</h1>
      </div>
    </header>
    ${loading('正在加载任务…')}
  </div>`;

  root.querySelector('[data-back]').addEventListener('click', () => router.go(from));

  let job;
  let sku = null;
  try {
    const [jobRes, skuRes] = await Promise.all([get(wsPath(`/jobs/${jobId}`)), get(wsPath('/skus'))]);
    job = jobRes;
    sku = ((skuRes && skuRes.items) || []).find((s) => s.id === job.sku_id) || null;
  } catch (err) {
    root.innerHTML = `<div class="screen job-screen">
      <header class="screen-head"><div class="head-main">
        <button type="button" class="back-btn" data-back>‹ 返回</button>
        <h1 class="screen-title">任务详情</h1>
      </div></header>
      <div class="state-error" role="alert">
        <p>${esc(friendlyError(err, '任务加载失败'))}</p>
        <button type="button" class="btn sm mt-8" data-retry>重试</button>
      </div>
    </div>`;
    root.querySelector('[data-back]').addEventListener('click', () => router.go(from));
    root.querySelector('[data-retry]').addEventListener('click', () => renderJob({ root, params, query }));
    return;
  }

  const st = jobStatus(job);
  const active = isActive(job);
  const canReview = job.status === 'succeeded';
  const reviewed = job.review_status && job.review_status !== 'pending';

  root.innerHTML = `<div class="screen job-screen">
    <header class="screen-head">
      <div class="head-main">
        <button type="button" class="back-btn" data-back aria-label="返回任务列表">‹ 返回</button>
        <h1 class="screen-title">${esc(templateName(job.template))} · <span class="mono">${esc(sku ? sku.code : 'SKU')}</span></h1>
        <p class="screen-sub">${esc(fmtTime(job.created_at))}</p>
      </div>
    </header>

    <section class="job-status-card">
      <div class="job-status-head">
        <span class="badge ${st.tone}">${esc(st.label)}</span>
        ${reviewed ? '<span class="hint">已审核，可重新审核</span>' : ''}
      </div>
      ${active
        ? `<div class="progress job-progress"><i style="width:${Math.max(2, Math.min(100, job.progress || 0))}%"></i></div>
           <p class="hint">生成中，进度每 2 秒自动刷新</p>`
        : ''}
      ${job.status === 'failed'
        ? `<div class="error-box" role="alert">
            <p>生成失败${job.error ? `：${esc(job.error)}` : ''}</p>
            <p class="hint">用户端没有重试接口，请联系管理员在后台重试该任务。</p>
          </div>`
        : ''}
      ${job.review_reason
        ? `<p class="review-reason">驳回原因：${esc(job.review_reason)}</p>`
        : ''}
    </section>

    ${job.output_asset_id
      ? `<section class="preview-block">
          <button type="button" class="preview-thumb" data-preview aria-label="全屏预览结果图">
            <img data-preview-img alt="生成结果图" hidden>
            <span class="preview-loading" data-preview-loading>正在加载图片…</span>
          </button>
          <button type="button" class="btn block lg mt-16" data-preview2>全屏预览 / 分享</button>
        </section>`
      : `<section class="preview-block muted">${job.status === 'succeeded' ? '这条任务没有结果图，可能被清理了。' : '结果图生成后会出现在这里。'}</section>`}

    <section class="review-block" aria-label="审核">
      <h2 class="block-title">审核</h2>
      ${canReview
        ? `<p class="hint">通过后结果图标记为质检通过，可被导出；驳回必须填写原因。</p>
           <div class="review-actions">
             <button type="button" class="btn primary block" data-approve>通过</button>
             <button type="button" class="btn danger block" data-reject>驳回…</button>
           </div>`
        : `<p class="hint">任务完成后才能审核。</p>`}
    </section>
  </div>`;

  root.querySelector('[data-back]').addEventListener('click', () => router.go(from));

  const goPreview = () => router.go(`/preview/${job.id}?from=${encodeURIComponent(`/job/${job.id}`)}`);
  const previewBtn = root.querySelector('[data-preview]');
  if (previewBtn) previewBtn.addEventListener('click', goPreview);
  const previewBtn2 = root.querySelector('[data-preview2]');
  if (previewBtn2) previewBtn2.addEventListener('click', goPreview);

  if (job.output_asset_id) loadPreviewThumb(root, job.output_asset_id);

  const approveBtn = root.querySelector('[data-approve]');
  const rejectBtn = root.querySelector('[data-reject]');

  if (approveBtn) {
    approveBtn.addEventListener('click', async () => {
      const ok = await confirmSheet({
        title: '通过这张结果图？',
        message: '通过后结果图会进入质检通过状态，可被导出。',
        confirmLabel: '通过',
        danger: false,
      });
      if (!ok) return;
      setBusy(approveBtn, true, '提交中…');
      try {
        await post(wsPath(`/jobs/${job.id}/review`), { status: 'approved' });
        toast('已通过审核', 'good');
        router.go('/jobs');
      } catch (err) {
        toast(friendlyError(err, '审核失败，请重试'), 'bad');
        setBusy(approveBtn, false);
        if (err && err.status === 409) renderJob({ root, params, query });
      }
    });
  }

  if (rejectBtn) {
    rejectBtn.addEventListener('click', async () => {
      const reason = await promptSheet({
        title: '驳回原因',
        hint: '会记录在任务上，至少 2 个字',
        placeholder: '例如：背景不干净、商品比例失真、有文字水印',
        submitLabel: '确认驳回',
        minLength: 2,
      });
      if (!reason) return;
      setBusy(rejectBtn, true, '提交中…');
      try {
        await post(wsPath(`/jobs/${job.id}/review`), { status: 'rejected', reason });
        toast('已驳回', 'good');
        router.go('/jobs');
      } catch (err) {
        toast(friendlyError(err, '驳回失败，请重试'), 'bad');
        setBusy(rejectBtn, false);
        if (err && err.status === 409) renderJob({ root, params, query });
      }
    });
  }

  if (active) {
    poll = setInterval(async () => {
      if (document.hidden) return;
      try {
        const next = await get(wsPath(`/jobs/${jobId}`));
        if (next.status !== job.status || next.review_status !== job.review_status) {
          renderJob({ root, params, query });
        }
      } catch {
        /* 静默，详情页可手动返回刷新 */
      }
    }, 2000);
  }

  setCleanup(stopPoll);
}

function fmtTime(value) {
  if (!value) return '';
  const d = new Date(value);
  if (isNaN(d.getTime())) return '';
  return `创建于 ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(
    d.getHours(),
  ).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

async function loadPreviewThumb(root, assetId) {
  const img = root.querySelector('[data-preview-img]');
  const placeholder = root.querySelector('[data-preview-loading]');
  if (!img) return;
  try {
    img.src = await assetURL(assetId);
    img.hidden = false;
    if (placeholder) placeholder.hidden = true;
  } catch (err) {
    if (placeholder) placeholder.textContent = friendlyError(err, '图片加载失败，点重试或下拉刷新');
  }
}
