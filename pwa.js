/* TeamPro PWA：Service Worker 註冊 + Android 安裝提示 + iOS 加入主畫面教學
   三個頁面（index/app/join）共用，只要 <script src="/pwa.js" defer></script> 即可。 */
(function () {
  'use strict';

  // 1) 註冊 Service Worker
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function () {/* 靜默失敗，不影響使用 */});
    });
  }

  var isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  if (isStandalone) return; // 已是 App 模式，不再提示

  var ua = navigator.userAgent || '';
  var isIOS = /iphone|ipad|ipod/i.test(ua) && !window.MSStream;
  var isAndroid = /android/i.test(ua);
  var DISMISS_KEY = 'tp_pwa_install_dismissed';
  function dismissed() { try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch (e) { return false; } }
  function setDismissed() { try { localStorage.setItem(DISMISS_KEY, '1'); } catch (e) {} }

  function el(tag, css, html) {
    var n = document.createElement(tag);
    if (css) n.style.cssText = css;
    if (html != null) n.innerHTML = html;
    return n;
  }

  // 2) Android / Chrome：beforeinstallprompt → 顯示底部安裝列
  var deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    if (dismissed()) return;
    showAndroidBar();
  });

  function showAndroidBar() {
    if (document.getElementById('tpInstallBar')) return;
    var bar = el('div', 'position:fixed;left:12px;right:12px;bottom:12px;z-index:99999;background:#171a21;border:1px solid #2a313d;border-radius:14px;padding:12px 14px;display:flex;align-items:center;gap:12px;box-shadow:0 8px 30px rgba(0,0,0,.45);font-family:-apple-system,"Noto Sans TC",Arial,sans-serif;');
    bar.id = 'tpInstallBar';
    bar.appendChild(el('img', 'width:40px;height:40px;border-radius:10px;flex:0 0 auto;', '').cloneNode());
    var img = bar.firstChild; img.src = '/icons/icon-192.png';
    var txt = el('div', 'flex:1;color:#e8edf4;font-size:14px;line-height:1.4;', '<b>把 TeamPro 加到主畫面</b><br><span style="color:#9aa6b2;font-size:12.5px;">像 App 一樣一鍵打開，更快更順手</span>');
    var go = el('button', 'background:#22c55e;color:#04140a;border:0;border-radius:10px;padding:10px 14px;font-size:14px;font-weight:700;cursor:pointer;', '安裝');
    var no = el('button', 'background:none;border:0;color:#6b7785;font-size:20px;cursor:pointer;padding:4px 6px;', '✕');
    go.onclick = function () {
      bar.remove();
      if (deferredPrompt) { deferredPrompt.prompt(); deferredPrompt = null; }
    };
    no.onclick = function () { bar.remove(); setDismissed(); };
    bar.appendChild(txt); bar.appendChild(go); bar.appendChild(no);
    document.body.appendChild(bar);
  }

  // 3) iOS Safari：沒有 beforeinstallprompt → 自製「加入主畫面」教學彈窗（首次、可關閉）
  if (isIOS && !dismissed()) {
    window.addEventListener('load', function () { setTimeout(showIOSGuide, 1800); });
  }

  function showIOSGuide() {
    if (document.getElementById('tpIosGuide')) return;
    var ov = el('div', 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.6);display:flex;align-items:flex-end;justify-content:center;font-family:-apple-system,"Noto Sans TC",Arial,sans-serif;');
    ov.id = 'tpIosGuide';
    var card = el('div', 'background:#171a21;border:1px solid #2a313d;border-radius:18px 18px 0 0;width:100%;max-width:480px;padding:20px 20px 28px;color:#e8edf4;');
    card.innerHTML =
      '<div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">' +
        '<img src="/icons/icon-192.png" style="width:46px;height:46px;border-radius:12px;">' +
        '<div><b style="font-size:16px;">把 TeamPro 裝到主畫面</b><br>' +
        '<span style="color:#9aa6b2;font-size:13px;">像 App 一樣全螢幕開啟，更像原生</span></div></div>' +
      '<ol style="margin:6px 0 16px;padding-left:20px;line-height:1.9;font-size:14.5px;color:#cfd8e3;">' +
        '<li>點下方工具列的「分享」<span style="display:inline-block;border:1px solid #2a313d;border-radius:6px;padding:0 6px;">⬆️</span></li>' +
        '<li>往下找到並點「<b>加入主畫面</b>」</li>' +
        '<li>右上角點「<b>新增</b>」即可</li>' +
      '</ol>' +
      '<button id="tpIosClose" style="width:100%;background:#22c55e;color:#04140a;border:0;border-radius:12px;padding:13px;font-size:16px;font-weight:700;cursor:pointer;">我知道了</button>';
    ov.appendChild(card);
    ov.addEventListener('click', function (e) { if (e.target === ov) { ov.remove(); setDismissed(); } });
    document.body.appendChild(ov);
    document.getElementById('tpIosClose').onclick = function () { ov.remove(); setDismissed(); };
  }
})();
