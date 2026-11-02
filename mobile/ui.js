/* DesignKit 移动端 · 通用 UI
 *
 * 复用 web/assets/core.js 的 ui（toast / esc / badge / empty / loading / fmt），
 * 这里补移动端专用的底部导航、底部弹层、生命周期清理和状态文案。
 */

import { ui as C } from '../web/assets/core.js';

export const esc = C.esc;
export const toast = C.toast;
export const fmt = C.fmt;
export const badge = C.badge;
export const empty = C.empty;
export const loading = C.loading;
export const label = C.label;

/* ---------------- 页面生命周期 ---------------- */

let cleanupFn = null;

export function setCleanup(fn) {
  cleanupFn = typeof fn === 'function' ? fn : null;
}

export function runCleanup() {
  if (!cleanupFn) return;
  try {
    cleanupFn();
  } catch (err) {
    console.error(err);
  }
  cleanupFn = null;
}

/* ---------------- 底部导航 ---------------- */

const ICONS = {
  skus: '<svg viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="3" width="6.5" height="6.5" rx="1.6"/><rect x="12.5" y="3" width="6.5" height="6.5" rx="1.6"/><rect x="3" y="12.5" width="6.5" height="6.5" rx="1.6"/><rect x="12.5" y="12.5" width="6.5" height="6.5" rx="1.6"/></svg>',
  capture: '<svg viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 8.5h3.2L8 6h6l1.8 2.5H19V18H3z" stroke-linejoin="round"/><circle cx="11" cy="12.8" r="3"/></svg>',
  jobs: '<svg viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 5.5h14M4 11h14M4 16.5h8" stroke-linecap="round"/><path d="M15 16.5l2 2 3-4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

const TABS = [
  { key: 'skus', hash: '/skus', label: '选品', icon: ICONS.skus },
  { key: 'capture', hash: '/capture', label: '拍摄', icon: ICONS.capture },
  { key: 'jobs', hash: '/jobs', label: '审核', icon: ICONS.jobs },
];

function ensureTabbar() {
  let el = document.querySelector('.tabbar');
  if (el) return el;
  el = document.createElement('nav');
  el.className = 'tabbar';
  el.setAttribute('aria-label', '主导航');
  el.innerHTML = TABS.map(
    (t) => `<a class="tabbar-item" href="#${t.hash}" data-tab="${t.key}">
      <span class="tabbar-icon" aria-hidden="true">${t.icon}</span>
      <span class="tabbar-label">${t.label}</span>
    </a>`,
  ).join('');
  document.body.appendChild(el);
  return el;
}

export function setTabbar(activeKey) {
  const el = ensureTabbar();
  const show = !!activeKey;
  el.hidden = !show;
  document.body.classList.toggle('has-tabbar', show);
  el.querySelectorAll('[data-tab]').forEach((a) => {
    if (a.dataset.tab === activeKey) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}

/* ---------------- 网络状态条 ---------------- */

export function initNetworkBanner() {
  let el = document.querySelector('.net-banner');
  if (!el) {
    el = document.createElement('div');
    el.className = 'net-banner';
    el.setAttribute('role', 'status');
    el.innerHTML = '<b>离线</b> 可以拍照选图，上传、生成和审核需要联网';
    document.body.appendChild(el);
  }
  const sync = () => {
    const offline = navigator.onLine === false;
    el.hidden = !offline;
    document.body.classList.toggle('is-offline', offline);
  };
  window.addEventListener('online', () => {
    sync();
    toast('网络已恢复', 'good');
  });
  window.addEventListener('offline', sync);
  sync();
}

/* ---------------- 底部弹层 ---------------- */

export function openSheet({ title = '', body = '', buttons = [], onClose } = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'overlay sheet-overlay';
  overlay.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title || '操作面板')}">
    <div class="sheet-handle" aria-hidden="true"></div>
    <div class="sheet-head">
      <h3>${esc(title)}</h3>
      <button type="button" class="btn ghost sm" data-close aria-label="关闭">✕</button>
    </div>
    <div class="sheet-body"></div>
    <div class="sheet-actions"></div>
  </div>`;
  const bodyEl = overlay.querySelector('.sheet-body');
  if (typeof body === 'string') bodyEl.innerHTML = body;
  else if (body) bodyEl.appendChild(body);

  const previouslyFocused = document.activeElement;
  let closed = false;

  const close = (value) => {
    if (closed) return;
    closed = true;
    overlay.classList.add('closing');
    document.removeEventListener('keydown', onKey);
    document.body.classList.remove('sheet-open');
    setTimeout(() => overlay.remove(), 160);
    if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
    if (onClose) onClose(value);
  };

  const onKey = (e) => {
    if (e.key === 'Escape') close(null);
  };

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close(null);
  });
  overlay.querySelector('[data-close]').addEventListener('click', () => close(null));
  document.addEventListener('keydown', onKey);

  const actions = overlay.querySelector('.sheet-actions');
  buttons.forEach((btn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn ${btn.kind || ''}`.trim();
    b.textContent = btn.label;
    if (btn.disabled) b.disabled = true;
    b.addEventListener('click', () => btn.onClick(close, b));
    actions.appendChild(b);
  });

  document.body.appendChild(overlay);
  document.body.classList.add('sheet-open');
  const first = overlay.querySelector('textarea, input, .sheet-actions .btn');
  if (first) setTimeout(() => first.focus(), 60);

  return { close, el: overlay, body: bodyEl };
}

