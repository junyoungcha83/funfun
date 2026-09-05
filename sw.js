// 정적 자산 오프라인 캐시. 캐시 이름 변경 시 옛 캐시 자동 폐기.
const CACHE = 'funfun-v20';
const ASSETS = [
  './', './index.html', './assets/app.css', './assets/app.js',
  './manifest.webmanifest', './assets/icon.svg', './assets/icon-maskable.svg',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;   // API·이미지는 패스
  // 항상 최신을 받아온다(no-store) — 캐시는 오프라인 폴백 용도로만 갱신.
  e.respondWith(
    fetch(req.url, { cache: 'no-store' }).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
  );
});
