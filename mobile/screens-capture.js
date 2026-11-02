/* 拍摄上传 + 发起生成
 *
 * 链路：选图（拍照 / 相册）→ 本地压缩到长边 1600 / JPEG 0.85 → 逐张上传（带进度、失败重试）
 *      → 选模板 → POST /jobs（幂等键防重复）→ 跳到任务页看进度。
 */

import { router } from '../web/assets/core.js';
import { post, upload as uploadFile, wsPath } from './api.js';
import { prepareImage, formatBytes } from './media.js';
import {
  esc, toast, empty, setBusy, setCleanup, friendlyError, templateName,
} from './ui.js';
import { currentSku } from './screens-skus.js';

const TEMPLATES = [
  { key: 'main', name: '主图', desc: '干净背景，突出商品本身，适合搜索首图' },
  { key: 'scene', name: '场景图', desc: '放进真实使用场景，提升代入感' },
  { key: 'selling_point', name: '卖点图', desc: '叠加核心卖点信息，适合详情页与广告' },
];

const state = {
  skuId: '',
  items: [],
  template: 'main',
  busy: false,
  idemKey: '',
};

let listEl = null;
let footBtn = null;
let footHint = null;

function newId() {
  return `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function newIdemKey() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `idem-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function resetItems() {
  state.items.forEach((it) => {
    if (it.preview) URL.revokeObjectURL(it.preview);
  });
  state.items = [];
  state.idemKey = '';
}

function uploadedItems() {
  return state.items.filter((it) => it.status === 'uploaded' && it.assetId);
}

function primaryItem() {
  const list = uploadedItems();
  return list.find((it) => it.selected) || list[0] || null;
}

function itemStatusText(it) {
  switch (it.status) {
    case 'compressing':
      return '正在压缩…';
    case 'uploading':
      return `上传中 ${it.progress || 0}%`;
    case 'uploaded':
      return `已上传 · ${it.width}×${it.height}`;
    case 'error':
      return it.error || '处理失败';
    default:
      return '等待中';
  }
}

function itemHTML(it) {
  const sizeLine = it.bytes
    ? `${formatBytes(it.srcBytes)} → ${formatBytes(it.bytes)}`
    : formatBytes(it.srcBytes);
  const canSelect = it.status === 'uploaded';
  return `<div class="up-item ${it.status} ${it.selected && canSelect ? 'is-primary' : ''}" data-item="${esc(it.id)}">
    <div class="up-thumb">
      ${it.preview ? `<img src="${esc(it.preview)}" alt="待上传图片预览" loading="lazy">` : '<span class="up-ph" aria-hidden="true">◌</span>'}
      ${canSelect ? '<span class="up-ok" aria-hidden="true">✓</span>' : ''}
      ${it.selected && canSelect ? '<span class="up-flag">素材图</span>' : ''}
    </div>
    <div class="up-body">
      <div class="up-top">
        <span class="up-name">${esc(it.name)}</span>
        <button type="button" class="icon-btn" data-remove="${esc(it.id)}" aria-label="移除这张图片">✕</button>
      </div>
      <div class="up-meta">${esc(sizeLine)}${it.compressed ? ' · 已压缩' : ''}</div>
      <div class="up-status">${esc(itemStatusText(it))}</div>
      ${it.status === 'uploading' || it.status === 'compressing'
        ? `<div class="progress"><i style="width:${it.status === 'compressing' ? 8 : it.progress || 0}%"></i></div>`
        : ''}
      ${it.status === 'error'
        ? `<div class="up-retry"><button type="button" class="btn sm" data-retry="${esc(it.id)}">重试</button><span class="hint">${esc(it.error || '')}</span></div>`
        : ''}
      ${canSelect && !it.selected ? '<div class="hint">点一下这张图，作为生成素材</div>' : ''}
    </div>
  </div>`;
}

function renderItems() {
  if (!listEl) return;
  if (!state.items.length) {
    listEl.innerHTML = `<p class="picker-empty muted">还没有图片。拍一张或从相册选几张，上传后即可生成。</p>`;
    return;
  }
  listEl.innerHTML = state.items.map(itemHTML).join('');
}

function updateProgress(item) {
  if (!listEl) return;
  const el = listEl.querySelector(`[data-item="${item.id}"]`);
  if (!el) return;
  const bar = el.querySelector('.progress > i');
  if (bar) bar.style.width = `${item.progress || 0}%`;
  const status = el.querySelector('.up-status');
  if (status && item.status === 'uploading') status.textContent = itemStatusText(item);
}

function updateFooter() {
  if (!footBtn) return;
  const uploaded = uploadedItems().length;
  const pending = state.items.filter(
    (it) => it.status === 'waiting' || it.status === 'compressing' || it.status === 'uploading',
  ).length;
  const failed = state.items.filter((it) => it.status === 'error').length;

  if (footHint) {
    let hint = '';
    if (!state.items.length) hint = '先选一张商品图';
    else if (pending) hint = `还有 ${pending} 张在上传，完成一张就可以先生成`;
    else if (!uploaded) hint = failed ? '上传失败，请点重试后再生成' : '还没有上传成功的图片';
    else hint = `将使用「${templateName(state.template)}」模板 · 已上传 ${uploaded} 张`;
    footHint.textContent = hint;
  }

  if (!footBtn) return;
  const disabled = state.busy || uploaded === 0;
  footBtn.disabled = disabled;
  if (!state.busy) {
    footBtn.textContent = uploaded ? `生成${templateName(state.template)}` : '上传后可生成';
  }
}

async function uploadItem(item) {
  if (!state.items.includes(item)) return;
  item.status = 'uploading';
  item.progress = 0;
  item.error = '';
  renderItems();
  updateFooter();
  try {
    const asset = await uploadFile(wsPath(`/skus/${encodeURIComponent(state.skuId)}/assets`), item.file, {
      onProgress: (p) => {
        item.progress = p;
        updateProgress(item);
      },
    });
    if (!state.items.includes(item)) return;
    item.assetId = asset && asset.id ? asset.id : '';
    item.status = item.assetId ? 'uploaded' : 'error';
    item.progress = 100;
    if (!item.assetId) item.error = '上传后没有拿到素材 ID，请重试';
    const hasPrimary = state.items.some((it) => it.selected && it.status === 'uploaded');
    if (!hasPrimary && item.status === 'uploaded') item.selected = true;
  } catch (err) {
    if (!state.items.includes(item)) return;
    item.status = 'error';
    item.error = friendlyError(err, '上传失败，请重试');
    if (err && err.status === 401) return;
  }
  renderItems();
  updateFooter();
}

async function handleFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;

  /* 先把所有图片占位列出来（等待中），再逐张压缩上传，用户能立刻看到全部选中的图 */
  const queued = files.map((raw) => ({
    id: newId(),
    raw,
    name: raw.name || 'photo.jpg',
    srcBytes: raw.size,
    status: 'waiting',
    progress: 0,
    preview: '',
    file: null,
    bytes: 0,
    width: 0,
    height: 0,
    compressed: false,
    assetId: '',
    error: '',
    selected: false,
  }));
  state.items.push(...queued);
  renderItems();
  updateFooter();

  for (const item of queued) {
    if (!state.items.includes(item)) continue;
    item.status = 'compressing';
    renderItems();
    try {
      const prepared = await prepareImage(item.raw);
      delete item.raw;
      if (!state.items.includes(item)) {
        URL.revokeObjectURL(prepared.previewURL);
        continue;
      }
      item.file = prepared.file;
      item.bytes = prepared.bytes;
      item.preview = prepared.previewURL;
      item.width = prepared.width;
      item.height = prepared.height;
      item.compressed = prepared.compressed;
      await uploadItem(item);
    } catch (err) {
      delete item.raw;
      if (!state.items.includes(item)) continue;
      item.status = 'error';
      item.error = friendlyError(err, '图片处理失败，请重试');
      renderItems();
      updateFooter();
    }
  }
}

