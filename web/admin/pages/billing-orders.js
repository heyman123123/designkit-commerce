/* 订单区块（订阅页的一部分）：列表 / 筛选 / 新建订单 / 退款。
 * 接口：GET /v1/admin/orders、POST /v1/admin/orders、POST /v1/admin/orders/{id}/refund
 */

import { ui, $ } from '../../assets/core.js';
import {
  adminApi,
  errorHTML,
  bindRetry,
  confirmAction,
  planBadge,
  orderBadge,
  orderStatusLabel,
  yuanToCents,
  centsToYuan,
  fmt,
} from '../admin-core.js';

const state = { items: [], status: '', tenants: [], plans: [] };

const CHANNELS = [
  ['manual', '人工开通'],
  ['stripe', 'Stripe'],
  ['alipay', '支付宝'],
  ['wechat', '微信支付'],
];

export function shellHTML() {
  return `<div class="card-head">
      <h2>订单</h2>
      <span class="chip" id="od-count">—</span>
      <div class="grow"></div>
      <button class="btn sm primary" id="od-new" type="button">新建订单</button>
    </div>
    <div class="toolbar slim mb-16">
      <select class="select tb-select" id="od-status" aria-label="按订单状态筛选">
        <option value="">全部状态</option>
        <option value="pending">待支付</option>
        <option value="paid">已支付</option>
        <option value="refunded">已退款</option>
      </select>
      <button class="btn sm ghost" id="od-refresh" type="button">刷新</button>
    </div>
    <div id="od-list">${ui.loading('正在加载订单…')}</div>
    <p class="hint mt-16">人工开通模式：新建「已支付」订单会立即把该套餐的配额应用到租户，并写入审计日志。</p>`;
}

function rowHTML(o) {
  const canRefund = o.status === 'paid';
  return `<tr>
    <td>
      <div class="mono">${fmt.shortId(o.id, 10)}</div>
      <div class="muted small">${ui.fmt.dt(o.created_at)}</div>
    </td>
    <td><div class="cell-title">${ui.esc(o.tenant_name || '—')}</div>
      <div class="mono muted small">${fmt.shortId(o.workspace_id)}</div></td>
    <td>${planBadge(o.plan_code)}</td>
    <td class="num"><b>${fmt.money(o.amount_cents)}</b></td>
    <td>${orderBadge(o.status)}</td>
    <td class="muted small">${ui.esc((CHANNELS.find(([v]) => v === o.channel) || [])[1] || o.channel || '—')}</td>
    <td class="muted small">${o.note ? ui.esc(o.note) : '—'}</td>
    <td class="shrink">${canRefund
      ? `<button class="btn sm danger" data-refund="${ui.esc(o.id)}" type="button">退款</button>`
      : '<span class="muted small">—</span>'}</td>
  </tr>`;
}

function listHTML(items) {
  if (!items.length) {
    return ui.empty({
      icon: '▤',
      title: state.status ? `没有「${orderStatusLabel(state.status)}」订单` : '还没有订单',
      sub: state.status ? '切换状态筛选，或新建一笔订单。' : '手动开通或续费时在这里登记，金额以元输入、按分存储。',
      action: '<button class="btn sm mt-8" data-new>新建订单</button>',
    });
  }
  return `<div class="table-wrap"><table class="table dense">
    <thead><tr>
      <th>订单</th><th>租户</th><th>套餐</th><th class="right">金额</th>
      <th>状态</th><th>渠道</th><th>备注</th><th class="shrink"></th>
    </tr></thead>
    <tbody>${items.map(rowHTML).join('')}</tbody>
  </table></div>`;
}

