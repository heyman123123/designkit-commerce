/* 管理员登录：#/login
 * 独立入口 + 独立令牌，不复用用户端会话。
 */

import { ui, $ } from '../../assets/core.js';
import { adminApi, adminSession, showShell, setAdminChip } from '../admin-core.js';

function screenHTML() {
  return `<div class="auth-screen admin-auth">
    <div class="auth-art">
      <div class="art-top">
        <div class="brand">
          <div class="brand-mark">DK</div>
          <div class="brand-text">
            <div class="brand-name">DesignKit</div>
            <div class="brand-sub">Platform Console</div>
          </div>
        </div>
      </div>
      <div>
        <div class="art-title">运营管理后台</div>
        <p class="art-sub">租户、配额、成本、任务与风控的唯一操作入口。此入口仅面向平台管理员，与用户工作台完全隔离。</p>
        <div class="art-points">
          <div class="art-point"><span class="art-dot"></span><div><b>租户与配额</b> · 调整套餐、SKU/导出额度，暂停与恢复</div></div>
          <div class="art-point"><span class="art-dot"></span><div><b>成本与运维</b> · 用量成本聚合、失败任务重试</div></div>
          <div class="art-point"><span class="art-dot"></span><div><b>可追溯</b> · 所有后台操作写入审计日志</div></div>
        </div>
      </div>
      <div class="muted small">独立管理员令牌 · audience=platform_admin</div>
    </div>

    <div class="auth-form-wrap">
      <form class="auth-form" id="admin-login-form" novalidate>
        <h1>管理员登录</h1>
        <p class="auth-sub">使用平台管理员账号登录，不适用于租户成员账号。</p>
        <div class="field">
          <label for="login-email">邮箱</label>
          <input class="input" id="login-email" name="email" type="email" autocomplete="username"
            placeholder="admin@example.com" required />
        </div>
        <div class="field">
          <label for="login-password">密码</label>
          <input class="input" id="login-password" name="password" type="password"
            autocomplete="current-password" placeholder="••••••••" required />
        </div>
        <div class="error-text hidden" id="login-error" role="alert"></div>
        <button class="btn primary block lg mt-8" id="login-submit" type="submit">登录后台</button>
        <p class="hint mt-16">没有管理员权限的账号会被拒绝（403）。如需开通，请联系平台负责人。</p>
      </form>
    </div>
  </div>`;
}

export async function page() {
  const loginRoot = $('#login-root');
  loginRoot.innerHTML = screenHTML();

  const form = $('#admin-login-form');
  const email = $('#login-email');
  const password = $('#login-password');
  const errorEl = $('#login-error');
  const submit = $('#login-submit');

  const showError = (msg) => {
    errorEl.textContent = msg;
    errorEl.classList.remove('hidden');
  };

  email.focus();

  form.onsubmit = async (e) => {
    e.preventDefault();
    errorEl.classList.add('hidden');

    const mail = email.value.trim();
    const pass = password.value;
    if (!mail || !pass) {
      showError('请填写邮箱和密码');
      return;
    }

    submit.disabled = true;
    const original = submit.textContent;
    submit.innerHTML = '<span class="spinner"></span> 登录中…';

    try {
      const data = await adminApi.post('/v1/admin/auth/login', { email: mail, password: pass });
      adminSession.save(data);
      setAdminChip(data.user);
      showShell();
      ui.toast('登录成功');
      location.hash = '#/tenants';
    } catch (err) {
      const msg =
        err.code === 'admin_required'
          ? '该账号没有平台管理员权限'
          : err.code === 'invalid_credentials'
            ? '邮箱或密码不正确'
            : err.code === 'network'
              ? '网络连接失败，请确认服务已启动'
              : err.message || '登录失败';
      showError(msg);
      password.value = '';
      password.focus();
    } finally {
      submit.disabled = false;
      submit.textContent = original;
    }
  };
}