async function generate() {
  if (state.busy) return;
  const primary = primaryItem();
  if (!primary) {
    toast('先上传至少一张图片', 'bad');
    return;
  }
  if (!state.idemKey) state.idemKey = newIdemKey();
  state.busy = true;
  setBusy(footBtn, true, '提交中…');
  updateFooter();
  try {
    const job = await post(wsPath('/jobs'), {
      sku_id: state.skuId,
      source_asset_id: primary.assetId,
      template: state.template,
      idempotency_key: state.idemKey,
    });
    state.idemKey = '';
    toast(`已提交${templateName(state.template)}生成，正在排队`, 'good');
    if (job && job.id) router.go(`/job/${job.id}`);
    else router.go('/jobs');
  } catch (err) {
    toast(friendlyError(err, '提交失败，请稍后重试'), 'bad');
  } finally {
    state.busy = false;
    setBusy(footBtn, false);
    updateFooter();
  }
}

export default function renderCapture({ root }) {
  const sku = currentSku();

  if (!sku) {
    root.innerHTML = `<div class="screen">${empty({
      icon: '◫',
      title: '还没有选择 SKU',
      sub: '先选一个 SKU，再拍照上传。',
      action: '<button type="button" class="btn primary block lg mt-16" data-go-skus>去选择 SKU</button>',
    })}</div>`;
    root.querySelector('[data-go-skus]').addEventListener('click', () => router.go('/skus'));
    return;
  }

  if (state.skuId !== sku.id) {
    resetItems();
    state.skuId = sku.id;
  }

  root.innerHTML = `<div class="screen capture-screen">
    <header class="screen-head">
      <div class="head-main">
        <h1 class="screen-title">拍摄上传</h1>
        <p class="screen-sub"><span class="mono">${esc(sku.code)}</span> · ${esc(sku.title || '未填写标题')}</p>
      </div>
      <div class="head-actions">
        <button type="button" class="btn ghost sm" data-switch>切换</button>
      </div>
    </header>

    <div class="picker">
      <button type="button" class="picker-btn" data-pick="camera">
        <span class="picker-icon" aria-hidden="true">◉</span>
        <span class="picker-label">拍照</span>
        <span class="picker-sub">调用后置摄像头</span>
      </button>
      <button type="button" class="picker-btn" data-pick="gallery">
        <span class="picker-icon" aria-hidden="true">▤</span>
        <span class="picker-label">从相册选</span>
        <span class="picker-sub">支持多张</span>
      </button>
    </div>
    <p class="hint compress-hint">自动压缩到长边 1600px · JPEG 0.85，再上传</p>

    <input type="file" accept="image/*" capture="environment" hidden data-input="camera">
    <input type="file" accept="image/*" multiple hidden data-input="gallery">

    <div class="up-list" data-list></div>

    <section class="template-block" aria-label="生成模板">
      <h2 class="block-title">生成模板</h2>
      <div class="seg seg-template" role="tablist">
        ${TEMPLATES.map(
          (t) => `<button type="button" class="seg-btn ${state.template === t.key ? 'active' : ''}"
            role="tab" aria-selected="${state.template === t.key}" data-template="${t.key}">${t.name}</button>`,
        ).join('')}
      </div>
      <p class="hint template-desc" data-template-desc>${esc(
        (TEMPLATES.find((t) => t.key === state.template) || TEMPLATES[0]).desc,
      )}</p>
    </section>

    <div class="capture-foot">
      <p class="hint" data-foot-hint></p>
      <button type="button" class="btn primary block lg" data-generate disabled>上传后可生成</button>
    </div>
  </div>`;

  listEl = root.querySelector('[data-list]');
  footBtn = root.querySelector('[data-generate]');
  footHint = root.querySelector('[data-foot-hint]');

  root.querySelector('[data-switch]').addEventListener('click', () => router.go('/skus'));

  const inputs = {
    camera: root.querySelector('[data-input="camera"]'),
    gallery: root.querySelector('[data-input="gallery"]'),
  };
  root.querySelectorAll('[data-pick]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = inputs[btn.dataset.pick];
      if (input) input.click();
    });
  });
  Object.values(inputs).forEach((input) => {
    input.addEventListener('change', () => {
      /* 注意：先复制成数组再清空 value —— FileList 是实时的，清空后原引用会变成 0 张 */
      const files = Array.from(input.files || []);
      input.value = '';
      handleFiles(files);
    });
  });

  listEl.addEventListener('click', (e) => {
    const removeBtn = e.target.closest('[data-remove]');
    if (removeBtn) {
      const id = removeBtn.dataset.remove;
      const idx = state.items.findIndex((it) => it.id === id);
      if (idx >= 0) {
        const it = state.items[idx];
        if (it.preview) URL.revokeObjectURL(it.preview);
        state.items.splice(idx, 1);
        const next = primaryItem();
        state.items.forEach((x) => {
          x.selected = next ? x.id === next.id : false;
        });
        renderItems();
        updateFooter();
      }
      return;
    }
    const retryBtn = e.target.closest('[data-retry]');
    if (retryBtn) {
      const it = state.items.find((x) => x.id === retryBtn.dataset.retry);
      if (it && it.file) uploadItem(it);
      else toast('这张图没有压缩成功，请移除后重新选择', 'bad');
      return;
    }
    const itemEl = e.target.closest('[data-item]');
    if (itemEl) {
      const it = state.items.find((x) => x.id === itemEl.dataset.item);
      if (it && it.status === 'uploaded') {
        state.items.forEach((x) => {
          x.selected = x.id === it.id;
        });
        renderItems();
        updateFooter();
      }
    }
  });

  root.querySelectorAll('[data-template]').forEach((b) => {
    b.addEventListener('click', () => {
      state.template = b.dataset.template;
      root.querySelectorAll('[data-template]').forEach((x) => {
        const on = x.dataset.template === state.template;
        x.classList.toggle('active', on);
        x.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      const desc = root.querySelector('[data-template-desc]');
      const t = TEMPLATES.find((x) => x.key === state.template);
      if (desc && t) desc.textContent = t.desc;
      footBtn.textContent = uploadedItems().length ? `生成${templateName(state.template)}` : '上传后可生成';
      updateFooter();
    });
  });

  root.querySelector('[data-generate]').addEventListener('click', generate);

  renderItems();
  updateFooter();

  setCleanup(() => {
    listEl = null;
    footBtn = null;
    footHint = null;
  });
}
