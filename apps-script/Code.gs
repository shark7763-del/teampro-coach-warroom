/* ============================================================
   TeamPro 教練戰情室 — 多租戶後端 Code.gs
   讓教練每天 3 分鐘掌握整隊狀態
   ------------------------------------------------------------
   架構：單一 GAS Web App + 單一 Google Sheet（多分頁，coachId 隔離）
   角色：platform_admin / coach / athlete(透過團隊連結，僅寫自己當日)

   ⚠️ 安全原則：
   - 教練身分一律由 session token 反推 coachId，絕不信任前端傳的 coachId/role。
   - 所有資料查詢一律以 coachId 過濾（租戶隔離）。
   - 配額檢查包在 LockService 交易內，避免併發繞過上限。

   部署：
   1. 新試算表 > 擴充功能 > Apps Script，貼上本檔。
   2. 執行一次 setup()（授權並建立所有分頁）。
   3. 設定管理者密碼：執行 setAdminPassword() 前先改下方字串。
   4. 部署 > 新增部署 > 網頁應用程式（執行身分：我；存取權：任何人）。
   5. 複製 /exec 網址，貼進四個前端的「系統設定」。
   ============================================================ */

/* ---------- 分頁名稱 ---------- */
var SHEETS = {
  coaches:  'coaches',
  sessions: 'sessions',
  teams:    'teams',
  athletes: 'athletes',
  records:  'records',
  audit:    'audit',
  contacts: 'contacts',
  privacyRequests: 'privacyRequests',
  attendance: 'attendance',
  competitions: 'competitions',
  weeklyKpi: 'weeklyKpi'
};

/* ---------- 表頭 ---------- */
var H = {
  coaches:  ['coachId', 'email', 'passwordHash', 'salt', 'name', 'plan', 'planExpiry', 'status', 'createdAt', 'lastLogin', 'paymentNote', 'settings'],
  sessions: ['token', 'coachId', 'expiresAt', 'isAsst'],
  teams:    ['teamId', 'coachId', 'teamName', 'sport', 'shareToken', 'status', 'createdAt', 'competitionSystem', 'sportCategory', 'memberTerm', 'asstPinHash', 'asstPinSalt'],
  athletes: ['athleteId', 'coachId', 'teamId', 'name', 'gradeClass', 'grp', 'active', 'createdAt', 'lastPerformanceVisibility', 'perfPinHash', 'perfPinSalt', 'kpiEnabled', 'kpiEnabledAt'],
  audit:    ['time', 'actor', 'action', 'target', 'detail'],
  contacts: ['time', 'topic', 'name', 'email', 'message'],
  privacyRequests: ['requestId', 'coachId', 'athleteId', 'athleteName', 'requestType', 'scope', 'note', 'status', 'createdAt', 'handledAt', 'resolutionNote'],
  // 快速點名：一筆=某教練某隊某日一次點名；marks 為 JSON { athleteId: {s:狀態, n:備註} }
  attendance: ['attId', 'coachId', 'teamId', 'date', 'course', 'marks', 'updatedAt'],
  // 比賽：選手回報時第一個建立、其他人用選的（同隊+日期+名稱歸戶）
  competitions: ['compId', 'coachId', 'teamId', 'date', 'name', 'location', 'createdAt']
};

/* ============================================================
   隱私／可見度設定（向後相容：不更動現有欄位，缺值一律以預設值處理）
   ------------------------------------------------------------
   lastPerformanceVisibility（「上次表現」可見範圍）預設 self_coach_only：
     - self_coach_only    ：只有選手本人與主教練可看完整內容（預設）
     - coach_assistant    ：主教練 + 有權限助教
     - parent_summary_only：家長只看整理後摘要
     - anonymous_stats    ：只進匿名團隊統計，不顯示個人原始內容
   讀取時請用 lastPerfVisibilityOf(athlete)，舊資料無此欄會回傳預設值。

   已完成：athletes 表已新增 lastPerformanceVisibility 欄位（sheet() 會自動補欄、
     舊列回空值＝預設），教練端「修改選手」可逐選手設定。

   TODO（後續再做）：
   - enforcement：parent_summary_only / anonymous_stats 對戰情室具名清單、匯出、
     排行榜的實際限制（本輪先做持久化＋設定＋標示，避免動到主畫面）。
   - 助教帳號制度（assistantAccounts）尚未實作：目前僅主教練可見完整內容，
     助教可見性待帳號系統建立後依 coach_assistant 規則開放。
   - 隱私請求已具備建立、查詢與結案流程；實際資料更正／隱藏／刪除仍由
     教練確認請求範圍後執行，避免誤刪敏感資料。
   ============================================================ */
var DEFAULT_LAST_PERF_VISIBILITY = 'self_coach_only';
var LAST_PERF_VISIBILITIES = ['self_coach_only', 'coach_assistant', 'parent_summary_only', 'anonymous_stats'];
function lastPerfVisibilityOf(a) {
  var v = a && a.lastPerformanceVisibility;
  return v && LAST_PERF_VISIBILITIES.indexOf(String(v)) !== -1 ? String(v) : DEFAULT_LAST_PERF_VISIBILITY;
}
function normVisibility(v) {
  return LAST_PERF_VISIBILITIES.indexOf(String(v)) !== -1 ? String(v) : DEFAULT_LAST_PERF_VISIBILITY;
}

/* records 欄位：基本識別 + 30 項 KPI + 計分 + 身體/心情/飲食 + 產出文字 */
var KPI_DIMENSIONS = ['technical', 'tactical', 'physical', 'mental', 'attitude', 'physiological'];
var KPI_ITEMS = [
  // 技術 technical
  'tech_accuracy', 'tech_stability', 'tech_speed', 'tech_power', 'tech_completion',
  // 戰術 tactical（通用詞：空間掌握/時機掌握/節奏轉換/局勢判讀/戰術執行）
  'tac_distance', 'tac_timing', 'tac_transition', 'tac_read', 'tac_execution',
  // 體能 physical
  'phy_explosive', 'phy_strength', 'phy_endurance', 'phy_cardio', 'phy_agility',
  // 心理 mental
  'men_focus', 'men_stress', 'men_confidence', 'men_resilience', 'men_motivation',
  // 態度 attitude
  'att_discipline', 'att_engagement', 'att_initiative', 'att_coachability', 'att_teamwork',
  // 生理 physiological
  'pio_sleep', 'pio_spirit', 'pio_soreness', 'pio_injury', 'pio_recovery'
];
var WEEKLY_KPI_HEADERS = ['weeklyKpiId', 'coachId', 'teamId', 'athleteId', 'name', 'weekStart', 'weekEnd', 'submittedAt', 'updatedAt']
  .concat(KPI_ITEMS)
  .concat(['technicalAvg', 'tacticalAvg', 'physicalAvg', 'mentalAvg', 'attitudeAvg', 'physiologicalAvg',
    'totalScore', 'status', 'qualityScore', 'qualityLabel', 'qualityReasons', 'rawJson']);
H.weeklyKpi = WEEKLY_KPI_HEADERS;

/* ===== KPI v2：15 題、不等題數、戰術依運動分類換組（計分只需 item keys，錨點在前端 api.js）===== */
var KPI2_DIM_ITEMS = {
  technical: ['t_accuracy', 't_stability', 't_speed'],
  physical: ['p_power', 'p_cardio'],
  mental: ['m_focus', 'm_resilience', 'm_confidence'],
  attitude: ['a_engage', 'a_coachable'],
  physiological: ['r_sleep', 'r_soreness', 'r_pain']
};
var KPI2_TACTICAL_ITEMS = {
  combat: ['tac_timing', 'tac_position'], endurance: ['tac_pace', 'tac_start'],
  ball: ['tac_move', 'tac_exec'], precision: ['tac_rhythm', 'tac_pressure'], gymnastics: ['tac_flow', 'tac_error']
};
var SPORTCAT_TACTICAL2 = {
  '技擊武道': 'combat', '田徑與體能型': 'endurance', '水上運動': 'endurance',
  '球類團隊': 'ball', '球拍與隔網': 'ball', '精準與瞄準': 'precision',
  '體操與技巧表現': 'gymnastics', '綜合項目': 'combat'
};
function kpi2TacticalGroup(cat) { return SPORTCAT_TACTICAL2[String(cat || '')] || 'combat'; }
function kpi2DimItems(cat) {
  return { technical: KPI2_DIM_ITEMS.technical, tactical: KPI2_TACTICAL_ITEMS[kpi2TacticalGroup(cat)],
    physical: KPI2_DIM_ITEMS.physical, mental: KPI2_DIM_ITEMS.mental,
    attitude: KPI2_DIM_ITEMS.attitude, physiological: KPI2_DIM_ITEMS.physiological };
}
function weeklyScoreV2(scores, cat) {
  var dims = kpi2DimItems(cat), dimAvg = {}, allValid = true, allSum = 0, allN = 0;
  KPI_DIMENSIONS.forEach(function (dk) {
    var keys = dims[dk], sum = 0;
    keys.forEach(function (k) {
      var v = Number(scores[k]);
      if (v < 1 || v > 5 || Math.floor(v) !== v) allValid = false; else { sum += v; allSum += v; allN++; }
    });
    dimAvg[dk] = +(sum / keys.length).toFixed(2);
  });
  return { valid: allValid, dimAvg: dimAvg, total: allN ? +(allSum / allN).toFixed(2) : 0, status: lightOf(allN ? allSum / allN : 0) };
}
/* 恢復 3 題 → 當日燈號：1=red 2=yellow ≥3=green，取最嚴重（傷勢=1 即紅旗） */
function kpi2RecoveryStatus(scores) {
  function lv(v) { v = Number(v); return v <= 1 ? 'red' : (v === 2 ? 'yellow' : 'green'); }
  return riskStatus('green', lv(scores.r_pain), lv(scores.r_sleep), lv(scores.r_soreness));
}
function isKpiV2(coachId) {
  var crow = findRow(SHEETS.coaches, 'coachId', coachId);
  if (crow === -1) return false;
  return parseSettings(readAll(SHEETS.coaches)[crow - 2].settings).kpiVersion === 'v2';
}

var RECORD_HEADERS = ['recordId', 'coachId', 'teamId', 'athleteId', 'name', 'date', 'timestamp', 'sessionType']
  .concat(KPI_ITEMS)
  .concat([
    'technicalAvg', 'tacticalAvg', 'physicalAvg', 'mentalAvg', 'attitudeAvg', 'physiologicalAvg',
    'totalScore', 'status',
    // 身體 / 飲食 / 心情
    'heightCm', 'weightKg', 'targetWeightKg', 'bmi',
    'breakfast', 'lunch', 'dinner', 'snacksDrinks', 'waterIntake', 'lateNightSnack',
    'moodIndex', 'moodReason', 'gratitude', 'reflection',
    // 三餐營養成分
    'breakfastNutri', 'lunchNutri', 'dinnerNutri',
    // 訓練課表（上午/下午/晚上）與訓練心得
    'trainingAM', 'trainingPM', 'trainingEve', 'trainingNotes',
    // 身體監控：睡眠/疲勞、傷勢
    'sleepHours', 'fatigue', 'injuryAreas', 'injuryNote',
    // 鼓勵隊友
    'encourageName', 'encourageMsg',
    // 教練回饋
    'coachComment', 'coachFeedbackAt',
    // 產出
    'nutritionAdvice', 'studentLineText', 'parentLineText', 'coachLineText',
    // 個資法同意紀錄
    'consentPrivacy', 'guardianConsent', 'consentAt', 'privacyVersion', 'consentText', 'deviceInfo',
    'rawJson',
    // 新欄位只能追加在尾端，避免既有 Sheet 的欄位位置與歷史資料錯位。
    'sleepBedTime', 'wakeTime', 'sleepQuality', 'sleepDurationMinutes', 'sleepDurationText', 'sleepRisk',
    'painStatus', 'painAreas', 'painScore', 'painImpact', 'painNote', 'painRisk',
    'waterAmount', 'sweatAmount', 'urineColor', 'hydrationRisk', 'hydrationAdvice', 'hydrationFlags',
    'reportQualityScore', 'reportQualityLabel', 'reportQualityReasons', 'coachSuggestion',
    // 比賽紀錄（選手回報時填，比賽日才有）
    'compName', 'compDate', 'compLocation', 'compResult', 'compDetail', 'compReflection', 'compAward', 'compAwardLink',
    // 教練點評時的快速整體觀察分（1-5），供 AI 成長目標做「認知落差」分析
    'coachObservation'
  ]);

/* ---------- 方案設定（寫死，不進 Sheet） ---------- */
var PLANS = {
  free: {
    name: '免費版', maxAthletes: 10, kpiAthletes: 5, maxTeams: 1, price: 0,
    lineNotifyPerDay: 1, report7Days: true, report30Days: false, pdfExport: false, multiTeam: false, customKpi: false, assistantAccounts: false,
    upgradePlan: 'coach'
  },
  coach: {
    name: '教練版', maxAthletes: 30, kpiAthletes: 15, maxTeams: 2, price: 299,
    lineNotifyPerDay: 'unlimited', report7Days: true, report30Days: true, pdfExport: false, multiTeam: false, customKpi: false, assistantAccounts: false,
    upgradePlan: 'team'
  },
  team: {
    name: '團隊版', maxAthletes: 80, kpiAthletes: 40, maxTeams: 99, price: 699,
    lineNotifyPerDay: 'unlimited', report7Days: true, report30Days: true, pdfExport: true, multiTeam: true, customKpi: false, assistantAccounts: false,
    upgradePlan: 'pro'
  },
  pro: {
    name: '專業版', maxAthletes: 200, kpiAthletes: 100, maxTeams: 99, price: 1299,
    lineNotifyPerDay: 'unlimited', report7Days: true, report30Days: true, pdfExport: true, multiTeam: true, customKpi: true, assistantAccounts: true,
    upgradePlan: 'pro'
  }
};

/* 燈號門檻（總 KPI，1–5） */
function lightOf(total) {
  var t = Number(total) || 0;
  if (t >= 4.0) return 'green';
  if (t >= 3.0) return 'yellow';
  return 'red';
}

/* ============================================================
   Web App 入口
   ============================================================ */
/* 診斷用（用網址查，key 防亂查；只回數量與日期、不回內容）。確認後可移除。 */
function debugFb(d) {
  if (String(d.key || '') !== 'tpdbg') return { ok: false, error: 'forbidden' };
  if (d.coach !== undefined) {
    var q = String(d.coach || '');
    var cs = readAll(SHEETS.coaches).filter(function (c) { return !q || String(c.name).indexOf(q) !== -1 || String(c.email).indexOf(q) !== -1; });
    return { ok: true, coachCount: cs.length, coaches: cs.slice(0, 30).map(function (c) {
      return { name: c.name, email: c.email, status: c.status, plan: c.plan, planExpiry: c.planExpiry, createdAt: c.createdAt, coachId: c.coachId };
    }) };
  }
  var name = String(d.name || '');
  var ath = readAll(SHEETS.athletes).filter(function (a) { return !name || String(a.name).indexOf(name) !== -1; });
  return { ok: true, count: ath.length, athletes: ath.slice(0, 20).map(function (a) {
    var recs = readAll(SHEETS.records).filter(function (r) { return String(r.athleteId) === String(a.athleteId); });
    var fb = recs.filter(function (r) { return String(r.coachComment || '').trim(); });
    var wk = readAll(SHEETS.weeklyKpi).filter(function (r) { return String(r.athleteId) === String(a.athleteId); });
    return { name: a.name, athleteId: a.athleteId, teamId: a.teamId, kpiEnabled: a.kpiEnabled,
      dailyRecords: recs.length, recordDates: recs.map(function (r) { return String(r.date); }),
      withFeedback: fb.length, feedbackDates: fb.map(function (r) { return String(r.date); }),
      weeklyKpi: wk.length, weeklyDates: wk.map(function (r) { return String(r.weekStart); }) };
  }) };
}

