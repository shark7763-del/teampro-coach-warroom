/* ============================================================
   TeamPro 教練戰情室 — 共用前端工具（API / session / UI）
   四個頁面共用。Web App 網址存在 localStorage（教練自己貼）。
   ============================================================ */
(function (global) {
  var LS_URL = 'teampro_webapp_url';
  var LS_TOKEN = 'teampro_token';

  // 若你已部署好固定後端，可在這裡填預設 /exec 網址，使用者就不必自己貼。
  var DEFAULT_URL = 'https://script.google.com/macros/s/AKfycbxPk4FqX_xuzL3bTaNFCpCt5JKW0uGTRuhiL0FcMCaRsK3LjURenSd0VYSjXprReYw-7A/exec';

  function getUrl() { return (localStorage.getItem(LS_URL) || DEFAULT_URL || '').trim(); }
  function setUrl(u) { localStorage.setItem(LS_URL, (u || '').trim()); }
  function getToken() { return localStorage.getItem(LS_TOKEN) || ''; }
  function setToken(t) { if (t) localStorage.setItem(LS_TOKEN, t); }
  function clearToken() { localStorage.removeItem(LS_TOKEN); }

  /* 呼叫後端：用 text/plain 避免 CORS preflight（GAS 友善） */
  async function call(action, data) {
    var url = getUrl();
    if (!url) return { ok: false, error: '尚未設定後端網址（請在系統設定貼上 GAS /exec 網址）' };
    var body = Object.assign({ action: action }, data || {});
    try {
      var res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(body)
      });
      return await res.json();
    } catch (e) {
      return { ok: false, error: '連線失敗：' + e.message };
    }
  }

  /* 需登入教練的呼叫：自動帶 token */
  async function callAuth(action, data) {
    return call(action, Object.assign({ token: getToken() }, data || {}));
  }

  /* ---- 小工具 ---- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function el(tag, attrs, html) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') e.className = attrs[k]; else if (k === 'dataset') Object.assign(e.dataset, attrs[k]);
      else e.setAttribute(k, attrs[k]);
    });
    if (html != null) e.innerHTML = html;
    return e;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }
  function toast(msg, isErr) {
    var t = el('div', { class: 'toast' + (isErr ? ' err' : '') }, esc(msg));
    document.body.appendChild(t);
    requestAnimationFrame(function () { t.classList.add('show'); });
    setTimeout(function () { t.classList.remove('show'); setTimeout(function () { t.remove(); }, 300); }, 2600);
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast('已複製到剪貼簿'); }
    catch (e) {
      var ta = el('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast('已複製'); } catch (e2) { toast('複製失敗，請手動選取', true); }
      ta.remove();
    }
  }

  var KPI_DIMENSIONS = [
    { key: 'technical', name: '技術', items: [
      ['tech_accuracy', '動作準確度'], ['tech_stability', '動作穩定度'], ['tech_speed', '速度與反應'],
      ['tech_power', '力量傳遞'], ['tech_completion', '技術完成度'] ] },
    { key: 'tactical', name: '戰術', items: [
      ['tac_distance', '空間掌握'], ['tac_timing', '時機掌握'], ['tac_transition', '節奏轉換'],
      ['tac_read', '局勢判讀'], ['tac_execution', '戰術執行'] ] },
    { key: 'physical', name: '體能', items: [
      ['phy_explosive', '爆發力'], ['phy_strength', '肌力'], ['phy_endurance', '肌耐力'],
      ['phy_cardio', '心肺耐力'], ['phy_agility', '敏捷與協調'] ] },
    { key: 'mental', name: '心理', items: [
      ['men_focus', '專注力'], ['men_stress', '壓力穩定'], ['men_confidence', '自信心'],
      ['men_resilience', '挫折恢復'], ['men_motivation', '訓練動機'] ] },
    { key: 'attitude', name: '態度', items: [
      ['att_discipline', '準時與紀律'], ['att_engagement', '訓練投入'], ['att_initiative', '主動修正'],
      ['att_coachability', '接受指導'], ['att_teamwork', '團隊合作'] ] },
    { key: 'physiological', name: '生理', items: [
      ['pio_sleep', '睡眠恢復'], ['pio_spirit', '精神恢復'], ['pio_soreness', '肌肉舒適度'],
      ['pio_injury', '傷勢安全度'], ['pio_recovery', '整體恢復感'] ] }
  ];

  function lightOf(total) { var t = Number(total) || 0; return t >= 4 ? 'green' : (t >= 3 ? 'yellow' : 'red'); }
  function lightText(l) { return l === 'green' ? '綠燈' : (l === 'yellow' ? '黃燈' : '紅燈'); }

  global.TP = {
    getUrl: getUrl, setUrl: setUrl, getToken: getToken, setToken: setToken, clearToken: clearToken,
    call: call, callAuth: callAuth,
    $: $, $all: $all, el: el, esc: esc, toast: toast, copy: copy,
    KPI_DIMENSIONS: KPI_DIMENSIONS, lightOf: lightOf, lightText: lightText
  };
})(window);
