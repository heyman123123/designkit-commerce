/* 共享核心：会话、API、UI 组件、路由。
 * 零构建 ES Module，Web 工作台 / 管理后台 / 移动端共用。
 */

/* ---------------- 会话 ---------------- */

const LS = {
  access: 'dk.access',
  refresh: 'dk.refresh',
  user: 'dk.user',
  ws: 'dk.ws',
};

export const session = {
  access: '',
  refresh: '',
  user: null,
  ws: null,

  load() {
    try {
      this.access = localStorage.getItem(LS.access) || '';
      this.refresh = localStorage.getItem(LS.refresh) || '';
      this.user = JSON.parse(localStorage.getItem(LS.user) || 'null');
      this.ws = JSON.parse(localStorage.getItem(LS.ws) || 'null');
    } catch {
      this.access = this.refresh = '';
      this.user = this.ws = null;
    }
    return this;
  },

  save(data) {
    if (data.access_token) {
      this.access = data.access_token;
      localStorage.setItem(LS.access, this.access);
    }
    if (data.refresh_token) {
      this.refresh = data.refresh_token;
      localStorage.setItem(LS.refresh, this.refresh);
    }
    if (data.user) {
      this.user = data.user;
      localStorage.setItem(LS.user, JSON.stringify(this.user));
    }
    if (data.workspace) {
      this.ws = data.workspace;
      localStorage.setItem(LS.ws, JSON.stringify(this.ws));
    }
  },

  setWorkspace(ws) {
    this.ws = ws;
    localStorage.setItem(LS.ws, JSON.stringify(ws));
  },

  clear() {
    this.access = this.refresh = '';
    this.user = this.ws = null;
    Object.values(LS).forEach((k) => localStorage.removeItem(k));
  },

  get isAuthed() {
    return !!this.access;
  },

  get slug() {
    return this.ws ? this.ws.slug : '';
  },
};

/* ---------------- API ---------------- */

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'error' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

let refreshing = null;

async function doRefresh() {
  if (!session.refresh) return false;
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

function jsonHeaders(extra = {}) {
  const h = { ...extra };
  if (session.access) h.Authorization = `Bearer ${session.access}`;
  return h;
}

async function parse(res) {
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const e = data && data.error ? data.error : {};
    throw new ApiError(e.message || `请求失败（${res.status}）`, {
      status: res.status,
      code: e.code || 'http_error',
    });
  }
  return data;
}

async function request(path, { method = 'GET', body, headers, retry = true } = {}) {
  const opts = { method, headers: jsonHeaders(headers) };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw new ApiError('网络连接失败，请检查服务是否启动', { code: 'network' });
  }
  if (res.status === 401 && retry && session.refresh) {
    const ok = await doRefresh();
    if (ok) return request(path, { method, body, headers, retry: false });
    session.clear();
    window.dispatchEvent(new CustomEvent('dk:logout'));
    throw new ApiError('登录已过期，请重新登录', { status: 401, code: 'unauthorized' });
  }
  return parse(res);
}

async function download(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: jsonHeaders() };
  if (opts.body != null) {
    init.body = JSON.stringify(opts.body);
    init.headers['Content-Type'] = 'application/json';
  }
  let res = await fetch(path, init);
  if (res.status === 401 && session.refresh) {
    if (await doRefresh()) res = await fetch(path, init);
  }
  if (!res.ok) {
    try {
      await parse(res);
    } catch (err) {
      throw err;
    }
  }
  const blob = await res.blob();
  const disp = res.headers.get('Content-Disposition') || '';
  const m = /filename="?([^";]+)"?/.exec(disp);
  const name = m ? m[1] : 'designkit-export.zip';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function upload(path, file, { onProgress, field = 'file' } = {}) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append(field, file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', path);
    if (session.access) xhr.setRequestHeader('Authorization', `Bearer ${session.access}`);
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };
    }
    xhr.onload = async () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText || 'null');
      } catch {
        data = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
      if (xhr.status === 401 && session.refresh && (await doRefresh())) {
        try {
          resolve(await upload(path, file, { onProgress, field }));
        } catch (e) {
          reject(e);
        }
        return;
      }
      const e = data && data.error ? data.error : {};
      reject(new ApiError(e.message || '上传失败', { status: xhr.status, code: e.code }));
    };
    xhr.onerror = () => reject(new ApiError('上传失败，请检查网络', { code: 'network' }));
    xhr.send(form);
  });
}

