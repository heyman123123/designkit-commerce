/* Web 工作台外壳：会话引导、登录/注册、侧边栏布局。 */

import { api, ui, session, router, ApiError } from '../assets/core.js';

const NAV = [
  { group: '生产', items: [
    { path: '/', icon: '◎', label: '工作台总览' },
    { path: '/projects', icon: '▤', label: '项目与素材' },
    { path: '/review', icon: '✓', label: '审核队列' },
    { path: '/jobs', icon: '⚙', label: '生成任务' },
    { path: '/exports', icon: '↓', label: '导出中心' },
  ]},
  { group: '工作区', items: [
    { path: '/usage', icon: '◔', label: '用量与成本' },
    { path: '/members', icon: '☺', label: '成员' },
    { path: '/settings', icon: '⚒', label: '设置' },
  ]},
];

let routesRef = [];

export async function boot(routes) {
  routesRef = routes || routesRef;
  session.load();
  const app = document.getElementById('app');
  app.innerHTML = ui.loading('正在加载工作区…');

  if (!session.access) {
    renderAuth(app);
    return;
  }
  try {
    const ok = await ensureWorkspace();
    if (!ok) {
      renderAuth(app);
      return;
    }
    renderShell(app);
  } catch (err) {
    console.error(err);
    if (err instanceof ApiError && (err.status === 401 || err.code === 'unauthorized')) {
      session.clear();
      renderAuth(app);
      return;
    }
    app.innerHTML = ui.empty({
      icon: '⚠',
      title: '无法连接服务',
      sub: err.message || '请确认后端已启动',
      action: '<button class="btn sm mt-8" id="retry-boot">重试</button>',
    });
    const b = document.getElementById('retry-boot');
    if (b) b.onclick = () => boot(routesRef);
  }
}

async function ensureWorkspace() {
  if (session.ws && session.slug) return true;
  const data = await api.get('/v1/workspaces');
  const items = (data.items || []).filter((w) => w.status !== 'deleted');
  if (items.length === 0) {
    const created = await api.post('/v1/workspaces', { name: '我的工作区' });
    const switched = await api.post(`/v1/workspaces/${created.id}/switch`);
    session.save(switched);
    return !!session.slug;
  }
  const target = items[0];
  const switched = await api.post(`/v1/workspaces/${target.id}/switch`);
  session.save(switched);
  return !!session.slug;
}

function renderAuth(app) {
  app.innerHTML = `
  <div class="auth-screen">
    <section class="auth-art">
      <div>
        <div class="brand" style="padding:0 0 30px">
          <div class="brand-mark">DK</div>
          <div class="brand-text">
            <div class="brand-name">DesignKit Commerce</div>
            <div class="brand-sub">Visual OS</div>
          </div>
        </div>
        <div class="art-title">把商品图变成<br/>能上架的全套视觉资产</div>
        <p class="art-sub">上传实拍图，自动分析卖点，生成主图、场景图与卖点图；按项目、SKU、文件夹和版本统一管理，质检通过后一键导出平台规格包。</p>
        <div class="art-points">
          <div class="art-point"><span class="art-dot"></span><span><b>一条 SKU 一条流水线</b><br/>素材、生成、质检、审核、导出全部可追溯</span></div>
          <div class="art-point"><span class="art-dot"></span><span><b>多人协作有边界</b><br/>编辑、审核、只读角色分离，租户数据行级隔离</span></div>
          <div class="art-point"><span class="art-dot"></span><span><b>成本看得见</b><br/>每次生成与导出都进入不可变用量流水</span></div>
        </div>
      </div>
      <div class="muted small">© DesignKit Commerce · 内部试用版</div>
    </section>
    <section class="auth-form-wrap">
      <div class="auth-form">
        <div class="auth-tabs" role="tablist">
          <button data-tab="login" class="active">登录</button>
          <button data-tab="register">注册新工作区</button>
        </div>
        <div id="auth-body"></div>
      </div>
    </section>
  </div>`;

  const body = document.getElementById('auth-body');
  const showLogin = () => {
    body.innerHTML = `
      <h1>欢迎回来</h1>
      <p class="auth-sub">继续处理你的商品视觉生产队列</p>
      <form id="login-form" novalidate>
        <div class="field"><label for="l-email">邮箱</label>
          <input class="input" id="l-email" type="email" autocomplete="email" placeholder="you@example.com" required></div>
        <div class="field"><label for="l-pass">密码</label>
          <input class="input" id="l-pass" type="password" autocomplete="current-password" placeholder="至少 8 位" required></div>
        <div class="error-text hidden" id="auth-err"></div>
        <button class="btn primary lg block mt-8" type="submit">登录</button>
      </form>`;
    const form = document.getElementById('login-form');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type=submit]');
      const errEl = document.getElementById('auth-err');
      errEl.classList.add('hidden');
      btn.disabled = true;
      btn.textContent = '登录中…';
      try {
        const data = await api.post('/v1/auth/login', {
          email: document.getElementById('l-email').value.trim(),
          password: document.getElementById('l-pass').value,
        });
        session.save(data);
        if (!data.workspace) await ensureWorkspace();
        boot(routesRef);
      } catch (err) {
        errEl.textContent = err.message;
        errEl.classList.remove('hidden');
        btn.disabled = false;
        btn.textContent = '登录';
      }
    };
  };

  const showRegister = () => {
    body.innerHTML = `
      <h1>创建工作区</h1>
      <p class="auth-sub">默认赠送 1 个 SKU 与 1 次高清导出，先跑通一条链路</p>
      <form id="reg-form" novalidate>
        <div class="field"><label for="r-name">你的称呼</label>
          <input class="input" id="r-name" placeholder="例如：小王"></div>
        <div class="field"><label for="r-email">邮箱</label>
          <input class="input" id="r-email" type="email" autocomplete="email" placeholder="you@example.com" required></div>
        <div class="field"><label for="r-pass">密码</label>
          <input class="input" id="r-pass" type="password" autocomplete="new-password" placeholder="至少 8 位" required></div>
        <div class="field"><label for="r-ws">工作区名称</label>
          <input class="input" id="r-ws" placeholder="例如：星野跨境"></div>
        <div class="error-text hidden" id="auth-err"></div>
        <button class="btn primary lg block mt-8" type="submit">创建并进入</button>
      </form>`;
    const form = document.getElementById('reg-form');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type=submit]');
      const errEl = document.getElementById('auth-err');
      errEl.classList.add('hidden');
      btn.disabled = true;
      btn.textContent = '创建中…';
      try {
        const data = await api.post('/v1/auth/register', {
          name: document.getElementById('r-name').value.trim(),
          email: document.getElementById('r-email').value.trim(),
          password: document.getElementById('r-pass').value,
          workspace_name: document.getElementById('r-ws').value.trim() || '我的工作区',
        });
        session.save(data);
        boot(routesRef);
      } catch (err) {
        errEl.textContent = err.message;
        errEl.classList.remove('hidden');
        btn.disabled = false;
        btn.textContent = '创建并进入';
      }
    };
  };

  document.querySelectorAll('.auth-tabs button').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('.auth-tabs button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      if (b.dataset.tab === 'login') showLogin();
      else showRegister();
    };
  });
  showLogin();
}

