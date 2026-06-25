/* TeamPro 教練戰情室 — Service Worker
   策略：
   - 導覽請求 (navigate)：network-first，離線時回 cache，再不行回 /offline.html
   - 同源靜態檔 (css/js/png)：stale-while-revalidate
   - 跨來源 / 非 GET（GAS API 等）：完全不攔截，永遠走網路（資料即時、不快取）
*/
var CACHE = 'teampro-v1';
var CORE = [
  '/', '/app', '/join', '/index.html', '/app.html', '/join.html',
  '/style.css', '/api.js', '/pwa.js', '/offline.html',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png'
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
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
        return res;
      }).catch(function () {
        return caches.match(req).then(function (hit) { return hit || caches.match('/offline.html'); });
      })
    );
    return;
  }

  // 靜態檔：stale-while-revalidate
  e.respondWith(
    caches.match(req).then(function (hit) {
      var net = fetch(req).then(function (res) {
        if (res && res.status === 200) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return hit; });
      return hit || net;
    })
  );
});

// 讓頁面可叫 SW 立即更新
self.addEventListener('message', function (e) {
  if (e.data === 'skipWaiting') self.skipWaiting();
});
