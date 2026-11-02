/* 失败任务：#/jobs
 * 列表 + 单条重试 + 刷新。重试由后端重置为 queued 且不重复扣减额度。
 */

import { ui, $, $$, debounce } from '../../assets/core.js';
import { adminApi, errorHTML, bindRetry, confirmAction, setNavCount, fmt } from '../admin-core.js';

const state = { items: [], keyword: '', tenants: new Map(), lastLoaded: 0 };

const TEMPLATE_LABEL = { main: '主图', scene: '场景图', selling_point: '卖点图' };

function shellHTML() {
  return `<div class="page-head">
    <div class="ph-main">
      <h1>失败任务</h1>
      <p class="page-sub" id="j-summary">加载中…</p>
    </div>
    <div class="ph-actions">
      <button class="btn sm" id="j-refresh" type="button">刷新</button>
    </div>
  </div>

  <div class="toolbar">
    <div class="tb-search">
      <span class="tb-icon">⌕</span>
      <input class="input" id="j-search" type="search" placeholder="搜索任务 ID 或租户名" autocomplete="off" />
    </div>
    <div class="grow"></div>
    <span class="chip" id="j-count">—</span>
    <span class="chip" id="j-fetched">—</span>
  </div>

  <div id="j-list">${ui.loading('正在加载失败任务…')}</div>

  <p class="hint mt-16">重试会把任务状态重置为“排队中”、清空错误与进度、尝试次数归零，不会再次扣减用户额度。</p>`;
}

function tenantLabel(id) {
  const t = state.tenants.get(id);
  if (t) return `<div class="cell-title">${ui.esc(t.name)}</div><div class="mono muted small">${ui.esc(t.slug || fmt.shortId(id))}</div>`;
  return `<span class="mono">${fmt.shortId(id)}</span>`;
}

function rowHTML(j) {
  return `<tr data-id="${ui.esc(j.id)}">
    <td>
      <div class="mono">${fmt.shortId(j.id, 10)}</div>
      <div class="muted small">${ui.fmt.dt(j.created_at)}</div>
    </td>
    <td>${tenantLabel(j.workspace_id)}</td>
    <td><span class="chip">${TEMPLATE_LABEL[j.template] || ui.esc(j.template || '—')}</span></td>
    <td class="num">${fmt.num(j.attempts)}</td>
    <td><div class="err-text" title="${ui.esc(j.error || '')}">${ui.esc(j.error || '—')}</div></td>
    <td class="muted small">${ui.fmt.ago(j.updated_at)}</td>
    <td class="shrink"><button class="btn sm" data-retry-job="${ui.esc(j.id)}" type="button">重试</button></td>
  </tr>`;
}

function filtered() {
  const k = state.keyword.toLowerCase();
  if (!k) return state.items;
  return state.items.filter((j) => {
    const t = state.tenants.get(j.workspace_id);
    return (
      String(j.id).toLowerCase().includes(k) ||
      String(j.workspace_id).toLowerCase().includes(k) ||
      (t && (t.name.toLowerCase().includes(k) || (t.slug || '').toLowerCase().includes(k)))
    );
  });
}

function listHTML(items) {
  if (!items.length) {
    return ui.empty({
      icon: '✓',
      title: state.items.length ? '没有匹配的失败任务' : '当前没有失败任务',
      sub: state.items.length
        ? '换个关键词试试，或清空搜索。'
        : '队列是干净的。任务失败后会出现在这里，可单条重试。',
      action: state.items.length
        ? '<button class="btn sm mt-8" data-clear>清空搜索</button>'
        : '<button class="btn sm mt-8" data-reload>刷新</button>',
    });
  }
  return `<div class="table-wrap"><table class="table dense">
    <thead><tr>
      <th>任务</th><th>租户</th><th>模板</th><th class="right">尝试</th>
      <th>失败原因</th><th>最近更新</th><th class="shrink"></th>
    </tr></thead>
    <tbody>${items.map(rowHTML).join('')}</tbody>
  </table></div>`;
}

export async function page({ root }) {
  root.innerHTML = shellHTML();

  const list = $('#j-list');
  const search = $('#j-search');
  const countEl = $('#j-count');
  const fetchedEl = $('#j-fetched');
  const summary = $('#j-summary');

  $('#j-refresh').onclick = () => load();
  search.oninput = debounce(() => {
    state.keyword = search.value.trim();
    render();
  }, 200);

  async function load() {
    list.innerHTML = ui.loading('正在加载失败任务…');
    summary.textContent = '加载中…';
    countEl.textContent = '—';

    // 租户名映射失败不影响任务列表本身。
    const tenantsPromise = adminApi
      .get('/v1/admin/tenants')
      .then((d) => {
        state.tenants = new Map((d.items || []).map((t) => [t.id, t]));
      })
      .catch(() => {
        state.tenants = new Map();
      });

    try {
      const [data] = await Promise.all([adminApi.get('/v1/admin/jobs/failed'), tenantsPromise]);
      state.items = data.items || [];
      state.lastLoaded = Date.now();
      render();
    } catch (err) {
      summary.textContent = '加载失败';
      countEl.textContent = '—';
      list.innerHTML = errorHTML(err);
      bindRetry(list, load);
    }
  }

  function render() {
    const items = filtered();
    list.innerHTML = listHTML(items);
    countEl.textContent = `失败 ${fmt.num(state.items.length)} 条`;
    setNavCount('jobs', state.items.length);
    fetchedEl.textContent = state.lastLoaded ? `更新于 ${ui.fmt.time(state.lastLoaded)}` : '—';
    summary.textContent = state.items.length
      ? `按最近更新时间倒序，最多展示 100 条；当前 ${fmt.num(state.items.length)} 条。`
      : '按最近更新时间倒序，最多展示 100 条。';

    list.querySelector('[data-clear]')?.addEventListener('click', () => {
      state.keyword = '';
      search.value = '';
      render();
    });
    list.querySelector('[data-reload]')?.addEventListener('click', () => load());

    $$('[data-retry-job]', list).forEach((btn) => {
      btn.onclick = () => retry(btn.dataset.retryJob, btn);
    });
  }

  async function retry(id, btn) {
    const job = state.items.find((j) => j.id === id);
    if (!job) return;
    const t = state.tenants.get(job.workspace_id);
    const ok = await confirmAction({
      title: '确认重试任务',
      message: `将任务 ${fmt.shortId(id, 10)} 重新排入队列${
        t ? `（租户「${t.name}」）` : ''
      }。`,
      confirmLabel: '重新排队',
      html: `<p class="hint mt-8">不会再次扣减额度；若再次失败会回到本列表。</p>`,
    });
    if (!ok) return;

    btn.disabled = true;
    btn.textContent = '重试中…';
    try {
      await adminApi.post(`/v1/admin/jobs/${encodeURIComponent(id)}/retry`);
      state.items = state.items.filter((j) => j.id !== id);
      render();
      ui.toast('已重新排队', 'good');
    } catch (err) {
      btn.disabled = false;
      btn.textContent = '重试';
      ui.toast(err.message || '重试失败', 'bad');
    }
  }

  await load();
}
