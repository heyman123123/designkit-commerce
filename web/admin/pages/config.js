/* 平台配置：#/config
 * 生成模板（可编辑 prompt / 上下架）+ 功能开关（可切换）。
 * 模型供应商与规则版本仍无接口，保留明确占位。
 */

import { ui, $ } from '../../assets/core.js';
import { adminApi, errorHTML, bindRetry, notWired, toneBadge, confirmAction, fmt } from '../admin-core.js';

const state = { templates: [], flags: [] };

function shellHTML() {
  return `<div class="page-head">
    <div class="ph-main">
      <h1>平台配置</h1>
      <p class="page-sub">生成模板与功能开关可直接修改；供应商与规则版本仍待接入。</p>
    </div>
    <div class="ph-actions"><button class="btn sm" id="cf-refresh" type="button">刷新</button></div>
  </div>

  <div class="card mb-16">
    <div class="card-head">
      <h2>生成模板</h2>
      <span class="chip" id="cf-tpl-count">—</span>
    </div>
    <div id="cf-tpl-list">${ui.loading('正在加载模板…')}</div>
    <p class="hint mt-16">模板编码与生成任务的 template 字段对应；停用后新任务不应再选择该模板。</p>
  </div>

  <div class="card mb-16">
    <div class="card-head">
      <h2>功能开关</h2>
      <span class="chip" id="cf-flag-count">—</span>
    </div>
    <div id="cf-flag-list">${ui.loading('正在加载开关…')}</div>
    <p class="hint mt-16">开关写入后立即生效于读取该 key 的服务端逻辑；前端不缓存。</p>
  </div>

  <div class="grid two">
    <div class="card">
      <div class="card-head"><h2>模型供应商</h2><span class="badge warn no-dot">接口未接入</span></div>
      ${notWired({
        title: '供应商与模型配置',
        desc: '当前供应商由服务端环境变量决定，后台不可见也不可改：无法在页面上确认用的是 mock 还是真实模型。',
        apis: ['GET /v1/admin/config/providers', 'PATCH /v1/admin/config/providers', 'POST /v1/admin/config/providers/test'],
      })}
    </div>
    <div class="card">
      <div class="card-head"><h2>平台规则版本</h2><span class="badge warn no-dot">接口未接入</span></div>
      ${notWired({
        title: 'QC 规则与内容规则版本',
        desc: 'QC 阈值目前写死在服务端，无版本号、无灰度、无回滚记录。',
        apis: ['GET /v1/admin/config/rules', 'POST /v1/admin/config/rules/versions', 'POST /v1/admin/config/rules/{version}/activate'],
      })}
    </div>
  </div>

  <div class="card mt-16">
    <div class="card-head"><h2>后台入口信息</h2><span class="badge good no-dot">当前真实配置</span></div>
    <div class="kv-list">
      <div class="info-row"><div class="ir-label">前端入口</div><div class="ir-value mono">/admin/</div></div>
      <div class="info-row"><div class="ir-label">接口前缀</div><div class="ir-value mono">/v1/admin/*</div></div>
      <div class="info-row"><div class="ir-label">鉴权</div><div class="ir-value mono">Authorization: Bearer &lt;admin token&gt;</div></div>
      <div class="info-row"><div class="ir-label">令牌受众</div><div class="ir-value mono">platform_admin（与用户端隔离）</div></div>
      <div class="info-row"><div class="ir-label">令牌存储</div><div class="ir-value mono">localStorage · dk.admin.token</div></div>
      <div class="info-row"><div class="ir-label">登录接口</div><div class="ir-value mono">POST /v1/admin/auth/login</div></div>
    </div>
  </div>`;
}

