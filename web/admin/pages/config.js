/* 平台配置：#/config
 * 模板枚举 main/scene/selling_point 来自后端模型，其余（供应商、规则版本、feature flags）
 * 均无接口，明确占位，不展示任何推测值。
 */

import { ui } from '../../assets/core.js';
import { notWired } from '../admin-core.js';

const TEMPLATES = [
  ['main', '主图', '白底主图，用于商品首图'],
  ['scene', '场景图', '场景合成，用于详情与广告'],
  ['selling_point', '卖点图', '卖点提炼，带文案排版'],
];

function shellHTML() {
  return `<div class="page-head">
    <div class="ph-main">
      <h1>平台配置</h1>
      <p class="page-sub">模型供应商、平台规则版本、模板上下架、feature flags。</p>
    </div>
    <div class="ph-actions"><span class="badge warn no-dot">接口未接入</span></div>
  </div>

  <div class="callout warn mb-16">
    <b>本模块后端接口尚未实现</b>
    <p class="muted small mt-8">
      模板名称来自后端枚举（<code class="code-inline">GenerationJob.Template</code>），是唯一真实信息；
      供应商、规则版本与开关状态没有读取接口，因此全部保持灰色不可编辑，不显示任何推测值。
    </p>
  </div>

  <div class="card mb-16">
    <div class="card-head"><h2>生成模板</h2><span class="badge muted no-dot">来自后端枚举</span></div>
    <div class="table-wrap"><table class="table dense">
      <thead><tr><th>模板</th><th>标识</th><th>用途</th><th>上架状态</th><th class="shrink">操作</th></tr></thead>
      <tbody>
        ${TEMPLATES.map(
          ([key, name, desc]) => `<tr>
            <td>${ui.esc(name)}</td>
            <td><span class="mono">${key}</span></td>
            <td class="muted small">${ui.esc(desc)}</td>
            <td><span class="badge muted no-dot">状态未知</span></td>
            <td class="shrink"><button class="btn sm ghost" disabled title="接口未接入">上下架</button></td>
          </tr>`,
        ).join('')}
      </tbody>
    </table></div>
    <p class="hint mt-16">模板上下架、默认模板、模板专属提示词需要模板管理接口与数据表。</p>
    <div class="nw-apis">
      <code class="code-inline">GET /v1/admin/templates</code>
      <code class="code-inline">PATCH /v1/admin/templates/{key}</code>
    </div>
  </div>

  <div class="grid two">
    <div class="card">
      <div class="card-head"><h2>模型供应商</h2><span class="badge warn no-dot">接口未接入</span></div>
      ${notWired({
        title: '供应商与模型配置',
        desc: '当前供应商由服务端环境变量决定，后台不可见也不可改：无法在页面上确认用的是 mock 还是真实模型。',
        apis: ['GET /v1/admin/config/providers', 'PATCH /v1/admin/config/providers', 'POST /v1/admin/config/providers/test'],
      })}
    </div>

    <div class="card">
      <div class="card-head"><h2>平台规则版本</h2><span class="badge warn no-dot">接口未接入</span></div>
      ${notWired({
        title: 'QC 规则与内容规则版本',
        desc: 'QC 阈值（分辨率、长宽比、白底占比）目前写死在服务端，无版本号、无灰度、无回滚记录。',
        apis: ['GET /v1/admin/config/rules', 'POST /v1/admin/config/rules/versions', 'POST /v1/admin/config/rules/{version}/activate'],
      })}
    </div>
  </div>

  <div class="card mt-16">
    <div class="card-head"><h2>Feature Flags</h2><span class="badge warn no-dot">接口未接入</span></div>
    ${notWired({
      title: '功能开关',
      desc: '没有开关表，也没有按租户/按比例放量的能力；页面不列任何“示例开关”。',
      apis: ['GET /v1/admin/flags', 'PATCH /v1/admin/flags/{key}', 'GET /v1/admin/flags/{key}/targets'],
    })}
  </div>

  <div class="card mt-16">
    <div class="card-head"><h2>后台入口信息</h2><span class="badge good no-dot">当前真实配置</span></div>
    <div class="kv-list">
      <div class="info-row"><div class="ir-label">前端入口</div><div class="ir-value mono">/admin/</div></div>
      <div class="info-row"><div class="ir-label">接口前缀</div><div class="ir-value mono">/v1/admin/*</div></div>
      <div class="info-row"><div class="ir-label">鉴权</div><div class="ir-value mono">Authorization: Bearer &lt;admin token&gt;</div></div>
      <div class="info-row"><div class="ir-label">令牌受众</div><div class="ir-value mono">platform_admin（与用户端隔离）</div></div>
      <div class="info-row"><div class="ir-label">令牌存储</div><div class="ir-value mono">localStorage · dk.admin.token</div></div>
      <div class="info-row"><div class="ir-label">登录接口</div><div class="ir-value mono">POST /v1/admin/auth/login</div></div>
    </div>
    <p class="hint mt-16">这些是前端实现的真实约定，可据此排查登录与权限问题。</p>
  </div>`;
}

export async function page({ root }) {
  root.innerHTML = shellHTML();
}
