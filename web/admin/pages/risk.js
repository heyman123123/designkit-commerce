/* 风控：#/risk
 * 上半部分用真实数据：已暂停租户（/v1/admin/tenants?status=suspended）+ 恢复操作。
 * 待审队列、投诉冻结、封禁策略没有后端接口，明确占位。
 */

import { ui, $ } from '../../assets/core.js';
import { adminApi, errorHTML, bindRetry, confirmAction, planBadge, statusBadge, fmt, notWired } from '../admin-core.js';

const state = { suspended: [] };

function shellHTML() {
  return `<div class="page-head">
    <div class="ph-main">
      <h1>风控</h1>
      <p class="page-sub">已暂停租户、人工待审队列、投诉冻结与封禁。当前仅“已暂停租户”有真实数据。</p>
    </div>
    <div class="ph-actions"><span class="badge warn no-dot">部分接口未接入</span></div>
  </div>

  <div class="card mb-16">
    <div class="card-head">
      <h2>已暂停租户</h2>
      <span class="chip">来自 /v1/admin/tenants?status=suspended</span>
      <div class="grow"></div>
      <button class="btn sm" id="r-refresh" type="button">刷新</button>
    </div>
    <div id="r-list">${ui.loading('正在加载…')}</div>
    <p class="hint mt-16">暂停/恢复复用租户接口；恢复后成员可立即继续写入与导出。</p>
  </div>

  <div class="grid two">
    <div class="card">
      <div class="card-head"><h2>人工待审队列</h2><span class="badge warn no-dot">接口未接入</span></div>
      ${notWired({
        title: '待审任务与人工复核',
        desc: '任务已有 review_status 字段（pending/approved/rejected/manual），但没有平台级待审列表与复核接口。',
        apis: ['GET /v1/admin/reviews?status=manual', 'POST /v1/admin/reviews/{jobID}/decision', 'GET /v1/admin/reviews/{jobID}'],
      })}
    </div>

    <div class="card">
      <div class="card-head"><h2>投诉与冻结</h2><span class="badge warn no-dot">接口未接入</span></div>
      ${notWired({
        title: '投诉队列与冻结记录',
        desc: '没有投诉模型与冻结原因字段；目前只能通过“暂停租户”阻断写入，缺少原因与工单追溯。',
        apis: ['GET /v1/admin/complaints?status=', 'POST /v1/admin/tenants/{id}/freeze', 'POST /v1/admin/tenants/{id}/ban'],
      })}
    </div>
  </div>

  <div class="card mt-16">
    <div class="card-head"><h2>封禁策略</h2><span class="badge warn no-dot">接口未接入</span></div>
    ${notWired({
      title: '自动风控规则',
      desc: '平台没有风控规则表：触发条件（投诉数、导出异常、内容风险）与处置动作（只读 / 冻结 / 封禁）均未定义。',
      apis: ['GET /v1/admin/risk/rules', 'PATCH /v1/admin/risk/rules/{id}', 'GET /v1/admin/risk/events'],
    })}
  </div>`;
}

function rowsHTML(items) {
  if (!items.length) {
    return ui.empty({
      icon: '⚑',
      title: '当前没有被暂停的租户',
      sub: '在租户详情页暂停某个租户后，会出现在这里。',
      action: '<button class="btn sm mt-8" data-goto>前往租户列表</button>',
    });
  }
  return `<div class="table-wrap"><table class="table dense">
    <thead><tr>
      <th>租户</th><th>Owner</th><th>套餐</th><th>状态</th><th class="right">累计成本</th><th>创建</th><th class="shrink"></th>
    </tr></thead>
    <tbody>${items
      .map(
        (t) => `<tr data-id="${ui.esc(t.id)}">
        <td><div class="cell-title">${ui.esc(t.name)}</div><div class="mono muted small">${ui.esc(t.slug)}</div></td>
        <td class="hide-sm small">${ui.esc(t.owner_email || '—')}</td>
        <td>${planBadge(t.plan)}</td>
        <td>${statusBadge(t.status)}</td>
        <td class="num">${fmt.money(t.cost_cents)}</td>
        <td class="hide-sm muted small">${ui.esc(t.created_at || '—')}</td>
        <td class="shrink"><button class="btn sm" data-restore="${ui.esc(t.id)}" type="button">恢复</button></td>
      </tr>`,
      )
      .join('')}</tbody>
  </table></div>`;
}

export async function page({ root }) {
  root.innerHTML = shellHTML();

  const list = $('#r-list');
  $('#r-refresh').onclick = () => load();

  async function load() {
    list.innerHTML = ui.loading('正在加载已暂停租户…');
    try {
      const data = await adminApi.get('/v1/admin/tenants?status=suspended');
      state.suspended = data.items || [];
      render();
    } catch (err) {
      list.innerHTML = errorHTML(err);
      bindRetry(list, load);
    }
  }

  function render() {
    list.innerHTML = rowsHTML(state.suspended);
    bindRetry(list, load);
    list.querySelector('[data-goto]')?.addEventListener('click', () => {
      location.hash = '#/tenants';
    });
    list.querySelectorAll('[data-restore]').forEach((btn) => {
      btn.onclick = () => restore(btn.dataset.restore, btn);
    });
  }

  async function restore(id, btn) {
    const t = state.suspended.find((x) => x.id === id);
    if (!t) return;
    const ok = await confirmAction({
      title: '确认恢复租户',
      message: `恢复「${t.name}」后，其成员可立即继续写入与导出。`,
      confirmLabel: '恢复租户',
      html: '<p class="hint mt-8">操作会记入审计日志（admin.tenant.suspend）。</p>',
    });
    if (!ok) return;
    btn.disabled = true;
    btn.textContent = '恢复中…';
    try {
      await adminApi.post(`/v1/admin/tenants/${encodeURIComponent(id)}/suspend`);
      state.suspended = state.suspended.filter((x) => x.id !== id);
      render();
      ui.toast('租户已恢复', 'good');
    } catch (err) {
      btn.disabled = false;
      btn.textContent = '恢复';
      ui.toast(err.message || '恢复失败', 'bad');
    }
  }

  await load();
}