function doGet(e) {
  var p = (e && e.parameter) || {};
  try {
    return handle(p.action || 'ping', p);
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  try {
    var body = {};
    if (e && e.postData && e.postData.contents) body = JSON.parse(e.postData.contents);
    return handle(body.action || 'ping', body);
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  }
}

function handle(action, d) {
  switch (action) {
    case 'ping':            return jsonOut({ ok: true, message: 'pong', time: now() });
    case 'debugfb':         return jsonOut(debugFb(d));

    /* ---- 教練帳號 ---- */
    case 'register':        return jsonOut(register(d));
    case 'login':           return jsonOut(login(d));
    case 'me':              return jsonOut(me(d));
    case 'logout':          return jsonOut(logout(d));
    case 'updateProfile':   return jsonOut(withCoach(d, updateProfile));
    case 'changePassword':  return jsonOut(withCoach(d, changePassword));
    case 'saveSettings':    return jsonOut(withCoach(d, saveSettings));

    /* ---- 團隊 ---- */
    case 'listTeams':       return jsonOut(withCoach(d, listTeams));
    case 'createTeam':      return jsonOut(withCoach(d, createTeam));
    case 'resetShareToken': return jsonOut(withCoach(d, resetShareToken));
    case 'deleteTeam':      return jsonOut(withCoach(d, deleteTeam));

    /* ---- 選手 ---- */
    case 'listAthletes':    return jsonOut(withCoach(d, listAthletes));
    case 'addAthlete':      return jsonOut(withCoach(d, addAthlete));
    case 'bulkAddAthletes':  return jsonOut(withCoach(d, bulkAddAthletes));
    case 'setAthleteActive':return jsonOut(withCoach(d, setAthleteActive));
    case 'updateAthlete':   return jsonOut(withCoach(d, updateAthlete));
    case 'setKpiTracking':  return jsonOut(withCoach(d, setKpiTracking));
    case 'setKpiTrackingBulk': return jsonOut(withCoach(d, setKpiTrackingBulk));
    case 'deleteAthlete':   return jsonOut(withCoach(d, deleteAthlete));

    /* ---- 快速點名（跨裝置同步，存後端） ---- */
    case 'saveAttendance':  return jsonOut(withCoach(d, saveAttendance));
    case 'getAttendance':   return jsonOut(withCoach(d, getAttendance));
    case 'attendanceRange': return jsonOut(withCoach(d, attendanceRange));
    case 'setAssistantPin': return jsonOut(withCoach(d, setAssistantPin));
    case 'assistantPinStatus': return jsonOut(withCoach(d, assistantPinStatus));

    /* ---- 助教點名（團隊 token + PIN 授權，只能碰那一隊的點名） ---- */
    case 'asstInfo':          return jsonOut(asstInfo(d));
    case 'asstGetAttendance': return jsonOut(withAssistant(d, getAttendance));
    case 'asstSaveAttendance':return jsonOut(withAssistant(d, saveAttendance));
    case 'asstLogin':         return jsonOut(asstLogin(d));   // 助教全開：PIN→主教練 token
    case 'resetDemo':         return jsonOut(withCoach(d, resetDemoAction));  // Demo 帳號重置展示資料

    /* ---- 戰情室 / 報告 ---- */
    case 'warroom':         return jsonOut(withCoach(d, warroom));
    case 'athleteRecords':  return jsonOut(withCoach(d, athleteRecords));
    case 'teamReport':      return jsonOut(withCoach(d, teamReport));
    case 'athleteWeeklyKpis': return jsonOut(withCoach(d, athleteWeeklyKpis));
    case 'visitSummary':    return jsonOut(withCoach(d, visitSummary));
    case 'trialSummary':    return jsonOut(withCoach(d, trialSummary));
    case 'coachFeedback':   return jsonOut(withCoach(d, coachFeedback));

    /* ---- 個資請求 ---- */
    case 'listPrivacyRequests': return jsonOut(withCoach(d, listPrivacyRequests));
    case 'createPrivacyRequest':return jsonOut(withCoach(d, createPrivacyRequest));
    case 'resolvePrivacyRequest':return jsonOut(withCoach(d, resolvePrivacyRequest));

    /* ---- 選手填寫（公開，靠 shareToken 限定團隊） ---- */
    case 'contact':         return jsonOut(contactSubmit(d));
    case 'joinInfo':        return jsonOut(joinInfo(d));
    case 'submitRecord':    return jsonOut(submitRecord(d));
    case 'kpiFormState':    return jsonOut(kpiFormState(d));
    case 'submitWeeklyKpi': return jsonOut(submitWeeklyKpi(d));
    case 'kpi2State':       return jsonOut(kpi2State(d));
    case 'submitKpi2':      return jsonOut(submitKpi2(d));
    case 'lastRecord':      return jsonOut(lastRecord(d));
    case 'myRecords':       return jsonOut(myRecords(d));
    case 'perfPinStatus':   return jsonOut(perfPinStatus(d));
    case 'setPerfPin':      return jsonOut(setPerfPin(d));
    case 'teamCompetitions':return jsonOut(teamCompetitions(d));
    case 'uploadAwardPhoto':return jsonOut(uploadAwardPhoto(d));

    /* ---- 管理者 ---- */
    case 'adminListCoaches':return jsonOut(withAdmin(d, adminListCoaches));
    case 'adminUpdatePlan': return jsonOut(withAdmin(d, adminUpdatePlan));
    case 'adminSetStatus':  return jsonOut(withAdmin(d, adminSetStatus));
    case 'adminStats':      return jsonOut(withAdmin(d, adminStats));

    default:                return jsonOut({ ok: false, error: '未知 action：' + action });
  }
}

/* ============================================================
   通用工具
   ============================================================ */
function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function now() { return new Date().toISOString(); }
function todayStr() {
  var tz = Session.getScriptTimeZone() || 'Asia/Taipei';
  return Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
}
function weekStartOf(date) {
  var p = String(date || '').split('-');
  if (p.length !== 3) return '';
  var dt = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 12));
  if (isNaN(dt.getTime())) return '';
  var day = dt.getUTCDay();
  dt.setUTCDate(dt.getUTCDate() - (day === 0 ? 6 : day - 1));
  return Utilities.formatDate(dt, 'UTC', 'yyyy-MM-dd');
}
function addDateDays(date, days) {
  var p = String(date || '').split('-');
  var dt = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]) + Number(days || 0), 12));
  return Utilities.formatDate(dt, 'UTC', 'yyyy-MM-dd');
}
/* Sheets 會把 "2026-06-19" 自動轉成 Date 物件，讀回需正規化回 yyyy-MM-dd 字串 */
function formatDateCell(v) {
  if (v instanceof Date) {
    var tz = Session.getScriptTimeZone() || 'Asia/Taipei';
    return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  }
  return String(v == null ? '' : v);
}
function uid(prefix) {
  return (prefix || '') + Utilities.getUuid().replace(/-/g, '').slice(0, 16);
}
function getProp(k) { return PropertiesService.getScriptProperties().getProperty(k); }
function setProp(k, v) { PropertiesService.getScriptProperties().setProperty(k, v == null ? '' : String(v)); }

function ss() { return SpreadsheetApp.getActiveSpreadsheet(); }
function headersFor(name) { return name === SHEETS.records ? RECORD_HEADERS : H[name]; }

/* 取得（或建立）指定分頁，並確保表頭 */
function sheet(name) {
  var s = ss().getSheetByName(name);
  var headers = headersFor(name);
  if (!s) {
    s = ss().insertSheet(name);
    if (headers) { s.getRange(1, 1, 1, headers.length).setValues([headers]); s.setFrozenRows(1); }
    return s;
  }
  if (headers) {
    if (s.getMaxColumns() < headers.length) s.insertColumnsAfter(s.getMaxColumns(), headers.length - s.getMaxColumns());
    if (s.getLastRow() === 0 || s.getRange(1, 1).getValue() !== headers[0] ||
        s.getRange(1, headers.length).getValue() !== headers[headers.length - 1]) {
      s.getRange(1, 1, 1, headers.length).setValues([headers]);
      s.setFrozenRows(1);
    }
  }
  return s;
}

/* 讀整個分頁為物件陣列 */
function readAll(name) {
  var s = sheet(name);
  var headers = headersFor(name);
  var last = s.getLastRow();
  if (last < 2) return [];
  var vals = s.getRange(2, 1, last - 1, headers.length).getValues();
  var isRecords = (name === SHEETS.records || name === SHEETS.weeklyKpi);
  return vals.map(function (row) {
    var o = {};
    for (var i = 0; i < headers.length; i++) o[headers[i]] = row[i];
    if (name === SHEETS.records && o.date) o.date = formatDateCell(o.date); // 防 Sheets 日期型別位移
    if (name === SHEETS.weeklyKpi && o.weekStart) o.weekStart = formatDateCell(o.weekStart);
    if (name === SHEETS.weeklyKpi && o.weekEnd) o.weekEnd = formatDateCell(o.weekEnd);
    return o;
  });
}

/* 依某欄找列號（1-based sheet row），找不到回 -1 */
function findRow(name, colKey, value) {
  var s = sheet(name);
  var headers = headersFor(name);
  var col = headers.indexOf(colKey);
  if (col === -1) return -1;
  var last = s.getLastRow();
  if (last < 2) return -1;
  var vals = s.getRange(2, col + 1, last - 1, 1).getValues();
  for (var i = 0; i < vals.length; i++) if (String(vals[i][0]) === String(value)) return i + 2;
  return -1;
}

/* 物件 → 依表頭順序的列陣列 */
function toRow(name, obj) {
  var headers = headersFor(name);
  return headers.map(function (k) { var v = obj[k]; return (v === undefined || v === null) ? '' : v; });
}
function appendObj(name, obj) { sheet(name).appendRow(toRow(name, obj)); }

function audit(actor, action, target, detail) {
  try { appendObj(SHEETS.audit, { time: now(), actor: actor, action: action, target: target, detail: detail || '' }); }
  catch (e) { /* 稽核失敗不影響主流程 */ }
}

/* ============================================================
   個資請求：由教練代選手／家長建立並追蹤處理狀態
   ============================================================ */
var PRIVACY_REQUEST_TYPES = ['hide_record', 'delete_record', 'correct_data', 'stop_use'];
var PRIVACY_REQUEST_STATUSES = ['pending', 'handled', 'rejected'];

function listPrivacyRequests(c, d) {
  var rows = readAll(SHEETS.privacyRequests).filter(function (r) {
    return String(r.coachId) === String(c.coachId);
  });
  rows.sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });
  return { ok: true, requests: rows };
}

function createPrivacyRequest(c, d) {
  var athleteId = String(d.athleteId || '').trim();
  var requestType = String(d.requestType || '').trim();
  var scope = String(d.scope || '').trim();
  var note = String(d.note || '').trim();
  if (!athleteId) return { ok: false, error: '請選擇選手' };
  if (PRIVACY_REQUEST_TYPES.indexOf(requestType) === -1) return { ok: false, error: '無效的請求類型' };
  if (!scope) return { ok: false, error: '請填寫資料範圍' };

  var athlete = readAll(SHEETS.athletes).filter(function (a) {
    return String(a.athleteId) === athleteId && String(a.coachId) === String(c.coachId);
  })[0];
  if (!athlete) return { ok: false, error: '找不到選手' };

  var item = {
    requestId: uid('pr_'), coachId: c.coachId, athleteId: athleteId,
    athleteName: athlete.name, requestType: requestType, scope: scope,
    note: note, status: 'pending', createdAt: now(), handledAt: '', resolutionNote: ''
  };
  appendObj(SHEETS.privacyRequests, item);
  audit(c.email, 'createPrivacyRequest', item.requestId, athlete.name + ' / ' + requestType + ' / ' + scope);
  return { ok: true, request: item };
}

function resolvePrivacyRequest(c, d) {
  var requestId = String(d.requestId || '').trim();
  var status = String(d.status || '').trim();
  var resolutionNote = String(d.resolutionNote || '').trim();
  if (PRIVACY_REQUEST_STATUSES.indexOf(status) === -1 || status === 'pending') {
    return { ok: false, error: '結案狀態只能是已處理或已駁回' };
  }
  if (!resolutionNote) return { ok: false, error: '請填寫處理說明' };

  var item = readAll(SHEETS.privacyRequests).filter(function (r) {
    return String(r.requestId) === requestId && String(r.coachId) === String(c.coachId);
  })[0];
  if (!item) return { ok: false, error: '找不到個資請求' };
  if (String(item.status) !== 'pending') return { ok: false, error: '此請求已結案' };

  item.status = status;
  item.handledAt = now();
  item.resolutionNote = resolutionNote;
  var row = findRow(SHEETS.privacyRequests, 'requestId', requestId);
  if (row === -1) return { ok: false, error: '找不到個資請求' };
  sheet(SHEETS.privacyRequests).getRange(row, 1, 1, H.privacyRequests.length)
    .setValues([toRow(SHEETS.privacyRequests, item)]);
  audit(c.email, 'resolvePrivacyRequest', requestId, status + ' / ' + resolutionNote);
  return { ok: true, request: item };
}

/* ---------- 密碼雜湊（GAS 無 bcrypt：salt + 多輪 SHA-256） ---------- */
function hashPassword(password, salt) {
  var data = salt + '::' + password;
  for (var i = 0; i < 5000; i++) {
    var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, data + i);
    data = bytes.map(function (b) { return ((b & 0xff) + 0x100).toString(16).slice(1); }).join('');
  }
  return data;
}

/* ============================================================
   教練帳號：註冊 / 登入 / 身分
   ============================================================ */
function register(d) {
  var email = String(d.email || '').trim().toLowerCase();
  var password = String(d.password || '');
  var name = String(d.name || '').trim();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: '請輸入有效 email' };
  if (password.length < 6) return { ok: false, error: '密碼至少 6 碼' };
  if (!name) return { ok: false, error: '請輸入教練姓名' };

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (findRow(SHEETS.coaches, 'email', email) !== -1) return { ok: false, error: '此 email 已註冊' };
    var coachId = uid('c_');
    var salt = uid('s_');
    appendObj(SHEETS.coaches, {
      coachId: coachId, email: email, passwordHash: hashPassword(password, salt), salt: salt,
      name: name, plan: 'free', planExpiry: '', status: 'active', createdAt: now(), lastLogin: now()
    });
    audit(email, 'register', coachId, '');
    var token = newSession(coachId);
    return { ok: true, token: token, coach: publicCoach(coachId) };
  } finally { lock.releaseLock(); }
}

function login(d) {
  var email = String(d.email || '').trim().toLowerCase();
  var password = String(d.password || '');
  var row = findRow(SHEETS.coaches, 'email', email);
  if (row === -1) return { ok: false, error: 'email 或密碼錯誤' };
  var c = readAll(SHEETS.coaches)[row - 2];
  if (String(c.status) === 'disabled') return { ok: false, error: '帳號已停用，請聯絡客服' };
  if (hashPassword(password, c.salt) !== String(c.passwordHash)) return { ok: false, error: 'email 或密碼錯誤' };
  sheet(SHEETS.coaches).getRange(row, H.coaches.indexOf('lastLogin') + 1).setValue(now());
  var token = newSession(c.coachId);
  audit(email, 'login', c.coachId, '');
  return { ok: true, token: token, coach: publicCoach(c.coachId) };
}

function newSession(coachId, isAsst) {
  var token = uid('t_') + uid('');
  var exp = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(); // 30 天
  appendObj(SHEETS.sessions, { token: token, coachId: coachId, expiresAt: exp, isAsst: isAsst ? 'true' : '' });
  return token;
}

function logout(d) {
  var row = findRow(SHEETS.sessions, 'token', d.token || '');
  if (row !== -1) sheet(SHEETS.sessions).deleteRow(row);
  return { ok: true };
}

/* 教練自助：修改顯示名稱（會反映在發給家長的報告上） */
function updateProfile(c, d) {
  var deny = denyAsst(c); if (deny) return deny;
  var name = String(d.name || '').trim();
  if (!name) return { ok: false, error: '請輸入姓名' };
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var row = findRow(SHEETS.coaches, 'coachId', c.coachId);
    if (row === -1) return { ok: false, error: '找不到帳號' };
    sheet(SHEETS.coaches).getRange(row, H.coaches.indexOf('name') + 1).setValue(name);
    audit(c.email, 'updateProfile', c.coachId, name);
    return { ok: true, coach: publicCoach(c.coachId) };
  } finally { lock.releaseLock(); }
}

/* 教練自助：修改密碼（須驗證目前密碼，重新產生 salt） */
function changePassword(c, d) {
  var deny = denyAsst(c); if (deny) return deny;
  var current = String(d.currentPassword || '');
  var next = String(d.newPassword || '');
  if (hashPassword(current, c.salt) !== String(c.passwordHash)) return { ok: false, error: '目前密碼不正確' };
  if (next.length < 6) return { ok: false, error: '新密碼至少 6 碼' };
  if (next === current) return { ok: false, error: '新密碼不可與目前密碼相同' };
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var row = findRow(SHEETS.coaches, 'coachId', c.coachId);
    if (row === -1) return { ok: false, error: '找不到帳號' };
    var salt = uid('s_');
    var s = sheet(SHEETS.coaches);
    s.getRange(row, H.coaches.indexOf('salt') + 1).setValue(salt);
    s.getRange(row, H.coaches.indexOf('passwordHash') + 1).setValue(hashPassword(next, salt));
    audit(c.email, 'changePassword', c.coachId, '');
    return { ok: true };
  } finally { lock.releaseLock(); }
}

/* 由 token 反推教練；過期/停用都擋。回傳 coach 物件或 null */
function coachFromToken(token) {
  if (!token) return null;
  var srow = findRow(SHEETS.sessions, 'token', token);
  if (srow === -1) return null;
  var sess = readAll(SHEETS.sessions)[srow - 2];
  if (new Date(sess.expiresAt).getTime() < Date.now()) { sheet(SHEETS.sessions).deleteRow(srow); return null; }
  var crow = findRow(SHEETS.coaches, 'coachId', sess.coachId);
  if (crow === -1) return null;
  var c = readAll(SHEETS.coaches)[crow - 2];
  if (String(c.status) === 'disabled') return null;
  c._isAsst = (sess.isAsst === true || String(sess.isAsst) === 'true'); // 助教 session 標記（僅記憶體，不寫回）
  return c;
}

/* 助教 session 不可執行的動作（設定類）守門：回 true 表示要擋下 */
function denyAsst(c) {
  return c && c._isAsst ? { ok: false, error: '助教權限無法變更設定，請由主教練操作' } : null;
}

/* 包裝：需要登入教練的動作。fn(coach, data) */
function withCoach(d, fn) {
  var c = coachFromToken(d.token);
  if (!c) return { ok: false, error: 'unauthorized', needLogin: true };
  return fn(c, d);
}

function me(d) {
  var c = coachFromToken(d.token);
  if (!c) return { ok: false, error: 'unauthorized', needLogin: true };
  return { ok: true, coach: publicCoach(c.coachId), isAsst: !!c._isAsst };
}

/* 對外的教練資料（含方案、配額、是否過期） */
function publicCoach(coachId) {
  var crow = findRow(SHEETS.coaches, 'coachId', coachId);
  if (crow === -1) return null;
  var c = readAll(SHEETS.coaches)[crow - 2];
  var plan = effectivePlan(c);
  return {
    coachId: c.coachId, email: c.email, name: c.name,
    plan: c.plan, effectivePlan: plan,
    planName: PLANS[plan].name, maxAthletes: PLANS[plan].maxAthletes,
    planExpiry: c.planExpiry, expired: isExpired(c),
    activeAthletes: countActiveAthletes(coachId), createdAt: c.createdAt,
    settings: parseSettings(c.settings)
  };
}

function parseSettings(s) { try { return JSON.parse(s || '{}') || {}; } catch (e) { return {}; } }

/* 教練跨裝置設定（自訂課程清單、LINE 連結等）合併儲存 */
function saveSettings(c, d) {
  var deny = denyAsst(c); if (deny) return deny;
  var patch = d.settings || {};
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var row = findRow(SHEETS.coaches, 'coachId', c.coachId);
    if (row === -1) return { ok: false, error: '找不到帳號' };
    var cur = parseSettings(readAll(SHEETS.coaches)[row - 2].settings);
    Object.keys(patch).forEach(function (k) { cur[k] = patch[k]; });
    sheet(SHEETS.coaches).getRange(row, H.coaches.indexOf('settings') + 1).setValue(JSON.stringify(cur));
    return { ok: true, settings: cur };
  } finally { lock.releaseLock(); }
}

/* 到期 → 退回 free 行為（資料不刪、超額唯讀） */
function isExpired(c) {
  if (c.plan === 'free' || !c.planExpiry) return false;
  return new Date(c.planExpiry).getTime() < Date.now();
}
function effectivePlan(c) { return isExpired(c) ? 'free' : c.plan; }

function countActiveAthletes(coachId) {
  return readAll(SHEETS.athletes).filter(function (a) {
    return String(a.coachId) === String(coachId) && String(a.active) !== 'false' && a.active !== false;
  }).length;
}

/* ============================================================
   團隊
   ============================================================ */
function listTeams(c) {
  var teams = readAll(SHEETS.teams).filter(function (t) { return String(t.coachId) === String(c.coachId); })
    .map(function (t) {
      var has = teamHasAsstPin(t);
      var o = {}; Object.keys(t).forEach(function (k) { if (k !== 'asstPinHash' && k !== 'asstPinSalt') o[k] = t[k]; });
      o.hasAsstPin = has; // 給教練端顯示「助教 PIN 已設/未設」，不外洩 hash/salt
      return o;
    });
  return { ok: true, teams: teams };
}

