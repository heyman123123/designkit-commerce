/* 审计日志：#/audit
 * 时间倒序（后端已排序，前端再兜底一次）+ 动作筛选 + 关键词 + 详情查看。
 */

import { ui, $, $$, debounce } from '../../assets/core.js';
import { adminApi, errorHTML, bindRetry, fmt } from '../admin-core.js';

const state = { items: [], action: '', keyword: '', page: 1, total: 0, size: 50 };

const ACTION_LABEL = {
  'admin.tenant.update': '调整租户',
  'admin.tenant.suspend': '暂停/恢复租户',
  'admin.job.retry': '重试任务',
};

function actionLabel(a) {
  return ACTION_LABEL[a] || a;
}

function shellHTML() {
  return `<div class="page-head">
    <div class="ph-main">
      <h1>审计日志</h1>
      <p class="page-sub">按时间倒序；支持按动作筛选与分页加载，后台操作标记来源为「管理员」。</p>
    </div>
    <div class="ph-actions"><button class="btn sm" id="a-refresh" type="button">刷新</button></div>
  </div>

  <div class="toolbar">
    <div class="tb-search">
      <span class="tb-icon">⌕</span>
      <input class="input" id="a-search" type="search" placeholder="搜索动作、对象或详情" autocomplete="off" />
    </div>
    <select class="select tb-select" id="a-action" aria-label="按动作筛选">
      <option value="">全部动作</option>
    </select>
    <div class="grow"></div>
    <span class="chip" id="a-count">—</span>
  </div>

  <div id="a-list">${ui.loading('正在加载审计日志…')}</div>

  <p class="hint mt-16">审计日志只读；动作筛选与分页由服务端完成，关键词在当前已加载记录内过滤。</p>`;
}

function rowHTML(it) {
  const actor = it.actor_id ? fmt.shortId(it.actor_id, 10) : '系统';
  const target = it.target ? String(it.target) : '';
  const hasMeta = !!(it.meta && String(it.meta).trim());
  return `<tr>
    <td class="nowrap">${ui.fmt.dt(it.created_at)}</td>
    <td>
      <code class="code-inline">${ui.esc(it.action || '—')}</code>
      <div class="muted small">${ui.esc(actionLabel(it.action))}</div>
    </td>
    <td>${target ? `<span class="mono" title="${ui.esc(target)}">${ui.esc(fmt.shortId(target, 12))}</span>` : '<span class="muted">—</span>'}</td>
    <td>${it.is_admin ? '<span class="badge accent no-dot">管理员</span>' : '<span class="badge muted no-dot">用户</span>'}</td>
    <td class="mono small">${ui.esc(actor)}</td>
    <td class="shrink">${hasMeta ? `<button class="btn sm ghost" data-meta="${ui.esc(it.id)}" type="button">查看</button>` : '<span class="muted small">—</span>'}</td>
  </tr>`;
}

function filtered() {
  const k = state.keyword.toLowerCase();
  return state.items
    .slice()
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .filter((it) => {
      if (state.action && it.action !== state.action) return false;
      if (!k) return true;
      return [it.action, it.target, it.meta, actionLabel(it.action)]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(k));
    });
}

function listHTML(items) {
  if (!items.length) {
    return ui.empty({
      icon: '≡',
      title: state.items.length ? '没有匹配的审计记录' : '暂无审计日志',
      sub: state.items.length
        ? '换个动作或关键词试试。'
        : '后台操作（调额、暂停、重试）与业务写操作都会写入这里。',
      action: state.items.length
        ? '<button class="btn sm mt-8" data-clear>清空筛选</button>'
        : '<button class="btn sm mt-8" data-reload>刷新</button>',
    });
  }
  const more = state.items.length < state.total
    ? `<div class="row mt-12" style="justify-content:center">
        <button class="btn sm" data-more type="button">加载更多（${fmt.num(state.items.length)} / ${fmt.num(state.total)}）</button>
      </div>`
    : '';
  return `<div class="table-wrap"><table class="table dense">
    <thead><tr>
      <th>时间</th><th>动作</th><th>对象</th><th>来源</th><th>操作者</th><th class="shrink"></th>
    </tr></thead>
    <tbody>${items.map(rowHTML).join('')}</tbody>
  </table></div>${more}`;
}

