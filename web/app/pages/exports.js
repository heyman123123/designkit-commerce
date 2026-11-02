/* 导出中心：按 SKU 打包已通过质检的结果 */

import { api, ui } from '../../assets/core.js';
import { setCrumb } from '../shell.js';
import { pageHead, loadSKUs, loadAssets, loadUsage } from '../common.js';

export async function render({ root }) {
  setCrumb(['工作台', '导出中心']);
  root.innerHTML = ui.loading();

  let skus, outputs, usage;
  try {
    [skus, outputs, usage] = await Promise.all([loadSKUs(), loadAssets({ kind: 'output' }), loadUsage()]);
  } catch (err) {
    root.innerHTML = ui.empty({ icon: '⚠', title: '加载失败', sub: err.message });
    return;
  }

  const passed = {};
  const all = {};
  outputs.forEach((a) => {
    all[a.sku_id] = (all[a.sku_id] || 0) + 1;
    if (a.status === 'qc_passed') passed[a.sku_id] = (passed[a.sku_id] || 0) + 1;
  });

  const remaining = Math.max(0, usage.export_quota - usage.export_used);
  const ready = skus.filter((s) => passed[s.id]);

  root.innerHTML = `
    ${pageHead({
      title: '导出中心',
      sub: '导出包只包含审核通过的结果图，按 Amazon 规格命名，下载为 ZIP。',
      actions: `<span class="badge ${remaining ? 'good' : 'bad'} no-dot">剩余额度 ${remaining}/${usage.export_quota}</span>`,
    })}
    ${remaining === 0 ? `<div class="card mb-24" style="border-color:rgba(239,100,97,.45)">
      <div class="row between wrap">
        <div><b>高清导出额度已用完</b>
          <div class="muted small">导出按次计费；请联系运营升级套餐或增加导出额度。</div></div>
        <a class="btn sm" href="#/usage">查看用量</a>
      </div>
    </div>` : ''}
    ${ready.length ? `<div class="table-wrap"><table class="table">
      <thead><tr><th>SKU</th><th>标题</th><th class="num">可导出</th><th class="num">结果总数</th><th class="shrink"></th></tr></thead>
      <tbody>${ready.map((s) => `<tr>
        <td><a class="mono" href="#/skus/${s.id}">${ui.esc(s.code)}</a></td>
        <td class="truncate" style="max-width:340px">${ui.esc(s.title || '—')}</td>
        <td class="num">${passed[s.id]}</td>
        <td class="num muted">${all[s.id] || 0}</td>
        <td class="shrink"><button class="btn sm primary" data-export="${s.id}" ${remaining === 0 ? 'disabled' : ''}>导出 ZIP</button></td>
      </tr>`).join('')}</tbody>
    </table></div>` : ui.empty({
      icon: '↓',
      title: '暂无可导出的 SKU',
      sub: '先在 SKU 详情页生成结果并通过审核，才会出现在这里。',
      action: '<a class="btn sm mt-8" href="#/review">去审核队列</a>',
    })}
    <p class="hint mt-8">每次导出扣 1 次额度，并写入不可变用量流水。</p>`;

  root.querySelectorAll('[data-export]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      b.textContent = '打包中…';
      try {
        await api.download(api.w(`/skus/${b.dataset.export}/export`));
        ui.toast('导出包已开始下载', 'good');
        render({ root });
      } catch (err) {
        ui.toast(err.message, 'bad');
        b.disabled = false;
        b.textContent = '导出 ZIP';
      }
    };
  });
}