function createTeam(c, d) {
  var teamName = String(d.teamName || '').trim();
  if (!teamName) return { ok: false, error: '請輸入團隊名稱' };
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var plan = effectivePlan(c);
    var limit = PLANS[plan] || PLANS.free;
    var maxTeams = limit.maxTeams || 1;
    var existingTeamCount = readAll(SHEETS.teams).filter(function (t) {
      return String(t.coachId) === String(c.coachId) && String(t.status || 'active') !== 'disabled';
    }).length;
    if (existingTeamCount >= maxTeams)
      return { ok: false, error: 'multi_team_locked', message: '目前方案最多可建立 ' + maxTeams + ' 個隊伍，升級後可管理更多隊伍。' };
    // 防呆：同教練底下不可有同名團隊（防重複建立 / 連點兩下）
    var dup = readAll(SHEETS.teams).some(function (t) {
      return String(t.coachId) === String(c.coachId) && String(t.teamName).trim() === teamName;
    });
    if (dup) return { ok: false, error: '已有同名團隊「' + teamName + '」，請換個名稱' };
    var team = {
      teamId: uid('tm_'), coachId: c.coachId, teamName: teamName,
      sport: String(d.sport || '跆拳道'), shareToken: uid('sh_'), status: 'active', createdAt: now(),
      competitionSystem: String(d.competitionSystem || ''), sportCategory: String(d.sportCategory || ''),
      memberTerm: String(d.memberTerm || '選手')
    };
    appendObj(SHEETS.teams, team);
    audit(c.email, 'createTeam', team.teamId, teamName);
    return { ok: true, team: team };
  } finally { lock.releaseLock(); }
}

function resetShareToken(c, d) {
  var row = findRow(SHEETS.teams, 'teamId', d.teamId || '');
  if (row === -1) return { ok: false, error: '找不到團隊' };
  var t = readAll(SHEETS.teams)[row - 2];
  if (String(t.coachId) !== String(c.coachId)) return { ok: false, error: 'forbidden' };
  var token = uid('sh_');
  sheet(SHEETS.teams).getRange(row, H.teams.indexOf('shareToken') + 1).setValue(token);
  audit(c.email, 'resetShareToken', d.teamId, '');
  return { ok: true, shareToken: token };
}

/* 刪除團隊（連同該隊選手與紀錄一併移除） */
function deleteTeam(c, d) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var row = findRow(SHEETS.teams, 'teamId', d.teamId || '');
    if (row === -1) return { ok: false, error: '找不到團隊' };
    var t = readAll(SHEETS.teams)[row - 2];
    if (String(t.coachId) !== String(c.coachId)) return { ok: false, error: 'forbidden' };
    var recN = deleteRowsByValue(SHEETS.records, 'teamId', d.teamId);
    var wkN = deleteRowsByValue(SHEETS.weeklyKpi, 'teamId', d.teamId);
    var athN = deleteRowsByValue(SHEETS.athletes, 'teamId', d.teamId);
    var trow = findRow(SHEETS.teams, 'teamId', d.teamId);
    if (trow !== -1) sheet(SHEETS.teams).deleteRow(trow);
    audit(c.email, 'deleteTeam', d.teamId, t.teamName + ' (選手' + athN + '/日報' + recN + '/週KPI' + wkN + ')');
    return { ok: true, deletedAthletes: athN, deletedRecords: recN, deletedWeeklyKpis: wkN };
  } finally { lock.releaseLock(); }
}

/* 刪除某欄位等於指定值的所有列（由下往上刪避免位移） */
function deleteRowsByValue(name, colKey, value) {
  var s = sheet(name);
  var headers = headersFor(name);
  var col = headers.indexOf(colKey);
  var last = s.getLastRow();
  if (col === -1 || last < 2) return 0;
  var vals = s.getRange(2, col + 1, last - 1, 1).getValues();
  var del = [];
  for (var i = 0; i < vals.length; i++) if (String(vals[i][0]) === String(value)) del.push(i + 2);
  del.sort(function (a, b) { return b - a; });
  del.forEach(function (r) { s.deleteRow(r); });
  return del.length;
}

/* ============================================================
   選手（含配額鎖）
   ============================================================ */
function listAthletes(c, d) {
  var kpiLimit = PLANS[effectivePlan(c)].kpiAthletes;
  var effectiveIds = effectiveKpiIds(c.coachId, kpiLimit);
  var reviewWeek = addDateDays(weekStartOf(todayStr()), -7);
  var completed = {};
  weeklyKpisCompat(c.coachId, '', '', reviewWeek, reviewWeek).forEach(function (x) { completed[String(x.athleteId)] = true; });
  var list = readAll(SHEETS.athletes).filter(function (a) {
    return String(a.coachId) === String(c.coachId) && (!d.teamId || String(a.teamId) === String(d.teamId));
  }).map(function (a) {
    // 不外洩 PIN 雜湊/鹽，只回是否已設定
    a.hasPerfPin = athleteHasPin(a);
    a.kpiEnabled = boolCell(a.kpiEnabled);
    a.kpiEffective = !!effectiveIds[String(a.athleteId)];
    a.kpiWeekStatus = !a.kpiEnabled ? 'disabled' : (a.kpiEffective ? (completed[String(a.athleteId)] ? 'completed' : 'due') : 'suspended');
    delete a.perfPinHash; delete a.perfPinSalt;
    return a;
  });
  return { ok: true, athletes: list, activeCount: countActiveAthletes(c.coachId), max: PLANS[effectivePlan(c)].maxAthletes,
    kpiUsed: Object.keys(effectiveIds).length, kpiEnabledCount: countKpiEnabled(c.coachId), kpiLimit: kpiLimit,
    kpiReviewWeekStart: reviewWeek, kpiReviewWeekEnd: addDateDays(reviewWeek, 6) };
}

function boolCell(v) { return v === true || String(v).toLowerCase() === 'true' || String(v) === '1'; }
function countKpiEnabled(coachId) {
  return readAll(SHEETS.athletes).filter(function (a) {
    return String(a.coachId) === String(coachId) && String(a.active) !== 'false' && a.active !== false && boolCell(a.kpiEnabled);
  }).length;
}
function effectiveKpiIds(coachId, limit) {
  var rows = readAll(SHEETS.athletes).filter(function (a) {
    return String(a.coachId) === String(coachId) && String(a.active) !== 'false' && a.active !== false && boolCell(a.kpiEnabled);
  }).sort(function (a, b) {
    return String(a.kpiEnabledAt || a.createdAt || '').localeCompare(String(b.kpiEnabledAt || b.createdAt || '')) ||
      String(a.athleteId).localeCompare(String(b.athleteId));
  });
  var ids = {};
  rows.slice(0, Number(limit || 0)).forEach(function (a) { ids[String(a.athleteId)] = true; });
  return ids;
}

function setKpiTracking(c, d) {
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var row = findRow(SHEETS.athletes, 'athleteId', d.athleteId || '');
    if (row === -1) return { ok: false, error: '找不到選手' };
    var a = readAll(SHEETS.athletes)[row - 2];
    if (String(a.coachId) !== String(c.coachId)) return { ok: false, error: 'forbidden' };
    var want = !!d.enabled;
    if (want && !boolCell(a.kpiEnabled)) {
      if (String(a.active) === 'false' || a.active === false) return { ok: false, error: '停用中的選手不能開啟 KPI 追蹤' };
      var plan = effectivePlan(c), limit = PLANS[plan].kpiAthletes;
      if (countKpiEnabled(c.coachId) >= limit)
        return { ok: false, error: 'kpi_limit_reached', limit: limit, plan: plan,
          message: PLANS[plan].name + '最多可追蹤 ' + limit + ' 位選手 KPI。' };
    }
    var s = sheet(SHEETS.athletes);
    s.getRange(row, H.athletes.indexOf('kpiEnabled') + 1).setValue(want);
    s.getRange(row, H.athletes.indexOf('kpiEnabledAt') + 1).setValue(want ? (a.kpiEnabledAt || now()) : '');
    audit(c.email, 'setKpiTracking', a.athleteId, String(want));
    return { ok: true, enabled: want, kpiUsed: countKpiEnabled(c.coachId), kpiLimit: PLANS[effectivePlan(c)].kpiAthletes };
  } finally { lock.releaseLock(); }
}

function setKpiTrackingBulk(c, d) {
  var ids = Array.isArray(d.athleteIds) ? d.athleteIds.map(String) : [];
  var unique = {}; ids.forEach(function (id) { if (id) unique[id] = true; });
  ids = Object.keys(unique).slice(0, 200);
  if (!ids.length) return { ok: false, error: '請先勾選選手' };

  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var all = readAll(SHEETS.athletes), targets = all.filter(function (a) {
      return String(a.coachId) === String(c.coachId) && !!unique[String(a.athleteId)];
    });
    if (targets.length !== ids.length) return { ok: false, error: '部分選手不存在或無權限' };
    var want = !!d.enabled;
    if (want && targets.some(function (a) { return String(a.active) === 'false' || a.active === false; }))
      return { ok: false, error: '停用中的選手不能開啟 KPI 追蹤' };

    var plan = effectivePlan(c), limit = PLANS[plan].kpiAthletes;
    if (want) {
      var after = all.filter(function (a) {
        return String(a.coachId) === String(c.coachId) && String(a.active) !== 'false' && a.active !== false &&
          (boolCell(a.kpiEnabled) || !!unique[String(a.athleteId)]);
      }).length;
      if (after > limit) return { ok: false, error: 'kpi_limit_reached', limit: limit, plan: plan,
        message: '這次會變成 ' + after + ' 位，超過' + PLANS[plan].name + ' ' + limit + ' 位 KPI 上限。請減少勾選人數。' };
    }

    var s = sheet(SHEETS.athletes), changed = 0, at = now();
    targets.forEach(function (a) {
      if (boolCell(a.kpiEnabled) === want) return;
      var row = findRow(SHEETS.athletes, 'athleteId', a.athleteId);
      s.getRange(row, H.athletes.indexOf('kpiEnabled') + 1).setValue(want);
      s.getRange(row, H.athletes.indexOf('kpiEnabledAt') + 1).setValue(want ? (a.kpiEnabledAt || at) : '');
      changed++;
    });
    audit(c.email, 'setKpiTrackingBulk', ids.join(','), String(want) + ' / changed=' + changed);
    return { ok: true, enabled: want, changed: changed, selected: ids.length,
      kpiUsed: countKpiEnabled(c.coachId), kpiLimit: limit };
  } finally { lock.releaseLock(); }
}

function addAthlete(c, d) {
  var name = String(d.name || '').trim();
  var teamId = String(d.teamId || '');
  if (!name) return { ok: false, error: '請輸入選手姓名' };
  if (teamId) {
    var trow = findRow(SHEETS.teams, 'teamId', teamId);
    if (trow === -1 || String(readAll(SHEETS.teams)[trow - 2].coachId) !== String(c.coachId))
      return { ok: false, error: '團隊不存在或無權限' };
  }
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    // 防呆：同團隊不可有同名的啟用中選手（防重複建立 / 連點兩下）
    var dup = readAll(SHEETS.athletes).some(function (a) {
      return String(a.coachId) === String(c.coachId) && String(a.teamId) === String(teamId) &&
             String(a.name).trim() === name && (String(a.active) !== 'false' && a.active !== false);
    });
    if (dup) return { ok: false, error: '此團隊已有同名選手「' + name + '」' };
    var plan = effectivePlan(c);
    var max = PLANS[plan].maxAthletes;
    if (countActiveAthletes(c.coachId) >= max) {
      var limitMessage = plan === 'free'
        ? '免費版可管理 10 位選手點名。你的隊伍已經超過免費人數，升級教練版即可管理 30 位選手。'
        : '已達 ' + PLANS[plan].name + ' 上限（' + max + ' 人），請升級方案';
      return { ok: false, error: 'plan_limit_reached', limit: max, plan: plan,
               message: limitMessage };
    }
    var a = {
      athleteId: uid('a_'), coachId: c.coachId, teamId: teamId, name: name,
      gradeClass: String(d.gradeClass || ''), grp: String(d.grp || ''), active: true, createdAt: now(),
      lastPerformanceVisibility: normVisibility(d.lastPerformanceVisibility), kpiEnabled: false, kpiEnabledAt: ''
    };
    appendObj(SHEETS.athletes, a);
    audit(c.email, 'addAthlete', a.athleteId, name);
    return { ok: true, athlete: a, activeCount: countActiveAthletes(c.coachId), max: max };
  } finally { lock.releaseLock(); }
}

function bulkAddAthletes(c, d) {
  var input = Array.isArray(d.rows) ? d.rows : [];
  if (!input.length) return { ok: false, error: '請提供匯入資料' };

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var teams = readAll(SHEETS.teams).filter(function (t) { return String(t.coachId) === String(c.coachId); });
    var teamMap = {};
    teams.forEach(function (t) {
      teamMap[String(t.teamId)] = t;
      teamMap[String(t.teamName).trim().toLowerCase()] = t;
    });

    var all = readAll(SHEETS.athletes);
    var plan = effectivePlan(c);
    var max = PLANS[plan].maxAthletes;
    var activeCount = countActiveAthletes(c.coachId);
    var remaining = max - activeCount;
    if (remaining <= 0) {
      return { ok: false, error: 'plan_limit_reached', limit: max, plan: plan,
        message: '已達 ' + PLANS[plan].name + ' 點名上限，無法再批次新增。' };
    }

    var seen = {};
    var create = [];
    var skipped = [];

    input.forEach(function (raw, idx) {
      var rowNo = Number(raw && raw.rowNo ? raw.rowNo : idx + 1);
      var name = String((raw && (raw.name || raw.athleteName)) || '').trim();
      var teamName = String((raw && (raw.teamName || raw.team)) || '').trim();
      var teamId = String((raw && raw.teamId) || '').trim();
      var gradeClass = String((raw && raw.gradeClass) || '').trim();
      var grp = String((raw && raw.grp) || '').trim();
      var vis = normVisibility((raw && raw.lastPerformanceVisibility) || '');
      if (!name) { skipped.push({ rowNo: rowNo, reason: '姓名空白' }); return; }
      var team = null;
      if (teamId && teamMap[teamId]) team = teamMap[teamId];
      if (!team && teamName) team = teamMap[teamName.toLowerCase()];
      if (!team) { skipped.push({ rowNo: rowNo, reason: '找不到團隊「' + teamName + '」' }); return; }

      var key = String(team.teamId) + '|' + name.toLowerCase();
      if (seen[key]) { skipped.push({ rowNo: rowNo, reason: '檔案內重複姓名' }); return; }
      if (create.length >= remaining) { skipped.push({ rowNo: rowNo, reason: '已達方案上限' }); return; }

      var dup = all.some(function (a) {
        return String(a.coachId) === String(c.coachId) && String(a.teamId) === String(team.teamId) &&
               String(a.name).trim().toLowerCase() === name.toLowerCase() &&
               (String(a.active) !== 'false' && a.active !== false);
      });
      if (dup) { skipped.push({ rowNo: rowNo, reason: '同團隊已有同名選手' }); return; }

      seen[key] = true;
      create.push({
        athleteId: uid('a_'), coachId: c.coachId, teamId: String(team.teamId), name: name,
        gradeClass: gradeClass, grp: grp, active: true, createdAt: now(),
        lastPerformanceVisibility: vis, kpiEnabled: false, kpiEnabledAt: ''
      });
    });

    if (!create.length) {
      return { ok: false, error: 'no_valid_rows', message: '沒有可匯入的有效資料', skipped: skipped };
    }

    create.forEach(function (a) { appendObj(SHEETS.athletes, a); });
    audit(c.email, 'bulkAddAthletes', String(create.length), JSON.stringify({ skipped: skipped.length }));
    return {
      ok: true,
      created: create.length,
      skipped: skipped.length,
      skippedRows: skipped,
      activeCount: countActiveAthletes(c.coachId),
      max: max
    };
  } finally { lock.releaseLock(); }
}

function setAthleteActive(c, d) {
  var row = findRow(SHEETS.athletes, 'athleteId', d.athleteId || '');
  if (row === -1) return { ok: false, error: '找不到選手' };
  var a = readAll(SHEETS.athletes)[row - 2];
  if (String(a.coachId) !== String(c.coachId)) return { ok: false, error: 'forbidden' };
  var want = !!d.active;
  if (want && !(String(a.active) !== 'false' && a.active !== false)) {
    // 恢復（從停用→啟用）也要檢查配額
    var lock = LockService.getScriptLock(); lock.waitLock(20000);
    try {
      var max = PLANS[effectivePlan(c)].maxAthletes;
      if (countActiveAthletes(c.coachId) >= max)
        return { ok: false, error: 'plan_limit_reached', limit: max, message: '已達上限，無法恢復' };
      sheet(SHEETS.athletes).getRange(row, H.athletes.indexOf('active') + 1).setValue(true);
    } finally { lock.releaseLock(); }
  } else {
    sheet(SHEETS.athletes).getRange(row, H.athletes.indexOf('active') + 1).setValue(want);
  }
  audit(c.email, 'setAthleteActive', d.athleteId, String(want));
  return { ok: true, activeCount: countActiveAthletes(c.coachId) };
}

/* 修改選手基本資料（姓名／年級班別／所屬團隊），用於 key 錯字或異動 */
function updateAthlete(c, d) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var row = findRow(SHEETS.athletes, 'athleteId', d.athleteId || '');
    if (row === -1) return { ok: false, error: '找不到選手' };
    var all = readAll(SHEETS.athletes);
    var a = all[row - 2];
    if (String(a.coachId) !== String(c.coachId)) return { ok: false, error: 'forbidden' };

    var name = String(d.name == null ? a.name : d.name).trim();
    if (!name) return { ok: false, error: '請輸入選手姓名' };
    var teamId = String(d.teamId == null ? a.teamId : d.teamId).trim() || a.teamId;
    // 若有指定團隊，確認該團隊屬於本教練
    if (teamId && teamId !== String(a.teamId)) {
      var trow = findRow(SHEETS.teams, 'teamId', teamId);
      if (trow === -1 || String(readAll(SHEETS.teams)[trow - 2].coachId) !== String(c.coachId))
        return { ok: false, error: '找不到團隊或無權限' };
    }
    // 同團隊不可有同名的啟用中選手（排除自己）
    var dup = all.some(function (x) {
      return String(x.athleteId) !== String(a.athleteId) &&
             String(x.coachId) === String(c.coachId) && String(x.teamId) === String(teamId) &&
             String(x.name).trim() === name && (String(x.active) !== 'false' && x.active !== false);
    });
    if (dup) return { ok: false, error: '此團隊已有同名選手「' + name + '」' };

    var s = sheet(SHEETS.athletes);
    s.getRange(row, H.athletes.indexOf('name') + 1).setValue(name);
    s.getRange(row, H.athletes.indexOf('gradeClass') + 1).setValue(String(d.gradeClass == null ? a.gradeClass : d.gradeClass));
    s.getRange(row, H.athletes.indexOf('teamId') + 1).setValue(teamId);
    if (d.lastPerformanceVisibility != null)
      s.getRange(row, H.athletes.indexOf('lastPerformanceVisibility') + 1).setValue(normVisibility(d.lastPerformanceVisibility));
    if (d.resetPerfPin) {
      s.getRange(row, H.athletes.indexOf('perfPinHash') + 1).setValue('');
      s.getRange(row, H.athletes.indexOf('perfPinSalt') + 1).setValue('');
    }
    audit(c.email, 'updateAthlete', d.athleteId, name + (d.resetPerfPin ? ' (PIN已重設)' : ''));
    return { ok: true };
  } finally { lock.releaseLock(); }
}

