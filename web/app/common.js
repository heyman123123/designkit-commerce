/* 工作台页面共用组件：页头、弹窗、任务状态、上传与生成流程。 */

import { api, ui, session } from '../../assets/core.js';

export const TPL = { main: '主图', scene: '场景图', selling_point: '卖点图' };
export const TEMPLATES = Object.keys(TPL);

export function pageHead({ title, sub = '', actions = '' }) {
  return `<div class="page-head">
    <div class="ph-main"><h1>${ui.esc(title)}</h1>${sub ? `<div class="page-sub">${ui.esc(sub)}</div>` : ''}</div>
    ${actions ? `<div class="ph-actions">${actions}</div>` : ''}
  </div>`;
}

export function jobBadge(job) {
  return ui.badge(job.status);
}

export function reviewBadge(job) {
  if (job.status !== 'succeeded') return ui.badge('muted', '—');
  return ui.badge(job.review_status);
}

export function templateChip(t) {
  return `<span class="chip">${ui.esc(TPL[t] || t)}</span>`;
}

export function errorState(message, retryId) {
  return ui.empty({
    icon: '⚠',
    title: '加载失败',
    sub: message,
    action: retryId ? `<button class="btn sm mt-8" id="${retryId}">重试</button>` : '',
  });
}

export function bindRetry(id, fn) {
  const b = document.getElementById(id);
  if (b) b.onclick = fn;
}

/* ---------------- 数据 ---------------- */

export async function loadProjects() {
  const data = await api.get(api.w('/projects'));
  return data.items || [];
}

export async function loadFolders(projectId) {
  const q = projectId ? `?project_id=${encodeURIComponent(projectId)}` : '';
  const data = await api.get(api.w('/folders') + q);
  return data.items || [];
}

export async function loadSKUs(projectId) {
  const q = projectId ? `?project_id=${encodeURIComponent(projectId)}` : '';
  const data = await api.get(api.w('/skus') + q);
  return data.items || [];
}

export async function loadJobs(params = {}) {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => { if (v) qs.set(k, v); });
  const data = await api.get(api.w('/jobs') + (qs.toString() ? `?${qs}` : ''));
  return data.items || [];
}

export async function loadAssets(params = {}) {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => { if (v) qs.set(k, v); });
  const data = await api.get(api.w('/assets') + (qs.toString() ? `?${qs}` : ''));
  return data.items || [];
}

export async function loadUsage() {
  return api.get(api.w('/usage'));
}

/* ---------------- SSE ---------------- */

export function connectEvents(onJob) {
  if (!session.access) return () => {};
  const url = `/v1/w/${encodeURIComponent(session.slug)}/events?access_token=${encodeURIComponent(session.access)}`;
  let es;
  try {
    es = new EventSource(url);
  } catch {
    return () => {};
  }
  es.addEventListener('job', (e) => {
    try {
      onJob(JSON.parse(e.data));
    } catch {
      /* 忽略单条解析失败 */
    }
  });
  es.onerror = () => {
    /* 浏览器会自愈重连；页面同时有手动刷新入口 */
  };
  return () => es.close();
}

/* ---------------- 项目 / SKU / 文件夹 ---------------- */

export function openCreateProject(onDone) {
  const body = document.createElement('div');
  body.innerHTML = `
    <div class="field"><label for="p-name">项目名称</label>
      <input class="input" id="p-name" placeholder="例如：3C 配件 · 美国站"></div>
    <div class="field"><label for="p-platform">平台</label>
      <select class="select" id="p-platform"><option value="amazon">Amazon</option></select></div>
    <div class="field"><label for="p-cat">品类</label>
      <input class="input" id="p-cat" placeholder="例如：充电配件"></div>`;
  const m = ui.modal({
    title: '新建项目',
    body,
    footer: [
      { label: '取消', kind: 'ghost' },
      { label: '创建', kind: 'primary', onClick: async (close) => {
        const name = body.querySelector('#p-name').value.trim();
        if (!name) return ui.toast('请填写项目名称', 'bad');
        try {
          await api.post(api.w('/projects'), {
            name,
            platform: body.querySelector('#p-platform').value,
            category: body.querySelector('#p-cat').value.trim(),
          });
          close();
          ui.toast('项目已创建', 'good');
          if (onDone) onDone();
        } catch (err) {
          ui.toast(err.message, 'bad');
        }
      }},
    ],
  });
  return m;
}

