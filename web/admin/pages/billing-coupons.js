/* 优惠码区块（订阅页的一部分）：列表 / 新建 / 编辑 / 启停。
 * 接口：GET /v1/admin/coupons、POST /v1/admin/coupons、PATCH /v1/admin/coupons/{code}
 */

import { ui, $, debounce } from '../../assets/core.js';
import {
  adminApi,
  errorHTML,
  bindRetry,
  confirmAction,
  toneBadge,
  yuanToCents,
  centsToYuan,
  fmt,
} from '../admin-core.js';

const state = { items: [], keyword: '', active: '' };

export function shellHTML() {
  return `<div class="card-head">
      <h2>优惠码</h2>
      <span class="chip" id="cp-count">—</span>
      <div class="grow"></div>
      <button class="btn sm primary" id="cp-new" type="button">新建优惠码</button>
    </div>
    <div class="toolbar slim mb-16">
      <div class="tb-search">
        <span class="tb-icon">⌕</span>
        <input class="input" id="cp-search" type="search" placeholder="搜索优惠码或备注" autocomplete="off" />
      </div>
      <select class="select tb-select" id="cp-active" aria-label="按状态筛选">
        <option value="">全部状态</option>
        <option value="1">启用中</option>
        <option value="0">已停用</option>
      </select>
    </div>
    <div id="cp-list">${ui.loading('正在加载优惠码…')}</div>`;
}

function discountText(c) {
  if (Number(c.percent_off) > 0) return `${c.percent_off}%`;
  if (Number(c.amount_off_cents) > 0) return `${fmt.money(c.amount_off_cents)}`;
  return '—';
}

function rowHTML(c) {
  const used = Number(c.redeemed) || 0;
  const max = Number(c.max_redemptions) || 0;
  const expires = c.expires_at ? ui.fmt.date(c.expires_at) : '长期有效';
  return `<tr>
    <td><span class="mono">${ui.esc(c.code)}</span></td>
    <td><b>${discountText(c)}</b></td>
    <td class="num">${fmt.num(used)} / ${max ? fmt.num(max) : '不限'}</td>
    <td class="muted small">${ui.esc(expires)}</td>
    <td>${toneBadge(c.active ? 'good' : 'muted', c.active ? '启用中' : '已停用')}</td>
    <td class="muted small">${ui.esc(c.note || '—')}</td>
    <td class="shrink">
      <button class="btn sm ghost" data-edit="${ui.esc(c.code)}" type="button">编辑</button>
      <button class="btn sm ghost" data-toggle="${ui.esc(c.code)}" type="button">${c.active ? '停用' : '启用'}</button>
    </td>
  </tr>`;
}

function listHTML(items) {
  if (!items.length) {
    return ui.empty({
      icon: '◫',
      title: state.items.length ? '没有匹配的优惠码' : '还没有优惠码',
      sub: state.items.length ? '换个关键词或状态试试。' : '新建优惠码后，可用于人工开通与续费抵扣。',
      action: '<button class="btn sm mt-8" data-clear>清空筛选</button>',
    });
  }
  return `<div class="table-wrap"><table class="table dense">
    <thead><tr><th>优惠码</th><th>折扣</th><th class="right">已用/上限</th><th>到期</th><th>状态</th><th>备注</th><th class="shrink"></th></tr></thead>
    <tbody>${items.map(rowHTML).join('')}</tbody>
  </table></div>`;
}

function couponForm(c) {
  const editing = !!c;
  return `<div class="field">
      <label for="cf-code">优惠码</label>
      <input class="input" id="cf-code" maxlength="40" value="${editing ? ui.esc(c.code) : ''}"
        ${editing ? 'disabled' : ''} placeholder="如 SPRING20" />
      <span class="hint">保存时自动转为大写；创建后编码不可修改。</span>
    </div>
    <div class="grid two" style="gap:12px">
      <div class="field">
        <label for="cf-percent">折扣百分比（%）</label>
        <input class="input" id="cf-percent" type="number" min="0" max="100" step="1"
          value="${editing && Number(c.percent_off) ? c.percent_off : ''}" placeholder="20" />
      </div>
      <div class="field">
        <label for="cf-amount">固定减免（元）</label>
        <input class="input" id="cf-amount" type="number" min="0" step="0.01"
          value="${editing && Number(c.amount_off_cents) ? centsToYuan(c.amount_off_cents) : ''}" placeholder="50.00" />
      </div>
      <div class="field">
        <label for="cf-max">总可用次数</label>
        <input class="input" id="cf-max" type="number" min="0" step="1"
          value="${editing && Number(c.max_redemptions) ? c.max_redemptions : ''}" placeholder="0 = 不限" />
      </div>
      <div class="field">
        <label for="cf-days">有效天数</label>
        <input class="input" id="cf-days" type="number" min="1" step="1" placeholder="留空 = 长期有效" />
        <span class="hint">${editing ? '填写会重设到期时间' : '从今天起算'}</span>
      </div>
    </div>
    <div class="field">
      <label for="cf-note">备注</label>
      <input class="input" id="cf-note" maxlength="255" value="${editing ? ui.esc(c.note || '') : ''}" placeholder="用途说明，可选" />
    </div>
    <label class="check-line"><input type="checkbox" id="cf-active" ${editing ? (c.active ? 'checked' : '') : 'checked'} /> 启用该优惠码</label>`;
}

