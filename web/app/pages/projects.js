/* 项目列表 */

import { api, ui } from '../../assets/core.js';
import { setCrumb } from '../shell.js';
import { pageHead, loadProjects, loadSKUs, openCreateProject } from '../common.js';

export async function render({ root }) {
  setCrumb(['工作台', '项目与素材']);
  root.innerHTML = ui.loading();

  let projects, skus;
  try {
    [projects, skus] = await Promise.all([loadProjects(), loadSKUs()]);
  } catch (err) {
    root.innerHTML = ui.empty({ icon: '⚠', title: '加载失败', sub: err.message });
    return;
  }
  const counts = {};
  skus.forEach((s) => { counts[s.project_id] = (counts[s.project_id] || 0) + 1; });

  root.innerHTML = `
    ${pageHead({
      title: '项目与素材',
      sub: '项目按站点或品类拆分，SKU 是生产的最小单位。',
      actions: '<button class="btn primary" id="new-project">+ 新建项目</button>',
    })}
    ${projects.length ? `<div class="grid three">
      ${projects.map((p) => `
        <a class="card" href="#/projects/${p.id}" style="text-decoration:none;color:inherit">
          <div class="row between">
            <h3>${ui.esc(p.name)}</h3>
            <span class="chip">${ui.esc(p.platform)}</span>
          </div>
          <div class="muted small mt-8">${ui.esc(p.category || '未设品类')}</div>
          <div class="divider"></div>
          <div class="row between small">
            <span class="muted">${counts[p.id] || 0} 个 SKU</span>
            <span class="muted">${ui.esc(ui.fmt.date(p.created_at))}</span>
          </div>
        </a>`).join('')}
    </div>` : ui.empty({
      icon: '▤',
      title: '还没有项目',
      sub: '先建一个项目，例如「3C 配件 · 美国站」，再往里放 SKU。',
      action: '<button class="btn sm mt-8" id="empty-new-project">新建项目</button>',
    })}`;

  const openNew = () => openCreateProject(() => render({ root }));
  document.getElementById('new-project').onclick = openNew;
  const emptyBtn = document.getElementById('empty-new-project');
  if (emptyBtn) emptyBtn.onclick = openNew;
}
