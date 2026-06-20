/* ============================================================
   TeamPro 教練戰情室 — 共用前端工具（API / session / UI）
   四個頁面共用。Web App 網址存在 localStorage（教練自己貼）。
   ============================================================ */
(function (global) {
  var LS_URL = 'teampro_webapp_url';
  var LS_TOKEN = 'teampro_token';
  var DEFAULT_LINE_URL = 'https://line.me/R/ti/p/@529utwnh';

  /* ============================================================
     方案權限欄位（商業化核心）
     plan        = free / coach / team / pro
     playerLimit = 5    / 15    / 40   / 100   （= 下方 maxAthletes）
     ------------------------------------------------------------
     ⚠️ 重要：此處為「前端顯示用」配額表。前端可據此顯示／提示限制，
     但這些限制【不可】作為真正的存取控制——前端值可被使用者竄改。
     真正的方案驗證（人數上限、功能解鎖、到期判斷）必須一律由後端
     （Apps Script / Code.gs）在每個寫入動作時重新檢查 plan 與
     playerLimit，前端配額僅供 UX 提示之用。
     ============================================================ */
  var PLAN_LIMITS = {
    free:  { name: '免費版',  maxAthletes: 5,   lineNotifyPerDay: 1,         report7Days: true, report30Days: false, pdfExport: false, multiTeam: false, customKpi: false, assistantAccounts: false, upgradePlan: 'coach' },
    coach: { name: '教練版',  maxAthletes: 15,  lineNotifyPerDay: 'unlimited', report7Days: true, report30Days: true,  pdfExport: true,  multiTeam: false, customKpi: false, assistantAccounts: false, upgradePlan: 'team' },
    team:  { name: '團隊版',  maxAthletes: 40,  lineNotifyPerDay: 'unlimited', report7Days: true, report30Days: true,  pdfExport: true,  multiTeam: true,  customKpi: true,  assistantAccounts: false, upgradePlan: 'pro' },
    pro:   { name: '專業版',  maxAthletes: 100, lineNotifyPerDay: 'unlimited', report7Days: true, report30Days: true,  pdfExport: true,  multiTeam: true,  customKpi: true,  assistantAccounts: true,  upgradePlan: 'pro' }
  };

  // 若你已部署好固定後端，可在這裡填預設 /exec 網址，使用者就不必自己貼。
  var DEFAULT_URL = 'https://script.google.com/macros/s/AKfycbxPk4FqX_xuzL3bTaNFCpCt5JKW0uGTRuhiL0FcMCaRsK3LjURenSd0VYSjXprReYw-7A/exec';

  function getUrl() { return (localStorage.getItem(LS_URL) || DEFAULT_URL || '').trim(); }
  function setUrl(u) { localStorage.setItem(LS_URL, (u || '').trim()); }
  function getLineUrl() { return (localStorage.getItem('teampro_line_url') || DEFAULT_LINE_URL || '').trim(); }
  function setLineUrl(u) { localStorage.setItem('teampro_line_url', (u || '').trim()); }
  function getPlanLimits(plan) { return PLAN_LIMITS[plan] || PLAN_LIMITS.free; }
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
    { key: 'technical', name: '技術執行', items: [
      ['tech_accuracy', '動作準確度'], ['tech_stability', '動作穩定度'], ['tech_speed', '速度與反應'],
      ['tech_power', '力量傳遞'], ['tech_completion', '技術完成度'] ] },
    { key: 'tactical', name: '戰術理解', items: [
      ['tac_distance', '空間掌握'], ['tac_timing', '時機掌握'], ['tac_transition', '節奏轉換'],
      ['tac_read', '局勢判讀'], ['tac_execution', '戰術執行'] ] },
    { key: 'physical', name: '體能負荷', items: [
      ['phy_explosive', '爆發力'], ['phy_strength', '肌力'], ['phy_endurance', '肌耐力'],
      ['phy_cardio', '心肺耐力'], ['phy_agility', '敏捷與協調'] ] },
    { key: 'mental', name: '心理狀態', items: [
      ['men_focus', '專注力'], ['men_stress', '壓力穩定'], ['men_confidence', '自信心'],
      ['men_resilience', '挫折恢復'], ['men_motivation', '訓練動機'] ] },
    { key: 'attitude', name: '訓練態度', items: [
      ['att_discipline', '準時與紀律'], ['att_engagement', '訓練投入'], ['att_initiative', '主動修正'],
      ['att_coachability', '接受指導'], ['att_teamwork', '團隊合作'] ] },
    { key: 'physiological', name: '生理恢復', items: [
      ['pio_sleep', '睡眠恢復'], ['pio_spirit', '精神恢復'], ['pio_soreness', '肌肉舒適度'],
      ['pio_injury', '傷勢安全度'], ['pio_recovery', '整體恢復感'] ] }
  ];

  function lightOf(total) { var t = Number(total) || 0; return t >= 4 ? 'green' : (t >= 3 ? 'yellow' : 'red'); }
  function lightText(l) { return l === 'green' ? '綠燈' : (l === 'yellow' ? '黃燈' : '紅燈'); }

  /* ============================================================
     隱私／權限相關常數與共用函式（全站一致，避免各頁規則不同步）
     ============================================================ */
  // 「上次表現」可見範圍。預設 self_coach_only：只有選手本人與主教練可看完整內容。
  var LAST_PERF_VISIBILITY = {
    SELF_COACH_ONLY: 'self_coach_only',   // 選手本人 + 主教練
    COACH_ASSISTANT: 'coach_assistant',   // 主教練 + 有權限助教
    PARENT_SUMMARY_ONLY: 'parent_summary_only', // 家長只看整理後摘要
    ANONYMOUS_STATS: 'anonymous_stats'    // 只進匿名團隊統計
  };
  var DEFAULT_LAST_PERF_VISIBILITY = LAST_PERF_VISIBILITY.SELF_COACH_ONLY;
  // 白話標籤（給教練端下拉與名單 badge 用）
  var VISIBILITY_LABELS = {
    self_coach_only: '只有我和選手本人', coach_assistant: '我和有權限助教',
    parent_summary_only: '家長可看摘要', anonymous_stats: '僅匿名統計'
  };
  function visibilityText(v) { return VISIBILITY_LABELS[v] || VISIBILITY_LABELS.self_coach_only; }
  function normVisibility(v) { return VISIBILITY_LABELS[v] ? v : DEFAULT_LAST_PERF_VISIBILITY; }

  // 隱私請求型別/狀態（資料隱藏、刪除、更正、停止使用）
  var PRIVACY_REQUEST_TYPES = ['hide_record', 'delete_record', 'correct_data', 'stop_use'];
  var PRIVACY_REQUEST_STATUS = ['pending', 'handled', 'rejected'];

  // 負面標籤 → 保護性說法（只改顯示文字，不影響資料邏輯與判斷條件）
  var SOFT_LABELS = {
    '紅燈選手': '今日需要關心', '連續下降選手': '近期需要支持', '未繳選手': '尚未完成回報',
    '退步': '需要加強', '狀態差': '狀態需關注', '心理低落': '情緒需要支持', '表現不好': '表現待穩定'
  };
  function softLabel(s) { var t = String(s == null ? '' : s); Object.keys(SOFT_LABELS).forEach(function (k) { t = t.split(k).join(SOFT_LABELS[k]); }); return t; }

  /* 家長端摘要：把原始訓練資料轉成「溫和、無原始分數/負面文字/敏感資料」的家長可看摘要。
     opts: { name, light: 'green'|'yellow'|'red', private: true 表示涉私密狀態 } */
  function parentSummary(opts) {
    opts = opts || {};
    var name = (opts.name && String(opts.name).trim()) || '孩子';
    if (opts.private) return '本週' + name + '有部分訓練狀態已由教練關心追蹤，詳細內容將由教練視情況與家長溝通。';
    var light = opts.light || 'green';
    if (light === 'green') return name + '近期訓練出席穩定，態度表現良好。教練將持續協助加強技術細節與訓練節奏。';
    if (light === 'yellow') return name + '近期訓練狀態大致穩定，教練會持續關心訓練節奏與恢復狀況，建議家長以鼓勵和陪伴為主。';
    return name + '近期訓練狀態需要支持，教練會持續關心與調整訓練安排，建議家長以鼓勵和陪伴為主。';
  }

  global.TP = {
    getUrl: getUrl, setUrl: setUrl, getToken: getToken, setToken: setToken, clearToken: clearToken,
    getLineUrl: getLineUrl, setLineUrl: setLineUrl,
    planLimits: PLAN_LIMITS, getPlanLimits: getPlanLimits,
    call: call, callAuth: callAuth,
    $: $, $all: $all, el: el, esc: esc, toast: toast, copy: copy,
    KPI_DIMENSIONS: KPI_DIMENSIONS, lightOf: lightOf, lightText: lightText,
    LAST_PERF_VISIBILITY: LAST_PERF_VISIBILITY, DEFAULT_LAST_PERF_VISIBILITY: DEFAULT_LAST_PERF_VISIBILITY,
    PRIVACY_REQUEST_TYPES: PRIVACY_REQUEST_TYPES, PRIVACY_REQUEST_STATUS: PRIVACY_REQUEST_STATUS,
    VISIBILITY_LABELS: VISIBILITY_LABELS, visibilityText: visibilityText, normVisibility: normVisibility,
    softLabel: softLabel, parentSummary: parentSummary
  };
})(window);
