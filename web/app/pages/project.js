/* 项目详情：文件夹树 + SKU 列表 */

import { api, ui } from '../../assets/core.js';
import { setCrumb } from '../shell.js';
import {
  pageHead, loadProjects, loadFolders, loadSKUs,
  openCreateFolder, openCreateSKU,
} from '../common.js';

export async function render({ params, root }) {
  root.innerHTML = ui.loading();
  let projects, folders, skus;
  try {
    [projects, folders, skus] = await Promise.all([
      loadProjects(), loadFolders(params.id), loadSKUs(params.id),
    ]);
  } catch (err) {
    root.innerHTML = ui.empty({ icon: '⚠', title: '加载失败', sub: err.message });
    return;
  }
  const project = projects.find((p) => p.id === params.id);
  if (!project) {
    root.innerHTML = ui.empty({ icon: '404', title: '项目不存在', sub: '可能已被删除，或你没有访问权限。' });
    return;
  }
  setCrumb(['工作台', `<a href="#/projects">项目</a>`, project.name]);

  let activeFolder = '';
  let keyword = '';

  const childrenOf = (id) => folders.filter((f) => (f.parent_id || '') === id);
  const topFolders = childrenOf('');

  root.innerHTML = `
    ${pageHead({
      title: project.name,
      sub: `${project.platform} · ${project.category || '未设品类'} · ${skus.length} 个 SKU`,
      actions: `
        <button class="btn" id="new-folder">+ 文件夹</button>
        <button class="btn primary" id="new-sku">+ 新建 SKU</button>`,
    })}
    <div style="display:grid;grid-template-columns:240px minmax(0,1fr);gap:18px" class="project-layout">
      <aside class="card pad-sm" style="align-self:start">
        <div class="row between mb-8"><b class="small">文件夹</b>
          <span class="muted small">${folders.length}</span></div>
        <div class="tree" id="folder-tree"></div>
      </aside>
      <section>
        <div class="row mb-16">
          <input class="input" id="sku-search" placeholder="搜索 SKU 编码或标题" style="max-width:320px">
          <span class="muted small" id="sku-count"></span>
        </div>
        <div id="sku-list"></div>
      </section>
    </div>`;

  const treeEl = document.getElementById('folder-tree');
  const listEl = document.getElementById('sku-list');

  function descendants(id) {
    const out = [id];
    childrenOf(id).forEach((c) => out.push(...descendants(c.id)));
    return out;
  }

  function renderTree() {
    const items = [`<div class="tree-item ${activeFolder === '' ? 'active' : ''}" data-folder="">
      <span>▤</span><span class="grow">全部 SKU</span><span class="count">${skus.length}</span></div>`];
    const renderLevel = (nodes, depth) => {
      nodes.forEach((f) => {
        const ids = descendants(f.id);
        const count = skus.filter((s) => ids.includes(s.folder_id)).length;
        items.push(`<div class="tree-item ${depth ? 'child' : ''} ${activeFolder === f.id ? 'active' : ''}" data-folder="${f.id}">
          <span>${depth ? '└' : '▸'}</span><span class="grow truncate">${ui.esc(f.name)}</span><span class="count">${count}</span></div>`);
        renderLevel(childrenOf(f.id), depth + 1);
      });
    };
    renderLevel(topFolders, 0);
    if (!topFolders.length) {
      items.push('<div class="muted small" style="padding:10px">还没有文件夹，可直接建 SKU 或先建批次。</div>');
    }
    treeEl.innerHTML = items.join('');
    treeEl.querySelectorAll('[data-folder]').forEach((el) => {
      el.onclick = () => {
        activeFolder = el.dataset.folder;
        renderTree();
        renderList();
      };
    });
  }

  const folderName = (id) => {
    const f = folders.find((x) => x.id === id);
    return f ? f.name : '未归档';
  };

  function renderList() {
    let rows = skus;
    if (activeFolder) {
      const ids = descendants(activeFolder);
      rows = rows.filter((s) => ids.includes(s.folder_id));
    }
    if (keyword) {
      const k = keyword.toLowerCase();
      rows = rows.filter((s) => (s.code + ' ' + (s.title || '')).toLowerCase().includes(k));
    }
    const countEl = document.getElementById('sku-count');
    if (countEl) countEl.textContent = `${rows.length} 个 SKU`;

    if (!skus.length) {
      listEl.innerHTML = ui.empty({
        icon: '◫',
        title: '这个项目还没有 SKU',
        sub: '一个 SKU 对应一个商品；创建后上传实拍图即可生成主图与场景图。',
        action: '<button class="btn sm mt-8" id="empty-new-sku">新建 SKU</button>',
      });
      const b = document.getElementById('empty-new-sku');
      if (b) b.onclick = () => openSKU();
      return;
    }
    if (!rows.length) {
      listEl.innerHTML = ui.empty({ icon: '⌕', title: '没有匹配的 SKU', sub: '换个关键词或切换文件夹。' });
      return;
    }

    listEl.innerHTML = `<div class="table-wrap"><table class="table">
      <thead><tr><th>SKU 编码</th><th>标题</th><th>文件夹</th><th>创建时间</th><th class="shrink"></th></tr></thead>
      <tbody>${rows.map((s) => `<tr>
        <td><a class="mono" href="#/skus/${s.id}">${ui.esc(s.code)}</a></td>
        <td class="truncate" style="max-width:320px">${ui.esc(s.title || '—')}</td>
        <td><span class="chip">${ui.esc(folderName(s.folder_id))}</span></td>
        <td class="muted small">${ui.esc(ui.fmt.date(s.created_at))}</td>
        <td class="shrink"><a class="btn sm" href="#/skus/${s.id}">打开</a></td>
      </tr>`).join('')}</tbody>
    </table></div>`;
  }

  const openSKU = () => openCreateSKU({
    projectId: project.id,
    folders: topFolders.concat(topFolders.flatMap((f) => childrenOf(f.id))),
    folderId: activeFolder,
    onDone: (created) => {
      if (created) location.hash = `#/skus/${created.id}`;
      else render({ params, root });
    },
  });

  document.getElementById('new-folder').onclick = () => openCreateFolder({
    projectId: project.id,
    parentId: activeFolder || '',
    onDone: () => render({ params, root }),
  });
  document.getElementById('new-sku').onclick = openSKU;
  document.getElementById('sku-search').oninput = (e) => {
    keyword = e.target.value.trim();
    renderList();
  };

  renderTree();
  renderList();

  const onNew = () => {
    if (location.hash !== `#/projects/${project.id}`) return;
    openSKU();
  };
  window.addEventListener('dk:new-sku', onNew);
  window.addEventListener('hashchange', () => window.removeEventListener('dk:new-sku', onNew), { once: true });
}