/* 永久刪除選手＋其所有回報紀錄（不可復原）。用於誤建或示範假資料清理 */
function deleteAthlete(c, d) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var row = findRow(SHEETS.athletes, 'athleteId', d.athleteId || '');
    if (row === -1) return { ok: false, error: '找不到選手' };
    var a = readAll(SHEETS.athletes)[row - 2];
    if (String(a.coachId) !== String(c.coachId)) return { ok: false, error: 'forbidden' };
    var recN = deleteRowsByValue(SHEETS.records, 'athleteId', d.athleteId);
    var wkN = deleteRowsByValue(SHEETS.weeklyKpi, 'athleteId', d.athleteId);
    var arow = findRow(SHEETS.athletes, 'athleteId', d.athleteId);
    if (arow !== -1) sheet(SHEETS.athletes).deleteRow(arow);
    audit(c.email, 'deleteAthlete', d.athleteId, a.name + ' (日報' + recN + '/週KPI' + wkN + ')');
    return { ok: true, deletedRecords: recN, deletedWeeklyKpis: wkN, activeCount: countActiveAthletes(c.coachId) };
  } finally { lock.releaseLock(); }
}

/* 專任教練訪視報告：一次彙總期間資料（點名/回報/傷勢…）供前端組報告 */
function visitSummary(c, d) {
  var teamId = String(d.teamId || ''), from = String(d.from || ''), to = String(d.to || '');
  var athletes = readAll(SHEETS.athletes).filter(function (a) {
    return String(a.coachId) === String(c.coachId) && (!teamId || String(a.teamId) === String(teamId)) &&
      String(a.active) !== 'false' && a.active !== false;
  });
  var aCount = athletes.length;
  var inRange = function (dt) { return (!from || String(dt) >= from) && (!to || String(dt) <= to); };
  var recs = readAll(SHEETS.records).filter(function (r) {
    return String(r.coachId) === String(c.coachId) && (!teamId || String(r.teamId) === String(teamId)) && inRange(r.date);
  });
  var visitWeekly = weeklyKpisCompat(c.coachId, teamId, '', from ? weekStartOf(from) : '', to ? weekStartOf(to) : '');
  var att = readAll(SHEETS.attendance).filter(function (a) {
    return String(a.coachId) === String(c.coachId) && (!teamId || String(a.teamId) === String(teamId)) && inRange(a.date);
  });

  var present = 0, slots = 0, courses = {};
  att.forEach(function (row) {
    var marks = {}; try { marks = JSON.parse(row.marks || '{}'); } catch (e) {}
    if (row.course) courses[row.course] = true;
    athletes.forEach(function (a) { var m = marks[a.athleteId]; if (m) { slots++; if (m.s !== 'absent' && m.s !== 'leave') present++; } });
  });
  var days = Math.max(1, Math.round((new Date(to) - new Date(from)) / 86400000) + 1);

  var injSet = {}, maxPain = 0, painParts = {}, sleepShort = 0, hydrFlag = 0, notesFilled = 0, fbCount = 0, lights = { green: 0, yellow: 0, red: 0 };
  var comps = {}, medals = { gold: 0, silver: 0, bronze: 0 }, compParts = 0, awardPhotos = [];
  recs.forEach(function (r) {
    if (r.compName && /^https?:\/\//.test(String(r.compAwardLink || ''))) awardPhotos.push({ name: r.name, comp: r.compName, url: r.compAwardLink });
    var p = Number(r.painScore) || 0;
    if (p >= 4) { injSet[r.athleteId] = true; if (p > maxPain) maxPain = p; if (r.painAreas) String(r.painAreas).split(',').forEach(function (x) { if (x && x !== '無受傷') painParts[x] = true; }); }
    if (Number(r.sleepDurationMinutes) > 0 && Number(r.sleepDurationMinutes) < 300) sleepShort++;
    if (r.hydrationRisk === 'red') hydrFlag++;
    if (String(r.trainingNotes || '').replace(/\s/g, '').length >= 4) notesFilled++;
    if (String(r.coachComment || '').trim()) fbCount++;
    var l = r.status || lightOf(r.totalScore); lights[l] = (lights[l] || 0) + 1;
    if (r.compName) {
      var k = String(r.compDate) + '|' + String(r.compName).trim();
      if (!comps[k]) comps[k] = { name: String(r.compName).trim(), date: String(r.compDate), location: r.compLocation || '', parts: [] };
      comps[k].parts.push({ name: r.name, result: r.compResult });
      compParts++;
      if (r.compResult === 'gold') medals.gold++; else if (r.compResult === 'silver') medals.silver++; else if (r.compResult === 'bronze') medals.bronze++;
    }
  });
  var compList = Object.keys(comps).map(function (k) { return comps[k]; }).sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });

  return {
    ok: true, athleteCount: aCount, days: days,
    trainingDays: att.length, courses: Object.keys(courses),
    attendanceRate: slots ? Math.round(present / slots * 100) : 0,
    reportCount: recs.length, weeklyKpiCount: visitWeekly.length,
    reportRate: (aCount && days) ? Math.min(100, Math.round(recs.length / (aCount * days) * 100)) : 0,
    notesFilled: notesFilled, feedbackCount: fbCount,
    injuryAthletes: Object.keys(injSet).length, maxPain: maxPain, painParts: Object.keys(painParts),
    sleepShort: sleepShort, hydrationFlag: hydrFlag, lights: lights,
    competitions: compList, compCount: compList.length, compParticipants: compParts, medals: medals,
    awardPhotos: awardPhotos
  };
}

/* ============================================================
   快速點名（跨裝置同步，存後端 attendance 表）
   marks JSON：{ athleteId: { s: 狀態, n: 備註 } }
   ============================================================ */
var ATT_STATUSES = ['present', 'late', 'leave', 'absent', 'early_leave', 'injured_watch', 'adjust_training'];

function attRowOf(coachId, teamId, date) {
  var all = readAll(SHEETS.attendance);
  for (var i = 0; i < all.length; i++) {
    if (String(all[i].coachId) === String(coachId) && String(all[i].teamId) === String(teamId) && String(all[i].date) === String(date))
      return { row: i + 2, obj: all[i] };
  }
  return null;
}

function saveAttendance(c, d) {
  var teamId = String(d.teamId || '');
  var date = String(d.date || todayStr());
  if (!teamId) return { ok: false, error: '請選擇隊伍' };
  var trow = findRow(SHEETS.teams, 'teamId', teamId);
  if (trow === -1 || String(readAll(SHEETS.teams)[trow - 2].coachId) !== String(c.coachId))
    return { ok: false, error: '找不到團隊或無權限' };
  var marksIn = d.marks || {}, marks = {};
  Object.keys(marksIn).forEach(function (aid) {
    var m = marksIn[aid] || {};
    var st = ATT_STATUSES.indexOf(String(m.s || m.status)) !== -1 ? String(m.s || m.status) : 'present';
    marks[String(aid)] = { s: st, n: String(m.n || m.note || '').slice(0, 200) };
  });
  var course = String(d.course || '').slice(0, 60);
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var hit = attRowOf(c.coachId, teamId, date);
    var s = sheet(SHEETS.attendance);
    if (hit) {
      s.getRange(hit.row, H.attendance.indexOf('course') + 1).setValue(course);
      s.getRange(hit.row, H.attendance.indexOf('marks') + 1).setValue(JSON.stringify(marks));
      s.getRange(hit.row, H.attendance.indexOf('updatedAt') + 1).setValue(now());
    } else {
      appendObj(SHEETS.attendance, { attId: uid('at_'), coachId: c.coachId, teamId: teamId, date: date,
        course: course, marks: JSON.stringify(marks), updatedAt: now() });
    }
    audit(c.email, 'saveAttendance', teamId, date + ' ' + course);
    return { ok: true };
  } finally { lock.releaseLock(); }
}

function getAttendance(c, d) {
  var hit = attRowOf(c.coachId, String(d.teamId || ''), String(d.date || todayStr()));
  if (!hit) return { ok: true, found: false, course: '', marks: {} };
  var marks = {};
  try { marks = JSON.parse(hit.obj.marks || '{}'); } catch (e) { marks = {}; }
  return { ok: true, found: true, course: hit.obj.course || '', marks: marks };
}

function attendanceRange(c, d) {
  var teamId = String(d.teamId || ''), from = String(d.from || ''), to = String(d.to || '');
  var rows = readAll(SHEETS.attendance).filter(function (a) {
    return String(a.coachId) === String(c.coachId) &&
      (!teamId || String(a.teamId) === String(teamId)) &&
      (!from || String(a.date) >= from) && (!to || String(a.date) <= to);
  }).map(function (a) {
    var marks = {}; try { marks = JSON.parse(a.marks || '{}'); } catch (e) {}
    return { date: a.date, teamId: a.teamId, course: a.course, marks: marks };
  }).sort(function (x, y) { return String(x.date).localeCompare(String(y.date)); });
  return { ok: true, records: rows };
}

/* ============================================================
   助教點名授權：團隊 shareToken + 4 位 PIN
   - 助教只能對「token 對應的那一隊」點名，看不到設定/方案/名單管理/KPI/回饋。
   - 認證後合成 coach context（沿用主教練 coachId 寫入），並強制 teamId = 該團隊。
   ============================================================ */
function teamHasAsstPin(t) { return !!(t && t.asstPinHash && String(t.asstPinHash).length); }

function withAssistant(d, fn) {
  var t = teamFromShareToken(d.t || d.shareToken);
  if (!t) return { ok: false, error: '連結無效或已被重設，請向教練索取新連結' };
  if (!teamHasAsstPin(t)) return { ok: false, error: '教練尚未開啟此隊的助教點名' };
  var pin = String(d.pin == null ? '' : d.pin);
  if (!pin || hashPassword(pin, t.asstPinSalt) !== String(t.asstPinHash))
    return { ok: false, error: 'PIN 不正確' };
  var c = { coachId: t.coachId, email: 'assistant:' + t.teamId };
  d.teamId = t.teamId; // 強制只能碰這一隊，忽略前端任何 teamId
  return fn(c, d);
}

function asstInfo(d) {
  var t = teamFromShareToken(d.t || d.shareToken);
  if (!t) return { ok: false, error: '連結無效或已被重設，請向教練索取新連結' };
  if (!teamHasAsstPin(t)) return { ok: false, error: '教練尚未開啟此隊的助教點名' };
  var pin = String(d.pin == null ? '' : d.pin);
  if (!pin) return { ok: true, needPin: true, teamName: t.teamName }; // 未帶 PIN：不洩漏名單
  if (hashPassword(pin, t.asstPinSalt) !== String(t.asstPinHash))
    return { ok: false, error: 'PIN 不正確' };
  var roster = readAll(SHEETS.athletes).filter(function (a) {
    return String(a.teamId) === String(t.teamId) && String(a.active) !== 'false' && a.active !== false;
  }).map(function (a) { return { athleteId: a.athleteId, name: a.name, gradeClass: a.gradeClass || '' }; });
  var courses = {};
  readAll(SHEETS.attendance).forEach(function (r) {
    if (String(r.teamId) === String(t.teamId) && r.course) courses[r.course] = true;
  });
  return { ok: true, needPin: false,
    team: { teamName: t.teamName, sport: t.sport, memberTerm: t.memberTerm || '選手' },
    roster: roster, courses: Object.keys(courses), statuses: ATT_STATUSES };
}

/* 助教全開登入：team shareToken + 4 位 PIN 正確 → 直接發一張「真正的主教練 session token」。
   ⚠️ 產品決策（使用者明確選擇）：助教＝完全比照主教練，含設定／方案訂閱／帳單／名單增刪／刪隊。
   等同用 4 位 PIN 分享完整帳號，操作在稽核上記為主教練本人；風險由教練自行承擔。 */
function asstLogin(d) {
  var t = teamFromShareToken(d.t || d.shareToken);
  if (!t) return { ok: false, error: '連結無效或已被重設，請向教練索取新連結' };
  if (!teamHasAsstPin(t)) return { ok: false, error: '教練尚未開啟此隊的助教功能' };
  var pin = String(d.pin == null ? '' : d.pin);
  if (!pin || hashPassword(pin, t.asstPinSalt) !== String(t.asstPinHash))
    return { ok: false, error: 'PIN 不正確' };
  var token = newSession(t.coachId, true);   // 標記助教 session：後端據此擋設定
  audit('assistant:' + t.teamId, 'asstLogin', t.coachId, t.teamName + '（助教登入）');
  return { ok: true, token: token, coach: publicCoach(t.coachId), isAsst: true };
}

/* 教練：設定／變更／清除該隊助教 PIN */
function setAssistantPin(c, d) {
  var teamId = String(d.teamId || '');
  var row = findRow(SHEETS.teams, 'teamId', teamId);
  if (row === -1 || String(readAll(SHEETS.teams)[row - 2].coachId) !== String(c.coachId))
    return { ok: false, error: '找不到團隊或無權限' };
  var s = sheet(SHEETS.teams);
  if (d.clear === true || d.clear === 'true') {
    s.getRange(row, H.teams.indexOf('asstPinHash') + 1).setValue('');
    s.getRange(row, H.teams.indexOf('asstPinSalt') + 1).setValue('');
    audit(c.email, 'clearAssistantPin', teamId, '');
    return { ok: true, hasPin: false };
  }
  var pin = String(d.pin || '');
  if (!/^\d{4}$/.test(pin)) return { ok: false, error: 'PIN 需為 4 位數字' };
  var salt = uid('a_');
  s.getRange(row, H.teams.indexOf('asstPinSalt') + 1).setValue(salt);
  s.getRange(row, H.teams.indexOf('asstPinHash') + 1).setValue(hashPassword(pin, salt));
  audit(c.email, 'setAssistantPin', teamId, '');
  return { ok: true, hasPin: true };
}

/* 教練：查該隊是否已設助教 PIN */
function assistantPinStatus(c, d) {
  var teamId = String(d.teamId || '');
  var row = findRow(SHEETS.teams, 'teamId', teamId);
  if (row === -1 || String(readAll(SHEETS.teams)[row - 2].coachId) !== String(c.coachId))
    return { ok: false, error: '找不到團隊或無權限' };
  return { ok: true, hasPin: teamHasAsstPin(readAll(SHEETS.teams)[row - 2]) };
}

/* ============================================================
   戰情室 / 報告
   ============================================================ */
function warroom(c, d) {
  var date = d.date || todayStr();
  var teamId = d.teamId || '';
  var athletes = readAll(SHEETS.athletes).filter(function (a) {
    return String(a.coachId) === String(c.coachId) &&
           (String(a.active) !== 'false' && a.active !== false) &&
           (!teamId || String(a.teamId) === String(teamId));
  });
  var allRecords = readAll(SHEETS.records).filter(function (r) {
    return String(r.coachId) === String(c.coachId) && String(r.date) <= String(date);
  });
  var todays = allRecords.filter(function (r) {
    return String(r.coachId) === String(c.coachId) && String(r.date) === String(date);
  });
  var byAthlete = {};
  todays.forEach(function (r) { byAthlete[String(r.athleteId)] = r; });
  var historyByAthlete = {};
  allRecords.forEach(function (r) {
    var key = String(r.athleteId);
    (historyByAthlete[key] || (historyByAthlete[key] = [])).push(r);
  });
  Object.keys(historyByAthlete).forEach(function (key) {
    historyByAthlete[key].sort(function (x, y) { return String(y.date).localeCompare(String(x.date)); });
  });
  var weeklyByAthlete = {};
  weeklyKpisCompat(c.coachId, teamId, '', '', '').forEach(function (r) {
    (weeklyByAthlete[String(r.athleteId)] || (weeklyByAthlete[String(r.athleteId)] = [])).push(r);
  });
  var kpiPeriod = kpiReviewPeriod(c.coachId, date);
  var reviewWeek = kpiPeriod.start;
  var effectiveIds = effectiveKpiIds(c.coachId, PLANS[effectivePlan(c)].kpiAthletes);
  var weeklyCompleted = 0;

  var submitted = [], missing = [], lights = { green: 0, yellow: 0, red: 0 }, encourages = [];
  var declining = [], worthEncouraging = [];
  athletes.forEach(function (a) {
    var r = byAthlete[String(a.athleteId)];
    if (r) {
      var light = r.status || riskStatus('green', r.painRisk, r.sleepRisk, r.hydrationRisk);
      var weekly = weeklyByAthlete[String(a.athleteId)] || [];
      var latestKpi = weekly[0] || null;
      var isDeclining = weekly.length >= 3 && Number(weekly[0].totalScore) < Number(weekly[1].totalScore) &&
        Number(weekly[1].totalScore) < Number(weekly[2].totalScore);
      lights[light] = (lights[light] || 0) + 1;
      submitted.push({
        athleteId: a.athleteId, name: a.name, totalScore: latestKpi ? latestKpi.totalScore : '', status: light,
        kpiWeekStart: latestKpi ? latestKpi.weekStart : '',
        moodIndex: r.moodIndex, recordId: r.recordId, declining: isDeclining,
        submittedAt: r.timestamp || '',
        sleepDurationMinutes: r.sleepDurationMinutes, sleepDurationText: r.sleepDurationText,
        sleepRisk: r.sleepRisk, painStatus: r.painStatus, painAreas: r.painAreas || r.injuryAreas,
        painScore: r.painScore, painImpact: r.painImpact, painRisk: r.painRisk,
        waterAmount: r.waterAmount, sweatAmount: r.sweatAmount, urineColor: r.urineColor,
        hydrationRisk: r.hydrationRisk, hydrationAdvice: r.hydrationAdvice,
        hydrationFlags: r.hydrationFlags, reportQualityScore: r.reportQualityScore,
        reportQualityLabel: r.reportQualityLabel, reportQualityReasons: r.reportQualityReasons,
        coachSuggestion: r.coachSuggestion
      });
      if (isDeclining) declining.push({ athleteId: a.athleteId, name: a.name });
      if (light === 'green' && latestKpi && Number(latestKpi.totalScore) >= 4.3)
        worthEncouraging.push({ athleteId: a.athleteId, name: a.name, totalScore: latestKpi.totalScore });
      if (r.encourageMsg && String(r.encourageMsg).trim())
        encourages.push({ from: a.name, to: r.encourageName || '', msg: String(r.encourageMsg) });
    } else {
      missing.push({ athleteId: a.athleteId, name: a.name });
    }
  });
  athletes.forEach(function (a) {
    if (effectiveIds[String(a.athleteId)] && (weeklyByAthlete[String(a.athleteId)] || []).some(function (x) { return String(x.weekStart) === reviewWeek; })) weeklyCompleted++;
  });
  var weeklyTotal = athletes.filter(function (a) { return effectiveIds[String(a.athleteId)]; }).length;
  return {
    ok: true, date: date,
    total: athletes.length, submittedCount: submitted.length, missingCount: missing.length,
    completionRate: athletes.length ? Math.round(submitted.length / athletes.length * 100) : 0,
    weeklyKpi: { weekStart: reviewWeek, weekEnd: kpiPeriod.end, cadence: kpiPeriod.cadence, total: weeklyTotal,
      completed: weeklyCompleted, missing: Math.max(0, weeklyTotal - weeklyCompleted),
      completionRate: weeklyTotal ? Math.round(weeklyCompleted / weeklyTotal * 100) : 0 },
    lights: lights, submitted: submitted, missing: missing, encourages: encourages,
    priority: {
      red: submitted.filter(function (s) { return s.status === 'red'; }),
      missing: missing, declining: declining, encouraging: worthEncouraging
    }
  };
}

