/* 订阅与计费：#/billing
 * 套餐定义（可编辑）+ 订单（新建/退款）+ 优惠码。全部走真实接口。
 */

import { ui, $ } from '../../assets/core.js';
import {
  adminApi,
  errorHTML,
  bindRetry,
  confirmAction,
  planBadge,
  toneBadge,
  yuanToCents,
  centsToYuan,
  fmt,
} from '../admin-core.js';
import * as orders from './billing-orders.js';
import * as coupons from './billing-coupons.js';

const state = { plans: [], tenants: [] };

function shellHTML() {
  return `<div class="page-head">
    <div class="ph-main">
      <h1>订阅与计费</h1>
      <p class="page-sub">套餐定义、订单登记、优惠码。当前为人工开通模式，支付网关尚未接入。</p>
    </div>
    <div class="ph-actions">
      <button class="btn sm" id="b-refresh" type="button">刷新</button>
    </div>
  </div>

  <div class="callout info mb-16">
    <b>人工开通与对账口径</b>
    <p class="muted small mt-8">
      订单金额以「元」录入、按「分」存储。新建「已支付」订单会立即把套餐配额应用到租户；
      退款只登记状态，不会自动回收配额。支付网关 webhook、发票与自动续费仍未接入。
    </p>
  </div>

  <div class="card mb-16">
    <div class="card-head">
      <h2>套餐定义</h2>
      <span class="chip" id="p-count">—</span>
      <div class="grow"></div>
      <button class="btn sm primary" id="p-new" type="button">新建套餐</button>
    </div>
    <div id="p-list">${ui.loading('正在加载套餐…')}</div>
    <p class="hint mt-16">套餐是租户 plan 字段的来源；修改配额不会自动下发，需在租户详情页「应用套餐」。</p>
  </div>

  <div class="card mb-16" id="orders-section"></div>
  <div class="card" id="coupons-section"></div>`;
}

function planRow(p) {
  return `<tr>
    <td>${planBadge(p.code)}</td>
    <td>${ui.esc(p.name || '—')}</td>
    <td class="num"><b>${fmt.money(p.price_cents)}</b></td>
    <td class="num">${fmt.num(p.period_days)} 天</td>
    <td class="num">${fmt.num(p.sku_quota)}</td>
    <td class="num">${fmt.num(p.export_quota)}</td>
    <td>${toneBadge(p.active ? 'good' : 'muted', p.active ? '启用' : '停用')}</td>
    <td class="num">${fmt.num(p.sort)}</td>
    <td class="shrink"><button class="btn sm ghost" data-edit="${ui.esc(p.code)}" type="button">编辑</button></td>
  </tr>`;
}

function plansHTML(items) {
  if (!items.length) {
    return ui.empty({
      icon: '◫',
      title: '还没有套餐定义',
      sub: '后端会在启动时写入默认套餐；如果为空，可手动新建。',
      action: '<button class="btn sm mt-8" data-new>新建套餐</button>',
    });
  }
  return `<div class="table-wrap"><table class="table dense">
    <thead><tr>
      <th>套餐</th><th>名称</th><th class="right">价格</th><th class="right">周期</th>
      <th class="right">SKU 配额</th><th class="right">导出配额</th><th>状态</th><th class="right">排序</th><th class="shrink"></th>
    </tr></thead>
    <tbody>${items.map(planRow).join('')}</tbody>
  </table></div>`;
}

function planForm(p) {
  const editing = !!p;
  return `<div class="grid two" style="gap:12px">
      <div class="field">
        <label for="pf-code">套餐编码</label>
        <input class="input" id="pf-code" maxlength="32" value="${editing ? ui.esc(p.code) : ''}"
          ${editing ? 'disabled' : ''} placeholder="如 team" />
        <span class="hint">租户 plan 字段引用该编码，创建后不可改。</span>
      </div>
      <div class="field">
        <label for="pf-name">展示名称</label>
        <input class="input" id="pf-name" maxlength="80" value="${editing ? ui.esc(p.name || '') : ''}" placeholder="如 团队版" />
      </div>
      <div class="field">
        <label for="pf-price">价格（元）</label>
        <input class="input" id="pf-price" type="number" min="0" step="0.01"
          value="${editing ? centsToYuan(p.price_cents) : '0.00'}" />
      </div>
      <div class="field">
        <label for="pf-period">周期（天）</label>
        <input class="input" id="pf-period" type="number" min="1" step="1" value="${editing ? Number(p.period_days) || 30 : 30}" />
      </div>
      <div class="field">
        <label for="pf-sku">SKU 配额</label>
        <input class="input" id="pf-sku" type="number" min="0" step="1" value="${editing ? Number(p.sku_quota) || 0 : 0}" />
      </div>
      <div class="field">
        <label for="pf-export">导出配额</label>
        <input class="input" id="pf-export" type="number" min="0" step="1" value="${editing ? Number(p.export_quota) || 0 : 0}" />
      </div>
      <div class="field">
        <label for="pf-sort">排序</label>
        <input class="input" id="pf-sort" type="number" step="1" value="${editing ? Number(p.sort) || 0 : 0}" />
      </div>
      <div class="field">
        <label>状态</label>
        <label class="check-line"><input type="checkbox" id="pf-active" ${editing ? (p.active ? 'checked' : '') : 'checked'} /> 启用该套餐</label>
      </div>
    </div>
    <div class="field">
      <label for="pf-features">功能说明</label>
      <input class="input" id="pf-features" maxlength="255" value="${editing ? ui.esc(p.features || '') : ''}" placeholder="可选，显示给运营参考" />
    </div>`;
}

