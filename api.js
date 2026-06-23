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
  // maxAthletes = 點名人數上限（硬限制）；kpiAthletes = KPI 追蹤人數（軟提示，超過建議升級）；maxTeams = 可建隊伍數
  var PLAN_LIMITS = {
    free:  { name: '免費版',  maxAthletes: 10,  kpiAthletes: 5,   maxTeams: 1,  lineNotifyPerDay: 1,          report7Days: true, report30Days: false, pdfExport: false, multiTeam: false, customKpi: false, assistantAccounts: false, upgradePlan: 'coach' },
    coach: { name: '教練版',  maxAthletes: 30,  kpiAthletes: 15,  maxTeams: 2,  lineNotifyPerDay: 'unlimited', report7Days: true, report30Days: true,  pdfExport: false, multiTeam: false, customKpi: false, assistantAccounts: false, upgradePlan: 'team' },
    team:  { name: '團隊版',  maxAthletes: 80,  kpiAthletes: 40,  maxTeams: 99, lineNotifyPerDay: 'unlimited', report7Days: true, report30Days: true,  pdfExport: true,  multiTeam: true,  customKpi: false, assistantAccounts: false, upgradePlan: 'pro' },
    pro:   { name: '專業版',  maxAthletes: 200, kpiAthletes: 100, maxTeams: 99, lineNotifyPerDay: 'unlimited', report7Days: true, report30Days: true,  pdfExport: true,  multiTeam: true,  customKpi: true,  assistantAccounts: true,  upgradePlan: 'pro' }
  };

  // 若你已部署好固定後端，可在這裡填預設 /exec 網址，使用者就不必自己貼。
  var DEFAULT_URL = 'https://script.google.com/macros/s/AKfycbzZ4TjCiK45tg99n561VAxhK_Jw62oomt-NDKRlJHEiKJf9w_MqIWsCsstREzekzng60A/exec';

  function getUrl() { return (localStorage.getItem(LS_URL) || DEFAULT_URL || '').trim(); }
  function setUrl(u) { localStorage.setItem(LS_URL, (u || '').trim()); }
  function getLineUrl() { return (localStorage.getItem('teampro_line_url') || DEFAULT_LINE_URL || '').trim(); }
  function setLineUrl(u) { localStorage.setItem('teampro_line_url', (u || '').trim()); }
  function getPlanLimits(plan) { return PLAN_LIMITS[plan] || PLAN_LIMITS.free; }
  function getToken() { return localStorage.getItem(LS_TOKEN) || ''; }
  function setToken(t) { if (t) localStorage.setItem(LS_TOKEN, t); }
  function clearToken() { localStorage.removeItem(LS_TOKEN); }

  var activeCalls = 0;
  function setApiBusy(busy) {
    activeCalls = Math.max(0, activeCalls + (busy ? 1 : -1));
    if (!document.body) return;
    var bar = document.getElementById('apiBusyBar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'apiBusyBar';
      bar.className = 'api-busy-bar';
      bar.setAttribute('role', 'progressbar');
      bar.setAttribute('aria-label', '資料處理中');
      document.body.appendChild(bar);
    }
    bar.classList.toggle('show', activeCalls > 0);
    document.body.classList.toggle('api-busy', activeCalls > 0);
  }

  /* 呼叫後端：用 text/plain 避免 CORS preflight（GAS 友善） */
  async function call(action, data) {
    var url = getUrl();
    if (!url) return { ok: false, error: '尚未設定後端網址（請在系統設定貼上 GAS /exec 網址）' };
    var body = Object.assign({ action: action }, data || {});
    setApiBusy(true);
    try {
      var res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(body)
      });
      return await res.json();
    } catch (e) {
      return { ok: false, error: '連線失敗：' + e.message };
    } finally {
      setApiBusy(false);
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
    var t = el('div', { class: 'toast' + (isErr ? ' err' : ''),
      role: isErr ? 'alert' : 'status', 'aria-live': isErr ? 'assertive' : 'polite' }, esc(msg));
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

  /* ============================================================
     KPI v2：15 題、每題含 1–5 行為錨點、每日填、戰術依運動分類換組
     - 6 面向不等題數：技術3/戰術2/體能2/心理3/態度2/生理(恢復)3 = 15
     - 戰術 2 題依 sportCategory 對應 A–E 五組
     - a = [1分,2分,3分,4分,5分] 行為錨點；q = 事件回憶提示句
     - 生理恢復 3 題同時驅動每日燈號（傷勢=1 → 紅旗）
     ============================================================ */
  var KPI2_DIMS = [
    { key: 'technical', name: '技術執行', items: [
      { k: 't_accuracy', n: '動作準確度（打得準不準）', q: '回想這週教練看你動作時：', a: [
        '常打到錯位置或錯角度，要從頭重教', '大方向對，細節常被點要修', '多數到位，偶爾 1–2 個細節被提醒',
        '幾乎都到位，只在快或累時跑掉', '又快又連續也維持準確，幾乎不被糾正'] },
      { k: 't_stability', n: '動作穩定度（站不站得住）', q: '回想踢／做完動作的瞬間：', a: [
        '做完站不住，會晃、要扶', '收腳常歪，重心容易跑掉', '慢做會穩，一快就亂',
        '連續做還站得住，偶爾小晃', '怎麼做都不晃，落地馬上接下一動'] },
      { k: 't_speed', n: '速度與反應（夠不夠快）', q: '回想這週對練／測驗：', a: [
        '明顯比對手或同學慢半拍', '偶爾跟得上，大多被搶先', '一半一半，順的時候不輸人',
        '多數時候反應夠快，能先動', '幾乎都比對方快，對手很難先打到我'] }
    ] },
    { key: 'tactical', name: '戰術理解', byCategory: true },
    { key: 'physical', name: '體能負荷', items: [
      { k: 'p_power', n: '爆發力（一下子的力量）', q: '回想這週最用力的那幾下：', a: [
        '使不出力，動作軟、沒速度', '偶爾有力，大多不夠脆', '一般，熱開後才有力',
        '多數動作有爆發、夠脆', '每一下都又快又重，自己感覺得到威力'] },
      { k: 'p_cardio', n: '心肺耐力（撐不撐得住）', q: '回想這週訓練後段：', a: [
        '沒幾下就喘到要停，撐不完', '後段明顯掉速、想偷懶', '一般，勉強撐完但很累',
        '多數時候撐得住，尾段還有力', '整堂維持強度，結束還能再加練'] }
    ] },
    { key: 'mental', name: '心理狀態', items: [
      { k: 'm_focus', n: '專注力（會不會分心）', q: '回想這週整堂課：', a: [
        '一直放空或看別處，教練要一直叫', '常分心，要提醒才拉回來', '一半專心，累了就飄',
        '多數時候專心，偶爾飄一下', '整堂一次都沒分心，連休息都在看別人打'] },
      { k: 'm_resilience', n: '挫折恢復（被電／失誤後）', q: '回想被糾正或失誤時：', a: [
        '一受挫就垮，接下來整場都散掉', '要很久才平復，一直想剛剛那球', '會難過一下，休息一下能回來',
        '失誤後幾秒就調整好，繼續打', '被打到反而更冷靜，馬上想怎麼扳回來'] },
      { k: 'm_confidence', n: '自信心（敢不敢）', q: '回想面對新動作或比賽：', a: [
        '不太敢出手，怕做錯被唸', '有點猶豫，要想很久才動', '一般，熟的動作敢、新的會縮',
        '多數時候敢嘗試，不太怕失敗', '比賽或新動作都敢拼，失敗了再試'] }
    ] },
    { key: 'attitude', name: '訓練態度', items: [
      { k: 'a_engage', n: '訓練投入（有沒有用力練）', q: '回想這週訓練：', a: [
        '常偷懶或做半套，等下課', '教練看才認真，沒看就鬆', '一般，該做的有做',
        '多數時候主動多練幾下', '每項都全力，還會自己加練'] },
      { k: 'a_coachable', n: '接受指導（聽不聽得進去）', q: '回想被糾正時：', a: [
        '被糾正會頂嘴或擺臉色，改不了', '表面聽，實際沒改', '會聽，改一下又忘',
        '聽得進去，當下會修', '主動問哪裡要改，改了還會記住'] }
    ] },
    { key: 'physiological', name: '生理恢復', daily: true, items: [
      { k: 'r_sleep', n: '睡眠恢復（睡飽沒）', q: '今天早上起床：', a: [
        '超累，像沒睡', '還是很沉，爬不起來', '普通，不算飽也不算累', '睡得不錯，有精神', '睡得很飽，精神超好'] },
      { k: 'r_soreness', n: '身體痠痛（痠不痠）', q: '今天身體感覺：', a: [
        '全身痠到影響動作', '明顯痠，練起來卡卡', '有點痠，還能練', '幾乎不痠，輕鬆', '完全不痠，身體很輕'] },
      { k: 'r_pain', n: '傷勢／疼痛（有沒有哪裡痛）', q: '今天：', a: [
        '有地方很痛，不該硬練', '有點痛，要小心', '舊傷微微感覺，可控制', '幾乎沒感覺', '完全沒問題'] }
    ] }
  ];

  // 戰術 2 題依運動分類換組
  var KPI2_TACTICAL = {
    combat: [
      { k: 'tac_timing', n: '時機掌握（抓不抓得到時機）', q: '回想這週對打：', a: [
        '永遠慢半拍，對手收腳了我才出', '偶爾抓到，大多還是被先打', '一半一半，順的時候打得到',
        '常能在對手要動的瞬間先出手', '幾乎都搶在對手前面，他一動我就到位'] },
      { k: 'tac_position', n: '距離與位置（卡不卡得到位置）', q: '回想這週對打站位：', a: [
        '常站錯位置，容易被繞到背後或被甩開', '比較好一點，但位置常被破', '偶爾失位，大多能自己救回來',
        '多數時候控好距離、先卡好位置', '幾乎都先佔好位置與距離，讓對手難進攻'] }
    ],
    endurance: [
      { k: 'tac_pace', n: '配速分配（會不會分配力氣）', q: '回想這週最近一次測驗／比賽：', a: [
        '一開始就衝太快，後段直接爆掉', '常亂掉，前後快慢不一', '大致會分配，偶爾配速跑掉',
        '多數時候配速穩，該保留有保留', '全程配速精準，該衝的點才全力衝'] },
      { k: 'tac_start', n: '起跑／出發與節奏（起得好不好）', q: '回想這週出發的瞬間：', a: [
        '出發常慢、預備動作亂掉', '偶爾起得好，大多沒抓到', '普通，狀況好才順',
        '多數時候出發快又穩', '每次都搶到先機、起跑／入水乾淨俐落'] }
    ],
    ball: [
      { k: 'tac_move', n: '跑位與卡位（站不站得到對的位置）', q: '回想這週比賽／分組：', a: [
        '常站錯位置、接應不到球', '偶爾跑對，大多慢一步', '一半一半，順的時候到得了位',
        '多數時候跑到對的位置接應／卡位', '幾乎都預判好、先到位讓隊友好傳'] },
      { k: 'tac_exec', n: '戰術執行與判讀（懂不懂怎麼打）', q: '回想這週執行戰術時：', a: [
        '不知道要打什麼戰術，亂打', '記得戰術，臨場常忘記', '記得住，照著打但不會變',
        '多數時候執行到位，偶爾能臨場調整', '能讀對手弱點，臨場就改打法'] }
    ],
    precision: [
      { k: 'tac_rhythm', n: '節奏一致性（每發穩不穩定）', q: '回想這週練習／比賽：', a: [
        '每發節奏亂、忽快忽慢', '偶爾穩，大多被自己打亂', '大致穩，壓力一來就亂',
        '多數發節奏一致，少數受干擾', '每一發節奏都一樣，幾乎不受干擾'] },
      { k: 'tac_pressure', n: '關鍵抗壓（越重要越穩嗎）', q: '回想關鍵的那幾發：', a: [
        '關鍵時手抖、明顯失常', '壓力下常掉水準', '普通，看當天狀況',
        '多數關鍵球穩得住', '越關鍵越冷靜，能定住打出水準'] }
    ],
    gymnastics: [
      { k: 'tac_flow', n: '成套銜接（順不順）', q: '回想這週走整套：', a: [
        '動作之間銜接卡、會斷掉', '大致連得起來，難度動作會頓', '一半順，狀況好才連貫',
        '多數時候流暢，少數小停頓', '整套行雲流水，銜接幾乎看不出接點'] },
      { k: 'tac_error', n: '失誤控制（失誤後救得回嗎）', q: '回想這週出現失誤時：', a: [
        '一個失誤，後面整套全亂', '失誤後勉強接回，但明顯亂', '失誤後能接回，扣一點分',
        '多數失誤馬上修，幾乎不影響後面', '就算失誤也修得讓人看不太出來'] }
    ]
  };

  // 運動分類 → 戰術組
  var SPORTCAT_TACTICAL = {
    '技擊武道': 'combat', '田徑與體能型': 'endurance', '水上運動': 'endurance',
    '球類團隊': 'ball', '球拍與隔網': 'ball', '精準與瞄準': 'precision',
    '體操與技巧表現': 'gymnastics', '綜合項目': 'combat'
  };
  function kpi2TacticalGroup(sportCategory) { return SPORTCAT_TACTICAL[String(sportCategory || '')] || 'combat'; }
  // 解析某運動分類的完整 15 題（戰術換成對應組），回傳 [{dimKey,dimName,daily,k,n,q,a}]
  function kpi2Resolve(sportCategory) {
    var out = [];
    KPI2_DIMS.forEach(function (dim) {
      var items = dim.byCategory ? (KPI2_TACTICAL[kpi2TacticalGroup(sportCategory)] || KPI2_TACTICAL.combat) : dim.items;
      items.forEach(function (it) {
        out.push({ dimKey: dim.key, dimName: dim.name, daily: !!dim.daily, k: it.k, n: it.n, q: it.q, a: it.a });
      });
    });
    return out;
  }

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
    if (light === 'green') return name + '近期出席穩定、訓練態度良好。教練會持續協助加強技術細節與訓練節奏；家長可以多給孩子肯定與鼓勵。';
    if (light === 'yellow') return name + '近期訓練狀態大致穩定，睡眠或恢復可以再留意一下。教練會協助調整訓練節奏；家長可以協助孩子規律作息、充足休息。';
    return name + '近期需要多一點支持。教練會持續關心並調整訓練安排；家長可以以鼓勵和陪伴為主，必要時再與教練聯繫，我們一起幫孩子。';
  }

  global.TP = {
    getUrl: getUrl, setUrl: setUrl, getToken: getToken, setToken: setToken, clearToken: clearToken,
    getLineUrl: getLineUrl, setLineUrl: setLineUrl,
    planLimits: PLAN_LIMITS, getPlanLimits: getPlanLimits,
    call: call, callAuth: callAuth,
    $: $, $all: $all, el: el, esc: esc, toast: toast, copy: copy,
    KPI_DIMENSIONS: KPI_DIMENSIONS, lightOf: lightOf, lightText: lightText,
    KPI2_DIMS: KPI2_DIMS, kpi2Resolve: kpi2Resolve, kpi2TacticalGroup: kpi2TacticalGroup,
    LAST_PERF_VISIBILITY: LAST_PERF_VISIBILITY, DEFAULT_LAST_PERF_VISIBILITY: DEFAULT_LAST_PERF_VISIBILITY,
    PRIVACY_REQUEST_TYPES: PRIVACY_REQUEST_TYPES, PRIVACY_REQUEST_STATUS: PRIVACY_REQUEST_STATUS,
    VISIBILITY_LABELS: VISIBILITY_LABELS, visibilityText: visibilityText, normVisibility: normVisibility,
    softLabel: softLabel, parentSummary: parentSummary
  };
})(window);