function trialSummary(c) {
  var created = new Date(c.createdAt).getTime();
  var accountDay = created ? Math.floor((Date.now() - created) / 86400000) + 1 : 1;
  var athletes = readAll(SHEETS.athletes).filter(function (a) {
    return String(a.coachId) === String(c.coachId) && String(a.active) !== 'false' && a.active !== false;
  });
  var records = readAll(SHEETS.records).filter(function (r) { return String(r.coachId) === String(c.coachId); });
  var redIds = {};
  records.forEach(function (r) {
    if ((r.status || lightOf(r.totalScore)) === 'red') redIds[String(r.athleteId)] = true;
  });
  return {
    ok: true, visible: accountDay >= 3, accountDay: accountDay,
    athleteCount: athletes.length, reportCount: records.length,
    redAthleteCount: Object.keys(redIds).length,
    estimatedMinutes: Math.max(10, records.length * 2),
    upgradeMessage: '升級教練版，每月 299 元，持續使用家長通知、歷史趨勢與成果報告。'
  };
}

function athleteRecords(c, d) {
  var aId = String(d.athleteId || '');
  var arow = findRow(SHEETS.athletes, 'athleteId', aId);
  if (arow === -1 || String(readAll(SHEETS.athletes)[arow - 2].coachId) !== String(c.coachId))
    return { ok: false, error: 'forbidden' };
  var recs = readAll(SHEETS.records).filter(function (r) {
    return String(r.coachId) === String(c.coachId) && String(r.athleteId) === aId;
  }).sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
  return { ok: true, records: recs.slice(0, Number(d.limit || 30)) };
}

/* 教練對某筆紀錄寫回饋 / 建議 */
function coachFeedback(c, d) {
  var recId = String(d.recordId || '');
  if (!recId) return { ok: false, error: '缺少 recordId' };
  var row = findRow(SHEETS.records, 'recordId', recId);
  if (row === -1) return { ok: false, error: '找不到紀錄（可能是舊資料）' };
  var rec = readAll(SHEETS.records)[row - 2];
  if (String(rec.coachId) !== String(c.coachId)) return { ok: false, error: 'forbidden' };
  sheet(SHEETS.records).getRange(row, RECORD_HEADERS.indexOf('coachComment') + 1).setValue(d.feedback || '');
  sheet(SHEETS.records).getRange(row, RECORD_HEADERS.indexOf('coachFeedbackAt') + 1).setValue(now());
  // 快速整體觀察分（1-5；空字串=清除）
  if (d.coachObservation !== undefined) {
    var obs = String(d.coachObservation || '');
    if (obs === '' || /^[1-5]$/.test(obs))
      sheet(SHEETS.records).getRange(row, RECORD_HEADERS.indexOf('coachObservation') + 1).setValue(obs);
  }
  audit(c.email, 'coachFeedback', recId, '');
  return { ok: true };
}

/* 團隊整體報告：彙整某期間全隊（或單一團隊）資料 */
function teamReport(c, d) {
  var teamId = d.teamId || '';
  var from = String(d.from || ''), to = String(d.to || '');
  var days = Number(d.days) || 1;
  if (effectivePlan(c) === 'free' && days > 7)
    return { ok: false, error: 'plan_limit_reached', message: '免費版僅支援 7 日報告，升級後可看 30 日報告。' };

  var athletes = readAll(SHEETS.athletes).filter(function (a) {
    return String(a.coachId) === String(c.coachId) &&
           (String(a.active) !== 'false' && a.active !== false) &&
           (!teamId || String(a.teamId) === String(teamId));
  });
  var aIds = {}; athletes.forEach(function (a) { aIds[String(a.athleteId)] = a; });
  var fromWeek = from ? weekStartOf(from) : '', toWeek = to ? weekStartOf(to) : '';
  var weekly = weeklyKpisCompat(c.coachId, teamId, '', fromWeek, toWeek).filter(function (r) {
    return !!aIds[String(r.athleteId)];
  });

  var recs = readAll(SHEETS.records).filter(function (r) {
    return String(r.coachId) === String(c.coachId) &&
           aIds[String(r.athleteId)] &&
           (!from || r.date >= from) && (!to || r.date <= to);
  });

  var DIMK = ['technicalAvg', 'tacticalAvg', 'physicalAvg', 'mentalAvg', 'attitudeAvg', 'physiologicalAvg'];
  var dimSum = {}, dimN = {}; DIMK.forEach(function (k) { dimSum[k] = 0; dimN[k] = 0; });
  var lights = { green: 0, yellow: 0, red: 0 };
  var totalSum = 0, totalN = 0;
  var byDate = {};      // date -> {sum,n}
  var perA = {};        // athleteId -> {recs:[]}

  weekly.forEach(function (r) {
    var t = Number(r.totalScore) || 0;
    if (t > 0) { totalSum += t; totalN++; }
    var l = r.status || lightOf(r.totalScore); lights[l] = (lights[l] || 0) + 1;
    DIMK.forEach(function (k) { var v = Number(r[k]) || 0; if (v > 0) { dimSum[k] += v; dimN[k]++; } });
    var ds = byDate[r.weekStart] || (byDate[r.weekStart] = { sum: 0, n: 0 });
    if (t > 0) { ds.sum += t; ds.n++; }
    (perA[r.athleteId] || (perA[r.athleteId] = [])).push(r);
  });

  // 每位選手摘要
  var athleteRows = athletes.map(function (a) {
    var rs = (perA[a.athleteId] || []).slice().sort(function (x, y) { return String(x.weekStart).localeCompare(String(y.weekStart)); });
    var totals = rs.map(function (r) { return Number(r.totalScore) || 0; }).filter(function (v) { return v > 0; });
    var avg = totals.length ? +(totals.reduce(function (s, v) { return s + v; }, 0) / totals.length).toFixed(2) : 0;
    var delta = (rs.length >= 2) ? +((Number(rs[rs.length - 1].totalScore) || 0) - (Number(rs[0].totalScore) || 0)).toFixed(2) : 0;
    var lastStatus = rs.length ? (rs[rs.length - 1].status || lightOf(rs[rs.length - 1].totalScore)) : '';
    return { name: a.name, gradeClass: a.gradeClass || '', filledDays: rs.length, avgTotal: avg, delta: delta, lastStatus: lastStatus };
  });

  var dimAvg = {}; DIMK.forEach(function (k) { dimAvg[k] = dimN[k] ? +(dimSum[k] / dimN[k]).toFixed(2) : 0; });
  var trend = Object.keys(byDate).sort().map(function (dt) {
    return { date: dt, avg: byDate[dt].n ? +(byDate[dt].sum / byDate[dt].n).toFixed(2) : 0, count: byDate[dt].n };
  });
  var expected = athletes.length * days;

  return {
    ok: true, from: from, to: to, days: days,
    athleteCount: athletes.length,
    teamAvg: totalN ? +(totalSum / totalN).toFixed(2) : 0,
    dimAvg: dimAvg, lights: lights,
    totalReports: recs.length, expectedReports: expected,
    completionRate: expected ? Math.round(recs.length / expected * 100) : 0,
    weeklyKpiReports: weekly.length,
    weeklyKpiExpected: athletes.filter(function (a) { return boolCell(a.kpiEnabled); }).length * Math.max(1, Object.keys(byDate).length),
    trend: trend, athletes: athleteRows
  };
}

/* ============================================================
   選手填寫（公開：靠 shareToken 限定團隊；只能寫自己當日）
   ============================================================ */
function teamFromShareToken(shareToken) {
  if (!shareToken) return null;
  var row = findRow(SHEETS.teams, 'shareToken', shareToken);
  if (row === -1) return null;
  var t = readAll(SHEETS.teams)[row - 2];
  if (String(t.status) === 'disabled') return null;
  // 教練停用則整團失效
  var crow = findRow(SHEETS.coaches, 'coachId', t.coachId);
  if (crow === -1 || String(readAll(SHEETS.coaches)[crow - 2].status) === 'disabled') return null;
  return t;
}

/* 公開聯絡表單：寄信給站長（用 getEffectiveUser，不寫死信箱），並備援存入 contacts 表 */
function contactSubmit(d) {
  if (d.website) return { ok: true }; // 蜜罐：機器人填了 hidden 欄就假裝成功
  var name = String(d.name || '').trim().slice(0, 100);
  var email = String(d.email || '').trim().slice(0, 150);
  var topic = String(d.topic || '網站來訊').trim().slice(0, 80);
  var msg = String(d.message || '').trim().slice(0, 5000);
  if (msg.length < 2) return { ok: false, error: '請填寫訊息內容' };

  // 備援：先寫入 contacts 表，避免寄信失敗時遺失訊息
  try { appendObj(SHEETS.contacts, { time: now(), topic: topic, name: name, email: email, message: msg }); } catch (e) {}

  // 寄信給指令碼擁有者（不在程式或網頁暴露信箱）
  try {
    var to = Session.getEffectiveUser().getEmail();
    if (to) {
      var opts = {
        to: to,
        subject: '[TeamPro 聯絡] ' + topic + (name ? '（' + name + '）' : ''),
        body: '主題：' + topic + '\n姓名：' + (name || '(未填)') + '\n回覆信箱：' + (email || '(未填)') +
              '\n時間：' + now() + '\n\n訊息：\n' + msg
      };
      if (email) opts.replyTo = email;
      MailApp.sendEmail(opts);
    }
  } catch (e) { /* 已存 contacts 表，仍回成功 */ }
  return { ok: true };
}

/* 選手挑比賽用：回傳該隊近 60 天的比賽（隊友已建立的） */
function teamCompetitions(d) {
  var t = teamFromShareToken(d.t || d.shareToken);
  if (!t) return { ok: false, error: '連結無效' };
  var since = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
  var comps = readAll(SHEETS.competitions).filter(function (x) {
    return String(x.teamId) === String(t.teamId) && String(x.date) >= since;
  }).map(function (x) { return { name: x.name, date: x.date, location: x.location }; })
    .sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
  return { ok: true, competitions: comps };
}

/* 獎狀照片上傳：base64 → Drive（知道連結可看），回傳可嵌入的縮圖網址 */
function awardFolder() {
  var name = 'TeamPro 獎狀照';
  var it = DriveApp.getFoldersByName(name);
  return it.hasNext() ? it.next() : DriveApp.createFolder(name);
}
function uploadAwardPhoto(d) {
  var t = teamFromShareToken(d.t || d.shareToken);
  if (!t) return { ok: false, error: '連結無效' };
  var dataUrl = String(d.dataUrl || '');
  var m = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
  if (!m) return { ok: false, error: '圖片格式不支援' };
  var bytes = Utilities.base64Decode(m[2]);
  if (bytes.length > 4 * 1024 * 1024) return { ok: false, error: '圖片過大，請重拍或再壓縮' };
  try {
    var fname = 'award_' + String(d.athleteId || '') + '_' + todayStr() + '_' + uid('').slice(0, 6) + '.jpg';
    var file = awardFolder().createFile(Utilities.newBlob(bytes, m[1], fname));
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    var id = file.getId();
    return { ok: true, url: 'https://drive.google.com/thumbnail?id=' + id + '&sz=w1000',
             viewLink: 'https://drive.google.com/file/d/' + id + '/view', fileId: id };
  } catch (e) { return { ok: false, error: '上傳失敗（請確認已授權 Drive）：' + e.message }; }
}

/* 比賽歸戶：同隊+日期+名稱已存在就用既有，否則建立（選手回報時呼叫） */
function findOrCreateCompetition(teamId, coachId, date, name, location) {
  name = String(name || '').trim(); if (!name) return '';
  date = String(date || '');
  var exist = readAll(SHEETS.competitions).filter(function (x) {
    return String(x.teamId) === String(teamId) && String(x.date) === date && String(x.name).trim().toLowerCase() === name.toLowerCase();
  })[0];
  if (exist) return exist.compId;
  var compId = uid('cp_');
  appendObj(SHEETS.competitions, { compId: compId, coachId: coachId, teamId: teamId, date: date, name: name, location: String(location || ''), createdAt: now() });
  return compId;
}

function joinInfo(d) {
  var t = teamFromShareToken(d.t || d.shareToken);
  if (!t) return { ok: false, error: '連結無效或已被重設，請向教練索取新連結' };
  var athletes = readAll(SHEETS.athletes).filter(function (a) {
    return String(a.teamId) === String(t.teamId) && (String(a.active) !== 'false' && a.active !== false);
  }).map(function (a) { return { athleteId: a.athleteId, name: a.name }; });
  // 教練是否專業版 → 選手端「7 日趨勢圖」賣點解鎖判斷
  var crow = findRow(SHEETS.coaches, 'coachId', t.coachId);
  var cplan = crow !== -1 ? effectivePlan(readAll(SHEETS.coaches)[crow - 2]) : 'free';
  return { ok: true, team: { teamId: t.teamId, teamName: t.teamName, sport: t.sport }, athletes: athletes, items: KPI_ITEMS, pro: cplan === 'pro', free: cplan === 'free' };
}

/* ---- 選手 PIN：保護「近期表現／帶入上次」只給本人看 ---- */
function athleteInTeam(teamId, athleteId) {
  var arow = findRow(SHEETS.athletes, 'athleteId', String(athleteId || ''));
  if (arow === -1) return null;
  var a = readAll(SHEETS.athletes)[arow - 2];
  return String(a.teamId) === String(teamId) ? a : null;
}
function athleteHasPin(a) { return !!(a && a.perfPinHash && String(a.perfPinHash).length); }
function pinOk(a, pin) {
  pin = String(pin == null ? '' : pin);
  return athleteHasPin(a) && pin && hashPassword(pin, a.perfPinSalt) === String(a.perfPinHash);
}

function perfPinStatus(d) {
  var t = teamFromShareToken(d.t || d.shareToken);
  if (!t) return { ok: false, error: '連結無效' };
  var a = athleteInTeam(t.teamId, d.athleteId);
  if (!a) return { ok: false, error: '選手不屬於此團隊' };
  return { ok: true, hasPin: athleteHasPin(a) };
}

/* 首次設定 PIN（已設過則需請教練重設，避免被覆蓋） */
function setPerfPin(d) {
  var t = teamFromShareToken(d.t || d.shareToken);
  if (!t) return { ok: false, error: '連結無效' };
  var pin = String(d.pin || '');
  if (!/^\d{4}$/.test(pin)) return { ok: false, error: 'PIN 需為 4 位數字' };
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var row = findRow(SHEETS.athletes, 'athleteId', String(d.athleteId || ''));
    if (row === -1) return { ok: false, error: '找不到選手' };
    var a = readAll(SHEETS.athletes)[row - 2];
    if (String(a.teamId) !== String(t.teamId)) return { ok: false, error: '選手不屬於此團隊' };
    if (athleteHasPin(a)) return { ok: false, error: '已設定 PIN，請直接輸入；忘記請找教練重設' };
    var salt = uid('p_');
    var s = sheet(SHEETS.athletes);
    s.getRange(row, H.athletes.indexOf('perfPinSalt') + 1).setValue(salt);
    s.getRange(row, H.athletes.indexOf('perfPinHash') + 1).setValue(hashPassword(pin, salt));
    return { ok: true };
  } finally { lock.releaseLock(); }
}

/* 回上次紀錄（供「帶入上次分數」降低填寫摩擦）。有設 PIN 時須驗證，否則不回內容 */
function lastRecord(d) {
  var t = teamFromShareToken(d.t || d.shareToken);
  if (!t) return { ok: false, error: '連結無效' };
  var aId = String(d.athleteId || '');
  var a = athleteInTeam(t.teamId, aId);
  if (!a) return { ok: false, error: '選手不屬於此團隊' };
  if (athleteHasPin(a) && !pinOk(a, d.pin)) return { ok: true, record: null, pinRequired: true };
  var recs = readAll(SHEETS.records).filter(function (r) {
    return String(r.teamId) === String(t.teamId) && String(r.athleteId) === aId;
  }).sort(function (a, b) { return String(b.timestamp).localeCompare(String(a.timestamp)); });
  return { ok: true, record: recs[0] || null };
}

