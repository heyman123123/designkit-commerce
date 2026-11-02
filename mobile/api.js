/* DesignKit 移动端 · API 层
 *
 * 复用 web/assets/core.js 的 session（同一套 dk.* localStorage 键），
 * 但错误体按后端真实契约解析：{ "error": "code", "message": "中文提示" }。
 * 共享 core 的 api 期待 { error: { code, message } }，因此移动端单独实现一层，
 * 不为了移动端去改共享文件。
 *
 * 规则：
 * - 401 用 /v1/auth/refresh 静默续期一次，仍失败则清会话并回登录页；
 * - 所有失败都翻译成中文可操作提示；
 * - 图片内容接口只认 Authorization 头，所以预览图用 fetch → blob URL。
 */

import { session, ApiError } from '../web/assets/core.js';

const TIMEOUT_MS = 20000;
const UPLOAD_TIMEOUT_MS = 120000;

let refreshing = null;

export function isOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

export function forceLogout(message = '登录已过期，请重新登录') {
  session.clear();
  try {
    localStorage.removeItem('dk.mobile.sku');
    localStorage.removeItem('dk.mobile.project');
  } catch {
    /* 忽略隐私模式下的存储异常 */
  }
  clearAssetCache();
  window.dispatchEvent(new CustomEvent('dk:logout', { detail: { message } }));
}

/* ---------------- 租户路径 ---------------- */

export function wsPath(path) {
  if (!session.slug) {
    throw new ApiError('尚未绑定工作区，请重新登录', { status: 0, code: 'no_workspace' });
  }
  return `/v1/w/${encodeURIComponent(session.slug)}${path}`;
}

function authHeaders(extra = {}) {
  const h = { ...extra };
  if (session.access) h.Authorization = `Bearer ${session.access}`;
  return h;
}

/* ---------------- 错误翻译 ---------------- */

function statusMessage(status) {
  if (status === 400) return '提交的内容有误，请检查后重试';
  if (status === 401) return '登录状态已失效，请重新登录';
  if (status === 402) return '套餐额度不足，请联系管理员调整';
  if (status === 403) return '当前账号没有这个操作权限';
  if (status === 404) return '内容不存在或已被删除';
  if (status === 409) return '当前状态不允许该操作';
  if (status === 413) return '文件太大，请换一张或压缩后重试';
  if (status === 429) return '操作太频繁，请稍后再试';
  if (status >= 500) return '服务端异常，请稍后重试';
  return `请求失败（${status}），请稍后重试`;
}

function toApiError(data, status) {
  let code = 'http_error';
  let message = '';
  const e = data && data.error;
  if (typeof e === 'string') {
    code = e;
    message = (data && data.message) || '';
  } else if (e && typeof e === 'object') {
    code = e.code || code;
    message = e.message || '';
  }
  return new ApiError(message || statusMessage(status), { status, code });
}

/* ---------------- 会话续期 ---------------- */

export function refreshSession() {
  if (!session.refresh) return Promise.resolve(false);
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const res = await fetch('/v1/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: session.refresh }),
      });
      if (!res.ok) return false;
      const data = await res.json();
      session.save(data);
      return true;
    } catch {
      return false;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/* ---------------- 通用请求 ---------------- */

export async function request(path, { method = 'GET', body, auth = true, retry = true, timeout = TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: authHeaders(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
      credentials: 'same-origin',
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new ApiError('请求超时，请检查网络后重试', { code: 'timeout' });
    }
    throw new ApiError('网络连接失败，请检查网络后重试', { code: 'network' });
  } finally {
    clearTimeout(timer);
  }

  if (auth && res.status === 401 && retry) {
    if (await refreshSession()) {
      return request(path, { method, body, auth, retry: false, timeout });
    }
    forceLogout();
    throw new ApiError('登录已过期，请重新登录', { status: 401, code: 'unauthorized' });
  }

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) throw toApiError(data, res.status);
  return data;
}

export const get = (path) => request(path);
export const post = (path, body) => request(path, { method: 'POST', body });

/* ---------------- 上传（XHR，带进度） ---------------- */

export function upload(path, file, { onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const send = async (retried) => {
      const form = new FormData();
      form.append('file', file, file.name || 'upload.jpg');
      const xhr = new XMLHttpRequest();
      xhr.open('POST', path);
      xhr.timeout = UPLOAD_TIMEOUT_MS;
      if (session.access) xhr.setRequestHeader('Authorization', `Bearer ${session.access}`);
      if (onProgress) {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
        };
      }
      xhr.onload = async () => {
        let data = null;
        try {
          data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
        } catch {
          data = null;
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(data);
          return;
        }
        if (xhr.status === 401 && !retried && (await refreshSession())) {
          send(true);
          return;
        }
        if (xhr.status === 401) forceLogout();
        reject(toApiError(data, xhr.status));
      };
      xhr.onerror = () => reject(new ApiError('上传失败，请检查网络后重试', { code: 'network' }));
      xhr.ontimeout = () => reject(new ApiError('上传超时，请重试', { code: 'timeout' }));
      xhr.onabort = () => reject(new ApiError('上传已取消', { code: 'aborted' }));
      xhr.send(form);
    };
    send(false);
  });
}

/* ---------------- 素材图片 ---------------- */

function assetContentPath(assetId) {
  return wsPath(`/assets/${assetId}/content`);
}

/* TODO(后端)：GetAssetContent 目前只认 Authorization 头，<img src> 无法带请求头。
 * 所以预览图走 fetch + Bearer → blob URL（今天就能用）。
 * 后端补上 ?access_token= 查询参数后可改用下面这个地址，省一次内存拷贝。
 */
export function assetContentURL(assetId) {
  return `${assetContentPath(assetId)}?access_token=${encodeURIComponent(session.access)}`;
}

const blobCache = new Map();
const urlCache = new Map();

export function assetBlob(assetId) {
  if (!blobCache.has(assetId)) {
    const p = (async () => {
      let res;
      try {
        res = await fetch(assetContentPath(assetId), { headers: authHeaders(), credentials: 'same-origin' });
        if (res.status === 401 && (await refreshSession())) {
          res = await fetch(assetContentPath(assetId), { headers: authHeaders(), credentials: 'same-origin' });
        }
      } catch {
        throw new ApiError('图片加载失败，请检查网络后重试', { code: 'network' });
      }
      if (res.status === 401) {
        forceLogout();
        throw new ApiError('登录已过期，请重新登录', { status: 401, code: 'unauthorized' });
      }
      if (!res.ok) {
        throw new ApiError('图片加载失败，请检查网络后重试', { status: res.status, code: 'asset_failed' });
      }
      return res.blob();
    })().catch((err) => {
      blobCache.delete(assetId);
      throw err;
    });
    blobCache.set(assetId, p);
  }
  return blobCache.get(assetId);
}

export async function assetURL(assetId) {
  const cached = urlCache.get(assetId);
  if (cached) return cached;
  const blob = await assetBlob(assetId);
  const url = URL.createObjectURL(blob);
  urlCache.set(assetId, url);
  return url;
}

export async function assetFile(assetId, filename) {
  const blob = await assetBlob(assetId);
  return new File([blob], filename || 'designkit.jpg', { type: blob.type || 'image/jpeg' });
}

export async function downloadAsset(assetId, filename) {
  const blob = await assetBlob(assetId);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'designkit.jpg';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function clearAssetCache() {
  for (const url of urlCache.values()) URL.revokeObjectURL(url);
  urlCache.clear();
  blobCache.clear();
}