export function openCreateFolder({ projectId, parentId = '', onDone }) {
  const body = document.createElement('div');
  body.innerHTML = `
    <div class="field"><label for="f-name">文件夹名称</label>
      <input class="input" id="f-name" placeholder="例如：充电头 / 2026 春季"></div>
    <p class="hint">文件夹最多两级：项目下建批次，批次下放 SKU。</p>`;
  ui.modal({
    title: parentId ? '新建子文件夹' : '新建文件夹',
    body,
    footer: [
      { label: '取消', kind: 'ghost' },
      { label: '创建', kind: 'primary', onClick: async (close) => {
        const name = body.querySelector('#f-name').value.trim();
        if (!name) return ui.toast('请填写名称', 'bad');
        try {
          await api.post(api.w('/folders'), { project_id: projectId, parent_id: parentId, name });
          close();
          ui.toast('文件夹已创建', 'good');
          if (onDone) onDone();
        } catch (err) {
          ui.toast(err.message, 'bad');
        }
      }},
    ],
  });
}

export function openCreateSKU({ projectId, folders = [], folderId = '', onDone }) {
  const body = document.createElement('div');
  body.innerHTML = `
    <div class="field"><label for="s-code">SKU 编码</label>
      <input class="input" id="s-code" placeholder="例如：DK-CHG-001" autocomplete="off"></div>
    <div class="field"><label for="s-title">商品标题</label>
      <input class="input" id="s-title" placeholder="用于生成提示词与导出命名"></div>
    <div class="field"><label for="s-folder">归属文件夹</label>
      <select class="select" id="s-folder">
        <option value="">不归档</option>
        ${folders.map((f) => `<option value="${f.id}" ${f.id === folderId ? 'selected' : ''}>${ui.esc(f.name)}</option>`).join('')}
      </select></div>
    <div class="field"><label for="s-attr">属性（可选，JSON）</label>
      <textarea class="textarea" id="s-attr" placeholder='{"颜色":"黑色","材质":"ABS"}'></textarea></div>`;
  ui.modal({
    title: '新建 SKU',
    body,
    footer: [
      { label: '取消', kind: 'ghost' },
      { label: '创建', kind: 'primary', onClick: async (close) => {
        const code = body.querySelector('#s-code').value.trim();
        if (!code) return ui.toast('请填写 SKU 编码', 'bad');
        const attrs = body.querySelector('#s-attr').value.trim();
        if (attrs) {
          try { JSON.parse(attrs); } catch { return ui.toast('属性必须是合法 JSON', 'bad'); }
        }
        try {
          const sku = await api.post(api.w('/skus'), {
            project_id: projectId,
            folder_id: body.querySelector('#s-folder').value || undefined,
            code,
            title: body.querySelector('#s-title').value.trim(),
            attributes: attrs || undefined,
          });
          close();
          ui.toast('SKU 已创建', 'good');
          if (onDone) onDone(sku);
        } catch (err) {
          ui.toast(err.message, 'bad');
        }
      }},
    ],
  });
}

/* ---------------- 上传 ---------------- */

function compressImage(file, maxEdge = 2000) {
  return new Promise((resolve) => {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return resolve(file);
    if (file.size < 900 * 1024) return resolve(file);
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      canvas.toBlob((blob) => {
        if (!blob) return resolve(file);
        resolve(new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }));
      }, 'image/jpeg', 0.88);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}