async function openForm(c, reload) {
  const m = ui.modal({
    title: c ? `编辑优惠码 ${c.code}` : '新建优惠码',
    body: couponForm(c),
    footer: [
      { label: '取消', kind: 'ghost', onClick: (close) => close() },
      {
        label: '保存',
        kind: 'primary',
        onClick: async (close) => {
          const el = m.body;
          const code = el.querySelector('#cf-code').value.trim().toUpperCase();
          const percent = Number(el.querySelector('#cf-percent').value || 0);
          const amount = yuanToCents(el.querySelector('#cf-amount').value || 0);
          const max = Number(el.querySelector('#cf-max').value || 0);
          const days = Number(el.querySelector('#cf-days').value || 0);
          const note = el.querySelector('#cf-note').value.trim();
          const active = el.querySelector('#cf-active').checked;

          if (!code) return ui.toast('请填写优惠码', 'bad');
          if (percent < 0 || percent > 100) return ui.toast('折扣百分比需在 0-100', 'bad');
          if (!percent && !amount) return ui.toast('请填写百分比或固定减免', 'bad');

          const payload = {
            code,
            percent_off: percent,
            amount_off_cents: amount,
            max_redemptions: max,
            active,
            note,
          };
          if (days > 0) payload.expires_in_days = days;

          const btn = m.el.querySelectorAll('.modal-foot .btn')[1];
          btn.disabled = true;
          btn.textContent = '保存中…';
          try {
            if (c) await adminApi.patch(`/v1/admin/coupons/${encodeURIComponent(c.code)}`, payload);
            else await adminApi.post('/v1/admin/coupons', payload);
            close();
            ui.toast(c ? '优惠码已更新' : '优惠码已创建', 'good');
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

export async function loadInto(el) {
  el.innerHTML = shellHTML();
  const list = $('#cp-list', el);

  $('#cp-new', el).onclick = () => openForm(null, load);
  const search = $('#cp-search', el);
  search.oninput = debounce(() => {
    state.keyword = search.value.trim().toLowerCase();
    render(el);
  }, 200);
  $('#cp-active', el).onchange = (e) => {
    state.active = e.target.value;
    render(el);
  };

  async function load() {
    list.innerHTML = ui.loading('正在加载优惠码…');
    try {
      const data = await adminApi.get('/v1/admin/coupons');
      state.items = data.items || [];
      render(el);
    } catch (err) {
      list.innerHTML = errorHTML(err);
      bindRetry(list, load);
    }
  }

  function render(container) {
    const items = state.items.filter((c) => {
      if (state.active === '1' && !c.active) return false;
      if (state.active === '0' && c.active) return false;
      if (!state.keyword) return true;
      return [c.code, c.note].filter(Boolean).some((v) => String(v).toLowerCase().includes(state.keyword));
    });

    list.innerHTML = listHTML(items);
    $('#cp-count', el).textContent = `${fmt.num(items.length)} / ${fmt.num(state.items.length)} 个`;
    bindRetry(list, load);

    list.querySelector('[data-clear]')?.addEventListener('click', () => {
      state.keyword = '';
      state.active = '';
      search.value = '';
      $('#cp-active', el).value = '';
      render(el);
    });

    list.querySelectorAll('[data-edit]').forEach((b) => {
      b.onclick = () => {
        const c = state.items.find((x) => x.code === b.dataset.edit);
        if (c) openForm(c, load);
      };
    });

    list.querySelectorAll('[data-toggle]').forEach((b) => {
      b.onclick = async () => {
        const c = state.items.find((x) => x.code === b.dataset.toggle);
        if (!c) return;
        const ok = await confirmAction({
          title: c.active ? '停用优惠码' : '启用优惠码',
          message: c.active ? `停用「${c.code}」后，新的订单将无法再使用它。` : `重新启用「${c.code}」。`,
          confirmLabel: c.active ? '停用' : '启用',
          danger: c.active,
        });
        if (!ok) return;
        try {
          await adminApi.patch(`/v1/admin/coupons/${encodeURIComponent(c.code)}`, {
            code: c.code,
            active: !c.active,
          });
          ui.toast(c.active ? '已停用' : '已启用', 'good');
          await load();
        } catch (err) {
          ui.toast(err.message || '操作失败', 'bad');
        }
      };
    });
  }

  await load();
  return load;
}
