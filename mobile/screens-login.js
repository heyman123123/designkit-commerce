/* 登录 / 注册
 *
 * 复用后端已有接口：POST /v1/auth/login、POST /v1/auth/register。
 * 登录响应里的 workspace 是移动端唯一可用的租户入口；没有工作区时明确提示，
 * 不把用户留在一个「已登录但什么都打不开」的状态。
 */

import { session, router } from '../web/assets/core.js';
import { request } from './api.js';
import { setBusy, friendlyError } from './ui.js';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export default function renderLogin({ root }) {
  if (session.isAuthed && session.ws) {
    router.go('/skus');
    return;
  }

  let mode = 'login';

  root.innerHTML = `<div class="screen login-screen">
    <div class="login-brand">
      <div class="brand-mark" aria-hidden="true">DK</div>
      <h1 class="login-title">DesignKit</h1>
      <p class="login-sub">电商视觉 · 移动端</p>
    </div>

    <form class="card login-card" novalidate>
      <div class="seg" role="tablist" aria-label="登录或注册">
        <button type="button" class="seg-btn active" data-mode="login" role="tab" aria-selected="true">登录</button>
        <button type="button" class="seg-btn" data-mode="register" role="tab" aria-selected="false">注册</button>
      </div>

      <div class="field">
        <label for="login-email">邮箱</label>
        <input id="login-email" class="input" type="email" inputmode="email" autocomplete="username"
          autocapitalize="off" spellcheck="false" placeholder="you@example.com" required>
      </div>

      <div class="field">
        <label for="login-password">密码</label>
        <input id="login-password" class="input" type="password" autocomplete="current-password"
          placeholder="登录密码" required>
        <span class="hint reg-only" hidden>至少 8 位</span>
      </div>

      <div class="field reg-only" hidden>
        <label for="login-name">称呼</label>
        <input id="login-name" class="input" type="text" autocomplete="name" maxlength="60" placeholder="例如：阿吉">
      </div>

      <div class="field reg-only" hidden>
        <label for="login-ws">工作区名称</label>
        <input id="login-ws" class="input" type="text" maxlength="60" placeholder="例如：我的店铺">
        <span class="hint">会作为团队工作区，创建后可在 Web 工作台管理成员</span>
      </div>

      <p class="form-error" role="alert" aria-live="assertive" hidden></p>

      <button class="btn primary block lg" type="submit" data-submit>登录</button>

      <p class="login-note muted">手机端只负责拍摄上传、生成进度、审核和结果分享。</p>
    </form>
  </div>`;

  const form = root.querySelector('form');
  const errorEl = root.querySelector('.form-error');
  const submitBtn = root.querySelector('[data-submit]');
  const emailEl = root.querySelector('#login-email');
  const passEl = root.querySelector('#login-password');
  const nameEl = root.querySelector('#login-name');
  const wsEl = root.querySelector('#login-ws');

  const showError = (msg) => {
    errorEl.textContent = msg;
    errorEl.hidden = !msg;
  };

  const applyMode = () => {
    const isReg = mode === 'register';
    root.querySelectorAll('.seg-btn').forEach((b) => {
      const on = b.dataset.mode === mode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    root.querySelectorAll('.reg-only').forEach((el) => {
      el.hidden = !isReg;
    });
    passEl.autocomplete = isReg ? 'new-password' : 'current-password';
    passEl.minLength = isReg ? 8 : 1;
    passEl.placeholder = isReg ? '设置至少 8 位密码' : '登录密码';
    submitBtn.textContent = isReg ? '注册并登录' : '登录';
    showError('');
  };

  root.querySelectorAll('.seg-btn').forEach((b) => {
    b.addEventListener('click', () => {
      mode = b.dataset.mode;
      applyMode();
    });
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (submitBtn.disabled) return;
    showError('');

    const email = emailEl.value.trim();
    const password = passEl.value;
    if (!EMAIL_RE.test(email)) {
      showError('请输入正确的邮箱地址');
      emailEl.focus();
      return;
    }
    if (mode === 'login' && !password) {
      showError('请输入密码');
      passEl.focus();
      return;
    }
    if (mode === 'register' && password.length < 8) {
      showError('密码至少 8 位');
      passEl.focus();
      return;
    }

    setBusy(submitBtn, true, mode === 'login' ? '登录中…' : '注册中…');
    try {
      const body = mode === 'login'
        ? { email, password }
        : {
            email,
            password,
            name: nameEl.value.trim(),
            workspace_name: wsEl.value.trim() || '我的工作区',
          };
      const data = await request(mode === 'login' ? '/v1/auth/login' : '/v1/auth/register', {
        method: 'POST',
        body,
        auth: false,
      });
      if (!data || !data.access_token) {
        showError('服务器没有返回登录凭证，请稍后重试');
        return;
      }
      if (!data.workspace) {
        showError('该账号还没有加入工作区，请先在 Web 工作台创建或加入工作区后再登录');
        return;
      }
      session.save(data);
      router.go('/skus');
    } catch (err) {
      showError(friendlyError(err, '登录失败，请稍后重试'));
    } finally {
      setBusy(submitBtn, false);
      submitBtn.textContent = mode === 'register' ? '注册并登录' : '登录';
    }
  });

  applyMode();
  emailEl.focus();
}