function navHTML() {
  return NAV.map((g) => `
    <div class="nav-group">${g.group}</div>
    ${g.items.map((it) => `<a class="nav-item" data-path="${it.path}" href="#${it.path}">
      <span class="ni">${it.icon}</span><span class="label">${it.label}</span>
    </a>`).join('')}
  `).join('');
}

function quotaHTML() {
  const ws = session.ws || {};
  const skuPct = ui.fmt.pct(ws.sku_used || 0, ws.sku_quota || 0);
  return `
    <div class="nav-group">配额</div>
    <div style="padding:0 10px 8px">
      <div class="row between small muted"><span>SKU</span><span class="mono">${ws.sku_used || 0}/${ws.sku_quota || 0}</span></div>
      <div class="progress mt-8"><i style="width:${skuPct}"></i></div>
      <div class="row between small muted mt-8"><span>导出</span><span class="mono">${ws.export_used || 0}/${ws.export_quota || 0}</span></div>
      <div class="progress mt-8"><i style="width:${ui.fmt.pct(ws.export_used || 0, ws.export_quota || 0)}"></i></div>
      <a class="btn sm block mt-8" href="#/usage">查看用量 / 升级</a>
    </div>`;
}

function renderShell(app) {
  const ws = session.ws || {};
  const user = session.user || {};
  const initial = (user.name || user.email || 'U').slice(0, 1).toUpperCase();
  app.innerHTML = `
  <div class="shell">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark">DK</div>
        <div class="brand-text"><div class="brand-name">DesignKit</div><div class="brand-sub">Visual OS</div></div>
      </div>
      <button class="ws-switch" id="ws-switch" title="切换工作区">
        <span class="avatar" style="width:22px;height:22px;flex:0 0 22px;font-size:10px">${ui.esc((ws.name || 'W').slice(0, 1))}</span>
        <span class="ws-meta"><span class="ws-name">${ui.esc(ws.name || '工作区')}</span><span class="ws-plan">${ui.esc(ui.label(ws.plan))}</span></span>
        <span class="chev muted">⌄</span>
      </button>
      <nav class="nav">${navHTML()}</nav>
      <div class="sidebar-foot">
        ${quotaHTML()}
        <div class="divider" style="margin:10px 0"></div>
        <div class="user-chip">
          <span class="avatar">${ui.esc(initial)}</span>
          <span class="u-meta"><span class="u-name">${ui.esc(user.name || '未命名')}</span><span class="u-mail">${ui.esc(user.email || '')}</span></span>
        </div>
        <button class="btn ghost sm block" id="logout-btn">退出登录</button>
      </div>
    </aside>
    <main class="main">
      <header class="topbar">
        <div class="crumb" id="crumb"></div>
        <div class="spacer"></div>
        <button class="btn sm" id="top-new-sku">+ 新建 SKU</button>
        <button class="btn sm" id="top-upload">↑ 上传素材</button>
      </header>
      <div class="content" id="page"></div>
    </main>
  </div>`;

  document.getElementById('logout-btn').onclick = async () => {
    const ok = await ui.confirm({ title: '退出登录', message: '本地令牌会清除，需要重新登录。', confirmLabel: '退出' });
    if (!ok) return;
    session.clear();
    location.hash = '#/';
    boot(routesRef);
  };
  document.getElementById('ws-switch').onclick = openWorkspaceSwitcher;
  document.getElementById('top-new-sku').onclick = () => {
    if (location.hash.startsWith('#/projects/')) {
      window.dispatchEvent(new CustomEvent('dk:new-sku'));
      return;
    }
    ui.toast('先进入一个项目，再新建 SKU');
    location.hash = '#/projects';
  };
  document.getElementById('top-upload').onclick = () => {
    if (location.hash.startsWith('#/skus/')) {
      window.dispatchEvent(new CustomEvent('dk:upload'));
      return;
    }
    ui.toast('先打开一个 SKU，再上传素材');
  };

  window.addEventListener('dk:logout', () => {
    session.clear();
    boot(routesRef);
  });

  const page = document.getElementById('page');
  updateActive();

  router.routes = [];
  routesRef.forEach(([pattern, pageFn, meta]) => router.add(pattern, pageFn, meta));
  router.start(page, {
    fallback({ path }, root) {
      root.innerHTML = ui.empty({ icon: '404', title: '页面不存在', sub: path });
    },
  });

  window.addEventListener('hashchange', updateActive);
}

