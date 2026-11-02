/* 任务列表：生成进度 + 待审队列
 *
 * 进度用 2 秒轮询兜底（后端 SSE 只认 Authorization 头，浏览器 EventSource 不能带；
 * 见 api.js 与交付说明，等后端支持 ?access_token 后换成 SSE）。
 */

import { router } from '../web/assets/core.js';
import { get, wsPath } from './api.js';
import {
  esc, empty, loading, fmt, setCleanup, friendlyError, jobStatus, isActive, templateName,
} from './ui.js';

const POLL_MS = 2000;
const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'active', label: '进行中' },
  { key: 'review', label: '待审核' },
];

let timer = null;

function stopPolling() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function needsReview(job) {
  return job && job.status === 'succeeded' && job.review_status === 'pending';
}

export default async function renderJobs({ root, query }) {
  stopPolling();

  let jobs = [];
  let skuMap = new Map();
  let filter = 'all';
  const skuFilter = (query && query.sku) || '';

  root.innerHTML = `<div class="screen jobs-screen">
    <header class="screen-head">
      <div class="head-main">
        <h1 class="screen-title">审核</h1>
        <p class="screen-sub" data-jobs-sub>正在加载任务…</p>
      </div>
      <div class="head-actions">
        <button type="button" class="btn ghost sm" data-refresh aria-label="刷新">↻</button>
      </div>
    </header>
    <div class="chips" role="tablist" aria-label="筛选任务">${FILTERS.map(
      (f) => `<button type="button" class="chip ${f.key === 'all' ? 'active' : ''}" role="tab"
        aria-selected="${f.key === 'all'}" data-filter="${f.key}">${f.label}<span class="chip-count" data-count="${f.key}"></span></button>`,
    ).join('')}</div>
    <div class="poll-hint" data-poll-hint hidden>每 2 秒自动刷新进度</div>
    <div class="jobs-list" data-jobs>${loading('正在加载任务…')}</div>
  </div>`;

  const listEl = root.querySelector('[data-jobs]');
  const subEl = root.querySelector('[data-jobs-sub]');
  const hintEl = root.querySelector('[data-poll-hint]');

  root.querySelector('[data-refresh]').addEventListener('click', () => renderJobs({ root, query }));

  root.querySelectorAll('[data-filter]').forEach((b) => {
    b.addEventListener('click', () => {
      filter = b.dataset.filter;
      root.querySelectorAll('[data-filter]').forEach((x) => {
        const on = x.dataset.filter === filter;
        x.classList.toggle('active', on);
        x.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      renderList();
    });
  });

  const jobsPath = () => wsPath(`/jobs${skuFilter ? `?sku_id=${encodeURIComponent(skuFilter)}` : ''}`);

  function skuCode(job) {
    const sku = skuMap.get(job.sku_id);
    return sku ? sku.code : '未知 SKU';
  }

  function filterJobs() {
    if (filter === 'active') return jobs.filter(isActive);
    if (filter === 'review') return jobs.filter(needsReview);
    return jobs;
  }

  function renderCounts() {
    const counts = {
      all: jobs.length,
      active: jobs.filter(isActive).length,
      review: jobs.filter(needsReview).length,
    };
    root.querySelectorAll('[data-count]').forEach((el) => {
      const n = counts[el.dataset.count] || 0;
      el.textContent = n ? String(n) : '';
    });
    const active = counts.active;
    const review = counts.review;
    subEl.textContent = active || review
      ? `${active ? `${active} 个生成中` : ''}${active && review ? ' · ' : ''}${review ? `${review} 个待审核` : ''}`
      : '任务完成后在这里审核';
  }

  function jobCardHTML(job) {
    const st = jobStatus(job);
    const active = isActive(job);
    const code = skuCode(job);
    const review = needsReview(job);
    return `<a class="job-card" href="#/job/${esc(job.id)}">
      <div class="job-top">
        <span class="job-title">${esc(templateName(job.template))} · <span class="mono">${esc(code)}</span></span>
        <span class="badge ${st.tone}">${esc(st.label)}</span>
      </div>
      <div class="job-meta">${esc(fmt.ago(job.created_at))}${job.error ? ` · <span class="bad">${esc(job.error)}</span>` : ''}</div>
      ${active
        ? `<div class="progress job-progress"><i style="width:${Math.max(2, Math.min(100, job.progress || 0))}%"></i></div>
           <div class="job-foot"><span class="hint">生成中，进度自动刷新</span></div>`
        : `<div class="job-foot"><span class="job-cta">${review ? '去审核 ›' : job.output_asset_id ? '查看结果 ›' : '查看详情 ›'}</span></div>`}
    </a>`;
  }

  function renderList() {
    const list = filterJobs();
    if (!list.length) {
      listEl.innerHTML = empty({
        icon: '◎',
        title: filter === 'review' ? '没有待审核的任务' : filter === 'active' ? '没有进行中的任务' : '还没有生成任务',
        sub: '拍摄上传后发起生成，任务会出现在这里。',
        action: filter === 'all'
          ? '<button type="button" class="btn primary block lg mt-16" data-go-capture>去拍摄上传</button>'
          : '',
      });
      const go = listEl.querySelector('[data-go-capture]');
      if (go) go.addEventListener('click', () => router.go('/capture'));
      return;
    }
    listEl.innerHTML = list.map(jobCardHTML).join('');
  }

  renderCounts();

  try {
    const [skuRes, jobRes] = await Promise.all([get(wsPath('/skus')), get(jobsPath())]);
    skuMap = new Map(((skuRes && skuRes.items) || []).map((s) => [s.id, s]));
    jobs = (jobRes && jobRes.items) || [];
  } catch (err) {
    listEl.innerHTML = `<div class="state-error" role="alert">
      <p>${esc(friendlyError(err, '任务加载失败'))}</p>
      <button type="button" class="btn sm mt-8" data-retry>重试</button>
    </div>`;
    const retry = listEl.querySelector('[data-retry]');
    if (retry) retry.addEventListener('click', () => renderJobs({ root, query }));
    return;
  }

  renderCounts();
  renderList();

  async function tick() {
    if (document.hidden) return;
    try {
      const res = await get(jobsPath());
      jobs = (res && res.items) || [];
      renderCounts();
      renderList();
      if (!jobs.some(isActive)) {
        stopPolling();
        hintEl.hidden = true;
      }
    } catch {
      /* 轮询失败静默处理，避免每 2 秒弹一次错误；用户可手动刷新 */
    }
  }

  if (jobs.some(isActive)) {
    hintEl.hidden = false;
    timer = setInterval(tick, POLL_MS);
  }

  const onVisible = () => {
    if (!document.hidden && jobs.some(isActive)) tick();
  };
  document.addEventListener('visibilitychange', onVisible);

  setCleanup(() => {
    stopPolling();
    document.removeEventListener('visibilitychange', onVisible);
  });
}
