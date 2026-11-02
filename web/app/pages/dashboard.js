/* 工作台总览：配额、成本、待审、最近任务与启动清单。 */

import { api, ui, session } from '../../assets/core.js';
import { setCrumb } from '../shell.js';
import {
  pageHead, loadUsage, loadJobs, loadProjects, loadSKUs, jobRowHTML,
  templateChip, connectEvents,
} from '../common.js';

let off = null;

export async function render({ root }) {
  if (off) { off(); off = null; }
  setCrumb(['工作台', '总览']);
  root.innerHTML = ui.loading('正在汇总工作区数据…');

  let usage, jobs, projects, skus;
  try {
    [usage, jobs, projects, skus] = await Promise.all([
      loadUsage(), loadJobs(), loadProjects(), loadSKUs(),
    ]);
  } catch (err) {
    root.innerHTML = ui.empty({
      icon: '⚠', title: '加载失败', sub: err.message,
      action: '<button class="btn sm mt-8" id="d-retry">重试</button>',
    });
    const b = document.getElementById('d-retry');
    if (b) b.onclick = () => render({ root });
    return;
  }

  const skuMap = Object.fromEntries(skus.map((s) => [s.id, s]));
  const pending = jobs.filter((j) => j.status === 'succeeded' && j.review_status === 'pending');
  const failed = jobs.filter((j) => j.status === 'failed');
  const recent = jobs.slice(0, 6);
  const ws = session.ws || {};
  const user = session.user || {};
  const projectMap = Object.fromEntries(projects.map((p) => [p.id, p]));

  const onboarding = skus.length === 0 ? `
    <section class="card mb-24">
      <div class="card-head"><h2>开始你的第一条生产链路</h2>
        <span class="badge accent no-dot">4 步</span></div>
      <div class="grid four">
        ${onboardStep(1, '建项目', '按站点或品类拆分', projects.length > 0, '#/projects')}
        ${onboardStep(2, '建 SKU', '一个商品一个 SKU', false, '#/projects')}
        ${onboardStep(3, '上传实拍图', '自动压缩后入库', false, '#/projects')}
        ${onboardStep(4, '生成并审核', '通过后导出 ZIP', false, '#/review')}
      </div>
    </section>` : '';

  root.innerHTML = `
    ${pageHead({
      title: `你好，${user.name || user.email || '创作者'}`,
      sub: `${ws.name || '工作区'} · ${ui.label(ws.plan)} · 角色 ${ui.label(ws.role)}`,
      actions: `
        <a class="btn" href="#/projects">项目与素材</a>
        <a class="btn primary" href="#/review">审核队列${pending.length ? ` · ${pending.length}` : ''}</a>`,
    })}
    ${onboarding}
    <div class="grid four mb-24">
      ${kpi('SKU 用量', `${usage.sku_used}/${usage.sku_quota}`, usage.sku_used >= usage.sku_quota ? '配额已用完，需升级' : '按租户配额计')}
      ${kpi('高清导出', `${usage.export_used}/${usage.export_quota}`, '每次导出扣 1 次')}
      ${kpi('累计成本', ui.fmt.cents(usage.cost_cents), '生成与导出流水合计')}
      ${kpi('待审核', String(pending.length), failed.length ? `${failed.length} 个任务失败` : '审核通过后才能导出', pending.length ? 'warn' : '')}
    </div>
    <div class="grid two">
      <section class="card">
        <div class="card-head"><h2>最近生成任务</h2>
          <a class="btn sm ghost" href="#/jobs">全部</a></div>
        ${recent.length ? `<div class="table-wrap"><table class="table">
          <thead><tr><th>SKU</th><th>模板</th><th>状态</th><th>进度 / 错误</th></tr></thead>
          <tbody>${recent.map((j) => `
            <tr>
              <td><a class="mono" href="#/skus/${j.sku_id}">${ui.esc(skuMap[j.sku_id] ? skuMap[j.sku_id].code : j.sku_id.slice(0, 8))}</a></td>
              <td>${templateChip(j.template)}</td>
              <td>${ui.badge(j.status)}</td>
              <td class="small muted truncate" style="max-width:220px">${j.status === 'running' || j.status === 'queued'
                ? `<div class="progress" style="width:120px"><i style="width:${j.progress || 0}%"></i></div>`
                : ui.esc(j.error || (j.status === 'succeeded' ? '已完成，等待审核' : '—'))}</td>
            </tr>`).join('')}</tbody>
        </table></div>` : ui.empty({ icon: '⚙', title: '还没有生成任务', sub: '打开一个 SKU，上传素材后发起生成。', action: '<a class="btn sm mt-8" href="#/projects">去项目</a>' })}
      </section>
      <section class="card">
        <div class="card-head"><h2>待审核结果</h2>
          <a class="btn sm ghost" href="#/review">处理</a></div>
        ${pending.length ? `<div class="col">
          ${pending.slice(0, 4).map((j) => `<div class="row between card pad-sm" style="background:var(--panel-2)">
            <div class="grow" style="min-width:0">
              <div class="small truncate"><b>${ui.esc(skuMap[j.sku_id] ? skuMap[j.sku_id].code : j.sku_id.slice(0, 8))}</b> · ${ui.esc(templateChip(j.template).replace(/<[^>]+>/g, ''))}</div>
              <div class="muted small">${ui.esc(ui.fmt.ago(j.updated_at || j.created_at))} 完成</div>
            </div>
            <a class="btn sm" href="#/skus/${j.sku_id}">查看</a>
          </div>`).join('')}
        </div>` : ui.empty({ icon: '✓', title: '没有待审核结果', sub: '生成完成的结果会出现在这里。' })}
      </section>
    </div>`;

  // 项目清单（有 SKU 后展示）
  if (projects.length) {
    const sec = document.createElement('section');
    sec.className = 'card mt-24';
    sec.innerHTML = `<div class="card-head"><h2>项目</h2><a class="btn sm ghost" href="#/projects">管理</a></div>
      <div class="grid three">
        ${projects.slice(0, 3).map((p) => {
          const count = skus.filter((s) => s.project_id === p.id).length;
          return `<a class="card pad-sm" href="#/projects/${p.id}" style="text-decoration:none;color:inherit">
            <div class="row between"><b>${ui.esc(p.name)}</b><span class="chip">${ui.esc(p.platform)}</span></div>
            <div class="muted small mt-8">${count} 个 SKU · ${ui.esc(p.category || '未设品类')}</div>
          </a>`;
        }).join('')}
      </div>`;
    root.appendChild(sec);
  }

  off = connectEvents(() => {
    // 任务状态变化时静默刷新一次
    if (document.getElementById('page') && location.hash === '#/') render({ root });
  });
  window.addEventListener('hashchange', () => { if (off) { off(); off = null; } }, { once: true });

  function kpi(label, value, note, tone) {
    return `<div class="kpi"><div class="k-label">${ui.esc(label)}</div>
      <div class="k-value" ${tone === 'warn' ? 'style="color:var(--warn)"' : ''}>${ui.esc(value)}</div>
      <div class="k-note">${ui.esc(note)}</div></div>`;
  }

  function onboardStep(n, title, sub, done, href) {
    return `<a class="card pad-sm" href="${href}" style="text-decoration:none;color:inherit;border-color:${done ? 'rgba(55,201,139,.4)' : 'var(--line-soft)'}">
      <div class="row between"><span class="badge ${done ? 'good' : 'muted'} no-dot">${done ? '已完成' : `第 ${n} 步`}</span></div>
      <div class="mt-8"><b>${ui.esc(title)}</b></div>
      <div class="muted small">${ui.esc(sub)}</div>
    </a>`;
  }
}