/* 選手查自己的近期紀錄（公開：靠 shareToken 限定團隊；有 PIN 須驗證、無 PIN 則先請設定） */
function myRecords(d) {
  var t = teamFromShareToken(d.t || d.shareToken);
  if (!t) return { ok: false, error: '連結無效' };
  var aId = String(d.athleteId || '');
  var a = athleteInTeam(t.teamId, aId);
  if (!a) return { ok: false, error: '選手不屬於此團隊' };
  if (!athleteHasPin(a)) return { ok: false, noPin: true, error: '尚未設定 PIN' };
  if (!pinOk(a, d.pin)) return { ok: false, pinRequired: true, error: 'PIN 不正確' };
  var lim = Number(d.limit || 14);
  var recs = weeklyKpisCompat(t.coachId, t.teamId, aId, '', '').map(function (r) {
    r.date = r.weekStart; return r;
  });
  var allRecs = readAll(SHEETS.records);
  var byDate = function (x, y) { return String(y.date).localeCompare(String(x.date)); };
  // 每日輕量回報：讓沒填週 KPI 的選手也看得到近期狀態（燈號/睡眠/疼痛/教練回饋）
  var daily = allRecs.filter(function (r) {
    return String(r.teamId) === String(t.teamId) && String(r.athleteId) === aId;
  }).sort(byDate).slice(0, lim).map(function (r) {
    return { date: r.date, status: r.status || riskStatus('green', r.painRisk, r.sleepRisk, r.hydrationRisk),
      coachComment: r.coachComment || '', sleepDurationText: r.sleepDurationText || '',
      painScore: r.painScore || '', hydrationRisk: r.hydrationRisk || '' };
  });
  // 最近一則教練回饋（不限是不是最新那筆）
  var latestFeedback = null;
  for (var fi = 0; fi < daily.length; fi++) {
    if (daily[fi].coachComment && String(daily[fi].coachComment).trim()) { latestFeedback = { msg: daily[fi].coachComment, date: daily[fi].date }; break; }
  }
  // 隊友鼓勵：別人填的回報中 encourageName == 這位選手
  var encourages = allRecs.filter(function (r) {
    return String(r.teamId) === String(t.teamId) && String(r.athleteId) !== aId &&
      String(r.encourageName || '').trim() === String(a.name).trim() && String(r.encourageMsg || '').trim();
  }).sort(byDate).slice(0, 8).map(function (r) { return { from: r.name, msg: r.encourageMsg, date: r.date }; });
  // 近期比賽
  var competitions = allRecs.filter(function (r) {
    return String(r.athleteId) === aId && String(r.compName || '').trim();
  }).sort(function (x, y) { return String(y.compDate || y.date).localeCompare(String(x.compDate || x.date)); })
    .slice(0, 6).map(function (r) {
      return { name: r.compName, date: r.compDate || r.date, result: r.compResult || '',
        reflection: r.compReflection || '', award: r.compAward || '', awardLink: r.compAwardLink || '' };
    });
  return { ok: true, records: recs.slice(0, lim), daily: daily, latestFeedback: latestFeedback,
    encourages: encourages, competitions: competitions };
}

function weeklyScoreOf(scores) {
  var dimAvg = {}, allValid = true;
  KPI_DIMENSIONS.forEach(function (dim, di) {
    var items = KPI_ITEMS.slice(di * 5, di * 5 + 5), sum = 0;
    items.forEach(function (k) {
      var v = Number(scores[k]);
      if (v < 1 || v > 5 || Math.floor(v) !== v) allValid = false;
      else sum += v;
    });
    dimAvg[dim] = +(sum / 5).toFixed(2);
  });
  var total = +(KPI_DIMENSIONS.reduce(function (s, k) { return s + dimAvg[k]; }, 0) / KPI_DIMENSIONS.length).toFixed(2);
  return { valid: allValid, dimAvg: dimAvg, total: total, status: lightOf(total) };
}

/* 新週 KPI + 舊 records 相容層：舊資料每人每週只取最後一筆。 */
function weeklyKpisCompat(coachId, teamId, athleteId, fromWeek, toWeek) {
  var byKey = {};
  readAll(SHEETS.records).filter(function (r) {
    return String(r.coachId) === String(coachId) && (!teamId || String(r.teamId) === String(teamId)) &&
      (!athleteId || String(r.athleteId) === String(athleteId)) && Number(r.totalScore) > 0;
  }).forEach(function (r) {
    var ws = weekStartOf(r.date), key = String(r.athleteId) + '|' + ws;
    if ((!fromWeek || ws >= fromWeek) && (!toWeek || ws <= toWeek) &&
        (!byKey[key] || String(r.timestamp) > String(byKey[key].updatedAt))) {
      byKey[key] = {
        weeklyKpiId: 'legacy_' + r.recordId, coachId: r.coachId, teamId: r.teamId,
        athleteId: r.athleteId, name: r.name, weekStart: ws, weekEnd: addDateDays(ws, 6),
        submittedAt: r.timestamp, updatedAt: r.timestamp,
        technicalAvg: r.technicalAvg, tacticalAvg: r.tacticalAvg, physicalAvg: r.physicalAvg,
        mentalAvg: r.mentalAvg, attitudeAvg: r.attitudeAvg, physiologicalAvg: r.physiologicalAvg,
        totalScore: r.totalScore, status: lightOf(r.totalScore), legacy: true, rawJson: r.rawJson
      };
    }
  });
  readAll(SHEETS.weeklyKpi).filter(function (r) {
    return String(r.coachId) === String(coachId) && (!teamId || String(r.teamId) === String(teamId)) &&
      (!athleteId || String(r.athleteId) === String(athleteId)) &&
      (!fromWeek || String(r.weekStart) >= fromWeek) && (!toWeek || String(r.weekStart) <= toWeek);
  }).forEach(function (r) { byKey[String(r.athleteId) + '|' + String(r.weekStart)] = r; });
  return Object.keys(byKey).map(function (k) { return byKey[k]; }).sort(function (a, b) {
    return String(b.weekStart).localeCompare(String(a.weekStart));
  });
}

function kpiEntitlementFor(t, a) {
  var crow = findRow(SHEETS.coaches, 'coachId', t.coachId);
  if (crow === -1) return { enabled: false, effective: false, limit: 0 };
  var c = readAll(SHEETS.coaches)[crow - 2], limit = PLANS[effectivePlan(c)].kpiAthletes;
  return { enabled: boolCell(a.kpiEnabled), effective: !!effectiveKpiIds(c.coachId, limit)[String(a.athleteId)], limit: limit };
}

/* KPI 評估頻率：教練帳號層級開關（weekly 預設 / daily），存 coaches.settings.kpiCadence */
function kpiCadenceOf(coachId) {
  var crow = findRow(SHEETS.coaches, 'coachId', coachId);
  if (crow === -1) return 'weekly';
  var s = parseSettings(readAll(SHEETS.coaches)[crow - 2].settings);
  if (s.kpiVersion === 'v2') return 'daily'; // v2 一律每日
  return s.kpiCadence === 'daily' ? 'daily' : 'weekly';
}
/* 當下「該填 / 該看」的評估週期：每天=當天；每週=剛結束的上一週。weeklyKpi 以 weekStart 當週期起點。 */
function kpiReviewPeriod(coachId, date) {
  date = String(date || todayStr());
  if (kpiCadenceOf(coachId) === 'daily') return { start: date, end: date, cadence: 'daily' };
  var ws = addDateDays(weekStartOf(date), -7);
  return { start: ws, end: addDateDays(ws, 6), cadence: 'weekly' };
}

function kpiFormState(d) {
  var t = teamFromShareToken(d.t || d.shareToken);
  if (!t) return { ok: false, error: '連結無效' };
  var a = athleteInTeam(t.teamId, d.athleteId), date = String(d.date || todayStr());
  if (!a) return { ok: false, error: '選手不屬於此團隊' };
  var ent = kpiEntitlementFor(t, a);
  var period = kpiReviewPeriod(t.coachId, date);
  var recs = weeklyKpisCompat(t.coachId, t.teamId, a.athleteId, period.start, period.start);
  return { ok: true, kpiEnabled: ent.enabled, kpiEffective: ent.effective, kpiDue: ent.effective && !recs.length,
    weekStart: period.start, weekEnd: period.end, cadence: period.cadence, completed: !!recs.length,
    hasPin: athleteHasPin(a), pinRequired: athleteHasPin(a) && !pinOk(a, d.pin) };
}

function submitWeeklyKpi(d) {
  var t = teamFromShareToken(d.t || d.shareToken);
  if (!t) return { ok: false, error: '連結無效或已被重設' };
  var a = athleteInTeam(t.teamId, d.athleteId);
  if (!a) return { ok: false, error: '選手不屬於此團隊' };
  var ent = kpiEntitlementFor(t, a);
  if (!ent.enabled || !ent.effective) return { ok: false, error: 'kpi_not_enabled', message: '此選手未開啟 KPI 追蹤或已超過方案配額。' };
  if (!athleteHasPin(a)) return { ok: false, noPin: true, error: '請先設定 4 位數 PIN 保護 KPI' };
  if (!pinOk(a, d.pin)) return { ok: false, pinRequired: true, error: 'PIN 不正確' };
  var period = kpiReviewPeriod(t.coachId, todayStr());
  var expectedWeek = period.start;
  var ws = String(d.weekStart || expectedWeek);
  if (ws !== expectedWeek) return { ok: false, error: period.cadence === 'daily' ? '只能填寫今日 KPI' : '只能填寫上週 KPI' };
  var calc = weeklyScoreOf(d.scores || {});
  if (!calc.valid) return { ok: false, error: '30 項 KPI 皆需填寫 1–5 分整數' };

  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    ent = kpiEntitlementFor(t, readAll(SHEETS.athletes)[findRow(SHEETS.athletes, 'athleteId', a.athleteId) - 2]);
    if (!ent.effective) return { ok: false, error: 'kpi_limit_reached', message: 'KPI 追蹤配額已滿。' };
    var existing = readAll(SHEETS.weeklyKpi), hitRow = -1;
    for (var i = 0; i < existing.length; i++) {
      if (String(existing[i].athleteId) === String(a.athleteId) && String(existing[i].weekStart) === ws) { hitRow = i + 2; break; }
    }
    var same = 0, vals = KPI_ITEMS.map(function (k) { return Number(d.scores[k]); });
    vals.forEach(function (v) { if (v === vals[0]) same++; });
    var qScore = same === KPI_ITEMS.length ? 60 : 100;
    var rec = {
      weeklyKpiId: hitRow === -1 ? uid('wk_') : existing[hitRow - 2].weeklyKpiId,
      coachId: t.coachId, teamId: t.teamId, athleteId: a.athleteId, name: a.name,
      weekStart: ws, weekEnd: period.end, submittedAt: hitRow === -1 ? now() : existing[hitRow - 2].submittedAt,
      updatedAt: now(), technicalAvg: calc.dimAvg.technical, tacticalAvg: calc.dimAvg.tactical,
      physicalAvg: calc.dimAvg.physical, mentalAvg: calc.dimAvg.mental, attitudeAvg: calc.dimAvg.attitude,
      physiologicalAvg: calc.dimAvg.physiological, totalScore: calc.total, status: calc.status,
      qualityScore: qScore, qualityLabel: qScore >= 80 ? '正常' : '需確認',
      qualityReasons: qScore < 80 ? '30 題全部同分' : '', rawJson: JSON.stringify(d.scores || {})
    };
    KPI_ITEMS.forEach(function (k) { rec[k] = Number(d.scores[k]); });
    if (hitRow === -1) appendObj(SHEETS.weeklyKpi, rec);
    else sheet(SHEETS.weeklyKpi).getRange(hitRow, 1, 1, WEEKLY_KPI_HEADERS.length).setValues([toRow(SHEETS.weeklyKpi, rec)]);
    return { ok: true, updated: hitRow !== -1, totalScore: calc.total, status: calc.status,
      dimAvg: calc.dimAvg, weekStart: ws, weekEnd: rec.weekEnd, quality: { score: qScore, label: rec.qualityLabel } };
  } finally { lock.releaseLock(); }
}

/* ===== KPI v2 提交（每日合流：一次提交＝15 題 KPI ＋水分等；恢復題驅動當日燈號）===== */
function kpi2State(d) {
  var t = teamFromShareToken(d.t || d.shareToken);
  if (!t) return { ok: false, error: '連結無效' };
  var a = athleteInTeam(t.teamId, d.athleteId), date = String(d.date || todayStr());
  if (!a) return { ok: false, error: '選手不屬於此團隊' };
  var ent = kpiEntitlementFor(t, a);
  var done = readAll(SHEETS.weeklyKpi).some(function (r) {
    return String(r.athleteId) === String(a.athleteId) && String(r.weekStart) === date;
  });
  return { ok: true, version: isKpiV2(t.coachId) ? 'v2' : 'v1',
    sportCategory: t.sportCategory || '', tacticalGroup: kpi2TacticalGroup(t.sportCategory),
    kpiEnabled: ent.enabled, kpiEffective: ent.effective, kpiDue: ent.effective && !done, completed: done,
    date: date, hasPin: athleteHasPin(a), pinRequired: athleteHasPin(a) && !pinOk(a, d.pin) };
}

function submitKpi2(d) {
  var t = teamFromShareToken(d.t || d.shareToken);
  if (!t) return { ok: false, error: '連結無效或已被重設' };
  var a = athleteInTeam(t.teamId, d.athleteId);
  if (!a) return { ok: false, error: '選手不屬於此團隊' };
  var ent = kpiEntitlementFor(t, a);
  if (!ent.enabled || !ent.effective) return { ok: false, error: 'kpi_not_enabled', message: '此選手未開啟 KPI 追蹤或已超過方案配額。' };
  if (!athleteHasPin(a)) return { ok: false, noPin: true, error: '請先設定 4 位數 PIN 保護 KPI' };
  if (!pinOk(a, d.pin)) return { ok: false, pinRequired: true, error: 'PIN 不正確' };
  var scores = d.scores || {};
  var calc = weeklyScoreV2(scores, t.sportCategory);
  if (!calc.valid) return { ok: false, error: '15 題都需填 1–5 分' };
  var date = String(d.date || todayStr());
  var recStatus = kpi2RecoveryStatus(scores);
  function lv(v) { v = Number(v); return v <= 1 ? 'red' : (v === 2 ? 'yellow' : 'green'); }

  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    ent = kpiEntitlementFor(t, readAll(SHEETS.athletes)[findRow(SHEETS.athletes, 'athleteId', a.athleteId) - 2]);
    if (!ent.effective) return { ok: false, error: 'kpi_limit_reached', message: 'KPI 追蹤配額已滿。' };
    // 1) weeklyKpi（聚合欄＋rawJson，key＝當日，upsert）
    var existing = readAll(SHEETS.weeklyKpi), hitRow = -1;
    for (var i = 0; i < existing.length; i++) {
      if (String(existing[i].athleteId) === String(a.athleteId) && String(existing[i].weekStart) === date) { hitRow = i + 2; break; }
    }
    var rec = {
      weeklyKpiId: hitRow === -1 ? uid('k2_') : existing[hitRow - 2].weeklyKpiId,
      coachId: t.coachId, teamId: t.teamId, athleteId: a.athleteId, name: a.name,
      weekStart: date, weekEnd: date, submittedAt: hitRow === -1 ? now() : existing[hitRow - 2].submittedAt,
      updatedAt: now(), technicalAvg: calc.dimAvg.technical, tacticalAvg: calc.dimAvg.tactical,
      physicalAvg: calc.dimAvg.physical, mentalAvg: calc.dimAvg.mental, attitudeAvg: calc.dimAvg.attitude,
      physiologicalAvg: calc.dimAvg.physiological, totalScore: calc.total, status: calc.status,
      qualityScore: 100, qualityLabel: '正常', qualityReasons: '', rawJson: JSON.stringify(scores)
    };
    if (hitRow === -1) appendObj(SHEETS.weeklyKpi, rec);
    else sheet(SHEETS.weeklyKpi).getRange(hitRow, 1, 1, WEEKLY_KPI_HEADERS.length).setValues([toRow(SHEETS.weeklyKpi, rec)]);

    // 2) 每日 record（不寫 totalScore→不被當 legacy 週KPI；供戰情室「已回報」＋當日燈號）
    var recs = readAll(SHEETS.records), rrow = -1;
    for (var j = 0; j < recs.length; j++) {
      if (String(recs[j].athleteId) === String(a.athleteId) && String(recs[j].date) === date) { rrow = j + 2; break; }
    }
    var rrec = rrow === -1 ? {} : recs[rrow - 2];
    rrec.recordId = rrec.recordId || uid('r_');
    rrec.coachId = t.coachId; rrec.teamId = t.teamId; rrec.athleteId = a.athleteId; rrec.name = a.name;
    rrec.date = date; rrec.timestamp = now(); rrec.status = recStatus;
    rrec.painRisk = lv(scores.r_pain); rrec.sleepRisk = lv(scores.r_sleep);
    rrec.painScore = Number(scores.r_pain) <= 2 ? (Number(scores.r_pain) === 1 ? 8 : 5) : 0;
    rrec.totalScore = '';
    if (d.waterAmount !== undefined) rrec.waterAmount = d.waterAmount;
    if (rrow === -1) appendObj(SHEETS.records, rrec);
    else sheet(SHEETS.records).getRange(rrow, 1, 1, RECORD_HEADERS.length).setValues([toRow(SHEETS.records, rrec)]);

    audit(a.name, 'submitKpi2', a.athleteId, date);
    return { ok: true, totalScore: calc.total, status: calc.status, dimAvg: calc.dimAvg, recoveryStatus: recStatus, date: date };
  } finally { lock.releaseLock(); }
}

function athleteWeeklyKpis(c, d) {
  var aId = String(d.athleteId || ''), row = findRow(SHEETS.athletes, 'athleteId', aId);
  if (row === -1 || String(readAll(SHEETS.athletes)[row - 2].coachId) !== String(c.coachId))
    return { ok: false, error: 'forbidden' };
  return { ok: true, records: weeklyKpisCompat(c.coachId, '', aId, '', '').slice(0, Number(d.limit || 30)) };
}

function sleepMetrics(bedTime, wakeTime) {
  var valid = /^([01]\d|2[0-3]):[0-5]\d$/;
  bedTime = String(bedTime || ''); wakeTime = String(wakeTime || '');
  if (!valid.test(bedTime) || !valid.test(wakeTime))
    return { minutes: '', text: '', risk: '' };
  var bp = bedTime.split(':'), wp = wakeTime.split(':');
  var start = Number(bp[0]) * 60 + Number(bp[1]);
  var end = Number(wp[0]) * 60 + Number(wp[1]);
  var minutes = end - start;
  if (minutes <= 0) minutes += 24 * 60;
  // 超過 18 小時通常是輸入錯誤，仍保留時數但標成紅燈供教練確認。
  var risk = minutes >= 420 && minutes <= 1080 ? 'green' : (minutes > 300 && minutes < 420 ? 'yellow' : 'red');
  return { minutes: minutes, text: Math.floor(minutes / 60) + ' 小時 ' + (minutes % 60) + ' 分', risk: risk };
}

function painMetrics(status, score, impact) {
  var allowedStatus = ['none', 'old', 'new', 'acute'];
  var allowedImpact = ['none', 'high_intensity', 'power_down', 'cannot_sport', 'daily_affected'];
  status = allowedStatus.indexOf(String(status)) !== -1 ? String(status) : 'none';
  impact = allowedImpact.indexOf(String(impact)) !== -1 ? String(impact) : 'none';
  score = Math.max(0, Math.min(10, Number(score) || 0));
  if (status === 'none') score = 0;
  var risk = score >= 7 ? 'red' : (score >= 4 ? 'yellow' : 'green');
  if (impact === 'cannot_sport' || impact === 'daily_affected') risk = 'red';
  return { status: status, score: score, impact: impact, risk: risk };
}

function previousDate(date) {
  var p = String(date || '').split('-');
  if (p.length !== 3) return '';
  var d = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])) - 86400000);
  return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
}

