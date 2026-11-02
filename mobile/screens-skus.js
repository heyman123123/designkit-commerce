/* 选 SKU：项目切换 + SKU 列表
 *
 * 只做「选择」；项目创建放在 Web 工作台（移动端不做，避免把工作台搬过来）。
 * 新建 SKU 例外：没有 SKU 就没法拍照，所以在手机上允许建一个（复用 POST /skus）。
 */

import { session, router } from '../web/assets/core.js';
import { get, post, wsPath, forceLogout } from './api.js';
import {
  esc, toast, empty, loading, label, fmt, setBusy, openSheet, friendlyError, confirmSheet,
} from './ui.js';

const SKU_KEY = 'dk.mobile.sku';
const PROJECT_KEY = 'dk.mobile.project';

export function currentSku() {
  try {
    return JSON.parse(localStorage.getItem(SKU_KEY) || 'null');
  } catch {
    return null;
  }
}

function rememberSku(sku) {
  localStorage.setItem(SKU_KEY, JSON.stringify(sku));
}

export default async function renderSkus({ root }) {
  const ws = session.ws || {};
  root.innerHTML = `<div class="screen">
    <header class="screen-head">
      <div class="head-main">
        <h1 class="screen-title">选择 SKU</h1>
        <p class="screen-sub">${esc(ws.name || '工作区')} · ${esc(label(ws.plan))}</p>
      </div>
      <div class="head-actions">
        <button type="button" class="btn ghost sm" data-refresh aria-label="刷新列表">↻</button>
        <button type="button" class="btn ghost sm" data-logout>退出</button>
      </div>
    </header>
    <div class="quota-line">SKU 已用 <b>${Number(ws.sku_used) || 0}</b> / ${Number(ws.sku_quota) || 0}
      <span class="dot-sep">·</span> 高清导出 ${Number(ws.export_quota) || 0} 次</div>
    <div class="body-slot">${loading('正在加载项目…')}</div>
  </div>`;

  const body = root.querySelector('.body-slot');

  root.querySelector('[data-logout]').addEventListener('click', async () => {
    if (await confirmSheet({ title: '退出登录', message: '退出后需要重新输入邮箱和密码。', confirmLabel: '退出', danger: true })) {
      forceLogout('已退出登录');
    }
  });
  root.querySelector('[data-refresh]').addEventListener('click', () => renderSkus({ root }));

  const showError = (msg, retry) => {
    body.innerHTML = `<div class="state-error" role="alert">
      <p>${esc(msg)}</p>
      ${retry ? '<button type="button" class="btn sm mt-8" data-retry>重试</button>' : ''}
    </div>`;
    const b = body.querySelector('[data-retry]');
    if (b) b.addEventListener('click', () => renderSkus({ root }));
  };

  let projects = [];
  let skus = [];
  let projectId = '';

  try {
    const res = await get(wsPath('/projects'));
    projects = (res && res.items) || [];
  } catch (err) {
    showError(friendlyError(err, '项目加载失败'), true);
    return;
  }

  if (!projects.length) {
    body.innerHTML = empty({
      icon: '▦',
      title: '还没有项目',
      sub: '移动端暂不支持新建项目，请先在 Web 工作台创建项目，再回来选 SKU。',
    });
    return;
  }

  const savedProject = localStorage.getItem(PROJECT_KEY);
  projectId = projects.some((p) => p.id === savedProject) ? savedProject : projects[0].id;
  localStorage.setItem(PROJECT_KEY, projectId);

  body.innerHTML = `<div class="chips" role="tablist" aria-label="项目">${projects
    .map(
      (p) => `<button type="button" class="chip ${p.id === projectId ? 'active' : ''}"
        role="tab" aria-selected="${p.id === projectId}" data-project="${esc(p.id)}">${esc(p.name)}</button>`,
    )
    .join('')}</div>
    <div class="sku-slot"></div>`;

  const skuSlot = body.querySelector('.sku-slot');

  body.querySelectorAll('[data-project]').forEach((b) => {
    b.addEventListener('click', () => {
      projectId = b.dataset.project;
      localStorage.setItem(PROJECT_KEY, projectId);
      body.querySelectorAll('[data-project]').forEach((x) => {
        const on = x.dataset.project === projectId;
        x.classList.toggle('active', on);
        x.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      loadSkus();
    });
  });

  async function loadSkus() {
    skuSlot.innerHTML = loading('正在加载 SKU…');
    try {
      const res = await get(wsPath(`/skus?project_id=${encodeURIComponent(projectId)}`));
      skus = (res && res.items) || [];
      renderSkusList();
    } catch (err) {
      skuSlot.innerHTML = `<div class="state-error" role="alert">
        <p>${esc(friendlyError(err, 'SKU 加载失败'))}</p>
        <button type="button" class="btn sm mt-8" data-retry-skus>重试</button>
      </div>`;
      skuSlot.querySelector('[data-retry-skus]').addEventListener('click', loadSkus);
    }
  }

  function renderSkusList() {
    const active = currentSku();
    if (!skus.length) {
      skuSlot.innerHTML = empty({
        icon: '◫',
        title: '这个项目还没有 SKU',
        sub: '建一个 SKU 编码，就可以拍照上传并生成商品图。',
      }) + `<button type="button" class="btn primary block lg mt-16" data-new-sku>新建 SKU</button>`;
    } else {
      skuSlot.innerHTML = `<div class="sku-list">${skus
        .map(
          (s) => `<button type="button" class="sku-row ${active && active.id === s.id ? 'selected' : ''}" data-sku="${esc(s.id)}">
            <span class="sku-main">
              <span class="sku-code mono">${esc(s.code)}</span>
              <span class="sku-title">${esc(s.title || '未填写标题')}</span>
              <span class="sku-meta">更新于 ${esc(fmt.ago(s.updated_at))}</span>
            </span>
            <span class="sku-go" aria-hidden="true">›</span>
          </button>`,
        )
        .join('')}</div>
        <button type="button" class="btn block lg mt-16" data-new-sku>新建 SKU</button>`;
    }

    skuSlot.querySelectorAll('[data-sku]').forEach((b) => {
      b.addEventListener('click', () => {
        const sku = skus.find((s) => s.id === b.dataset.sku);
        if (!sku) return;
        rememberSku(sku);
        router.go('/capture');
      });
    });
    const newBtn = skuSlot.querySelector('[data-new-sku]');
    if (newBtn) newBtn.addEventListener('click', () => openCreateSku());
  }

  function openCreateSku() {
    const project = projects.find((p) => p.id === projectId);
    const sheet = openSheet({
      title: '新建 SKU',
      body: `<p class="muted">项目：${esc(project ? project.name : '—')}</p>
        <label class="field mt-16">
          <span class="label">SKU 编码 *</span>
          <input class="input" name="code" maxlength="80" autocapitalize="characters" placeholder="如 AMZ-BOTTLE-01">
        </label>
        <label class="field">
          <span class="label">商品标题</span>
          <input class="input" name="title" maxlength="200" placeholder="选填，便于之后辨认">
        </label>
        <p class="hint">编码在工作区内唯一；配额用尽时后端会提示升级套餐。</p>`,
      buttons: [
        { label: '取消', kind: 'ghost', onClick: (close) => close() },
        {
          label: '创建',
          kind: 'primary',
          onClick: async (close, btn) => {
            const code = sheet.body.querySelector('[name="code"]').value.trim();
            const title = sheet.body.querySelector('[name="title"]').value.trim();
            if (!code) {
              toast('请填写 SKU 编码', 'bad');
              sheet.body.querySelector('[name="code"]').focus();
              return;
            }
            setBusy(btn, true, '创建中…');
            try {
              const sku = await post(wsPath('/skus'), { project_id: projectId, code, title });
              close();
              toast('SKU 已创建', 'good');
              rememberSku(sku);
              router.go('/capture');
            } catch (err) {
              toast(friendlyError(err, '创建失败，请稍后重试'), 'bad');
              setBusy(btn, false);
            }
          },
        },
      ],
    });
    const codeInput = sheet.body.querySelector('[name="code"]');
    if (codeInput) codeInput.focus();
  }

  await loadSkus();
}
