/* 工作区设置 */

import { api, ui, session } from '../../assets/core.js';
import { setCrumb } from '../shell.js';
import { pageHead, loadUsage } from '../common.js';

export async function render({ root }) {
  setCrumb(['工作台', '设置']);
  root.innerHTML = ui.loading();

  let usage;
  try {
    usage = await loadUsage();
  } catch (err) {
    root.innerHTML = ui.empty({ icon: '⚠', title: '加载失败', sub: err.message });
    return;
  }

  const ws = session.ws || {};
  const user = session.user || {};

  root.innerHTML = `
    ${pageHead({ title: '设置', sub: '工作区信息、账号与套餐状态。' })}
    <div class="grid two">
      <section class="card">
        <h3>工作区</h3>
        <div class="divider"></div>
        <div class="col">
          <div class="row between"><span class="muted small">名称</span><b>${ui.esc(ws.name || '—')}</b></div>
          <div class="row between"><span class="muted small">租户标识</span><span class="mono">${ui.esc(ws.slug || '—')}</span></div>
          <div class="row between"><span class="muted small">套餐</span>${ui.badge(ws.plan)}</div>
          <div class="row between"><span class="muted small">状态</span>${ui.badge(ws.status)}</div>
          <div class="row between"><span class="muted small">我的角色</span>${ui.badge(ws.role)}</div>
          <div class="row between"><span class="muted small">SKU / 导出</span><span class="mono">${usage.sku_used}/${usage.sku_quota} · ${usage.export_used}/${usage.export_quota}</span></div>
        </div>
        <p class="hint mt-8">名称与套餐由平台运营调整；如需变更请联系运营或在管理后台处理。</p>
      </section>
      <section class="card">
        <h3>账号</h3>
        <div class="divider"></div>
        <div class="col">
          <div class="row between"><span class="muted small">姓名</span><b>${ui.esc(user.name || '未命名')}</b></div>
          <div class="row between"><span class="muted small">邮箱</span><span>${ui.esc(user.email || '—')}</span></div>
          <div class="row between"><span class="muted small">平台管理员</span><span>${user.is_platform_admin ? ui.badge('accent', '是') : '否'}</span></div>
        </div>
        ${user.is_platform_admin ? `<div class="divider"></div>
          <a class="btn" href="/admin/" target="_blank" rel="noopener">打开运营管理后台 ↗</a>` : ''}
        <div class="divider"></div>
        <button class="btn danger" id="sign-out">退出登录</button>
      </section>
    </div>

    <section class="card mt-24">
      <h3>接口与集成</h3>
      <div class="divider"></div>
      <p class="muted small">当前工作区 API 基址：</p>
      <pre class="mono" style="background:var(--panel-2);padding:12px;border-radius:10px;overflow:auto">/v1/w/${ui.esc(ws.slug || '{slug}')}</pre>
      <p class="hint mt-8">所有请求需带 <span class="code-inline">Authorization: Bearer &lt;access_token&gt;</span>；令牌有效期 30 分钟，前端会自动刷新。</p>
    </section>`;

  document.getElementById('sign-out').onclick = async () => {
    const ok = await ui.confirm({ title: '退出登录', message: '本地令牌会清除，需要重新登录。', confirmLabel: '退出' });
    if (!ok) return;
    session.clear();
    location.hash = '#/';
    location.reload();
  };
}
