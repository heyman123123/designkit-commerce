/* 租户详情：#/tenants/:id
 * 基本信息 / 用量 / 套餐与配额编辑 / 暂停恢复（全部二次确认）。
 */

import { ui, $ } from '../../assets/core.js';
import {
  adminApi,
  errorHTML,
  bindRetry,
  confirmAction,
  planBadge,
  statusBadge,
  quotaCell,
  setCrumb,
  fmt,
} from '../admin-core.js';

const PLANS = [
  ['free', '免费版'],
  ['starter', '入门版'],
  ['growth', '成长版'],
  ['pro', '专业版'],
];

const EDITABLE_STATUS = [
  ['active', '正常'],
  ['readonly', '只读'],
];

/** 暂停/删除等状态不在可编辑列表里，但必须保留当前值，避免保存其他字段时被改回 active。 */
function statusOptions(current) {
  const opts = EDITABLE_STATUS.slice();
  if (!opts.some(([v]) => v === current)) opts.push([current, `${ui.label(current)}（当前）`]);
  return opts;
}

let current = null;

function infoRow(label, valueHTML) {
  return `<div class="info-row"><div class="ir-label">${label}</div><div class="ir-value">${valueHTML}</div></div>`;
}

function detailHTML(d) {
  const ws = d.workspace || {};
  const suspended = ws.status === 'suspended';
  const trial = ws.trial_ends_at ? ui.fmt.date(ws.trial_ends_at) : '未设置';

  return `<div class="page-head">
    <div class="ph-main">
      <a class="back-link" href="#/tenants">← 租户列表</a>
      <div class="row wrap" style="gap:10px">
        <h1>${ui.esc(ws.name || '—')}</h1>
        ${planBadge(ws.plan)}
        ${statusBadge(ws.status)}
      </div>
      <p class="page-sub mono">${ui.esc(ws.slug || '—')} · ${ui.esc(ws.id || '—')}</p>
    </div>
    <div class="ph-actions">
      <button class="btn sm" id="d-refresh" type="button">刷新</button>
      <button class="btn sm ${suspended ? '' : 'danger'}" id="d-suspend" type="button">
        ${suspended ? '恢复租户' : '暂停租户'}
      </button>
    </div>
  </div>

  <div class="grid four mb-16">
    <div class="kpi">
      <div class="k-label">SKU 用量</div>
      <div class="k-value">${fmt.num(ws.sku_used)}<span class="k-of"> / ${ws.sku_quota ? fmt.num(ws.sku_quota) : '未设置'}</span></div>
      ${quotaCell(ws.sku_used, ws.sku_quota)}
    </div>
    <div class="kpi">
      <div class="k-label">导出用量</div>
      <div class="k-value">${fmt.num(ws.export_used)}<span class="k-of"> / ${ws.export_quota ? fmt.num(ws.export_quota) : '未设置'}</span></div>
      ${quotaCell(ws.export_used, ws.export_quota)}
    </div>
    <div class="kpi">
      <div class="k-label">生成任务</div>
      <div class="k-value">${fmt.num(d.jobs)}</div>
      <div class="k-note">项目 ${fmt.num(d.projects)} · SKU ${fmt.num(d.skus)}</div>
    </div>
    <div class="kpi">
      <div class="k-label">累计成本</div>
      <div class="k-value">${fmt.money(d.cost_cents)}</div>
      <div class="k-note">usage_ledger 汇总</div>
    </div>
  </div>

  <div class="grid two">
    <div class="card">
      <div class="card-head"><h2>基本信息</h2>${statusBadge(ws.status)}</div>
      ${infoRow('租户 ID', `<span class="mono">${ui.esc(ws.id || '—')}</span>`)}
      ${infoRow('Slug', `<span class="mono">${ui.esc(ws.slug || '—')}</span>`)}
      ${infoRow('Owner', `<span class="small">${ui.esc(ws.owner_id || '—')}</span>`)}
      ${infoRow('成员数', `<b>${fmt.num(d.members)}</b> 人`)}
      ${infoRow('套餐', planBadge(ws.plan))}
      ${infoRow('创建时间', ui.fmt.dt(ws.created_at))}
      ${infoRow('最近更新', ui.fmt.dt(ws.updated_at))}
      ${infoRow('试用到期', trial)}
      <p class="hint mt-16">成员列表、Owner 邮箱重置等接口尚未接入，详情页暂只展示数量。</p>
    </div>

    <div class="card">
      <div class="card-head"><h2>套餐与配额</h2></div>
      <form id="d-form" novalidate>
        <div class="field">
          <label for="f-name">租户名称</label>
          <input class="input" id="f-name" value="${ui.esc(ws.name || '')}" maxlength="120" required />
        </div>
        <div class="grid two" style="gap:12px">
          <div class="field">
            <label for="f-plan">套餐</label>
            <select class="select" id="f-plan">
              ${PLANS.map(([v, l]) => `<option value="${v}" ${v === ws.plan ? 'selected' : ''}>${l}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label for="f-status">状态</label>
            <select class="select" id="f-status">
              ${statusOptions(ws.status)
                .map(([v, l]) => `<option value="${v}" ${v === ws.status ? 'selected' : ''}>${l}</option>`)
                .join('')}
            </select>
            <span class="hint">暂停请使用右上角“暂停租户”</span>
          </div>
          <div class="field">
            <label for="f-sku">SKU 配额</label>
            <input class="input" id="f-sku" type="number" min="0" step="1" value="${Number(ws.sku_quota) || 0}" />
          </div>
          <div class="field">
            <label for="f-export">导出配额</label>
            <input class="input" id="f-export" type="number" min="0" step="1" value="${Number(ws.export_quota) || 0}" />
          </div>
        </div>
        <div class="error-text hidden" id="d-error" role="alert"></div>
        <div class="row between mt-8">
          <span class="hint">修改会写入审计日志 admin.tenant.update</span>
          <button class="btn primary" id="d-save" type="submit">保存修改</button>
        </div>
      </form>
    </div>
  </div>

  <div class="card danger-zone mt-16">
    <div class="card-head">
      <h2>${suspended ? '恢复租户' : '危险操作'}</h2>
      <span class="badge ${suspended ? 'bad' : 'muted'} no-dot">${suspended ? '当前已暂停' : '影响租户可用性'}</span>
    </div>
    <p class="muted small">
      ${suspended
        ? '恢复后该租户成员立即可以继续写入、上传与导出。'
        : '暂停后该租户进入 suspended 状态，成员无法继续写入或导出；数据不会被删除，可随时恢复。'}
    </p>
    <button class="btn mt-8 ${suspended ? 'primary' : 'danger'}" id="d-suspend-2" type="button">
      ${suspended ? '恢复该租户' : '暂停该租户'}
    </button>
    <p class="hint mt-8">操作会记入审计日志（admin.tenant.suspend）。</p>
  </div>`;
}

function diffOf(ws, form) {
  const next = {
    name: form.name.trim(),
    plan: form.plan,
    status: form.status,
    sku_quota: Number(form.sku),
    export_quota: Number(form.export),
  };
  const diff = {};
  if (next.name && next.name !== ws.name) diff.name = next.name;
  if (next.plan !== ws.plan) diff.plan = next.plan;
  if (next.status !== ws.status) diff.status = next.status;
  if (next.sku_quota !== Number(ws.sku_quota)) diff.sku_quota = next.sku_quota;
  if (next.export_quota !== Number(ws.export_quota)) diff.export_quota = next.export_quota;
  return { diff, next };
}

const FIELD_LABEL = { name: '名称', plan: '套餐', status: '状态', sku_quota: 'SKU 配额', export_quota: '导出配额' };

function diffHTML(ws, diff) {
  const rows = Object.entries(diff)
    .map(([k, v]) => {
      const before = k === 'plan' ? ui.label(ws.plan) : k === 'status' ? ui.label(ws.status) : ws[k];
      const after = k === 'plan' ? ui.label(v) : k === 'status' ? ui.label(v) : v;
      return `<div class="diff-row"><span>${FIELD_LABEL[k] || k}</span>
        <code class="code-inline">${ui.esc(before)}</code><span class="muted">→</span>
        <code class="code-inline">${ui.esc(after)}</code></div>`;
    })
    .join('');
  return `<div class="diff-list">${rows}</div>`;
}

export async function page({ params, root }) {
  root.innerHTML = ui.loading('正在加载租户详情…');
  current = null;

  async function load() {
    try {
      const data = await adminApi.get(`/v1/admin/tenants/${encodeURIComponent(params.id)}`);
      current = data;
      render();
    } catch (err) {
      if (err.status === 404) {
        root.innerHTML = ui.empty({
          icon: '▤',
          title: '租户不存在',
          sub: '该租户可能已被删除，或 ID 不正确。',
          action: '<a class="btn sm mt-8" href="#/tenants">返回租户列表</a>',
        });
        return;
      }
      root.innerHTML = errorHTML(err);
      bindRetry(root, load);
    }
  }

  function render() {
    const d = current;
    const ws = d.workspace || {};
    root.innerHTML = detailHTML(d);
    setCrumb(
      `<a href="#/tenants">租户</a><span>/</span><b>${ui.esc(ws.name || fmt.shortId(ws.id))}</b>`,
    );

    $('#d-refresh').onclick = () => load();
    $('#d-suspend').onclick = () => toggleSuspend();
    $('#d-suspend-2').onclick = () => toggleSuspend();

    const form = $('#d-form');
    const errorEl = $('#d-error');
    form.onsubmit = async (e) => {
      e.preventDefault();
      errorEl.classList.add('hidden');

      const values = {
        name: $('#f-name').value,
        plan: $('#f-plan').value,
        status: $('#f-status').value,
        sku: $('#f-sku').value,
        export: $('#f-export').value,
      };

      if (!values.name.trim()) {
        errorEl.textContent = '租户名称不能为空';
        errorEl.classList.remove('hidden');
        return;
      }
      const skuQ = Number(values.sku);
      const expQ = Number(values.export);
      if (!Number.isInteger(skuQ) || skuQ < 0 || !Number.isInteger(expQ) || expQ < 0) {
        errorEl.textContent = '配额必须是非负整数';
        errorEl.classList.remove('hidden');
        return;
      }

      const { diff } = diffOf(ws, values);
      if (!Object.keys(diff).length) {
        ui.toast('没有需要保存的改动');
        return;
      }

      const ok = await confirmAction({
        title: '确认修改租户配置',
        message: `即将修改「${ws.name}」的以下字段：`,
        html: diffHTML(ws, diff),
        confirmLabel: '保存修改',
      });
      if (!ok) return;

      const btn = $('#d-save');
      btn.disabled = true;
      btn.textContent = '保存中…';
      try {
        await adminApi.patch(`/v1/admin/tenants/${encodeURIComponent(ws.id)}`, diff);
        ui.toast('已保存并写入审计日志', 'good');
        await load();
      } catch (err) {
        errorEl.textContent = err.message || '保存失败';
        errorEl.classList.remove('hidden');
        btn.disabled = false;
        btn.textContent = '保存修改';
      }
    };
  }

  async function toggleSuspend() {
    const ws = (current && current.workspace) || {};
    const suspended = ws.status === 'suspended';
    const ok = await confirmAction({
      title: suspended ? '确认恢复租户' : '确认暂停租户',
      message: suspended
        ? `恢复「${ws.name}」后，其成员可立即继续写入与导出。`
        : `暂停「${ws.name}」后，其成员将无法继续写入或导出。租户数据保留，可随时恢复。`,
      confirmLabel: suspended ? '恢复租户' : '暂停租户',
      danger: !suspended,
      html: `<p class="hint mt-8">此操作会记入审计日志，可在「审计日志」中查看。</p>`,
    });
    if (!ok) return;

    const btn = $('#d-suspend');
    if (btn) btn.disabled = true;
    try {
      const res = await adminApi.post(`/v1/admin/tenants/${encodeURIComponent(ws.id)}/suspend`);
      ui.toast(res.status === 'suspended' ? '租户已暂停' : '租户已恢复', 'good');
      await load();
    } catch (err) {
      ui.toast(err.message || '操作失败', 'bad');
      if (btn) btn.disabled = false;
    }
  }

  await load();
}