function templateRow(t) {
  const prompt = (t.prompt || '').replace(/\s+/g, ' ');
  return `<tr>
    <td><span class="chip mono">${ui.esc(t.code)}</span></td>
    <td>${ui.esc(t.name || '—')}</td>
    <td class="muted small">${ui.esc(t.platform || '—')}</td>
    <td><div class="prompt-cell" title="${ui.esc(prompt)}">${ui.esc(prompt || '—')}</div></td>
    <td class="num">${fmt.num(t.sort)}</td>
    <td>${toneBadge(t.active ? 'good' : 'muted', t.active ? '已上架' : '已下架')}</td>
    <td class="shrink">
      <button class="btn sm ghost" data-tpl-edit="${ui.esc(t.code)}" type="button">编辑</button>
      <button class="btn sm ghost" data-tpl-toggle="${ui.esc(t.code)}" type="button">${t.active ? '下架' : '上架'}</button>
    </td>
  </tr>`;
}

function templatesHTML(items) {
  if (!items.length) {
    return ui.empty({
      icon: '⚙',
      title: '还没有模板配置',
      sub: '后端启动时会写入默认模板（主图/场景图/卖点图）；如果为空，请检查 SeedPlatform 是否执行。',
    });
  }
  return `<div class="table-wrap"><table class="table dense">
    <thead><tr><th>编码</th><th>名称</th><th>平台</th><th>提示词</th><th class="right">排序</th><th>状态</th><th class="shrink"></th></tr></thead>
    <tbody>${items.map(templateRow).join('')}</tbody>
  </table></div>`;
}

function flagsHTML(items) {
  if (!items.length) {
    return ui.empty({
      icon: '⚙',
      title: '还没有功能开关',
      sub: '后端启动时会写入默认开关；如果为空，请检查 SeedPlatform 是否执行。',
    });
  }
  return `<div class="table-wrap"><table class="table dense">
    <thead><tr><th>Key</th><th>说明</th><th>状态</th><th class="shrink">切换</th></tr></thead>
    <tbody>${items
      .map(
        (f) => `<tr>
        <td><span class="mono">${ui.esc(f.key)}</span></td>
        <td class="muted small">${ui.esc(f.description || '—')}</td>
        <td>${toneBadge(f.enabled ? 'good' : 'muted', f.enabled ? '已开启' : '已关闭')}</td>
        <td class="shrink">
          <label class="switch" title="${f.enabled ? '关闭' : '开启'}">
            <input type="checkbox" data-flag="${ui.esc(f.key)}" ${f.enabled ? 'checked' : ''} />
            <span class="sw-track"><span class="sw-dot"></span></span>
          </label>
        </td>
      </tr>`,
      )
      .join('')}</tbody>
  </table></div>`;
}

async function openTemplateForm(t, reload) {
  const m = ui.modal({
    title: `编辑模板 · ${t.code}`,
    wide: true,
    body: `<div class="grid two" style="gap:12px">
        <div class="field">
          <label for="tf-name">名称</label>
          <input class="input" id="tf-name" maxlength="80" value="${ui.esc(t.name || '')}" />
        </div>
        <div class="field">
          <label for="tf-platform">平台</label>
          <input class="input" id="tf-platform" maxlength="32" value="${ui.esc(t.platform || '')}" placeholder="amazon" />
        </div>
        <div class="field">
          <label for="tf-sort">排序</label>
          <input class="input" id="tf-sort" type="number" step="1" value="${Number(t.sort) || 0}" />
        </div>
        <div class="field">
          <label>状态</label>
          <label class="check-line"><input type="checkbox" id="tf-active" ${t.active ? 'checked' : ''} /> 上架</label>
        </div>
      </div>
      <div class="field">
        <label for="tf-prompt">提示词</label>
        <textarea class="textarea" id="tf-prompt" rows="6" maxlength="2000">${ui.esc(t.prompt || '')}</textarea>
        <span class="hint">与生成服务使用的模板提示词对应，修改后保存即写入配置。</span>
      </div>`,
    footer: [
      { label: '取消', kind: 'ghost', onClick: (close) => close() },
      {
        label: '保存',
        kind: 'primary',
        onClick: async (close) => {
          const el = m.body;
          const name = el.querySelector('#tf-name').value.trim();
          const platform = el.querySelector('#tf-platform').value.trim();
          const prompt = el.querySelector('#tf-prompt').value;
          const sort = Number(el.querySelector('#tf-sort').value || 0);
          const active = el.querySelector('#tf-active').checked;
          if (!name) return ui.toast('请填写模板名称', 'bad');
          if (!Number.isInteger(sort)) return ui.toast('排序必须是整数', 'bad');

          const btn = m.el.querySelectorAll('.modal-foot .btn')[1];
          btn.disabled = true;
          btn.textContent = '保存中…';
          try {
            await adminApi.patch(`/v1/admin/config/templates/${encodeURIComponent(t.code)}`, {
              name,
              platform,
              prompt,
              sort,
              active,
            });
            close();
            ui.toast('模板已更新', 'good');
            await reload();
          } catch (err) {
            btn.disabled = false;
            btn.textContent = '保存';
            ui.toast(err.message || '保存失败', 'bad');
          }
        },
      },
    ],
  });
}