export const api = {
  request,
  download,
  upload,
  get: (p) => request(p),
  post: (p, body) => request(p, { method: 'POST', body }),
  patch: (p, body) => request(p, { method: 'PATCH', body }),
  del: (p) => request(p, { method: 'DELETE' }),
  /** 租户作用域路径，自动补 slug。 */
  w(path) {
    return `/v1/w/${encodeURIComponent(session.slug)}${path}`;
  },
  /** 素材内容地址：后端支持 access_token 查询参数，便于 <img> 直接引用。 */
  assetURL(assetId) {
    return `/v1/w/${encodeURIComponent(session.slug)}/assets/${assetId}/content?access_token=${encodeURIComponent(session.access)}`;
  },
};

/* ---------------- UI ---------------- */

const STATUS_LABEL = {
  queued: '排队中',
  running: '生成中',
  succeeded: '已完成',
  failed: '失败',
  canceled: '已取消',
  pending: '待审核',
  approved: '已通过',
  rejected: '已驳回',
  manual: '人工复核',
  uploaded: '已上传',
  analyzed: '已分析',
  generated: '已生成',
  qc_passed: '质检通过',
  qc_rejected: '质检未过',
  frozen: '已冻结',
  active: '正常',
  readonly: '只读',
  suspended: '已暂停',
  deleted: '已删除',
  owner: '所有者',
  admin: '管理员',
  editor: '编辑',
  reviewer: '审核',
  viewer: '只读',
  free: '免费版',
  starter: '入门版',
  growth: '成长版',
  pro: '专业版',
};

const STATUS_TONE = {
  queued: 'muted',
  running: 'info',
  succeeded: 'good',
  failed: 'bad',
  canceled: 'muted',
  pending: 'warn',
  approved: 'good',
  rejected: 'bad',
  manual: 'info',
  uploaded: 'muted',
  analyzed: 'info',
  generated: 'info',
  qc_passed: 'good',
  qc_rejected: 'bad',
  frozen: 'warn',
  active: 'good',
  readonly: 'warn',
  suspended: 'bad',
  owner: 'accent',
};

