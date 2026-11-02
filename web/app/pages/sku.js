/* SKU 详情：素材、生成结果、审核、任务、导出 */

import { api, ui } from '../../assets/core.js';
import { setCrumb } from '../shell.js';
import {
  pageHead, loadSKUs, loadAssets, loadJobs, openUpload, openGenerate,
  openReview, templateChip, connectEvents, TPL,
} from '../common.js';

let cleanup = null;

export async function render({ params, query, root }) {
  if (cleanup) { cleanup(); cleanup = null; }
  root.innerHTML = ui.loading();

  let sku, assets, jobs;
  try {
    const [skus, allAssets, allJobs] = await Promise.all([
      loadSKUs(), loadAssets({ sku_id: params.id }), loadJobs({ sku_id: params.id }),
    ]);
    sku = skus.find((s) => s.id === params.id);
    assets = allAssets;
    jobs = allJobs;
  } catch (err) {
    root.innerHTML = ui.empty({ icon: '⚠', title: '加载失败', sub: err.message });
    return;
  }
  if (!sku) {
    root.innerHTML = ui.empty({ icon: '404', title: 'SKU 不存在', sub: '可能已被删除，或你没有访问权限。' });
    return;
  }
  setCrumb(['工作台', '<a href="#/projects">项目</a>', sku.code]);

  const sourceAssets = assets.filter((a) => a.kind === 'source');
  const outputAssets = assets.filter((a) => a.kind === 'output');
  const assetById = Object.fromEntries(assets.map((a) => [a.id, a]));
  const pendingReview = jobs.filter((j) => j.status === 'succeeded' && j.review_status === 'pending');
  const approved = jobs.filter((j) => j.review_status === 'approved');
  const activeTab = query.tab || 'assets';

  root.innerHTML = `
    ${pageHead({
      title: sku.code,
      sub: `${sku.title || '未填写标题'} · 素材 ${sourceAssets.length} · 结果 ${outputAssets.length} · 待审 ${pendingReview.length}`,
      actions: `
        <button class="btn" id="act-upload">↑ 上传素材</button>
        <button class="btn primary" id="act-generate">✦ 发起生成</button>
        <button class="btn" id="act-export">↓ 导出 ZIP</button>`,
    })}
    <div class="tabs" id="sku-tabs">
      <div class="tab ${activeTab === 'assets' ? 'active' : ''}" data-tab="assets">素材 · ${sourceAssets.length}</div>
      <div class="tab ${activeTab === 'results' ? 'active' : ''}" data-tab="results">结果与审核 · ${outputAssets.length}</div>
      <div class="tab ${activeTab === 'jobs' ? 'active' : ''}" data-tab="jobs">任务 · ${jobs.length}</div>
      <div class="tab ${activeTab === 'versions' ? 'active' : ''}" data-tab="versions">版本</div>
      <div class="tab ${activeTab === 'info' ? 'active' : ''}" data-tab="info">信息</div>
    </div>
    <div id="sku-body"></div>`;

  const body = document.getElementById('sku-body');

  document.getElementById('act-upload').onclick = () => openUpload({ sku, onDone: () => render({ params, query, root }) });
  document.getElementById('act-generate').onclick = () => openGenerate({
    sku, assets: sourceAssets,
    onDone: () => render({ params, query: { ...query, tab: 'jobs' }, root }),
  });
  document.getElementById('act-export').onclick = async () => {
    try {
      await api.download(api.w(`/skus/${sku.id}/export`));
      ui.toast('导出包已开始下载', 'good');
    } catch (err) {
      ui.toast(err.message, 'bad');
    }
  };
  document.querySelectorAll('#sku-tabs .tab').forEach((t) => {
    t.onclick = () => {
      document.querySelectorAll('#sku-tabs .tab').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      show(t.dataset.tab);
    };
  });

  function show(tab) {
    if (tab === 'assets') return showAssets();
    if (tab === 'results') return showResults();
    if (tab === 'jobs') return showJobs();
    if (tab === 'versions') return showVersions();
    return showInfo();
  }

  function showAssets() {
    body.innerHTML = `
      <div class="card mb-16">
        <div class="row between wrap">
          <div>
            <b>商品实拍素材</b>
            <div class="muted small">生成时会读取这里的图片作为参考；大图上传前自动压缩。</div>
          </div>
          <button class="btn sm" id="inline-upload">上传图片</button>
        </div>
      </div>
      ${sourceAssets.length
        ? `<div class="thumb-grid">${sourceAssets.map((a) => `<div class="thumb" data-open-asset="${a.id}">
            <img src="${api.assetURL(a.id)}" loading="lazy" alt="">
            <div class="t-meta"><span>${ui.esc(ui.fmt.date(a.created_at))}</span>
              <span style="margin-left:auto">${a.width && a.height ? `${a.width}×${a.height}` : ui.fmt.bytes(a.size_bytes)}</span></div>
          </div>`).join('')}</div>`
        : ui.empty({
          icon: '↑',
          title: '还没有素材',
          sub: '上传 1–3 张清晰的商品实拍图，白底或纯色背景效果最好。',
          action: '<button class="btn sm mt-8" id="empty-upload">上传素材</button>',
        })}`;
    const b1 = document.getElementById('inline-upload');
    if (b1) b1.onclick = () => openUpload({ sku, onDone: () => render({ params, query, root }) });
    const b2 = document.getElementById('empty-upload');
    if (b2) b2.onclick = () => openUpload({ sku, onDone: () => render({ params, query, root }) });
    body.querySelectorAll('[data-open-asset]').forEach((el) => {
      el.onclick = () => previewAsset(assetById[el.dataset.openAsset]);
    });
  }

  function showResults() {
    if (!outputAssets.length) {
      body.innerHTML = ui.empty({
        icon: '✦',
        title: '还没有生成结果',
        sub: '选一个模板发起生成；完成后会出现在这里等待审核。',
        action: '<button class="btn sm mt-8" id="empty-generate">发起生成</button>',
      });
      const b = document.getElementById('empty-generate');
      if (b) b.onclick = () => openGenerate({ sku, assets: sourceAssets, onDone: () => render({ params, query: { ...query, tab: 'results' }, root }) });
      return;
    }
    const jobByOutput = {};
    jobs.forEach((j) => { if (j.output_asset_id) jobByOutput[j.output_asset_id] = j; });

    body.innerHTML = `
      <div class="thumb-grid mb-24">
        ${outputAssets.map((a) => {
          const j = jobByOutput[a.id] || {};
          return `<div class="thumb" style="aspect-ratio:1">
            <img src="${api.assetURL(a.id)}" loading="lazy" alt="">
            <div class="t-meta"><span>${ui.esc(TPL[j.template] || '')}</span>
              <span style="margin-left:auto">${ui.badge(j.review_status || 'pending').replace('class="badge', 'class="badge no-dot')}</span></div>
          </div>`;
        }).join('')}
      </div>
      <div class="card">
        <div class="card-head"><h2>待审核</h2><span class="badge warn no-dot">${pendingReview.length}</span></div>
        ${pendingReview.length ? `<div class="table-wrap"><table class="table">
          <thead><tr><th>模板</th><th>成本</th><th>完成时间</th><th class="shrink"></th></tr></thead>
          <tbody>${pendingReview.map((j) => `<tr>
            <td>${templateChip(j.template)}</td>
            <td class="num">${ui.fmt.cents(j.cost_cents)}</td>
            <td class="muted small">${ui.esc(ui.fmt.ago(j.updated_at || j.created_at))}</td>
            <td class="shrink"><button class="btn sm primary" data-review="${j.id}">审核</button></td>
          </tr>`).join('')}</tbody></table></div>`
          : '<p class="muted small">当前没有待审核结果。</p>'}
      </div>`;
    body.querySelectorAll('[data-review]').forEach((b) => {
      b.onclick = () => {
        const job = jobs.find((j) => j.id === b.dataset.review);
        openReview({
          job,
          outputAsset: assetById[job.output_asset_id],
          onDone: () => render({ params, query: { ...query, tab: 'results' }, root }),
        });
      };
    });
  }

  function showJobs() {
    if (!jobs.length) {
      body.innerHTML = ui.empty({ icon: '⚙', title: '还没有任务', sub: '发起生成后，任务进度会实时更新。' });
      return;
    }
    body.innerHTML = `<div class="table-wrap"><table class="table">
      <thead><tr><th>模板</th><th>状态</th><th>进度 / 错误</th><th>审核</th><th class="num">成本</th><th>时间</th><th class="shrink"></th></tr></thead>
      <tbody>${jobs.map((j) => `<tr>
        <td>${templateChip(j.template)}</td>
        <td>${ui.badge(j.status)}</td>
        <td class="shrink" style="min-width:140px">
          ${j.status === 'running' || j.status === 'queued'
            ? `<div class="progress" style="width:110px"><i style="width:${j.progress || 0}%"></i></div>`
            : `<span class="muted small">${ui.esc(j.error || '—')}</span>`}
        </td>
        <td>${j.status === 'succeeded' ? ui.badge(j.review_status) : '<span class="muted">—</span>'}</td>
        <td class="num">${ui.fmt.cents(j.cost_cents)}</td>
        <td class="muted small">${ui.esc(ui.fmt.ago(j.created_at))}</td>
        <td class="shrink">${j.status === 'succeeded' && j.review_status === 'pending'
          ? `<button class="btn sm" data-review="${j.id}">审核</button>` : ''}</td>
      </tr>`).join('')}</tbody></table></div>
      <p class="hint mt-8">失败任务会由平台运维在管理后台重试；如长时间失败请联系运营。</p>`;

    body.querySelectorAll('[data-review]').forEach((b) => {
      b.onclick = () => {
        const job = jobs.find((j) => j.id === b.dataset.review);
        openReview({
          job,
          outputAsset: job.output_asset_id ? assetById[job.output_asset_id] : null,
          onDone: () => render({ params, query: { ...query, tab: 'jobs' }, root }),
        });
      };
    });
  }

  async function showVersions() {
    body.innerHTML = ui.loading('正在读取版本链…');
    let data;
    try {
      data = await api.get(api.w(`/skus/${sku.id}/versions`));
    } catch (err) {
      body.innerHTML = ui.empty({ icon: '⚠', title: '版本读取失败', sub: err.message });
      return;
    }
    const items = data.items || [];
    if (!items.length) {
      body.innerHTML = ui.empty({ icon: '⌘', title: '还没有版本', sub: '生成成功的结果会按模板自动编号，审核通过的结果成为当前版本。' });
      return;
    }
    const groups = {};
    items.forEach((v) => { (groups[v.template] = groups[v.template] || []).push(v); });

    body.innerHTML = Object.keys(groups).sort().map((t) => `
      <section class="card mb-16">
        <div class="card-head"><h2>${ui.esc(TPL[t] || t)}</h2>
          <span class="chip">${groups[t].length} 个版本</span>
          <span class="grow"></span>
          <button class="btn sm" data-compare="${t}">版本对比</button></div>
        <div class="thumb-grid">
          ${groups[t].map((v) => `<div class="thumb" style="aspect-ratio:1">
            ${v.asset_id ? `<img src="${api.assetURL(v.asset_id)}" loading="lazy" alt="">` : '<div class="empty" style="border:none">无输出</div>'}
            <div class="t-meta">
              <span>v${v.version_no}</span>
              <span style="margin-left:auto">${v.is_current ? ui.badge('good', '当前').replace('class="badge', 'class="badge no-dot') : ui.badge(v.review_status).replace('class="badge', 'class="badge no-dot')}</span>
            </div>
          </div>`).join('')}
        </div>
        <div class="table-wrap mt-16"><table class="table">
          <thead><tr><th>版本</th><th>审核</th><th>质检分</th><th>成本</th><th>时间</th><th class="shrink"></th></tr></thead>
          <tbody>${groups[t].map((v) => `<tr>
            <td class="mono">v${v.version_no}${v.is_current ? ' · 当前' : ''}</td>
            <td>${ui.badge(v.review_status)}</td>
            <td class="num">${v.qc_score || '—'}</td>
            <td class="num">${ui.fmt.cents(v.cost_cents)}</td>
            <td class="muted small">${ui.esc(ui.fmt.dt(v.created_at))}</td>
            <td class="shrink">${v.is_current ? '<span class="muted small">已是当前</span>'
              : `<button class="btn sm" data-promote="${v.job_id}">设为主版本</button>`}</td>
          </tr>`).join('')}</tbody>
        </table></div>
        ${vIssues(groups[t])}
      </section>`).join('');

    body.querySelectorAll('[data-compare]').forEach((b) => {
      b.onclick = () => openCompare(b.dataset.compare);
    });

    // openCompare 并排比较同一模板下的两个版本。
    function openCompare(template) {
      const list = groups[template].slice().sort((a, b) => a.version_no - b.version_no);
      if (list.length < 2) {
        ui.toast('该模板只有一个版本，暂无可对比对象', 'warn');
        return;
      }
      const opt = (v, selected) => `<option value="${v.job_id}" ${selected ? 'selected' : ''}>v${v.version_no}${v.is_current ? ' · 当前' : ''} · ${v.review_status}</option>`;
      const leftDefault = list[0];
      const rightDefault = list[list.length - 1];
      const panel = document.createElement('div');
      panel.innerHTML = `
        <div class="grid two" style="gap:12px">
          <div class="field"><label for="cmp-left">左侧版本</label>
            <select class="select" id="cmp-left">${list.map((v) => opt(v, v.job_id === leftDefault.job_id)).join('')}</select></div>
          <div class="field"><label for="cmp-right">右侧版本</label>
            <select class="select" id="cmp-right">${list.map((v) => opt(v, v.job_id === rightDefault.job_id)).join('')}</select></div>
        </div>
        <div id="cmp-body">${ui.loading('正在读取版本…')}</div>`;

      const load = async () => {
        const left = panel.querySelector('#cmp-left').value;
        const right = panel.querySelector('#cmp-right').value;
        const host = panel.querySelector('#cmp-body');
        if (left === right) {
          host.innerHTML = '<p class="muted small">左右选择的是同一个版本，请换成两个不同版本。</p>';
          return;
        }
        host.innerHTML = ui.loading('正在读取版本…');
        let data;
        try {
          data = await api.get(api.w(`/skus/${sku.id}/compare?left=${encodeURIComponent(left)}&right=${encodeURIComponent(right)}`));
        } catch (err) {
          host.innerHTML = ui.empty({ icon: '⚠', title: '对比失败', sub: err.message });
          return;
        }
        const currentIds = new Set((data.marks || []).filter((m) => m.is_current).map((m) => m.job_id));
        host.innerHTML = `<div class="grid two" style="gap:12px">
          ${sideHTML(data.left, '左', currentIds)}
          ${sideHTML(data.right, '右', currentIds)}
        </div>${diffHTML(data)}`;
      };

      const sideHTML = (side, tag, currentIds) => {
        const job = side.job || {};
        const a = side.asset;
        const isCurrent = currentIds.has(job.id);
        const meta = list.find((v) => v.job_id === job.id);
        const label = meta ? `v${meta.version_no}` : job.id.slice(0, 6);
        const qc = a && a.qc_score != null ? a.qc_score : '—';
        const size = a && a.width && a.height ? `${a.width}×${a.height}` : '—';
        return `<div class="card pad-sm">
          <div class="row between"><b>${tag} · ${label}</b>${isCurrent ? ui.badge('good', '当前') : ''}</div>
          <div class="thumb mt-8" style="aspect-ratio:1;background:#000">
            ${a ? `<img src="${api.assetURL(a.id)}" style="object-fit:contain" loading="lazy" alt="">` : '<div class="empty" style="border:none">无输出</div>'}
          </div>
          <div class="col small mt-8">
            <div class="row between"><span class="muted">审核</span>${ui.badge(job.review_status || 'pending')}</div>
            <div class="row between"><span class="muted">质检分</span><span class="num">${qc}</span></div>
            <div class="row between"><span class="muted">尺寸</span><span class="mono">${size}</span></div>
            <div class="row between"><span class="muted">成本</span><span class="num">${ui.fmt.cents(job.cost_cents)}</span></div>
            <div class="row between"><span class="muted">时间</span><span>${ui.esc(ui.fmt.dt(job.created_at))}</span></div>
          </div>
        </div>`;
      };

      const diffHTML = (data) => {
        const a = data.left || {};
        const b = data.right || {};
        const qa = a.asset && a.asset.qc_score != null ? a.asset.qc_score : null;
        const qb = b.asset && b.asset.qc_score != null ? b.asset.qc_score : null;
        const items = [];
        if (qa != null && qb != null && qa !== qb) {
          items.push(`质检分 ${qa} → ${qb}（${qb > qa ? '提升' : '下降'} ${Math.abs(qb - qa)} 分）`);
        }
        if (a.job && b.job) {
          if (a.job.review_status !== b.job.review_status) items.push(`审核结论 ${a.job.review_status} → ${b.job.review_status}`);
          if ((a.job.cost_cents || 0) !== (b.job.cost_cents || 0)) items.push(`单次成本 ${ui.fmt.cents(a.job.cost_cents)} → ${ui.fmt.cents(b.job.cost_cents)}`);
        }
        return `<div class="callout info mt-12"><b>差异摘要</b>
          <p class="muted small mt-8">${items.length ? ui.esc(items.join('；')) : '两个版本的关键指标一致，可重点看图面差异。'}</p></div>`;
      };

      ui.modal({
        title: `版本对比 · ${TPL[template] || template}`,
        body: panel,
        wide: true,
        footer: [{ label: '关闭', kind: 'ghost', onClick: (close) => close() }],
      });
      panel.querySelector('#cmp-left').onchange = load;
      panel.querySelector('#cmp-right').onchange = load;
      load();
    }

    body.querySelectorAll('[data-promote]').forEach((b) => {
      b.onclick = async () => {
        b.disabled = true;
        try {
          await api.post(api.w(`/skus/${sku.id}/versions/${b.dataset.promote}/current`), {});
          ui.toast('已切换当前版本', 'good');
          showVersions();
        } catch (err) {
          ui.toast(err.message, 'bad');
          b.disabled = false;
        }
      };
    });

    function vIssues(list) {
      const withIssues = list.filter((v) => v.qc_issues && v.qc_issues !== '[]' && v.qc_issues !== '');
      if (!withIssues.length) return '';
      return `<div class="divider"></div><div class="col small">
        ${withIssues.map((v) => `<div><b>v${v.version_no} 质检问题：</b><span class="muted">${ui.esc(String(v.qc_issues))}</span></div>`).join('')}
      </div>`;
    }
  }

  function showInfo() {
    let attrs = '';
    try {
      const parsed = sku.attributes ? JSON.parse(sku.attributes) : null;
      if (parsed) attrs = Object.entries(parsed).map(([k, v]) => `${k}: ${v}`).join('\n');
      else attrs = sku.attributes || '';
    } catch { attrs = sku.attributes || ''; }

    body.innerHTML = `<div class="grid two">
      <div class="card">
        <h3>基本信息</h3>
        <div class="divider"></div>
        <div class="col">
          <div class="row between"><span class="muted small">SKU 编码</span><span class="mono">${ui.esc(sku.code)}</span></div>
          <div class="row between"><span class="muted small">标题</span><span>${ui.esc(sku.title || '—')}</span></div>
          <div class="row between"><span class="muted small">创建时间</span><span>${ui.esc(ui.fmt.dt(sku.created_at))}</span></div>
          <div class="row between"><span class="muted small">已通过审核</span><span>${approved.length} 个结果</span></div>
        </div>
      </div>
      <div class="card">
        <h3>商品属性</h3>
        <div class="divider"></div>
        <pre class="mono" style="white-space:pre-wrap;margin:0;color:var(--ink-2)">${ui.esc(attrs || '未填写')}</pre>
        <p class="hint mt-8">属性会进入生成提示词，影响卖点图文案与配色建议。</p>
      </div>
    </div>`;
  }

  function previewAsset(asset) {
    if (!asset) return;
    ui.modal({
      title: asset.kind === 'output' ? '生成结果' : '素材预览',
      body: `<div style="background:#000;border-radius:12px;display:grid;place-items:center">
        <img src="${api.assetURL(asset.id)}" style="max-height:70vh;max-width:100%;object-fit:contain" alt="">
      </div>
      <div class="row mt-16 small muted">
        <span>${ui.esc(ui.fmt.bytes(asset.size_bytes))}</span>
        <span>${asset.width}×${asset.height}</span>
        <span>${ui.esc(ui.fmt.dt(asset.created_at))}</span>
        ${ui.badge(asset.status)}
      </div>`,
      wide: true,
    });
  }

  show(activeTab);

  const onUpload = () => openUpload({ sku, onDone: () => render({ params, query, root }) });
  window.addEventListener('dk:upload', onUpload);
  window.addEventListener('hashchange', () => window.removeEventListener('dk:upload', onUpload), { once: true });

  cleanup = connectEvents(() => {
    if (location.hash.startsWith('#/skus/')) render({ params, query, root });
  });
  window.addEventListener('hashchange', () => { if (cleanup) { cleanup(); cleanup = null; } }, { once: true });
}