function hydrationMetrics(d, previous, sleep) {
  var water = ['very_little', 'normal', 'enough', 'a_lot'].indexOf(String(d.waterAmount)) !== -1 ? String(d.waterAmount) : '';
  var sweat = ['low', 'normal', 'high', 'very_high'].indexOf(String(d.sweatAmount)) !== -1 ? String(d.sweatAmount) : '';
  var urine = ['clear', 'pale_yellow', 'yellow', 'dark', 'abnormal'].indexOf(String(d.urineColor)) !== -1 ? String(d.urineColor) : '';
  var risk = 'green', flags = [];
  var highSweatLowWater = (sweat === 'high' || sweat === 'very_high') && (water === 'very_little' || water === 'normal');
  var consecutiveDark = urine === 'dark' && previous && String(previous.date) === previousDate(d.date) && String(previous.urineColor) === 'dark';
  if (urine === 'yellow') { risk = 'yellow'; flags.push('urine_yellow'); }
  if (water === 'very_little') { risk = 'yellow'; flags.push('low_water'); }
  if (highSweatLowWater) { risk = 'yellow'; flags.push('high_sweat_low_water'); }
  if (urine === 'dark') { risk = 'yellow'; flags.push('dark_urine'); }
  if (sweat === 'very_high' && water === 'very_little') flags.push('severe_dehydration_risk');
  if (urine === 'abnormal' || consecutiveDark ||
      (urine === 'dark' && Number(d.fatigue) >= 7 && sleep.minutes !== '' && Number(sleep.minutes) < 420)) risk = 'red';
  if (urine === 'abnormal') flags.push('abnormal_urine');
  if (consecutiveDark) flags.push('consecutive_dark');
  var advice = risk === 'red'
    ? '水分狀態需立即確認；若尿液呈茶色、紅色或異常混濁，請通知家長並視情況尋求醫療協助。'
    : risk === 'yellow'
      ? '今日訓練前後加強補水，流汗多時分次補充水分與電解質。'
      : urine === 'clear' ? '水分充足，維持適量補水，避免短時間過量飲水。' : '水分狀況良好，維持規律補水。';
  return { water: water, sweat: sweat, urine: urine, risk: risk, flags: flags, advice: advice };
}

function scoreSimilarity(scores, record) {
  var old = {};
  try { old = JSON.parse(String(record && record.rawJson || '{}')); } catch (e) { old = {}; }
  var same = 0, compared = 0;
  KPI_ITEMS.forEach(function (k) {
    var a = Number(scores[k]), b = Number(old[k]);
    if (a >= 1 && a <= 5 && b >= 1 && b <= 5) { compared++; if (a === b) same++; }
  });
  return compared ? same / compared : 0;
}

function qualityMetrics(d, scores, total, dimAvg, previousRecords, pain, sleep) {
  var score = 100, reasons = [];
  if (String(d.trainingNotes || '').replace(/\s/g, '').length < 4) { score -= 15; reasons.push('心得過短'); }
  // 日報輕量回報異常：高疼痛但回報影響輕微、睡眠過少但品質填良好（矛盾，請教練確認）
  if (pain && Number(pain.score) >= 7 && (d.painImpact === 'none' || d.painImpact === 'high_intensity')) { score -= 25; reasons.push('高疼痛但回報影響輕微'); }
  if (sleep && sleep.minutes !== '' && Number(sleep.minutes) > 0 && Number(sleep.minutes) < 240 && String(d.sleepQuality) === 'good') { score -= 20; reasons.push('睡眠過少但品質填良好'); }
  var prev = previousRecords[0];
  if (prev && scoreSimilarity(scores, prev) >= 0.9) { score -= 25; reasons.push('KPI 與前次高度相同'); }
  if (pain.score >= 7 && (Number(total) >= 4 || Number(dimAvg.physical) >= 4 || Number(dimAvg.physiological) >= 4)) {
    score -= 20; reasons.push('高疼痛但狀態分數過高');
  }
  if (sleep.minutes !== '' && Number(sleep.minutes) < 300 && (Number(scores.pio_spirit) === 5 || Number(scores.pio_recovery) === 5)) {
    score -= 20; reasons.push('睡眠不足但恢復填滿分');
  }
  var day1 = previousDate(d.date), day2 = previousDate(day1);
  if (previousRecords.length >= 2 && String(previousRecords[0].date) === day1 && String(previousRecords[1].date) === day2 &&
      scoreSimilarity(scores, previousRecords[0]) >= 0.9 && scoreSimilarity(scores, previousRecords[1]) >= 0.9) {
    score -= 30; reasons.push('連續 3 天填寫幾乎相同');
  }
  score = Math.max(0, score);
  return { score: score, label: score >= 80 ? '正常' : (score >= 60 ? '需確認' : '疑似敷衍'), reasons: reasons };
}

function riskStatus(base, painRisk, sleepRisk, hydrationRisk) {
  var rank = { green: 0, yellow: 1, red: 2 }, result = base || 'green';
  [painRisk, sleepRisk, hydrationRisk].forEach(function (r) { if (rank[r] > rank[result]) result = r; });
  return result;
}

function coachSuggestionFor(rec) {
  if (rec.painRisk === 'red') return '建議停止專項訓練，立即確認疼痛並通知教練／家長。';
  if (rec.hydrationRisk === 'red') return rec.hydrationAdvice;
  if (rec.sleepRisk === 'red') return '今日降低訓練強度與反應負荷，優先安排恢復。';
  if (Number(rec.painScore) >= 4) return '今日降低高衝擊與疼痛部位負荷，訓練中持續觀察。';
  if (rec.hydrationRisk === 'yellow') return rec.hydrationAdvice;
  if (rec.sleepRisk === 'yellow') return '睡眠偏少，今日控制高強度訓練量並留意疲勞。';
  if (rec.reportQualityLabel !== '正常') return '先口頭確認今日狀態，再依實際情況安排訓練。';
  return '今日狀態穩定，可依原定計畫訓練並持續觀察。';
}

function submitRecord(d) {
  var t = teamFromShareToken(d.t || d.shareToken);
  if (!t) return { ok: false, error: '連結無效或已被重設' };
  var aId = String(d.athleteId || '');
  var arow = findRow(SHEETS.athletes, 'athleteId', aId);
  if (arow === -1) return { ok: false, error: '找不到選手' };
  var a = readAll(SHEETS.athletes)[arow - 2];
  if (String(a.teamId) !== String(t.teamId)) return { ok: false, error: '選手不屬於此團隊' };

  // 日報只儲存安全與恢復資料；30 項 KPI 由 submitWeeklyKpi 獨立寫入。
  var scores = {};
  var date = d.date || todayStr();
  var dimAvg = { technical: '', tactical: '', physical: '', mental: '', attitude: '', physiological: '' };
  var total = '';
  var baseStatus = 'green';

  var athleteHistory = readAll(SHEETS.records).filter(function (r) {
    return String(r.teamId) === String(t.teamId) && String(r.athleteId) === aId && String(r.date) < String(date);
  }).sort(function (x, y) { return String(y.date).localeCompare(String(x.date)); });
  d.date = date;
  var sleep = sleepMetrics(d.sleepBedTime, d.wakeTime);
  var pain = painMetrics(d.painStatus, d.painScore, d.painImpact);
  var hydration = hydrationMetrics({
    date: date, waterAmount: d.waterAmount, sweatAmount: d.sweatAmount,
    urineColor: d.urineColor, fatigue: d.fatigue
  }, athleteHistory[0] || null, sleep);
  var quality = qualityMetrics(d, scores, total, dimAvg, [], pain, sleep);
  var status = riskStatus(baseStatus, pain.risk, sleep.risk, hydration.risk);

  var height = Number(d.heightCm) || '';
  var weight = Number(d.weightKg) || '';
  var bmi = (height && weight) ? +(weight / Math.pow(height / 100, 2)).toFixed(1) : '';

  var rec = {
    recordId: uid('r_'), coachId: t.coachId, teamId: t.teamId, athleteId: aId, name: a.name,
    date: date, timestamp: now(), sessionType: String(d.sessionType || 'training'),
    technicalAvg: dimAvg.technical, tacticalAvg: dimAvg.tactical, physicalAvg: dimAvg.physical,
    mentalAvg: dimAvg.mental, attitudeAvg: dimAvg.attitude, physiologicalAvg: dimAvg.physiological,
    totalScore: total, status: status,
    heightCm: height, weightKg: weight, targetWeightKg: Number(d.targetWeightKg) || '', bmi: bmi,
    breakfast: d.breakfast || '', lunch: d.lunch || '', dinner: d.dinner || '',
    snacksDrinks: d.snacksDrinks || '', waterIntake: d.waterIntake || '', lateNightSnack: d.lateNightSnack || '',
    moodIndex: Number(d.moodIndex) || '', moodReason: d.moodReason || '', gratitude: d.gratitude || '',
    reflection: d.reflection || '',
    breakfastNutri: d.breakfastNutri || '', lunchNutri: d.lunchNutri || '', dinnerNutri: d.dinnerNutri || '',
    trainingAM: d.trainingAM || '', trainingPM: d.trainingPM || '', trainingEve: d.trainingEve || '', trainingNotes: d.trainingNotes || '',
    sleepHours: sleep.minutes !== '' ? +(sleep.minutes / 60).toFixed(2) : (d.sleepHours || ''),
    fatigue: Number(d.fatigue) || '', injuryAreas: d.injuryAreas || '', injuryNote: d.injuryNote || '',
    sleepBedTime: d.sleepBedTime || '', wakeTime: d.wakeTime || '', sleepQuality: d.sleepQuality || '',
    sleepDurationMinutes: sleep.minutes, sleepDurationText: sleep.text, sleepRisk: sleep.risk,
    painStatus: pain.status, painAreas: pain.status === 'none' ? '' : (d.painAreas || d.injuryAreas || ''),
    painScore: pain.score, painImpact: pain.impact, painNote: d.painNote || d.injuryNote || '', painRisk: pain.risk,
    waterAmount: hydration.water, sweatAmount: hydration.sweat, urineColor: hydration.urine,
    hydrationRisk: hydration.risk, hydrationAdvice: hydration.advice, hydrationFlags: hydration.flags.join(','),
    reportQualityScore: quality.score, reportQualityLabel: quality.label,
    reportQualityReasons: quality.reasons.join('、'), coachSuggestion: '',
    encourageName: d.encourageName || '', encourageMsg: d.encourageMsg || '',
    nutritionAdvice: d.nutritionAdvice || '', studentLineText: d.studentLineText || '',
    parentLineText: d.parentLineText || '', coachLineText: d.coachLineText || '',
    // 個資法同意紀錄（隨每次回報留存）
    consentPrivacy: d.consentPrivacy ? true : false,
    guardianConsent: d.guardianConsent ? true : false,
    consentAt: d.consentAt || now(),
    privacyVersion: String(d.privacyVersion || ''),
    consentText: String(d.consentText || ''),
    deviceInfo: String(d.deviceInfo || ''),
    // 比賽紀錄（比賽日才有）
    compName: String(d.compName || '').trim(), compDate: String(d.compName ? (d.compDate || date) : ''),
    compLocation: String(d.compLocation || ''), compResult: String(d.compResult || ''),
    compDetail: String(d.compDetail || ''), compReflection: String(d.compReflection || ''),
    compAward: d.compAward ? true : false, compAwardLink: String(d.compAwardLink || ''),
    rawJson: ''
  };
  rec.coachSuggestion = coachSuggestionFor(rec);
  KPI_ITEMS.forEach(function (k) { rec[k] = ''; });
  if (rec.compName) findOrCreateCompetition(t.teamId, t.coachId, rec.compDate, rec.compName, rec.compLocation);

  // upsert：同團隊同選手同日只留一筆
  var existing = readAll(SHEETS.records);
  var hitRow = -1;
  for (var i = 0; i < existing.length; i++) {
    if (String(existing[i].teamId) === String(t.teamId) &&
        String(existing[i].athleteId) === aId &&
        String(existing[i].date) === String(date)) { hitRow = i + 2; break; }
  }
  if (hitRow !== -1) {
    rec.recordId = existing[hitRow - 2].recordId || rec.recordId;
    sheet(SHEETS.records).getRange(hitRow, 1, 1, RECORD_HEADERS.length).setValues([toRow(SHEETS.records, rec)]);
    return { ok: true, updated: true, totalScore: total, status: status, dimAvg: dimAvg,
             sleep: sleep, pain: pain, hydration: hydration, quality: quality };
  }
  appendObj(SHEETS.records, rec);
  return { ok: true, updated: false, totalScore: total, status: status, dimAvg: dimAvg,
           sleep: sleep, pain: pain, hydration: hydration, quality: quality };
}

/* ============================================================
   管理者後台
   ============================================================ */
function checkAdmin(d) {
  var key = getProp('ADMIN_PASSWORD');
  if (!key) return false;            // 沒設密碼一律拒絕（安全預設）
  return d && String(d.adminPassword) === key;
}
function withAdmin(d, fn) {
  if (!checkAdmin(d)) return { ok: false, error: '管理者密碼錯誤或未設定' };
  return fn(d);
}

function adminListCoaches(d) {
  d = d || {};
  var q = String(d.q || '').trim().toLowerCase();
  var coaches = readAll(SHEETS.coaches).map(function (c) {
    return {
      coachId: c.coachId, email: c.email, name: c.name, plan: c.plan,
      planName: PLANS[c.plan] ? PLANS[c.plan].name : c.plan,
      planExpiry: c.planExpiry, expired: isExpired(c), status: c.status,
      createdAt: c.createdAt, lastLogin: c.lastLogin, paymentNote: c.paymentNote || '',
      activeAthletes: countActiveAthletes(c.coachId), max: PLANS[effectivePlan(c)].maxAthletes
    };
  });
  if (q) coaches = coaches.filter(function (c) {
    return String(c.email).toLowerCase().indexOf(q) !== -1 || String(c.name).toLowerCase().indexOf(q) !== -1;
  });
  return { ok: true, coaches: coaches, plans: PLANS };
}

function adminUpdatePlan(d) {
  var row = findRow(SHEETS.coaches, 'coachId', d.coachId || '');
  if (row === -1) return { ok: false, error: '找不到教練' };
  if (d.plan && !PLANS[d.plan]) return { ok: false, error: '未知方案' };
  if (d.plan) sheet(SHEETS.coaches).getRange(row, H.coaches.indexOf('plan') + 1).setValue(d.plan);
  if (typeof d.planExpiry !== 'undefined')
    sheet(SHEETS.coaches).getRange(row, H.coaches.indexOf('planExpiry') + 1).setValue(d.planExpiry || '');
  if (typeof d.paymentNote !== 'undefined')
    sheet(SHEETS.coaches).getRange(row, H.coaches.indexOf('paymentNote') + 1).setValue(String(d.paymentNote || '').trim());
  audit('admin', 'updatePlan', d.coachId, (d.plan || '') + ' / ' + (d.planExpiry || ''));
  return { ok: true };
}

function adminSetStatus(d) {
  var row = findRow(SHEETS.coaches, 'coachId', d.coachId || '');
  if (row === -1) return { ok: false, error: '找不到教練' };
  var st = (String(d.status) === 'disabled') ? 'disabled' : 'active';
  sheet(SHEETS.coaches).getRange(row, H.coaches.indexOf('status') + 1).setValue(st);
  audit('admin', 'setStatus', d.coachId, st);
  return { ok: true, status: st };
}

function adminStats(d) {
  var coaches = readAll(SHEETS.coaches);
  var byPlan = { free: 0, coach: 0, team: 0, pro: 0 };
  var mrr = 0, active = 0, expiringSoon = [];
  var soon = Date.now() + 7 * 24 * 3600 * 1000;
  coaches.forEach(function (c) {
    byPlan[c.plan] = (byPlan[c.plan] || 0) + 1;
    if (String(c.status) === 'active') active++;
    if (!isExpired(c) && PLANS[c.plan]) mrr += PLANS[c.plan].price;
    if (c.plan !== 'free' && c.planExpiry) {
      var t = new Date(c.planExpiry).getTime();
      if (t > Date.now() && t < soon) expiringSoon.push({
        email: c.email, name: c.name, plan: c.plan,
        planName: PLANS[c.plan] ? PLANS[c.plan].name : c.plan,
        planExpiry: c.planExpiry, daysLeft: Math.ceil((t - Date.now()) / 86400000),
        paymentNote: c.paymentNote || ''
      });
    }
  });
  return { ok: true, totalCoaches: coaches.length, activeCoaches: active, byPlan: byPlan, mrr: mrr, expiringSoon: expiringSoon };
}

/* ============================================================
   一次性設定（在編輯器手動執行）
   ============================================================ */
function setup() {
  Object.keys(SHEETS).forEach(function (k) { sheet(SHEETS[k]); });
  return 'TeamPro 後端分頁建立完成：' + Object.keys(SHEETS).map(function (k) { return SHEETS[k]; }).join('、');
}

/* ⚠️ 設管理者密碼：改成你自己的，執行一次後請把字串改回佔位字。 */
function setAdminPassword() {
  setProp('ADMIN_PASSWORD', '請改成你的管理者密碼');
  return '管理者密碼已設定。';
}

/* ============================================================
   一鍵清除測試資料（在編輯器手動執行）
   ------------------------------------------------------------
   刪除所有 email 含 TEST_EMAIL_SUFFIX 的教練，及其名下
   sessions / teams / athletes / records / privacyRequests。正式帳號不受影響。
   由下往上刪以避免列位移。
   ============================================================ */
var TEST_EMAIL_SUFFIX = '@teampro.test';

function cleanupTestData() {
  // 1) 找出測試教練的 coachId
  var coaches = readAll(SHEETS.coaches);
  var testIds = {};
  coaches.forEach(function (c) {
    if (String(c.email || '').toLowerCase().indexOf(TEST_EMAIL_SUFFIX) !== -1) testIds[String(c.coachId)] = true;
  });
  var ids = Object.keys(testIds);
  if (!ids.length) return '沒有找到測試帳號（email 含 ' + TEST_EMAIL_SUFFIX + '）。';

  // 2) 各分頁刪除 coachId 命中的列（coaches 用 coachId 欄；sessions/teams/athletes/records 同名欄）
  var report = {};
  report.coaches  = deleteRowsByCoach(SHEETS.coaches,  'coachId', testIds);
  report.sessions = deleteRowsByCoach(SHEETS.sessions, 'coachId', testIds);
  report.teams    = deleteRowsByCoach(SHEETS.teams,    'coachId', testIds);
  report.athletes = deleteRowsByCoach(SHEETS.athletes, 'coachId', testIds);
  report.records  = deleteRowsByCoach(SHEETS.records,  'coachId', testIds);
  report.privacyRequests = deleteRowsByCoach(SHEETS.privacyRequests, 'coachId', testIds);

  audit('admin', 'cleanupTestData', ids.join(','), JSON.stringify(report));
  return '已清除 ' + ids.length + ' 個測試教練。刪除列數：' +
    'coaches=' + report.coaches + '、sessions=' + report.sessions +
    '、teams=' + report.teams + '、athletes=' + report.athletes + '、records=' + report.records +
    '、privacyRequests=' + report.privacyRequests + '。';
}