function updateActive() {
  const { path } = router.current();
  document.querySelectorAll('.nav-item').forEach((a) => {
    const p = a.dataset.path;
    const active = p === '/' ? path === '/' : path === p || path.startsWith(p + '/');
    a.classList.toggle('active', active);
  });
}

export function setCrumb(textOrHTML) {
  const el = document.getElementById('crumb');
  if (!el) return;
  el.innerHTML = typeof textOrHTML === 'string' ? textOrHTML : textOrHTML.map((x) => ui.esc(x)).join(' / ');
}

export function refreshQuotaBars() {
  const foot = document.querySelector('.sidebar-foot');
  if (!foot) return;
  const holder = document.createElement('div');
  holder.innerHTML = quotaHTML();
  const old = foot.querySelector('.nav-group');
  if (old) old.replaceWith(holder.querySelector('.nav-group'));
}

async function openWorkspaceSwitcher() {
  const data = await api.get('/v1/workspaces');
  const items = data.items || [];
  const body = document.createElement('div');
  body.innerHTML = `
    <div class="col">
      ${items.map((w) => `<button class="ws-switch" data-ws="${w.id}" style="width:100%">
        <span class="avatar" style="width:22px;height:22px;flex:0 0 22px;font-size:10px">${ui.esc((w.name || 'W').slice(0, 1))}</span>
        <span class="ws-meta"><span class="ws-name">${ui.esc(w.name)}</span>
        <span class="ws-plan">${ui.esc(ui.label(w.plan))} · ${ui.esc(ui.label(w.role))} · SKU ${w.sku_used}/${w.sku_quota}</span></span>
        ${w.slug === session.slug ? '<span class="badge accent">当前</span>' : ''}
      </button>`).join('')}
    </div>
    <div class="divider"></div>
    <div class="field"><label for="new-ws-name">新建工作区</label>
      <div class="row"><input class="input" id="new-ws-name" placeholder="工作区名称">
        <button class="btn" id="new-ws-btn">创建</button></div></div>`;

  const m = ui.modal({ title: '切换工作区', body });
  body.querySelectorAll('[data-ws]').forEach((b) => {
    b.onclick = async () => {
      try {
        const switched = await api.post(`/v1/workspaces/${b.dataset.ws}/switch`);
        session.save(switched);
        m.close();
        location.hash = '#/';
        boot(routesRef);
      } catch (err) {
        ui.toast(err.message, 'bad');
      }
    };
  });
  const createBtn = body.querySelector('#new-ws-btn');
  createBtn.onclick = async () => {
    const name = body.querySelector('#new-ws-name').value.trim();
    if (!name) return ui.toast('请填写工作区名称', 'bad');
    try {
      const created = await api.post('/v1/workspaces', { name });
      const switched = await api.post(`/v1/workspaces/${created.id}/switch`);
      session.save(switched);
      m.close();
      location.hash = '#/';
      boot(routesRef);
    } catch (err) {
      ui.toast(err.message, 'bad');
    }
  };
}