export async function page({ root }) {
  root.innerHTML = shellHTML();

  const tplList = $('#cf-tpl-list');
  const flagList = $('#cf-flag-list');

  $('#cf-refresh').onclick = () => loadAll();

  async function loadAll() {
    await Promise.all([loadTemplates(), loadFlags()]);
  }

  async function loadTemplates() {
    tplList.innerHTML = ui.loading('正在加载模板…');
    try {
      const d = await adminApi.get('/v1/admin/config/templates');
      state.templates = d.items || [];
      renderTemplates();
    } catch (err) {
      tplList.innerHTML = errorHTML(err);
      bindRetry(tplList, loadTemplates);
    }
  }

  async function loadFlags() {
    flagList.innerHTML = ui.loading('正在加载开关…');
    try {
      const d = await adminApi.get('/v1/admin/config/flags');
      state.flags = d.items || [];
      renderFlags();
    } catch (err) {
      flagList.innerHTML = errorHTML(err);
      bindRetry(flagList, loadFlags);
    }
  }

  function renderTemplates() {
    tplList.innerHTML = templatesHTML(state.templates);
    $('#cf-tpl-count').textContent = `共 ${fmt.num(state.templates.length)} 个`;
    bindRetry(tplList, loadTemplates);

    tplList.querySelectorAll('[data-tpl-edit]').forEach((b) => {
      b.onclick = () => {
        const t = state.templates.find((x) => x.code === b.dataset.tplEdit);
        if (t) openTemplateForm(t, loadTemplates);
      };
    });

    tplList.querySelectorAll('[data-tpl-toggle]').forEach((b) => {
      b.onclick = async () => {
        const t = state.templates.find((x) => x.code === b.dataset.tplToggle);
        if (!t) return;
        const ok = await confirmAction({
          title: t.active ? '下架模板' : '上架模板',
          message: t.active
            ? `下架「${t.name || t.code}」后，新任务不应再选择该模板。`
            : `重新上架「${t.name || t.code}」。`,
          confirmLabel: t.active ? '下架' : '上架',
          danger: t.active,
        });
        if (!ok) return;
        try {
          await adminApi.patch(`/v1/admin/config/templates/${encodeURIComponent(t.code)}`, { active: !t.active });
          ui.toast(t.active ? '模板已下架' : '模板已上架', 'good');
          await loadTemplates();
        } catch (err) {
          ui.toast(err.message || '操作失败', 'bad');
        }
      };
    });
  }

  function renderFlags() {
    flagList.innerHTML = flagsHTML(state.flags);
    $('#cf-flag-count').textContent = `共 ${fmt.num(state.flags.length)} 个`;
    bindRetry(flagList, loadFlags);

    flagList.querySelectorAll('[data-flag]').forEach((input) => {
      input.onchange = async () => {
        const key = input.dataset.flag;
        const next = input.checked;
        input.disabled = true;
        try {
          await adminApi.patch(`/v1/admin/config/flags/${encodeURIComponent(key)}`, { enabled: next });
          ui.toast(`${key} 已${next ? '开启' : '关闭'}`, 'good');
          await loadFlags();
        } catch (err) {
          input.checked = !next;
          input.disabled = false;
          ui.toast(err.message || '切换失败', 'bad');
        }
      };
    });
  }

  await loadAll();
}
