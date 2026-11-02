/* DesignKit 移动端 · Service Worker
 *
 * 只缓存静态资源；/v1/* 一律走网络，绝不缓存 API（避免把别人的数据和过期任务留在缓存里）。
 * 导航请求 network-first（离线回 index.html），静态资源 stale-while-revalidate。
 */

const CACHE = 'dk-mobile-v1';

const PRECACHE = [
  './',
  './index.html',
  './mobile.css',
  './app.js',
  './api.js',
  './ui.js',
  './media.js',
  './screens-login.js',
  './screens-skus.js',
  './screens-capture.js',
  './screens-jobs.js',
  './screens-job.js',
  './screens-preview.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  /* 共享设计系统（同源、跨 /m/ 作用域，可正常缓存） */
  '../web/assets/core.js',
  '../web/assets/app.css',
];

const OFFLINE_FALLBACK = './index.html';

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      /* 逐个缓存：某个图标缺失不应该让整个安装失败 */
      await Promise.allSettled(PRECACHE.map((url) => cache.add(new Request(url, { cache: 'reload' }))));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE && k.startsWith('dk-mobile-')).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/v1/') || url.pathname.includes('/v1/')) return;
  if (url.pathname.endsWith('/sw.js')) return;

  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req));
    return;
  }
  event.respondWith(staleWhileRevalidate(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    const cached = await cache.match(req);
    if (cached) return cached;
    const fallback = await cache.match(OFFLINE_FALLBACK);
    if (fallback) return fallback;
    return new Response('当前离线，且没有缓存页面。', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req);
  const updating = fetch(req)
    .then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);
  if (cached) return cached;
  const fresh = await updating;
  if (fresh) return fresh;
  return new Response('离线且未缓存该资源', {
    status: 503,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
