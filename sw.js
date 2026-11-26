const CACHE_NAME = 'silent-iphone-camera-20261126-193000';
const ASSET_VER = '20261126-193000';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  `./css/style.css?v=${ASSET_VER}`,
  `./js/app.js?v=${ASSET_VER}`,
  './js/camera-engine.js',
  './js/filters.js',
  './js/ios-photos.js',
  './js/storage.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(
        ASSETS.map((url) =>
          fetch(url, { cache: 'no-store' })
            .then((res) => (res && res.ok ? cache.put(url, res) : null))
            .catch(() => null)
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// 高速起動（Stale-While-Revalidate）＋ version.json / 更新貫通(_v) は常に Network Only
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const reqUrl = new URL(event.request.url);
  if (reqUrl.origin !== self.location.origin) return;

  // version.json は常にサーバーから直接取得（キャッシュ禁止）
  if (reqUrl.pathname.endsWith('/version.json')) {
    event.respondWith(fetch(event.request, { cache: 'no-store' }));
    return;
  }

  // バージョン更新時のキャッシュ貫通リクエスト（?_v=...）は必ず最新HTMLを取得してキャッシュも差し替え
  if (reqUrl.searchParams.has('_v')) {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' })
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            const clone2 = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put('./', clone);
              cache.put('./index.html', clone2);
            });
          }
          return response;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // 通常起動・アセット取得：キャッシュがあれば0msで即返却し、裏で最新を取得してキャッシュ更新
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request)
        .then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);
      return cached || networkFetch;
    })
  );
});