async function openPlanForm(p, reload) {
  const m = ui.modal({
    title: p ? `编辑套餐 ${p.code}` : '新建套餐',
    wide: true,
    body: planForm(p),
    footer: [
      { label: '取消', kind: 'ghost', onClick: (close) => close() },
      {
        label: '保存',
        kind: 'primary',
        onClick: async (close) => {
          const el = m.body;
          const code = el.querySelector('#pf-code').value.trim();
          const name = el.querySelector('#pf-name').value.trim();
          const price = yuanToCents(el.querySelector('#pf-price').value || 0);
          const period = Number(el.querySelector('#pf-period').value || 0);
          const sku = Number(el.querySelector('#pf-sku').value || 0);
          const exp = Number(el.querySelector('#pf-export').value || 0);
          const sort = Number(el.querySelector('#pf-sort').value || 0);
          const features = el.querySelector('#pf-features').value.trim();
          const active = el.querySelector('#pf-active').checked;

          if (!code) return ui.toast('请填写套餐编码', 'bad');
          if (!name) return ui.toast('请填写展示名称', 'bad');
          if (![period, sku, exp, sort].every((n) => Number.isInteger(n) && n >= 0)) {
            return ui.toast('周期与配额必须是非负整数', 'bad');
          }
          if (period < 1) return ui.toast('周期至少 1 天', 'bad');

          const payload = {
            code,
            name,
            price_cents: price,
            period_days: period,
            sku_quota: sku,
            export_quota: exp,
            sort,
            active,
            features,
          };

          const btn = m.el.querySelectorAll('.modal-foot .btn')[1];
          btn.disabled = true;
          btn.textContent = '保存中…';
          try {
            if (p) await adminApi.patch(`/v1/admin/plans/${encodeURIComponent(p.code)}`, payload);
            else await adminApi.post('/v1/admin/plans', payload);
            close();
            ui.toast(p ? '套餐已更新' : '套餐已创建', 'good');
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

  const list = $('#p-list');
  $('#b-refresh').onclick = () => location.reload();

  async function loadPlans() {
    list.innerHTML = ui.loading('正在加载套餐…');
    try {
      const data = await adminApi.get('/v1/admin/plans');
      state.plans = data.items || [];
      renderPlans();
    } catch (err) {
      list.innerHTML = errorHTML(err);
      bindRetry(list, loadPlans);
    }
  }

  function renderPlans() {
    list.innerHTML = plansHTML(state.plans);
    $('#p-count').textContent = `共 ${fmt.num(state.plans.length)} 个`;
    bindRetry(list, loadPlans);

    list.querySelector('[data-new]')?.addEventListener('click', () => openPlanForm(null, loadPlans));
    list.querySelectorAll('[data-edit]').forEach((b) => {
      b.onclick = () => {
        const p = state.plans.find((x) => x.code === b.dataset.edit);
        if (p) openPlanForm(p, loadPlans);
      };
    });
  }

  async function loadTenants() {
    try {
      const data = await adminApi.get('/v1/admin/tenants');
      state.tenants = data.items || [];
    } catch {
      state.tenants = [];
    }
  }

  $('#p-new').onclick = () => openPlanForm(null, loadPlans);

  await Promise.all([loadPlans(), loadTenants()]);

  const ctx = { tenants: state.tenants, plans: state.plans };
  await orders.loadInto($('#orders-section'), ctx);
  await coupons.loadInto($('#coupons-section'));
}