function orderForm() {
  const activePlans = state.plans.length ? state.plans : [];
  return `<div class="field">
      <label for="of-tenant">租户</label>
      <select class="select" id="of-tenant">
        ${state.tenants.map((t) => `<option value="${ui.esc(t.id)}">${ui.esc(t.name)}（${ui.esc(t.slug)}）</option>`).join('')}
      </select>
    </div>
    <div class="grid two" style="gap:12px">
      <div class="field">
        <label for="of-plan">套餐</label>
        <select class="select" id="of-plan">
          ${activePlans.map((p) => `<option value="${ui.esc(p.code)}" data-price="${Number(p.price_cents) || 0}">${ui.esc(p.name || p.code)}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label for="of-amount">金额（元）</label>
        <input class="input" id="of-amount" type="number" min="0" step="0.01" value="0.00" />
      </div>
      <div class="field">
        <label for="of-status">状态</label>
        <select class="select" id="of-status">
          <option value="paid">已支付（立即应用套餐）</option>
          <option value="pending">待支付</option>
        </select>
      </div>
      <div class="field">
        <label for="of-channel">渠道</label>
        <select class="select" id="of-channel">
          ${CHANNELS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="field">
      <label for="of-note">备注</label>
      <input class="input" id="of-note" maxlength="255" placeholder="发票抬头、合同号等，可选" />
    </div>
    ${state.tenants.length ? '' : '<p class="error-text">没有可选租户：请先在租户页确认已有租户。</p>'}`;
}

async function openOrderForm(reload) {
  if (!state.tenants.length || !state.plans.length) {
    ui.toast('缺少租户或套餐数据，无法新建订单', 'bad');
    return;
  }
  const m = ui.modal({
    title: '新建订单',
    wide: true,
    body: orderForm(),
    footer: [
      { label: '取消', kind: 'ghost', onClick: (close) => close() },
      {
        label: '创建订单',
        kind: 'primary',
        onClick: async (close) => {
          const el = m.body;
          const workspace_id = el.querySelector('#of-tenant').value;
          const plan_code = el.querySelector('#of-plan').value;
          const amount = yuanToCents(el.querySelector('#of-amount').value || 0);
          const status = el.querySelector('#of-status').value;
          const channel = el.querySelector('#of-channel').value;
          const note = el.querySelector('#of-note').value.trim();

          if (!workspace_id || !plan_code) return ui.toast('请选择租户与套餐', 'bad');

          const btn = m.el.querySelectorAll('.modal-foot .btn')[1];
          btn.disabled = true;
          btn.textContent = '创建中…';
          try {
            await adminApi.post('/v1/admin/orders', { workspace_id, plan_code, amount_cents: amount, status, channel, note });
            close();
            ui.toast('订单已创建', 'good');
            await reload();
          } catch (err) {
            btn.disabled = false;
            btn.textContent = '创建订单';
            ui.toast(err.message || '创建失败', 'bad');
          }
        },
      },
    ],
  });

  const planSel = m.body.querySelector('#of-plan');
  const tenantSel = m.body.querySelector('#of-tenant');
  const amount = m.body.querySelector('#of-amount');
  const syncPrice = () => {
    const opt = planSel.selectedOptions[0];
    if (opt) amount.value = centsToYuan(opt.dataset.price);
  };
  planSel.onchange = syncPrice;
  // 默认选中租户当前套餐，避免人工开通时选错档位。
  tenantSel.onchange = () => {
    const t = state.tenants.find((x) => x.id === tenantSel.value);
    if (t && state.plans.some((p) => p.code === t.plan)) planSel.value = t.plan;
    syncPrice();
  };
  tenantSel.onchange();
  syncPrice();
}

export async function loadInto(el, ctx) {
  state.tenants = (ctx && ctx.tenants) || [];
  state.plans = (ctx && ctx.plans) || [];
  el.innerHTML = shellHTML();

  const list = $('#od-list', el);
  const statusSel = $('#od-status', el);
  statusSel.value = state.status;

  $('#od-refresh', el).onclick = () => load();
  $('#od-new', el).onclick = () => openOrderForm(load);
  statusSel.onchange = () => {
    state.status = statusSel.value;
    load();
  };

  async function load() {
    list.innerHTML = ui.loading('正在加载订单…');
    const qs = state.status ? `?status=${encodeURIComponent(state.status)}` : '';
    try {
      const data = await adminApi.get(`/v1/admin/orders${qs}`);
      state.items = data.items || [];
      render();
    } catch (err) {
      list.innerHTML = errorHTML(err);
      bindRetry(list, load);
    }
  }

  function render() {
    list.innerHTML = listHTML(state.items);
    $('#od-count', el).textContent = `共 ${fmt.num(state.items.length)} 单`;
    bindRetry(list, load);

    list.querySelector('[data-new]')?.addEventListener('click', () => openOrderForm(load));

    list.querySelectorAll('[data-refund]').forEach((b) => {
      b.onclick = async () => {
        const o = state.items.find((x) => x.id === b.dataset.refund);
        if (!o) return;
        const ok = await confirmAction({
          title: '确认订单退款',
          message: `订单 ${fmt.shortId(o.id, 10)}（${fmt.money(o.amount_cents)}）将标记为已退款。`,
          confirmLabel: '标记退款',
          danger: true,
          html: '<p class="hint mt-8">该操作只登记退款状态，不会自动回收已应用的套餐配额，请按需在租户页调整。</p>',
        });
        if (!ok) return;
        b.disabled = true;
        b.textContent = '处理中…';
        try {
          await adminApi.post(`/v1/admin/orders/${encodeURIComponent(o.id)}/refund`);
          ui.toast('订单已标记退款', 'good');
          await load();
        } catch (err) {
          b.disabled = false;
          b.textContent = '退款';
          ui.toast(err.message || '退款失败', 'bad');
        }
      };
    });
  }

  await load();
  return load;
}