export function openUpload({ sku, onDone }) {
  const body = document.createElement('div');
  body.innerHTML = `
    <div class="dropzone" id="dz">
      <div class="dz-title">把商品实拍图拖到这里</div>
      <div class="small">或点击选择 · 支持 PNG / JPEG / WebP · 单张不超过 25MB · 可多选</div>
    </div>
    <input type="file" id="file-input" accept="image/png,image/jpeg,image/webp" multiple hidden>
    <div id="up-list" class="col mt-16"></div>
    <p class="hint mt-8">大图会先压缩到长边 2000px 再上传，原始文件不落地。</p>`;

  const input = body.querySelector('#file-input');
  const dz = body.querySelector('#dz');
  const list = body.querySelector('#up-list');

  dz.onclick = () => input.click();
  dz.ondragover = (e) => { e.preventDefault(); dz.classList.add('drag'); };
  dz.ondragleave = () => dz.classList.remove('drag');
  dz.ondrop = (e) => {
    e.preventDefault();
    dz.classList.remove('drag');
    handleFiles(Array.from(e.dataTransfer.files || []));
  };
  input.onchange = () => handleFiles(Array.from(input.files || []));

  const m = ui.modal({ title: `上传素材 · ${sku.code}`, body, wide: true });

  async function handleFiles(files) {
    const images = files.filter((f) => /^image\//.test(f.type));
    if (!images.length) return ui.toast('请选择图片文件', 'bad');
    let done = 0;
    let failed = 0;
    for (const original of images) {
      const row = document.createElement('div');
      row.className = 'card pad-sm';
      row.innerHTML = `
        <div class="row between">
          <span class="truncate small">${ui.esc(original.name)}</span>
          <span class="muted small">准备中…</span>
        </div>
        <div class="progress mt-8"><i style="width:0%"></i></div>`;
      list.appendChild(row);
      const bar = row.querySelector('.progress > i');
      const note = row.querySelector('.muted');
      try {
        const file = await compressImage(original);
        if (file.size > 25 * 1024 * 1024) throw new Error('文件超过 25MB');
        note.textContent = '上传中…';
        await api.upload(api.w(`/skus/${sku.id}/assets`), file, {
          onProgress: (p) => {
            bar.style.width = p + '%';
            note.textContent = `上传中 ${p}%`;
          },
        });
        bar.style.width = '100%';
        note.textContent = '已入库';
        done++;
      } catch (err) {
        failed++;
        note.textContent = err.message || '上传失败';
        note.style.color = 'var(--bad)';
      }
    }
    if (done) ui.toast(`已上传 ${done} 张${failed ? `，${failed} 张失败` : ''}`, failed ? 'bad' : 'good');
    if (done && onDone) onDone();
    setTimeout(() => { if (list.children.length) m.close(); }, 700);
  }
}

/* ---------------- 生成 ---------------- */

export function openGenerate({ sku, assets = [], template = 'main', onDone }) {
  const body = document.createElement('div');
  body.innerHTML = `
    <div class="field"><label>生成模板</label>
      <div class="row wrap" id="tpl-row">
        ${TEMPLATES.map((t) => `<button type="button" class="btn sm ${t === template ? 'primary' : ''}" data-tpl="${t}">${TPL[t]}</button>`).join('')}
      </div>
      <span class="hint">主图偏白底商品展示；场景图加生活化背景；卖点图突出 2–3 个核心卖点。</span>
    </div>
    <div class="field"><label>参考素材</label>
      ${assets.length ? `<div class="thumb-grid" id="asset-pick">
        ${assets.map((a) => `<div class="thumb" data-asset="${a.id}">
          <img src="${api.assetURL(a.id)}" alt="">
          <div class="t-meta"><span>${ui.esc(ui.fmt.date(a.created_at))}</span></div>
        </div>`).join('')}
      </div>` : `<div class="empty" style="padding:22px"><div class="e-sub">该 SKU 还没有上传素材，可以先提交无参考生成</div></div>`}
    </div>
    <p class="hint">同一 SKU 与模板的重复提交会被幂等键保护，不会重复扣成本。</p>`;

  let chosenTpl = template;
  let chosenAsset = assets.length ? assets[0].id : '';

  body.querySelectorAll('[data-tpl]').forEach((b) => {
    b.onclick = () => {
      chosenTpl = b.dataset.tpl;
      body.querySelectorAll('[data-tpl]').forEach((x) => x.classList.remove('primary'));
      b.classList.add('primary');
    };
  });
  body.querySelectorAll('[data-asset]').forEach((el) => {
    el.onclick = () => {
      chosenAsset = el.dataset.asset;
      body.querySelectorAll('[data-asset]').forEach((x) => x.classList.remove('sel'));
      el.classList.add('sel');
    };
  });

  ui.modal({
    title: `发起生成 · ${sku.code}`,
    body,
    wide: true,
    footer: [
      { label: '取消', kind: 'ghost' },
      { label: '加入生成队列', kind: 'primary', onClick: async (close) => {
        try {
          await api.post(api.w('/jobs'), {
            sku_id: sku.id,
            source_asset_id: chosenAsset || undefined,
            template: chosenTpl,
            idempotency_key: crypto.randomUUID(),
          });
          close();
          ui.toast('已加入生成队列', 'good');
          if (onDone) onDone();
        } catch (err) {
          ui.toast(err.message, 'bad');
        }
      }},
    ],
  });
}

/* ---------------- 审核 ---------------- */

export function openReview({ job, outputAsset, onDone }) {
  const body = document.createElement('div');
  body.innerHTML = `
    ${outputAsset ? `<div class="thumb" style="aspect-ratio:auto;max-height:420px;display:grid;place-items:center;background:#000">
      <img src="${api.assetURL(outputAsset.id)}" style="max-height:420px;object-fit:contain" alt="">
    </div>` : '<p class="muted">该任务没有可用输出图。</p>'}
    <div class="row mt-16">
      ${ui.badge('info', TPL[job.template] || job.template)}
      <span class="muted small">成本 ${ui.fmt.cents(job.cost_cents)}</span>
      <span class="muted small">尝试 ${job.attempts} 次</span>
    </div>
    <div class="field mt-16"><label for="rv-reason">驳回原因（驳回必填）</label>
      <textarea class="textarea" id="rv-reason" placeholder="例如：商品边缘被裁切、背景出现品牌 logo"></textarea></div>`;

  ui.modal({
    title: '审核生成结果',
    body,
    wide: true,
    footer: [
      { label: '驳回', kind: 'danger', onClick: async (close) => {
        const reason = body.querySelector('#rv-reason').value.trim();
        if (!reason) return ui.toast('驳回必须填写原因', 'bad');
        try {
          await api.post(api.w(`/jobs/${job.id}/review`), { status: 'rejected', reason });
          close();
          ui.toast('已驳回', 'good');
          if (onDone) onDone();
        } catch (err) { ui.toast(err.message, 'bad'); }
      }},
      { label: '通过', kind: 'primary', onClick: async (close) => {
        try {
          await api.post(api.w(`/jobs/${job.id}/review`), { status: 'approved' });
          close();
          ui.toast('已通过审核', 'good');
          if (onDone) onDone();
        } catch (err) { ui.toast(err.message, 'bad'); }
      }},
    ],
  });
}

/* ---------------- 任务行 ---------------- */

export function jobRowHTML(job, skuMap = {}) {
  const sku = skuMap[job.sku_id];
  return `<tr data-job="${job.id}">
    <td><span class="mono">${ui.esc(sku ? sku.code : job.sku_id.slice(0, 8))}</span></td>
    <td>${templateChip(job.template)}</td>
    <td>${jobBadge(job)}</td>
    <td class="shrink">${job.status === 'running' || job.status === 'queued'
      ? `<div class="progress" style="width:90px"><i style="width:${job.progress || 0}%"></i></div>`
      : `<span class="muted small">${ui.esc(job.error || '—')}</span>`}</td>
    <td>${reviewBadge(job)}</td>
    <td class="num">${ui.fmt.cents(job.cost_cents)}</td>
    <td class="shrink muted small">${ui.esc(ui.fmt.ago(job.created_at))}</td>
    <td class="shrink"><button class="btn sm" data-open="${job.id}">查看</button></td>
  </tr>`;
}

export function assetHTML(asset, { selected = false } = {}) {
  return `<div class="thumb ${selected ? 'sel' : ''}" data-asset-card="${asset.id}">
    <img src="${api.assetURL(asset.id)}" alt="${ui.esc(asset.mime)}" loading="lazy">
    <div class="t-meta">
      <span>${asset.kind === 'output' ? '结果' : '素材'}</span>
      <span>·</span>
      <span>${asset.width && asset.height ? `${asset.width}×${asset.height}` : ui.fmt.bytes(asset.size_bytes)}</span>
      ${asset.status ? `<span style="margin-left:auto">${ui.badge(asset.status).replace('class="badge', 'class="badge no-dot')}</span>` : ''}
    </div>
  </div>`;
}