export const ui = {
  esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },

  label(status) {
    return STATUS_LABEL[status] || status || '—';
  },

  badge(status, label) {
    const tone = STATUS_TONE[status] || 'muted';
    return `<span class="badge ${tone}">${ui.esc(label || ui.label(status))}</span>`;
  },

  fmt: {
    cents(v) {
      return '$' + ((Number(v) || 0) / 100).toFixed(2);
    },
    bytes(v) {
      const n = Number(v) || 0;
      if (n < 1024) return n + ' B';
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
      return (n / 1024 / 1024).toFixed(1) + ' MB';
    },
    date(v) {
      if (!v) return '—';
      const d = new Date(v);
      if (isNaN(d.getTime())) return '—';
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    },
    time(v) {
      if (!v) return '—';
      const d = new Date(v);
      if (isNaN(d.getTime())) return '—';
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    },
    dt(v) {
      if (!v) return '—';
      return `${ui.fmt.date(v)} ${ui.fmt.time(v)}`;
    },
    ago(v) {
      if (!v) return '—';
      const t = new Date(v).getTime();
      if (!t) return '—';
      const s = Math.max(1, Math.floor((Date.now() - t) / 1000));
      if (s < 60) return `${s} 秒前`;
      if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
      if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
      return `${Math.floor(s / 86400)} 天前`;
    },
    pct(a, b) {
      if (!b) return '0%';
      return Math.min(100, Math.round((a / b) * 100)) + '%';
    },
  },

  toast(message, tone = '') {
    let stack = document.querySelector('.toast-stack');
    if (!stack) {
      stack = document.createElement('div');
      stack.className = 'toast-stack';
      document.body.appendChild(stack);
    }
    const el = document.createElement('div');
    el.className = `toast ${tone}`;
    el.textContent = message;
    stack.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateY(4px)';
      el.style.transition = 'all .18s';
      setTimeout(() => el.remove(), 200);
    }, tone === 'bad' ? 5200 : 3200);
  },

  empty({ icon = '◍', title = '暂无数据', sub = '', action = '' } = {}) {
    return `<div class="empty">
      <div class="e-icon">${icon}</div>
      <div class="e-title">${ui.esc(title)}</div>
      ${sub ? `<div class="e-sub">${ui.esc(sub)}</div>` : ''}
      ${action || ''}
    </div>`;
  },

  loading(text = '加载中…') {
    return `<div class="loading-block"><span class="spinner"></span>${ui.esc(text)}</div>`;
  },

  modal({ title, body, footer, wide = false, onClose } = {}) {
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
      <div class="modal-head"><h3>${ui.esc(title || '')}</h3>
        <button class="btn ghost sm" data-close aria-label="关闭">✕</button></div>
      <div class="modal-body"></div>
      ${footer ? '<div class="modal-foot"></div>' : ''}
    </div>`;
    const bodyEl = overlay.querySelector('.modal-body');
    if (typeof body === 'string') bodyEl.innerHTML = body;
    else if (body) bodyEl.appendChild(body);

    const close = () => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      if (onClose) onClose();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    overlay.querySelector('[data-close]').onclick = close;

    if (footer) {
      const foot = overlay.querySelector('.modal-foot');
      (footer || []).forEach((btn) => {
        const b = document.createElement('button');
        b.className = `btn ${btn.kind || ''}`.trim();
        b.textContent = btn.label;
        b.onclick = () => btn.onClick ? btn.onClick(close) : close();
        foot.appendChild(b);
      });
    }
    document.body.appendChild(overlay);
    const first = overlay.querySelector('input, textarea, select');
    if (first) setTimeout(() => first.focus(), 30);
    return { close, el: overlay, body: bodyEl };
  },

  confirm({ title = '确认操作', message = '', confirmLabel = '确认', cancelLabel = '取消', danger = false } = {}) {
    return new Promise((resolve) => {
      const m = ui.modal({
        title,
        body: `<p class="muted">${ui.esc(message)}</p>`,
        footer: [
          { label: cancelLabel, kind: 'ghost', onClick: (close) => { close(); resolve(false); } },
          { label: confirmLabel, kind: danger ? 'danger' : 'primary', onClick: (close) => { close(); resolve(true); } },
        ],
        onClose: () => resolve(false),
      });
      m.el.querySelector('.modal-body');
    });
  },
};

/* ---------------- 路由 ---------------- */

export const router = {
  routes: [],
  root: null,
  fallback: null,

  add(pattern, page, meta = {}) {
    const parts = pattern.split('/').filter(Boolean);
    this.routes.push({ pattern, parts, page, meta });
    return this;
  },

  current() {
    const raw = (location.hash || '#/').replace(/^#/, '');
    const [path, queryStr] = raw.split('?');
    const query = {};
    if (queryStr) {
      new URLSearchParams(queryStr).forEach((v, k) => { query[k] = v; });
    }
    return { path: path || '/', query, raw };
  },

  match(path) {
    const segs = path.split('/').filter(Boolean);
    for (const r of this.routes) {
      if (r.parts.length !== segs.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < r.parts.length; i++) {
        const p = r.parts[i];
        if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(segs[i]);
        else if (p !== segs[i]) { ok = false; break; }
      }
      if (ok) return { route: r, params };
    }
    return null;
  },

  go(path) {
    if ((location.hash || '').replace(/^#/, '') === path) this.render();
    else location.hash = path;
  },

  async render() {
    const { path, query } = this.current();
    const found = this.match(path);
    this.root.innerHTML = '';
    try {
      if (!found) {
        if (this.fallback) await this.fallback({ path, query }, this.root);
        else this.root.innerHTML = ui.empty({ icon: '404', title: '页面不存在', sub: path });
        return;
      }
      await found.route.page({ params: found.params, query, root: this.root });
    } catch (err) {
      console.error(err);
      this.root.innerHTML = ui.empty({
        icon: '⚠',
        title: '页面加载失败',
        sub: err && err.message ? err.message : '未知错误',
        action: '<button class="btn sm mt-8" onclick="location.reload()">重新加载</button>',
      });
    }
  },

  start(root, { fallback } = {}) {
    this.root = root;
    this.fallback = fallback;
    if (this._bound) window.removeEventListener('hashchange', this._bound);
    this._bound = () => this.render();
    window.addEventListener('hashchange', this._bound);
    return this.render();
  },
};

export function debounce(fn, ms = 250) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function $(sel, root = document) {
  return root.querySelector(sel);
}

export function $$(sel, root = document) {
  return Array.from(root.querySelectorAll(sel));
}
