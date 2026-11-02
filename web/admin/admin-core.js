/* 管理后台本地核心：独立管理员会话、adminApi、确认框、状态渲染。
 * 刻意不复用 web/assets/core.js 的 session/api —— 后台令牌 audience 独立，
 * 不能与用户端 dk.access 互相污染；这里只复用 ui / router 等无状态部分。
 */

import { ui } from '../assets/core.js';

const KEY = {
  token: 'dk.admin.token',
  user: 'dk.admin.user',
  exp: 'dk.admin.exp',
  reason: 'dk.admin.reason',
};

/* ---------------- 管理员会话 ---------------- */

let expiryTimer = 0;
let signingOut = false;

export const adminSession = {
  token: '',
  user: null,
  exp: 0,

  load() {
    try {
      this.token = localStorage.getItem(KEY.token) || '';
      this.user = JSON.parse(localStorage.getItem(KEY.user) || 'null');
      this.exp = Number(localStorage.getItem(KEY.exp) || 0);
    } catch {
      this.token = '';
      this.user = null;
      this.exp = 0;
    }
    this.armExpiry();
    return this;
  },

  save(data) {
    signingOut = false;
    this.token = data.access_token || '';
    this.user = data.user || null;
    const ttl = Number(data.expires_in) || 0;
    this.exp = this.token && ttl ? Date.now() + ttl * 1000 : 0;
    if (this.token) localStorage.setItem(KEY.token, this.token);
    if (this.user) localStorage.setItem(KEY.user, JSON.stringify(this.user));
    if (this.exp) localStorage.setItem(KEY.exp, String(this.exp));
    this.armExpiry();
  },

  clear() {
    this.token = '';
    this.user = null;
    this.exp = 0;
    [KEY.token, KEY.user, KEY.exp].forEach((k) => localStorage.removeItem(k));
    if (expiryTimer) {
      clearTimeout(expiryTimer);
      expiryTimer = 0;
    }
  },

  get isAuthed() {
    return !!this.token && (!this.exp || this.exp > Date.now());
  },

  /** 到期前 5 秒自动登出，避免用户点击后才看到 401。 */
  armExpiry() {
    if (expiryTimer) clearTimeout(expiryTimer);
    expiryTimer = 0;
    if (!this.token || !this.exp) return;
    const ms = this.exp - Date.now() - 5000;
    if (ms <= 0) return;
    expiryTimer = setTimeout(() => logout('登录已过期，请重新登录'), Math.min(ms, 2 ** 31 - 1));
  },
};

/* ---------------- API ---------------- */

export class AdminApiError extends Error {
  constructor(message, { status = 0, code = 'error' } = {}) {
    super(message);
    this.name = 'AdminApiError';
    this.status = status;
    this.code = code;
  }
}

export function logout(reason = '') {
  // 并发请求同时 401 时只处理一次，避免重复弹提示、重复重渲染登录页。
  if (signingOut) return;
  signingOut = true;
  adminSession.clear();
  if (reason) sessionStorage.setItem(KEY.reason, reason);
  window.dispatchEvent(new CustomEvent('dk:admin:logout'));
}

