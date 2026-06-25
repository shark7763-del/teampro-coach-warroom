/* TeamPro 原生能力抽象層（第四階段接線預備）
   - 在 Capacitor App 內：用原生外掛（相機/分享/QR/生物辨識/推播/離線）
   - 在一般網頁：自動降級為 Web 行為，完全不影響現有功能
   用 Capacitor.registerPlugin（免打包工具），外掛需在 D:\TeamPro-App 安裝並 cap sync 後才會在 App 生效。 */
(function (global) {
  'use strict';
  var C = global.Capacitor;
  var isNative = !!(C && C.isNativePlatform && C.isNativePlatform());
  function plugin(name) { try { return isNative && C.registerPlugin ? C.registerPlugin(name) : null; } catch (e) { return null; } }

  // 進 App 時的原生外觀（狀態列、隱藏啟動畫面）
  function ready() {
    if (!isNative) return;
    var SplashScreen = plugin('SplashScreen'); if (SplashScreen) try { SplashScreen.hide(); } catch (e) {}
    var StatusBar = plugin('StatusBar');
    if (StatusBar) try { StatusBar.setStyle({ style: 'DARK' }); StatusBar.setBackgroundColor({ color: '#0f1115' }); } catch (e) {}
  }

  // 原生分享（含分享到 LINE）；網頁降級為 navigator.share → 複製
  async function share(opts) {
    opts = opts || {};
    var Share = plugin('Share');
    if (Share) { try { await Share.share({ title: opts.title || 'TeamPro', text: opts.text || '', url: opts.url || '', dialogTitle: '分享' }); return true; } catch (e) { return false; } }
    if (global.navigator && navigator.share) { try { await navigator.share({ title: opts.title, text: opts.text, url: opts.url }); return true; } catch (e) {} }
    if (global.TP && TP.copy) { TP.copy(opts.text || opts.url || ''); return true; }
    return false;
  }

  // 拍照 / 選圖（傷勢照、訓練影格）；網頁降級為 <input type=file>
  async function takePhoto() {
    var Camera = plugin('Camera');
    if (Camera) {
      try { var r = await Camera.getPhoto({ quality: 70, resultType: 'dataUrl', source: 'CAMERA' }); return r.dataUrl || null; } catch (e) { return null; }
    }
    return await webFilePick('image/*');
  }

  // QR 掃描（綁定選手 / 家長）；網頁降級為手動輸入
  async function scanQR() {
    var Scanner = plugin('BarcodeScanner'); // @capacitor-mlkit/barcode-scanning
    if (Scanner) {
      try { var r = await Scanner.scan(); return (r && r.barcodes && r.barcodes[0] && r.barcodes[0].rawValue) || null; } catch (e) { return null; }
    }
    return global.prompt ? (global.prompt('輸入綁定碼（App 內可直接掃 QR）') || null) : null;
  }

  // 生物辨識（Face ID / 指紋）登入前驗證；網頁直接放行
  async function biometric() {
    var Bio = plugin('BiometricAuth'); // @aparajita/capacitor-biometric-auth
    if (!Bio) return true;
    try { await Bio.authenticate({ reason: '請驗證身分以登入 TeamPro', androidTitle: 'TeamPro 登入驗證' }); return true; }
    catch (e) { return false; }
  }

  // 推播註冊（FCM/APNs）：取得 token，交由後端儲存。需先在 Firebase/Apple 設定憑證。
  async function registerPush(onToken) {
    var Push = plugin('PushNotifications');
    if (!Push) return null;
    try {
      var perm = await Push.requestPermissions();
      if (perm.receive !== 'granted') return null;
      Push.addListener('registration', function (t) { if (onToken) onToken(t.value); });
      await Push.register();
      return true;
    } catch (e) { return null; }
  }

  // 離線佇列（離線點名）：存本機，恢復網路後 flush。優先用原生 Preferences，否則 localStorage。
  var QKEY = 'tp_offline_queue';
  var Prefs = plugin('Preferences');
  async function qGet() {
    if (Prefs) { try { var r = await Prefs.get({ key: QKEY }); return JSON.parse(r.value || '[]'); } catch (e) { return []; } }
    try { return JSON.parse(localStorage.getItem(QKEY) || '[]'); } catch (e) { return []; }
  }
  async function qSet(arr) {
    var v = JSON.stringify(arr || []);
    if (Prefs) { try { await Prefs.set({ key: QKEY, value: v }); return; } catch (e) {} }
    try { localStorage.setItem(QKEY, v); } catch (e) {}
  }
  async function enqueue(action, data) { var q = await qGet(); q.push({ action: action, data: data, ts: Date.now() }); await qSet(q); }
  // flush：把佇列逐筆送後端（需傳入送出函式，預設用 TP.callAuth）
  async function flushQueue(sender) {
    sender = sender || (global.TP && TP.callAuth);
    if (!sender) return { sent: 0, left: 0 };
    var q = await qGet(), left = [], sent = 0;
    for (var i = 0; i < q.length; i++) {
      try { var r = await sender(q[i].action, q[i].data); if (r && r.ok) sent++; else left.push(q[i]); }
      catch (e) { left.push(q[i]); }
    }
    await qSet(left);
    return { sent: sent, left: left.length };
  }

  function webFilePick(accept) {
    return new Promise(function (resolve) {
      var inp = document.createElement('input'); inp.type = 'file'; inp.accept = accept || '*/*';
      inp.onchange = function () {
        var f = inp.files && inp.files[0]; if (!f) return resolve(null);
        var rd = new FileReader(); rd.onload = function () { resolve(rd.result); }; rd.onerror = function () { resolve(null); }; rd.readAsDataURL(f);
      };
      inp.click();
    });
  }

  // 恢復連線自動 flush 離線佇列
  if (global.addEventListener) global.addEventListener('online', function () { flushQueue(); });

  global.TPNative = {
    isNative: isNative, ready: ready, share: share, takePhoto: takePhoto,
    scanQR: scanQR, biometric: biometric, registerPush: registerPush,
    enqueue: enqueue, flushQueue: flushQueue, queue: qGet
  };
  if (document.readyState !== 'loading') ready(); else document.addEventListener('DOMContentLoaded', ready);
})(window);
