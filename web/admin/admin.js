/* 管理后台入口：路由装配、鉴权守卫、外壳同步。
 * 页面清单：#/login、#/tenants、#/tenants/:id、#/billing、#/costs、#/jobs、#/risk、#/config、#/audit
 */

import { router, ui, $ } from '../assets/core.js';
import {
  adminSession,
  adminApi,
  logout,
  showShell,
  showLoginScreen,
  setActiveNav,
  setCrumb,
  setNavCount,
  setAdminChip,
} from './admin-core.js';

import * as loginPage from './pages/login.js';
import * as tenantsPage from './pages/tenants.js';
import * as tenantPage from './pages/tenant.js';
import * as jobsPage from './pages/jobs.js';
import * as billingPage from './pages/billing.js';
import * as costsPage from './pages/costs.js';
import * as riskPage from './pages/risk.js';
import * as configPage from './pages/config.js';
import * as auditPage from './pages/audit.js';

const ROOT = '#/tenants';

const PAGE_META = {
  '/tenants': '租户',
  '/billing': '订阅与计费',
  '/costs': '成本看板',
  '/jobs': '失败任务',
  '/risk': '风控',
  '/config': '平台配置',
  '/audit': '审计日志',
};

/** 鉴权守卫：无有效令牌一律回登录页，绝不渲染半个后台。 */
function guard(page, meta = {}) {
  return async (ctx) => {
    if (!adminSession.isAuthed) {
      // 从未登录过（没有令牌）时安静跳转，只有令牌过期才提示。
      logout(adminSession.token ? '登录已过期，请重新登录' : '');
      return;
    }
    showShell();
    setAdminChip(adminSession.user);
    setActiveNav(router.current().path);
    setCrumb(
      `<a href="${ROOT}">运营后台</a><span>/</span><b>${ui.esc(meta.title || PAGE_META['/tenants'])}</b>`,
    );
    await page(ctx);
  };
}

function goLogin() {
  showLoginScreen();
  if (router.current().path === '/login') router.render();
  else location.hash = '#/login';
}

/* ---------------- 路由表 ---------------- */

router.add('/login', async ({ root }) => {
  if (adminSession.isAuthed) {
    location.hash = ROOT;
    return;
  }
  await loginPage.page({ root });
});

router.add('/tenants', guard(tenantsPage.page, { title: '租户' }));
router.add('/tenants/:id', guard(tenantPage.page, { title: '租户详情' }));
router.add('/billing', guard(billingPage.page, { title: '订阅与计费' }));
router.add('/costs', guard(costsPage.page, { title: '成本看板' }));
router.add('/jobs', guard(jobsPage.page, { title: '失败任务' }));
router.add('/risk', guard(riskPage.page, { title: '风控' }));
router.add('/config', guard(configPage.page, { title: '平台配置' }));
router.add('/audit', guard(auditPage.page, { title: '审计日志' }));

/* ---------------- 启动 ---------------- */

async function loadNavCounts() {
  try {
    const jobs = await adminApi.get('/v1/admin/jobs/failed');
    setNavCount('jobs', (jobs.items || []).length);
  } catch {
    /* 侧栏计数失败不影响主流程 */
  }
}

function bindChrome() {
  const logoutBtn = $('#logout-btn');
  if (logoutBtn) {
    logoutBtn.onclick = async () => {
      logout('已退出登录');
      ui.toast('已退出登录');
    };
  }
  const reloadBtn = $('#reload-btn');
  if (reloadBtn) reloadBtn.onclick = () => router.render();

  window.addEventListener('dk:admin:logout', () => {
    goLogin();
    const reason = sessionStorage.getItem('dk.admin.reason');
    if (reason) {
      sessionStorage.removeItem('dk.admin.reason');
      ui.toast(reason, 'bad');
    }
  });
}

function boot() {
  adminSession.load();
  bindChrome();

  const { path } = router.current();
  if (!adminSession.isAuthed && path !== '/login') {
    showLoginScreen();
    location.hash = '#/login';
  } else if (adminSession.isAuthed && path === '/login') {
    location.hash = ROOT;
  } else if (adminSession.isAuthed) {
    showShell();
    setAdminChip(adminSession.user);
    loadNavCounts();
  }

  router.start($('#page'), {
    fallback: async ({ path }, root) => {
      root.innerHTML = ui.empty({
        icon: '404',
        title: '页面不存在',
        sub: path,
        action: `<a class="btn sm mt-8" href="${ROOT}">返回租户列表</a>`,
      });
    },
  });
}

boot();