export function confirmSheet({ title = '确认操作', message = '', confirmLabel = '确认', cancelLabel = '取消', danger = false } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    openSheet({
      title,
      body: `<p class="muted">${esc(message)}</p>`,
      buttons: [
        { label: cancelLabel, kind: 'ghost', onClick: (close) => { finish(false); close(); } },
        { label: confirmLabel, kind: danger ? 'danger' : 'primary', onClick: (close) => { finish(true); close(); } },
      ],
      onClose: () => finish(false),
    });
  });
}

export function promptSheet({
  title = '填写内容',
  hint = '',
  placeholder = '',
  submitLabel = '提交',
  minLength = 2,
  maxLength = 200,
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const sheet = openSheet({
      title,
      body: `<label class="field">
          <span class="label">原因</span>
          <textarea class="textarea" rows="4" maxlength="${maxLength}" placeholder="${esc(placeholder)}"></textarea>
          <span class="hint" data-hint>${esc(hint)}</span>
        </label>`,
      buttons: [
        { label: '取消', kind: 'ghost', onClick: (close) => { finish(null); close(); } },
        {
          label: submitLabel,
          kind: 'primary',
          disabled: true,
          onClick: (close) => {
            const ta = sheet.body.querySelector('textarea');
            const value = ta ? ta.value.trim() : '';
            if (value.length < minLength) return;
            finish(value);
            close();
          },
        },
      ],
      onClose: () => finish(null),
    });

    const ta = sheet.body.querySelector('textarea');
    const hintEl = sheet.body.querySelector('[data-hint]');
    const submit = sheet.el.querySelector('.sheet-actions .btn.primary');
    const sync = () => {
      const n = ta.value.trim().length;
      if (submit) submit.disabled = n < minLength;
      if (hintEl) hintEl.textContent = `${hint ? hint + ' ' : ''}${n}/${maxLength}`;
    };
    ta.addEventListener('input', sync);
    sync();
  });
}

/* ---------------- 小工具 ---------------- */

export function setBusy(button, busy, busyLabel = '处理中…') {
  if (!button) return;
  if (busy) {
    if (!button.dataset.originalHtml) button.dataset.originalHtml = button.innerHTML;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.innerHTML = `<span class="spinner sm" aria-hidden="true"></span>${esc(busyLabel)}`;
  } else {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    if (button.dataset.originalHtml) {
      button.innerHTML = button.dataset.originalHtml;
      delete button.dataset.originalHtml;
    }
  }
}

export function friendlyError(err, fallback = '操作失败，请稍后重试') {
  if (!err) return fallback;
  if (err.message) return err.message;
  return fallback;
}

export function templateName(t) {
  if (t === 'main') return '主图';
  if (t === 'scene') return '场景图';
  if (t === 'selling_point') return '卖点图';
  return t || '未知模板';
}

export function jobStatus(job) {
  if (!job) return { tone: 'muted', label: '未知' };
  const s = job.status;
  const r = job.review_status;
  if (s === 'queued') return { tone: 'muted', label: '排队中' };
  if (s === 'running') return { tone: 'info', label: `生成中 ${job.progress || 0}%` };
  if (s === 'failed') return { tone: 'bad', label: '生成失败' };
  if (s === 'canceled') return { tone: 'muted', label: '已取消' };
  if (s === 'succeeded') {
    if (r === 'approved') return { tone: 'good', label: '已通过' };
    if (r === 'rejected') return { tone: 'bad', label: '已驳回' };
    if (r === 'manual') return { tone: 'info', label: '人工复核' };
    return { tone: 'warn', label: '待审核' };
  }
  return { tone: 'muted', label: s || '未知' };
}

export function isActive(job) {
  return !!job && (job.status === 'queued' || job.status === 'running');
}

export function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  return new Promise((resolve, reject) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy') ? resolve() : reject(new Error('复制失败，请手动复制'));
    } catch (err) {
      reject(err);
    } finally {
      ta.remove();
    }
  });
}
