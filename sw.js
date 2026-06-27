/* TeamPro 教練戰情室 — Service Worker
   策略：
   - 導覽請求 (navigate)：network-first，離線時回 cache，再不行回 /offline.html
   - 同源靜態檔 (css/js/png)：stale-while-revalidate
   - 跨來源 / 非 GET（GAS API 等）：完全不攔截，永遠走網路（資料即時、不快取）
*/
var CACHE = 'teampro-v6';
var CORE = [
  './', 'index.html', 'app.html', 'join.html', 'school.html', 'principal.html', 'handover.html',
  'style.css?v=20260627-shell1', 'app-shell.20260627b.css', 'api.js?v=20260627-shell1', 'app-shell.20260627c.js',
  'app-modules/dashboard.js?v=20260627-shell3', 'app-modules/legacy-frame.js',
  'app-full.html', 'app-full-extra.20260627a.css', 'app-full.20260627b.js',
  'role-portal.css?v=20260627-role1', 'school-tools.js?v=20260627-role1', 'pwa.js?v=20260627-shell1', 'offline.html',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
  'assets/logo.webp'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (cache) {
      // 個別加入，單一檔 404 不會讓整個安裝失敗
      return Promise.allSettled(CORE.map(function (u) { return cache.add(new Request(u, { cache: 'reload' })); }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  // 只處理同源 GET；POST 與跨來源（GAS API、字型等）一律放行走網路
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 導覽：network-first → cache → 離線頁
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(function (res) {
        var copy = withCacheHeader(res.clone(), 'no-cache');
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
        return withCacheHeader(res, 'no-cache');
      }).catch(function () {
        return caches.match(req).then(function (hit) { return hit || caches.match('offline.html'); });
      })
    );
    return;
  }

  // 靜態檔：stale-while-revalidate
  var isStatic = /\.(?:css|js|mjs|png|jpe?g|webp|gif|svg|ico|woff2?|ttf)$/i.test(url.pathname);
  var staticCache = isStatic ? 'public, max-age=31536000, immutable' : 'public, max-age=3600';
  e.respondWith(
    caches.match(req).then(function (hit) {
      var net = fetch(req).then(function (res) {
        if (res && res.status === 200) {
          var copy = withCacheHeader(res.clone(), staticCache);
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return withCacheHeader(res, staticCache);
      }).catch(function () { return hit; });
      return hit || net;
    })
  );
});

function withCacheHeader(res, value) {
  if (!res || !res.headers) return res;
  try {
    var headers = new Headers(res.headers);
    headers.set('Cache-Control', value);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: headers });
  } catch (e) {
    return res;
  }
}

// 讓頁面可叫 SW 立即更新
self.addEventListener('message', function (e) {
  if (e.data === 'skipWaiting') self.skipWaiting();
});