export async function page({ root }) {
  root.innerHTML = shellHTML();

  const list = $('#a-list');
  const search = $('#a-search');
  const actionSel = $('#a-action');
  const countEl = $('#a-count');

  if (state.keyword) search.value = state.keyword;

  $('#a-refresh').onclick = () => load();
  search.oninput = debounce(() => {
    state.keyword = search.value.trim();
    render();
  }, 200);
  actionSel.onchange = () => {
    state.action = actionSel.value;
    load({ reset: true });
  };

  async function load({ reset = true } = {}) {
    if (reset) {
      state.page = 1;
      list.innerHTML = ui.loading('正在加载审计日志…');
      countEl.textContent = '—';
    }
    try {
      const qs = new URLSearchParams({ page: String(state.page), size: String(state.size) });
      if (state.action) qs.set('action', state.action);
      const data = await adminApi.get(`/v1/admin/audit?${qs.toString()}`);
      const items = data.items || [];
      state.total = Number(data.total) || items.length;
      state.items = reset ? items : state.items.concat(items);
      if (reset) fillActions();
      render();
    } catch (err) {
      list.innerHTML = errorHTML(err);
      bindRetry(list, () => load({ reset: true }));
    }
  }

  // fillActions 用已加载记录里的动作做候选，另外补上已知动作，避免筛选后选项消失。
  function fillActions() {
    const counts = new Map();
    state.items.forEach((it) => counts.set(it.action, (counts.get(it.action) || 0) + 1));
    Object.keys(ACTION_LABEL).forEach((a) => { if (!counts.has(a)) counts.set(a, 0); });
    const current = state.action;
    actionSel.innerHTML =
      '<option value="">全部动作</option>' +
      Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([a, n]) => `<option value="${ui.esc(a)}">${ui.esc(actionLabel(a))}${n ? `（${n}）` : ''}</option>`)
        .join('');
    actionSel.value = counts.has(current) || current === '' ? current : '';
    state.action = actionSel.value;
  }

  function render() {
    const items = filtered();
    list.innerHTML = listHTML(items);
    countEl.textContent = `已加载 ${fmt.num(state.items.length)} / 共 ${fmt.num(state.total)} 条`;

    list.querySelector('[data-clear]')?.addEventListener('click', () => {
      state.keyword = '';
      state.action = '';
      search.value = '';
      actionSel.value = '';
      render();
    });
    list.querySelector('[data-reload]')?.addEventListener('click', () => load({ reset: true }));
    list.querySelector('[data-more]')?.addEventListener('click', (e) => {
      e.currentTarget.disabled = true;
      state.page += 1;
      load({ reset: false });
    });

    $$('[data-meta]', list).forEach((btn) => {
      btn.onclick = () => {
        const it = state.items.find((x) => x.id === btn.dataset.meta);
        if (!it) return;
        ui.modal({
          title: `审计详情 · ${actionLabel(it.action)}`,
          wide: true,
          body: `<div class="kv-list">
              <div class="info-row"><div class="ir-label">动作</div><div class="ir-value mono">${ui.esc(it.action || '—')}</div></div>
              <div class="info-row"><div class="ir-label">对象</div><div class="ir-value mono">${ui.esc(it.target || '—')}</div></div>
              <div class="info-row"><div class="ir-label">时间</div><div class="ir-value">${ui.fmt.dt(it.created_at)}</div></div>
              <div class="info-row"><div class="ir-label">操作者</div><div class="ir-value mono">${ui.esc(it.actor_id || '系统')}</div></div>
              <div class="info-row"><div class="ir-label">来源</div><div class="ir-value">${it.is_admin ? '平台管理员' : '用户'}</div></div>
            </div>
            <pre class="json-block">${ui.esc(fmt.json(it.meta) || '（无详情）')}</pre>`,
          footer: [{ label: '关闭', kind: 'ghost' }],
        });
      };
    });
  }

  await load();
}
