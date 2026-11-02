/* 结果全屏预览 + 分享
 *
 * 图片：fetch + Bearer → blob URL（后端内容接口只认 Authorization 头）。
 * 分享：Web Share API（有文件能力时分享图片文件）；不支持时降级为下载 + 复制深链，
 * 并明确告知「对方需要登录后查看」——目前后端没有公开分享令牌，不假装能匿名分享。
 */

import { router } from '../web/assets/core.js';
import { get, wsPath, assetURL, assetFile, downloadAsset } from './api.js';
import {
  esc, toast, setCleanup, friendlyError, templateName, copyText, fmt,
} from './ui.js';

const fileCache = new Map();

export default async function renderPreview({ root, params, query }) {
  const jobId = params.jobId;
  const from = (query && query.from) || '/jobs';

  document.body.classList.add('viewer-open');
  root.innerHTML = `<div class="viewer">
    <div class="viewer-bar"><button type="button" class="viewer-btn" data-close aria-label="关闭">✕</button></div>
    <div class="viewer-loading">正在加载结果…</div>
  </div>`;

  let cleanup = () => {};
  setCleanup(() => {
    cleanup();
    document.body.classList.remove('viewer-open');
  });

  const close = () => {
    document.body.classList.remove('viewer-open');
    router.go(from);
  };

  root.querySelector('[data-close]').addEventListener('click', close);

  let job;
  let assets = [];
  let sku = null;

  try {
    const [jobRes, skuRes] = await Promise.all([get(wsPath(`/jobs/${jobId}`)), get(wsPath('/skus'))]);
    job = jobRes;
    sku = ((skuRes && skuRes.items) || []).find((s) => s.id === job.sku_id) || null;
    const assetRes = await get(wsPath(`/assets?sku_id=${encodeURIComponent(job.sku_id)}&kind=output`));
    assets = (assetRes && assetRes.items) || [];
  } catch (err) {
    root.innerHTML = `<div class="viewer">
      <div class="viewer-bar">
        <button type="button" class="viewer-btn" data-close aria-label="关闭">✕</button>
        <span class="viewer-count">预览</span>
      </div>
      <div class="viewer-empty">
        <p>${esc(friendlyError(err, '结果加载失败'))}</p>
        <button type="button" class="btn sm" data-retry>重试</button>
        <button type="button" class="btn ghost sm" data-back>返回任务</button>
      </div>
    </div>`;
    root.querySelector('[data-close]').addEventListener('click', close);
    root.querySelector('[data-back]').addEventListener('click', close);
    root.querySelector('[data-retry]').addEventListener('click', () => renderPreview({ root, params, query }));
    return;
  }

  assets.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  if (job.output_asset_id && !assets.some((a) => a.id === job.output_asset_id)) {
    assets.push({ id: job.output_asset_id, sku_id: job.sku_id, created_at: job.updated_at });
  }

  if (!assets.length) {
    root.innerHTML = `<div class="viewer">
      <div class="viewer-bar">
        <button type="button" class="viewer-btn" data-close aria-label="关闭">✕</button>
        <span class="viewer-count">预览</span>
      </div>
      <div class="viewer-empty">
        <p>这条任务还没有结果图。</p>
        <p class="hint">生成完成后结果图会出现在这里。</p>
        <button type="button" class="btn sm" data-back>返回任务</button>
      </div>
    </div>`;
    root.querySelector('[data-close]').addEventListener('click', close);
    root.querySelector('[data-back]').addEventListener('click', close);
    return;
  }

  const code = sku ? sku.code : 'SKU';
  const startIndex = Math.max(0, assets.findIndex((a) => a.id === (job.output_asset_id || assets[assets.length - 1].id)));
  let index = startIndex === -1 ? assets.length - 1 : startIndex;

  const fileName = (asset, i) => {
    const t = assettemplate(job, asset);
    return `${code}-${t}-${i + 1}.jpg`;
  };

  root.innerHTML = `<div class="viewer" role="dialog" aria-modal="true" aria-label="结果预览">
    <div class="viewer-bar">
      <button type="button" class="viewer-btn" data-close aria-label="关闭">✕</button>
      <span class="viewer-count" data-counter>${index + 1} / ${assets.length}</span>
      <button type="button" class="viewer-btn" data-download aria-label="下载当前图片">↓</button>
    </div>
    <div class="viewer-stage" data-stage>
      <div class="viewer-track" data-track>
        ${assets
          .map(
            (a, i) => `<div class="viewer-slide" data-slide="${i}">
              <img data-img="${esc(a.id)}" alt="结果图 ${i + 1}" hidden>
              <span class="viewer-ph" data-ph>加载中…</span>
            </div>`,
          )
          .join('')}
      </div>
    </div>
    <div class="viewer-foot">
      <p class="viewer-caption" data-caption></p>
      <p class="hint viewer-hint">左右滑动切换 · 下拉或点 ✕ 关闭</p>
      <button type="button" class="btn primary block lg" data-share>分享</button>
    </div>
  </div>`;

  const track = root.querySelector('[data-track]');
  const stage = root.querySelector('[data-stage]');
  const counter = root.querySelector('[data-counter]');
  const caption = root.querySelector('[data-caption]');
  const slides = Array.from(root.querySelectorAll('[data-slide]'));

  function assettemplate(currentJob, asset) {
    if (currentJob.output_asset_id === asset.id) return templateName(currentJob.template);
    return '结果图';
  }

  function updateCaption() {
    const asset = assets[index];
    const t = assettemplate(job, asset);
    const date = asset.created_at ? fmt.date(asset.created_at) : '';
    caption.innerHTML = `<b>${esc(t)}</b> · <span class="mono">${esc(code)}</span>${date ? ` · ${esc(date)}` : ''}`;
  }

  function updateCounter() {
    counter.textContent = `${index + 1} / ${assets.length}`;
  }

  async function ensure(i) {
    const asset = assets[i];
    const slide = slides[i];
    if (!asset || !slide) return;
    const state = slide.dataset.state;
    if (state === 'loaded' || state === 'loading') return;
    slide.dataset.state = 'loading';
    const img = slide.querySelector('[data-img]');
    const ph = slide.querySelector('[data-ph]');
    try {
      const url = await assetURL(asset.id);
      img.src = url;
      img.hidden = false;
      if (ph) ph.hidden = true;
      slide.dataset.state = 'loaded';
      /* 预取文件，iOS 要求 share() 在点击手势里同步调用，不能先 await fetch */
      assetFile(asset.id, fileName(asset, i))
        .then((f) => fileCache.set(asset.id, f))
        .catch(() => {});
    } catch (err) {
      slide.dataset.state = 'error';
      if (ph) {
        ph.hidden = false;
        ph.innerHTML = `<span>${esc(friendlyError(err, '图片加载失败'))}</span>
          <button type="button" class="btn sm" data-reload="${i}">重试</button>`;
      }
    }
  }

  function go(next) {
    const clamped = Math.max(0, Math.min(assets.length - 1, next));
    if (clamped === index && slides[index].dataset.state === 'loaded') {
      track.style.transform = `translateX(${-index * 100}%)`;
      return;
    }
    index = clamped;
    track.style.transition = '';
    track.style.transform = `translateX(${-index * 100}%)`;
    updateCounter();
    updateCaption();
    ensure(index);
    ensure(index + 1);
    ensure(index - 1);
  }

  track.style.transform = `translateX(${-index * 100}%)`;
  updateCounter();
  updateCaption();
  ensure(index);
  ensure(index + 1);
  ensure(index - 1);

  /* ---------------- 手势 ---------------- */
  let startX = 0;
  let startY = 0;
  let dragging = false;
  let dx = 0;
  let dy = 0;

  const onTouchStart = (e) => {
    if (e.touches.length !== 1) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    dx = 0;
    dy = 0;
    dragging = true;
    track.style.transition = 'none';
  };

  const onTouchMove = (e) => {
    if (!dragging || e.touches.length !== 1) return;
    dx = e.touches[0].clientX - startX;
    dy = e.touches[0].clientY - startY;
    track.style.transform = `translateX(calc(${-index * 100}% + ${dx}px))`;
  };

  const onTouchEnd = () => {
    if (!dragging) return;
    dragging = false;
    track.style.transition = '';
    if (dy > 90 && Math.abs(dx) < 60) {
      close();
      return;
    }
    if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.2) {
      go(dx < 0 ? index + 1 : index - 1);
      return;
    }
    track.style.transform = `translateX(${-index * 100}%)`;
    dx = 0;
    dy = 0;
  };

  stage.addEventListener('touchstart', onTouchStart, { passive: true });
  stage.addEventListener('touchmove', onTouchMove, { passive: true });
  stage.addEventListener('touchend', onTouchEnd, { passive: true });
  stage.addEventListener('touchcancel', onTouchEnd, { passive: true });

  const onKey = (e) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowRight') go(index + 1);
    else if (e.key === 'ArrowLeft') go(index - 1);
  };
  document.addEventListener('keydown', onKey);

  stage.addEventListener('click', (e) => {
    const reload = e.target.closest('[data-reload]');
    if (!reload) return;
    const i = Number(reload.dataset.reload);
    const slide = slides[i];
    if (slide) slide.dataset.state = '';
    ensure(i);
  });

  root.querySelector('[data-close]').addEventListener('click', close);

  root.querySelector('[data-download]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const asset = assets[index];
    btn.disabled = true;
    try {
      await downloadAsset(asset.id, fileName(asset, index));
      toast('已下载当前图片', 'good');
    } catch (err) {
      toast(friendlyError(err, '下载失败，请重试'), 'bad');
    } finally {
      btn.disabled = false;
    }
  });

  root.querySelector('[data-share]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const asset = assets[index];
    const name = fileName(asset, index);
    const title = 'DesignKit 结果图';
    const text = `${code} · ${templateName(job.template)} · DesignKit 生成`;

    btn.disabled = true;
    try {
      const file = fileCache.get(asset.id);
      if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title, text });
          return;
        } catch (err) {
          if (err && err.name === 'AbortError') return;
        }
      }
      if (navigator.share) {
        try {
          await navigator.share({ title, text, url: location.href });
          return;
        } catch (err) {
          if (err && err.name === 'AbortError') return;
        }
      }
      /* 降级：下载 + 复制深链（链接需要登录，明确提示） */
      await downloadAsset(asset.id, name);
      const link = `${location.origin}${location.pathname}#/preview/${job.id}`;
      await copyText(link);
      toast('已下载图片，并复制了预览链接；对方需登录后查看', 'good');
    } catch (err) {
      toast(friendlyError(err, '分享失败，请重试'), 'bad');
    } finally {
      btn.disabled = false;
    }
  });

  cleanup = () => {
    document.removeEventListener('keydown', onKey);
    stage.removeEventListener('touchstart', onTouchStart);
    stage.removeEventListener('touchmove', onTouchMove);
    stage.removeEventListener('touchend', onTouchEnd);
    stage.removeEventListener('touchcancel', onTouchEnd);
  };
}
