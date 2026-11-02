/* 成员与角色 */

import { api, ui, session } from '../../assets/core.js';
import { setCrumb } from '../shell.js';
import { pageHead } from '../common.js';

const ROLES = [
  ['owner', '所有者', '工作区最高权限，可管理成员与全部生产操作'],
  ['admin', '管理员', '可管理成员、项目与生产流程'],
  ['editor', '编辑', '可建项目/SKU、上传素材、发起生成、导出'],
  ['reviewer', '审核', '可审核生成结果，不能发起生成'],
  ['viewer', '只读', '只能查看与下载已通过的结果'],
];

export async function render({ root }) {
  setCrumb(['工作台', '成员']);
  root.innerHTML = ui.loading();

  let data;
  try {
    data = await api.get(api.w('/members'));
  } catch (err) {
    root.innerHTML = ui.empty({ icon: '⚠', title: '加载失败', sub: err.message });
    return;
  }
  const members = data.items || [];
  const canManage = ['owner', 'admin'].includes((session.ws || {}).role);

  root.innerHTML = `
    ${pageHead({
      title: '成员',
      sub: '成员必须先在平台注册账号，再按邮箱加入工作区。',
      actions: canManage ? '<button class="btn primary" id="add-member">+ 添加成员</button>' : '',
    })}
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>成员</th><th>邮箱</th><th>角色</th><th>权限说明</th></tr></thead>
        <tbody>${members.map((m) => {
          const role = ROLES.find((r) => r[0] === m.role);
          return `<tr>
            <td><div class="row"><span class="avatar" style="width:24px;height:24px;flex:0 0 24px;font-size:11px">${ui.esc((m.name || m.email || 'U').slice(0, 1).toUpperCase())}</span>
              <span>${ui.esc(m.name || '未命名')}</span></div></td>
            <td class="muted">${ui.esc(m.email)}</td>
            <td>${ui.badge(m.role)}</td>
            <td class="muted small">${ui.esc(role ? role[2] : '')}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>
    </div>
    <section class="card mt-24">
      <h3>角色权限</h3>
      <div class="divider"></div>
      <div class="grid two">
        ${ROLES.map(([k, name, desc]) => `<div class="row" style="align-items:flex-start">
          <div style="flex:0 0 72px">${ui.badge(k, name)}</div>
          <div class="muted small">${ui.esc(desc)}</div>
        </div>`).join('')}
      </div>
    </section>`;

  const addBtn = document.getElementById('add-member');
  if (addBtn) addBtn.onclick = () => {
    const body = document.createElement('div');
    body.innerHTML = `
      <div class="field"><label for="m-email">成员邮箱</label>
        <input class="input" id="m-email" type="email" placeholder="member@example.com"></div>
      <div class="field"><label for="m-role">角色</label>
        <select class="select" id="m-role">
          ${ROLES.filter((r) => r[0] !== 'owner').map((r) => `<option value="${r[0]}">${r[1]}</option>`).join('')}
        </select></div>
      <p class="hint">对方必须已经注册过 DesignKit 账号，否则会提示「该邮箱尚未注册」。</p>`;
    ui.modal({
      title: '添加成员',
      body,
      footer: [
        { label: '取消', kind: 'ghost' },
        { label: '添加', kind: 'primary', onClick: async (close) => {
          const email = body.querySelector('#m-email').value.trim();
          if (!email) return ui.toast('请填写邮箱', 'bad');
          try {
            await api.post(api.w('/members'), { email, role: body.querySelector('#m-role').value });
            close();
            ui.toast('成员已添加', 'good');
            render({ root });
          } catch (err) { ui.toast(err.message, 'bad'); }
        }},
      ],
    });
  };
}