function deleteRowsByCoach(name, colKey, idSet) {
  var s = sheet(name);
  var headers = (name === SHEETS.records) ? RECORD_HEADERS : H[name];
  var col = headers.indexOf(colKey);
  var last = s.getLastRow();
  if (col === -1 || last < 2) return 0;
  var vals = s.getRange(2, col + 1, last - 1, 1).getValues();
  var toDelete = [];
  for (var i = 0; i < vals.length; i++) {
    if (idSet[String(vals[i][0])]) toDelete.push(i + 2);
  }
  toDelete.sort(function (a, b) { return b - a; }); // 由下往上刪
  toDelete.forEach(function (r) { s.deleteRow(r); });
  return toDelete.length;
}

/* ============================================================
   Demo 展示資料種子（簡報用）
   - 在 Apps Script 編輯器直接執行 seedDemoAccount() 即可建立／重建。
   - 帳號 demo@teampro.tw / TeamPro2026，固定可登入、長期保留。
   - 展示前可按 App 內「重置 Demo 資料」或重跑此函式，讓 7 天資料永遠落在「今天」結尾。
   - 只動 Demo 教練自己的資料（用其 coachId 過濾），不影響任何正式帳號。
   - 重用真實引擎（sleep/pain/hydration/quality/riskStatus）計算燈號，確保戰情室呈現一致。
   ============================================================ */
var DEMO_COACH = { email: 'demo@teampro.tw', password: 'TeamPro2026', name: 'TeamPro Demo 教練' };
var DEMO_TEAM_NAME = 'TeamPro 展示隊｜青少年運動 Demo';
var DEMO_SCHOOL = 'TeamPro 示範學校（Demo）';

function demoFindCoachId_() {
  var row = findRow(SHEETS.coaches, 'email', DEMO_COACH.email);
  return row === -1 ? '' : String(readAll(SHEETS.coaches)[row - 2].coachId);
}

/* 建立或更新 Demo 教練帳號（pro 永不過期＝解鎖全功能展示；仍只放 5 位選手） */
function demoEnsureCoach_() {
  var row = findRow(SHEETS.coaches, 'email', DEMO_COACH.email);
  var salt = uid('s_');
  if (row !== -1) {
    var c = readAll(SHEETS.coaches)[row - 2];
    var s = sheet(SHEETS.coaches);
    s.getRange(row, H.coaches.indexOf('salt') + 1).setValue(salt);
    s.getRange(row, H.coaches.indexOf('passwordHash') + 1).setValue(hashPassword(DEMO_COACH.password, salt));
    s.getRange(row, H.coaches.indexOf('name') + 1).setValue(DEMO_COACH.name);
    s.getRange(row, H.coaches.indexOf('plan') + 1).setValue('pro');
    s.getRange(row, H.coaches.indexOf('planExpiry') + 1).setValue('2099-12-31');
    s.getRange(row, H.coaches.indexOf('status') + 1).setValue('active');
    var ex = parseSettings(c.settings); ex.isDemo = true; ex.school = DEMO_SCHOOL; ex.kpiCadence = 'weekly'; ex.kpiVersion = 'v1';
    s.getRange(row, H.coaches.indexOf('settings') + 1).setValue(JSON.stringify(ex));
    return String(c.coachId);
  }
  var coachId = uid('c_');
  appendObj(SHEETS.coaches, {
    coachId: coachId, email: DEMO_COACH.email, passwordHash: hashPassword(DEMO_COACH.password, salt), salt: salt,
    name: DEMO_COACH.name, plan: 'pro', planExpiry: '2099-12-31', status: 'active',
    createdAt: now(), lastLogin: '', paymentNote: 'DEMO 展示帳號（請勿刪除）',
    settings: JSON.stringify({ isDemo: true, school: DEMO_SCHOOL, kpiCadence: 'weekly', kpiVersion: 'v1' })
  });
  return coachId;
}

/* 清掉 Demo 教練所有資料（只此 coachId，不碰正式資料） */
function demoWipe_(coachId) {
  var idSet = {}; idSet[String(coachId)] = true;
  deleteRowsByCoach(SHEETS.records, 'coachId', idSet);
  deleteRowsByCoach(SHEETS.attendance, 'coachId', idSet);
  deleteRowsByCoach(SHEETS.weeklyKpi, 'coachId', idSet);
  deleteRowsByCoach(SHEETS.competitions, 'coachId', idSet);
  deleteRowsByCoach(SHEETS.athletes, 'coachId', idSet);
  deleteRowsByCoach(SHEETS.teams, 'coachId', idSet);
}

function demoKpi_(a, b, c, d, e, f) {
  return { technical: a, tactical: b, physical: c, mental: d, attitude: e, physiological: f };
}

/* 依角色＋天數位移（0=今天）回傳當日回報輸入 */
function demoInputs_(key, offset) {
  var FB0 = {
    wang: '你這週的技術穩定度很好，代表平常訓練有累積出成果。不過壓力分數偏高，接下來我們先把目標放在「穩定完成每一組動作」，不要急著追求完美。',
    lin: '這週回報看起來比較簡短，教練不會責備你，但希望你可以多寫一句今天遇到的困難。只要你願意誠實回報，我們就比較知道怎麼幫你。',
    chen: '今天疼痛分數偏高，訓練先以低衝擊與技術修正為主，不急著衝強度。你的任務是把身體照顧好，這也是選手成熟的一部分。',
    hsu: '今天流汗量高但水分補充不足，這會影響專注力與恢復。明天訓練前先完成基本補水，訓練後也要觀察尿液顏色。',
    chang: '你這幾天的態度很穩，完成度也有提升。這種穩定累積就是進步的關鍵，接下來可以挑戰更高品質的動作細節。'
  };
  var FB3 = {
    wang: '這幾天的訓練紀律維持得很好。記得高壓時用呼吸調節，讓表現更穩定，不用每一下都追求滿分。',
    lin: '今天願意多寫一點，很好。教練看得到你的努力，明天我們一起設一個小目標，先求有做到再求做好。',
    chen: '恢復期照表操課，疼痛有下降就是好訊號。先把基礎動作做扎實，回到強度時會更穩。',
    hsu: '補水有改善，繼續保持訓練前中後分次喝水的習慣。身體狀態穩定，技術才能練得上去。',
    chang: '動作細節又更乾淨了，這種穩定進步很難得。下週可以挑戰把節奏再提一點，保持這個態度。'
  };
  var fdays = key === 'lin' ? [2, 4] : [0, 3];   // 林子棠今日未回報，回饋放在 day2/day4
  var fb = offset === fdays[0] ? FB0[key] : (offset === fdays[1] ? FB3[key] : '');

  if (key === 'wang') return {
    kpi: demoKpi_(5, 4, 4, 4, 5, 4), bed: '23:30', wake: '06:30',
    painStatus: 'none', painScore: 0, painImpact: 'none',
    water: 'enough', sweat: 'normal', urine: 'pale_yellow', fatigue: 3, mood: offset === 0 ? 2 : 3,
    am: '晨操：核心與動態暖身 30 分', pm: '專長訓練：品勢與腳法修正、踢靶 10 組', eve: '晚自習：影像複盤',
    notes: offset === 0 ? '今天動作很順，但比賽快到了有點緊張，壓力比較大。' : '訓練完成度高，腳法越來越穩定。',
    coachComment: fb
  };
  if (key === 'lin') {
    var hard = (offset === 1);
    var lb = Math.min(4, +(2.6 + offset * 0.07).toFixed(2)); // 越近(offset小)越低 → 週 KPI 連週下滑
    return {
      kpi: demoKpi_(lb, lb, lb, lb, lb, lb), bed: hard ? '02:00' : '00:30', wake: hard ? '05:30' : '06:30',
      sleepQuality: hard ? 'good' : '', painStatus: 'none', painScore: 0, painImpact: 'none',
      water: 'normal', sweat: 'normal', urine: 'yellow', fatigue: 5, mood: 3,
      am: '晨操：慢跑', pm: '專長訓練：基本動作', eve: '',
      notes: '普通', coachComment: fb
    };
  }
  if (key === 'chen') {
    var acute = (offset === 0);
    // 傷勢影響表現：KPI 隨 recency 遞減 → 連週下滑（戰情室「近期需要支持」，且今日有回報才會被列入）
    var cb = Math.min(4.2, +(2.9 + offset * 0.06).toFixed(2));
    return {
      kpi: demoKpi_(cb, cb, +(cb - 0.2).toFixed(2), cb, cb, +(cb - 0.2).toFixed(2)), bed: acute ? '00:30' : '23:30', wake: '06:00',
      painStatus: offset <= 1 ? 'new' : 'old', painScore: acute ? 7 : (offset === 1 ? 5 : 3),
      painImpact: acute ? 'power_down' : 'high_intensity',
      injuryAreas: '右大腿後側拉傷（Demo）', injuryNote: '踢擊後緊繃，下壓會痛',
      water: 'normal', sweat: 'normal', urine: 'pale_yellow', fatigue: acute ? 6 : 4, mood: 3,
      am: '晨操：低衝擊伸展', pm: acute ? '下午訓練：技術修正為主，暫停高強度對打' : '專長訓練：踢靶與步法', eve: '',
      notes: acute ? '右大腿後側拉傷還是會痛，今天踢擊力量出不太來。' : '拉傷部位有比較好一點，訓練有保留。',
      coachComment: fb
    };
  }
  if (key === 'hsu') {
    var dehy = (offset === 0);
    return {
      kpi: demoKpi_(4, 3, 4, 3, 4, 4), bed: '23:30', wake: dehy ? '05:30' : '06:30',
      painStatus: 'none', painScore: 0, painImpact: 'none',
      water: dehy ? 'very_little' : 'normal', sweat: dehy ? 'very_high' : 'high',
      urine: dehy ? 'dark' : 'yellow', fatigue: dehy ? 7 : 5, mood: 3,
      am: '晨操：間歇跑', pm: '專長訓練：高強度對打 5 回合', eve: '',
      notes: dehy ? '今天流好多汗，比較懶得喝水，下午有點頭暈。' : '訓練流汗多，會記得補水。',
      coachComment: fb
    };
  }
  // chang：穩定進步（KPI 逐日提升），今日輕微睡眠黃燈
  var base = Math.min(5, Math.max(3, +(4.4 - offset * 0.13).toFixed(2)));
  return {
    kpi: demoKpi_(base, base, base, base, Math.min(5, +(base + 0.2).toFixed(2)), base),
    bed: offset === 0 ? '00:00' : '23:30', wake: '06:30',
    painStatus: 'none', painScore: 0, painImpact: 'none',
    water: 'enough', sweat: 'normal', urine: 'pale_yellow', fatigue: 3, mood: 4,
    am: '晨操：技術暖身', pm: '專長訓練：動作品質與節奏', eve: '晚自習：自主伸展',
    notes: '今天狀態不錯，動作細節有抓到，會繼續保持。', coachComment: fb
  };
}

/* 用真實引擎把一筆 Demo 回報組成完整 record（含安全燈號與 KPI 雙軌） */
function demoBuildRecord_(coachId, team, a, date, inp, prev) {
  var sleep = sleepMetrics(inp.bed, inp.wake);
  var pain = painMetrics(inp.painStatus || 'none', inp.painScore || 0, inp.painImpact || 'none');
  var hydration = hydrationMetrics({ date: date, waterAmount: inp.water, sweatAmount: inp.sweat, urineColor: inp.urine, fatigue: inp.fatigue }, prev, sleep);
  var quality = qualityMetrics({ trainingNotes: inp.notes, painImpact: pain.impact, sleepQuality: inp.sleepQuality || '' }, {}, '', {}, [], pain, sleep);
  var status = riskStatus('green', pain.risk, sleep.risk, hydration.risk);
  var dims = inp.kpi;
  var total = dims ? +(['technical', 'tactical', 'physical', 'mental', 'attitude', 'physiological']
    .reduce(function (s, k) { return s + Number(dims[k]); }, 0) / 6).toFixed(2) : '';
  var rec = {
    recordId: uid('r_'), coachId: coachId, teamId: team.teamId, athleteId: a.athleteId, name: a.name,
    date: date, timestamp: date + 'T18:30:00.000Z', sessionType: 'training',
    technicalAvg: dims ? dims.technical : '', tacticalAvg: dims ? dims.tactical : '', physicalAvg: dims ? dims.physical : '',
    mentalAvg: dims ? dims.mental : '', attitudeAvg: dims ? dims.attitude : '', physiologicalAvg: dims ? dims.physiological : '',
    totalScore: total, status: status,
    moodIndex: inp.mood || '', reflection: inp.notes || '',
    trainingAM: inp.am || '', trainingPM: inp.pm || '', trainingEve: inp.eve || '', trainingNotes: inp.notes || '',
    sleepHours: sleep.minutes !== '' ? +(sleep.minutes / 60).toFixed(2) : '',
    fatigue: inp.fatigue || '', injuryAreas: inp.injuryAreas || '', injuryNote: inp.injuryNote || '',
    sleepBedTime: inp.bed || '', wakeTime: inp.wake || '', sleepQuality: inp.sleepQuality || '',
    sleepDurationMinutes: sleep.minutes, sleepDurationText: sleep.text, sleepRisk: sleep.risk,
    painStatus: pain.status, painAreas: pain.status === 'none' ? '' : (inp.injuryAreas || ''),
    painScore: pain.score, painImpact: pain.impact, painNote: inp.injuryNote || '', painRisk: pain.risk,
    waterAmount: hydration.water, sweatAmount: hydration.sweat, urineColor: hydration.urine,
    hydrationRisk: hydration.risk, hydrationAdvice: hydration.advice, hydrationFlags: hydration.flags.join(','),
    reportQualityScore: quality.score, reportQualityLabel: quality.label, reportQualityReasons: quality.reasons.join('、'),
    coachSuggestion: '', coachComment: inp.coachComment || '', coachFeedbackAt: inp.coachComment ? now() : ''
  };
  rec.coachSuggestion = coachSuggestionFor(rec);
  return rec;
}

/* 點名：每日一種課程輪替，狀態依角色循環（出席率差異＋今日留異常給戰情室展示） */
function demoSeedAttendance_(coachId, team, athletes, dates) {
  var courses = ['晨操', '專長訓練', '晚自習', '自主訓練'];
  // 各角色一段循環，跨日重複 → 不同出席率（王/張接近全勤，林最差）
  var cyc = {
    'Demo 王柏鈞': ['present'],
    'Demo 林子棠': ['present', 'late', 'absent', 'present', 'leave', 'late', 'absent'],
    'Demo 陳希恩': ['present', 'present', 'present', 'injured_watch', 'present', 'present', 'injured_watch'],
    'Demo 許晨熙': ['present', 'present', 'late', 'present', 'present'],
    'Demo 張晏慈': ['present', 'present', 'present', 'present', 'present', 'late', 'present']
  };
  dates.forEach(function (date, i) {
    var marks = {};
    athletes.forEach(function (a) {
      var arr = cyc[a.name] || ['present'];
      marks[String(a.athleteId)] = { s: arr[i % arr.length], n: '' };
    });
    appendObj(SHEETS.attendance, {
      attId: uid('at_'), coachId: coachId, teamId: team.teamId, date: date,
      course: courses[i % courses.length], marks: JSON.stringify(marks), updatedAt: now()
    });
  });
}

/* 重建 Demo 團隊＋5 選手＋7 天回報＋點名（資料永遠落在今天結尾） */
function demoRebuild_(coachId) {
  demoWipe_(coachId);
  var team = {
    teamId: uid('tm_'), coachId: coachId, teamName: DEMO_TEAM_NAME,
    sport: '跆拳道 / 綜合運動示範', shareToken: uid('sh_'), status: 'active', createdAt: now(),
    competitionSystem: '全中運項目', sportCategory: '技擊武道', memberTerm: '選手', asstPinHash: '', asstPinSalt: ''
  };
  appendObj(SHEETS.teams, team);
  var defs = [
    { key: 'wang', name: 'Demo 王柏鈞', gradeClass: '701' },
    { key: 'lin', name: 'Demo 林子棠', gradeClass: '702' },
    { key: 'chen', name: 'Demo 陳希恩', gradeClass: '801' },
    { key: 'hsu', name: 'Demo 許晨熙', gradeClass: '802' },
    { key: 'chang', name: 'Demo 張晏慈', gradeClass: '901' }
  ];
  var athletes = defs.map(function (d) {
    var a = {
      athleteId: uid('a_'), coachId: coachId, teamId: team.teamId, name: d.name, gradeClass: d.gradeClass,
      grp: '', active: true, createdAt: now(), lastPerformanceVisibility: 'self_coach_only',
      perfPinHash: '', perfPinSalt: '', kpiEnabled: true, kpiEnabledAt: now()
    };
    appendObj(SHEETS.athletes, a);
    a._key = d.key;
    return a;
  });
  var today = todayStr();
  var DAYS = 21; // 3 週：撐起 30 天報告與「近期需要支持（連續 3 週下滑）」
  var dates = []; for (var i = DAYS - 1; i >= 0; i--) dates.push(addDateDays(today, -i));
  athletes.forEach(function (a) {
    var prev = null;
    dates.forEach(function (date, di) {
      var offset = (DAYS - 1) - di; // di=最後 → offset 0 = 今天
      if (a._key === 'lin' && offset === 0) return; // 林子棠今日未回報（展示尚未回報）
      var inp = demoInputs_(a._key, offset);
      var rec = demoBuildRecord_(coachId, team, a, date, inp, prev);
      appendObj(SHEETS.records, rec);
      prev = rec;
    });
  });
  demoSeedAttendance_(coachId, team, athletes, dates);
  return { ok: true, teamId: team.teamId, shareToken: team.shareToken, athletes: athletes.length, days: dates.length };
}

/* 編輯器一鍵：建立／重建 Demo 帳號與完整展示資料 */
function seedDemoAccount() {
  var coachId = demoEnsureCoach_();
  var r = demoRebuild_(coachId);
  Logger.log('Demo seeded: ' + JSON.stringify(r));
  return r;
}

/* App 內「重置 Demo 資料」用：只有 Demo 帳號可呼叫 */
function resetDemoAction(c, d) {
  if (String(c.email) !== DEMO_COACH.email) return { ok: false, error: '只有 Demo 帳號可以重置展示資料' };
  var r = demoRebuild_(c.coachId);
  audit(c.email, 'resetDemo', c.coachId, 'rebuild ' + r.athletes + ' athletes');
  return { ok: true, message: 'Demo 展示資料已重置（7 天資料已更新到今天）', summary: r };
}
