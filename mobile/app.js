/* DesignKit 移动端 · 入口
 *
 * hash 路由 + 底部导航 + Service Worker 注册。
 * 受保护页面统一走 guard：没有访问令牌或没有工作区时回登录页。
 */

import { session, router } from '../web/assets/core.js';
import { clearAssetCache } from './api.js';
import {
  runCleanup, setTabbar, initNetworkBanner, toast, empty,
} from './ui.js';
import renderLogin from './screens-login.js';
import renderSkus from './screens-skus.js';
import renderCapture from './screens-capture.js';
import renderJobs from './screens-jobs.js';
import renderJob from './screens-job.js';
import renderPreview from './screens-preview.js';

const view = document.getElementById('view');

function guard(page, tab) {
  return async (ctx) => {
    runCleanup();
    if (!session.isAuthed || !session.ws) {
      router.go('/login');
      return;
    }
    setTabbar(tab);
    await page(ctx);
  };
}

router
  .add('/login', async (ctx) => {
    runCleanup();
    setTabbar(null);
    await renderLogin(ctx);
  })
  .add('/skus', guard(renderSkus, 'skus'))
  .add('/capture', guard(renderCapture, 'capture'))
  .add('/jobs', guard(renderJobs, 'jobs'))
  .add('/job/:id', guard(renderJob, null))
  .add('/preview/:jobId', guard(renderPreview, null));

/* 路由切换前清理上一页：轮询、触摸监听、body 滚动锁 */
window.addEventListener('hashchange', () => runCleanup());

window.addEventListener('dk:logout', (e) => {
  runCleanup();
  clearAssetCache();
  setTabbar(null);
  const msg = (e && e.detail && e.detail.message) || '登录已过期，请重新登录';
  if ((location.hash || '').replace(/^#/, '') !== '/login') {
    router.go('/login');
    toast(msg, 'bad');
  }
});

session.load();
initNetworkBanner();

router.start(view, {
  fallback: ({ path }) => {
    if (path === '/' || path === '') {
      router.go(session.isAuthed && session.ws ? '/skus' : '/login');
      return;
    }
    setTabbar(null);
    view.innerHTML = `<div class="screen">
      ${empty({
        icon: '404',
        title: '页面不存在',
        sub: path,
        action: '<button type="button" class="btn primary block lg mt-16" data-home>回到首页</button>',
      })}
    </div>`;
    view.querySelector('[data-home]').addEventListener('click', () => {
      router.go(session.isAuthed && session.ws ? '/skus' : '/login');
    });
  },
});

registerServiceWorker();

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            toast('新版本已下载，重新打开应用后生效', 'good');
          }
        });
      });
    } catch (err) {
      console.warn('Service Worker 注册失败（离线能力不可用）', err);
    }
  });
}