async function parseBody(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function request(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (adminSession.token) headers.Authorization = `Bearer ${adminSession.token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new AdminApiError('网络连接失败，请确认服务已启动', { code: 'network' });
  }

  const data = await parseBody(res);
  if (!res.ok) {
    // 后端返回扁平 { error: "code", message: "中文" }，同时兼容嵌套写法。
    const raw = data ? data.error : null;
    const flat = typeof raw === 'string' ? raw : '';
    const nested = raw && typeof raw === 'object' ? raw : {};
    const err = new AdminApiError(
      (data && data.message) || nested.message || `请求失败（${res.status}）`,
      { status: res.status, code: nested.code || flat || 'http_error' },
    );
    // 后台没有 refresh_token：401 一律回登录；403 仅管理员校验失败时回登录。
    // 登录接口自身的 401/403 是“凭据错误”，必须交给登录页展示，不能触发全局登出。
    const isLoginCall = path === '/v1/admin/auth/login';
    if (!isLoginCall && (res.status === 401 || (res.status === 403 && err.code === 'admin_required'))) {
      logout('登录状态已失效，请重新登录');
    }
    throw err;
  }
  return data;
}

export const adminApi = {
  get: (p) => request(p),
  post: (p, body) => request(p, { method: 'POST', body }),
  patch: (p, body) => request(p, { method: 'PATCH', body }),
};

/* ---------------- 确认框（不依赖 ui.confirm） ----------------
 * 共享 core 的 ui.confirm 在关闭时先触发 onClose 再 resolve(true)，
 * 导致 Promise 永远拿到 false；这里按同样视觉重写，语义正确。
 */

export function confirmAction({
  title = '确认操作',
  message = '',
  html = '',
  confirmLabel = '确认',
  cancelLabel = '取消',
  danger = false,
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    ui.modal({
      title,
      body: `<p class="muted">${ui.esc(message)}</p>${html}`,
      footer: [
        { label: cancelLabel, kind: 'ghost', onClick: (close) => { finish(false); close(); } },
        { label: confirmLabel, kind: danger ? 'danger' : 'primary', onClick: (close) => { finish(true); close(); } },
      ],
      onClose: () => finish(false),
    });
  });
}

/* ---------------- 取值与展示小工具 ---------------- */

export const fmt = {
  money: (cents) => ui.fmt.cents(cents),
  shortId: (id, n = 8) => (id ? String(id).slice(0, n) : '—'),
  num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n.toLocaleString('zh-CN') : '0';
  },
  pct(v) {
    const n = Number(v);
    return Number.isFinite(n) ? `${n}%` : '—';
  },
  json(v) {
    if (!v) return '';
    try {
      return JSON.stringify(typeof v === 'string' ? JSON.parse(v) : v, null, 2);
    } catch {
      return String(v);
    }
  },
};

const PLAN_TONE = { free: 'muted', starter: 'info', growth: 'accent', pro: 'good' };

/** 套餐徽章：core 的状态映射里没有套餐 tone，这里补齐。 */
export function planBadge(plan) {
  const tone = PLAN_TONE[plan] || 'muted';
  return `<span class="badge ${tone} no-dot">${ui.esc(ui.label(plan) || '—')}</span>`;
}

export function statusBadge(status) {
  return ui.badge(status);
}

/** 配额进度条：0 配额视为“未设置”，超额与接近上限分别染色。 */
export function quotaCell(used, quota) {
  const u = Math.max(0, Number(used) || 0);
  const q = Math.max(0, Number(quota) || 0);
  if (!q) {
    return `<div class="quota">
      <div class="q-num">${fmt.num(u)} <span class="muted">/ 未设置</span></div>
      <div class="progress thin"><i style="width:0%"></i></div>
    </div>`;
  }
  const pct = Math.round((u / q) * 100);
  const tone = pct >= 100 ? 'bad' : pct >= 80 ? 'warn' : '';
  return `<div class="quota">
    <div class="q-num">${fmt.num(u)} <span class="muted">/ ${fmt.num(q)}</span>
      <span class="q-pct ${pct >= 100 ? 'bad' : pct >= 80 ? 'warn' : ''}">${pct}%</span></div>
    <div class="progress thin ${tone}"><i style="width:${Math.min(100, pct)}%"></i></div>
  </div>`;
}

/* ---------------- 运营字典 ---------------- */

const ORDER_STATUS = { pending: '待支付', paid: '已支付', refunded: '已退款', void: '已作废' };
const ORDER_TONE = { pending: 'warn', paid: 'good', refunded: 'muted', void: 'muted' };
const RISK_KIND = { complaint: '投诉', copyright: '侵权', abuse: '滥用', quality: '质量', other: '其他' };
const RISK_STATUS = { open: '待处理', resolved: '已结案', frozen: '已冻结' };
const RISK_TONE = { open: 'warn', resolved: 'good', frozen: 'bad' };
const SEVERITY = { low: '低', medium: '中', high: '高' };
const SEVERITY_TONE = { low: 'muted', medium: 'warn', high: 'bad' };

export function toneBadge(tone, label) {
  return `<span class="badge ${tone || 'muted'} no-dot">${ui.esc(label || '—')}</span>`;
}

export function orderBadge(status) {
  return toneBadge(ORDER_TONE[status] || 'muted', ORDER_STATUS[status] || status || '—');
}

export function riskStatusBadge(status) {
  return toneBadge(RISK_TONE[status] || 'muted', RISK_STATUS[status] || status || '—');
}

export function severityBadge(severity) {
  return toneBadge(SEVERITY_TONE[severity] || 'muted', SEVERITY[severity] || severity || '—');
}

export function riskKindLabel(kind) {
  return RISK_KIND[kind] || kind || '—';
}

export function orderStatusLabel(status) {
  return ORDER_STATUS[status] || status || '—';
}

/** 元 ↔ 分：后台表单按“元”输入，接口按“分”存储。 */
export function yuanToCents(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export function centsToYuan(v) {
  return ((Number(v) || 0) / 100).toFixed(2);
}

export function errorHTML(err, { retry = true, title = '加载失败' } = {}) {
  const msg = (err && err.message) || '未知错误';
  const code = err && err.code ? `<span class="chip mono">${ui.esc(err.code)}</span>` : '';
  return `<div class="state-error" role="alert">
    <div class="se-icon">⚠</div>
    <div class="se-title">${ui.esc(title)}</div>
    <div class="se-sub">${ui.esc(msg)}</div>
    ${code ? `<div class="mt-8">${code}</div>` : ''}
    ${retry ? '<button class="btn sm mt-8" data-retry>重试</button>' : ''}
  </div>`;
}

export function bindRetry(container, fn) {
  const btn = container.querySelector('[data-retry]');
  if (btn) btn.onclick = () => fn();
}

/** 未接入接口的统一占位：明确说明，不伪造任何数据。 */
export function notWired({ title = '接口未接入', desc = '', apis = [] } = {}) {
  return `<div class="not-wired">
    <div class="nw-head"><span class="badge warn no-dot">接口未接入</span><b>${ui.esc(title)}</b></div>
    ${desc ? `<p class="muted small">${ui.esc(desc)}</p>` : ''}
    ${apis.length ? `<div class="nw-apis">${apis.map((a) => `<code class="code-inline">${ui.esc(a)}</code>`).join('')}</div>` : ''}
    <p class="muted small">后端接口补齐后，这里会直接展示真实数据；当前不展示任何示例值。</p>
  </div>`;
}

/* ---------------- 外壳 DOM ---------------- */

export function showShell() {
  const shell = document.getElementById('shell');
  const login = document.getElementById('login-root');
  if (shell) shell.classList.remove('hidden');
  if (login) login.classList.add('hidden');
}

export function showLoginScreen() {
  const shell = document.getElementById('shell');
  const login = document.getElementById('login-root');
  if (shell) shell.classList.add('hidden');
  if (login) login.classList.remove('hidden');
}

export function setActiveNav(path) {
  const seg = (path || '/').split('/').filter(Boolean)[0] || '';
  document.querySelectorAll('#nav .nav-item').forEach((el) => {
    const route = (el.dataset.route || '').split('/').filter(Boolean)[0] || '';
    el.classList.toggle('active', route === seg);
  });
}

export function setCrumb(html) {
  const el = document.getElementById('crumb');
  if (el) el.innerHTML = html;
}

export function setNavCount(name, value) {
  const el = document.querySelector(`#nav [data-count="${name}"]`);
  if (!el) return;
  el.textContent = value ? String(value) : '';
}

export function setAdminChip(user) {
  const name = document.getElementById('admin-name');
  const mail = document.getElementById('admin-email');
  const av = document.getElementById('admin-avatar');
  const u = user || {};
  if (name) name.textContent = u.name || u.email || '平台管理员';
  if (mail) mail.textContent = u.email || '';
  if (av) av.textContent = String(u.name || u.email || 'A').slice(0, 1).toUpperCase();
}
