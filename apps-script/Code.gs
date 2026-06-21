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
  competitions: 'competitions'
};

/* ---------- 表頭 ---------- */
var H = {
  coaches:  ['coachId', 'email', 'passwordHash', 'salt', 'name', 'plan', 'planExpiry', 'status', 'createdAt', 'lastLogin', 'paymentNote', 'settings'],
  sessions: ['token', 'coachId', 'expiresAt'],
  teams:    ['teamId', 'coachId', 'teamName', 'sport', 'shareToken', 'status', 'createdAt', 'competitionSystem', 'sportCategory', 'memberTerm'],
  athletes: ['athleteId', 'coachId', 'teamId', 'name', 'gradeClass', 'grp', 'active', 'createdAt', 'lastPerformanceVisibility', 'perfPinHash', 'perfPinSalt'],
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
    'compName', 'compDate', 'compLocation', 'compResult', 'compDetail', 'compReflection', 'compAward', 'compAwardLink'
  ]);

/* ---------- 方案設定（寫死，不進 Sheet） ---------- */
var PLANS = {
  free: {
    name: '免費版', maxAthletes: 5, price: 0,
    lineNotifyPerDay: 1, report7Days: true, report30Days: false, pdfExport: false, multiTeam: false, customKpi: false, assistantAccounts: false,
    upgradePlan: 'coach'
  },
  coach: {
    name: '教練版', maxAthletes: 15, price: 299,
    lineNotifyPerDay: 'unlimited', report7Days: true, report30Days: true, pdfExport: true, multiTeam: false, customKpi: false, assistantAccounts: false,
    upgradePlan: 'team'
  },
  team: {
    name: '團隊版', maxAthletes: 40, price: 699,
    lineNotifyPerDay: 'unlimited', report7Days: true, report30Days: true, pdfExport: true, multiTeam: true, customKpi: true, assistantAccounts: false,
    upgradePlan: 'pro'
  },
  pro: {
    name: '專業版', maxAthletes: 100, price: 1299,
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
    case 'setAthleteActive':return jsonOut(withCoach(d, setAthleteActive));
    case 'updateAthlete':   return jsonOut(withCoach(d, updateAthlete));
    case 'deleteAthlete':   return jsonOut(withCoach(d, deleteAthlete));

    /* ---- 快速點名（跨裝置同步，存後端） ---- */
    case 'saveAttendance':  return jsonOut(withCoach(d, saveAttendance));
    case 'getAttendance':   return jsonOut(withCoach(d, getAttendance));
    case 'attendanceRange': return jsonOut(withCoach(d, attendanceRange));

    /* ---- 戰情室 / 報告 ---- */
    case 'warroom':         return jsonOut(withCoach(d, warroom));
    case 'athleteRecords':  return jsonOut(withCoach(d, athleteRecords));
    case 'teamReport':      return jsonOut(withCoach(d, teamReport));
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
    case 'lastRecord':      return jsonOut(lastRecord(d));
    case 'myRecords':       return jsonOut(myRecords(d));
    case 'perfPinStatus':   return jsonOut(perfPinStatus(d));
    case 'setPerfPin':      return jsonOut(setPerfPin(d));
    case 'teamCompetitions':return jsonOut(teamCompetitions(d));

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

/* 取得（或建立）指定分頁，並確保表頭 */
function sheet(name) {
  var s = ss().getSheetByName(name);
  var headers = H[name] || (name === SHEETS.records ? RECORD_HEADERS : null);
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
  var headers = (name === SHEETS.records) ? RECORD_HEADERS : H[name];
  var last = s.getLastRow();
  if (last < 2) return [];
  var vals = s.getRange(2, 1, last - 1, headers.length).getValues();
  var isRecords = (name === SHEETS.records);
  return vals.map(function (row) {
    var o = {};
    for (var i = 0; i < headers.length; i++) o[headers[i]] = row[i];
    if (isRecords && o.date) o.date = formatDateCell(o.date); // 防 Sheets 日期型別位移
    return o;
  });
}

/* 依某欄找列號（1-based sheet row），找不到回 -1 */
function findRow(name, colKey, value) {
  var s = sheet(name);
  var headers = (name === SHEETS.records) ? RECORD_HEADERS : H[name];
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
  var headers = (name === SHEETS.records) ? RECORD_HEADERS : H[name];
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

function newSession(coachId) {
  var token = uid('t_') + uid('');
  var exp = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(); // 30 天
  appendObj(SHEETS.sessions, { token: token, coachId: coachId, expiresAt: exp });
  return token;
}

function logout(d) {
  var row = findRow(SHEETS.sessions, 'token', d.token || '');
  if (row !== -1) sheet(SHEETS.sessions).deleteRow(row);
  return { ok: true };
}

/* 教練自助：修改顯示名稱（會反映在發給家長的報告上） */
function updateProfile(c, d) {
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
  return c;
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
  return { ok: true, coach: publicCoach(c.coachId) };
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
  var teams = readAll(SHEETS.teams).filter(function (t) { return String(t.coachId) === String(c.coachId); });
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
    if (!limit.multiTeam) {
      var existingTeamCount = readAll(SHEETS.teams).filter(function (t) {
        return String(t.coachId) === String(c.coachId) && String(t.status || 'active') !== 'disabled';
      }).length;
      if (existingTeamCount >= 1)
        return { ok: false, error: 'multi_team_locked', message: '目前方案僅支援 1 個隊伍，請升級後再新增。' };
    }
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
    var athN = deleteRowsByValue(SHEETS.athletes, 'teamId', d.teamId);
    var trow = findRow(SHEETS.teams, 'teamId', d.teamId);
    if (trow !== -1) sheet(SHEETS.teams).deleteRow(trow);
    audit(c.email, 'deleteTeam', d.teamId, t.teamName + ' (選手' + athN + '/紀錄' + recN + ')');
    return { ok: true, deletedAthletes: athN, deletedRecords: recN };
  } finally { lock.releaseLock(); }
}

/* 刪除某欄位等於指定值的所有列（由下往上刪避免位移） */
function deleteRowsByValue(name, colKey, value) {
  var s = sheet(name);
  var headers = (name === SHEETS.records) ? RECORD_HEADERS : H[name];
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
  var list = readAll(SHEETS.athletes).filter(function (a) {
    return String(a.coachId) === String(c.coachId) && (!d.teamId || String(a.teamId) === String(d.teamId));
  }).map(function (a) {
    // 不外洩 PIN 雜湊/鹽，只回是否已設定
    a.hasPerfPin = athleteHasPin(a);
    delete a.perfPinHash; delete a.perfPinSalt;
    return a;
  });
  return { ok: true, athletes: list, activeCount: countActiveAthletes(c.coachId), max: PLANS[effectivePlan(c)].maxAthletes };
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
        ? '你已達免費版 5 位選手上限。升級教練版，每月 299 元，可管理 15 位選手並開啟家長通知、歷史趨勢與成果報告。'
        : '已達 ' + PLANS[plan].name + ' 上限（' + max + ' 人），請升級方案';
      return { ok: false, error: 'plan_limit_reached', limit: max, plan: plan,
               message: limitMessage };
    }
    var a = {
      athleteId: uid('a_'), coachId: c.coachId, teamId: teamId, name: name,
      gradeClass: String(d.gradeClass || ''), grp: String(d.grp || ''), active: true, createdAt: now(),
      lastPerformanceVisibility: normVisibility(d.lastPerformanceVisibility)
    };
    appendObj(SHEETS.athletes, a);
    audit(c.email, 'addAthlete', a.athleteId, name);
    return { ok: true, athlete: a, activeCount: countActiveAthletes(c.coachId), max: max };
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
    var arow = findRow(SHEETS.athletes, 'athleteId', d.athleteId);
    if (arow !== -1) sheet(SHEETS.athletes).deleteRow(arow);
    audit(c.email, 'deleteAthlete', d.athleteId, a.name + ' (紀錄' + recN + ')');
    return { ok: true, deletedRecords: recN, activeCount: countActiveAthletes(c.coachId) };
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
  var comps = {}, medals = { gold: 0, silver: 0, bronze: 0 }, compParts = 0;
  recs.forEach(function (r) {
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
    reportCount: recs.length, reportRate: (aCount && days) ? Math.min(100, Math.round(recs.length / (aCount * days) * 100)) : 0,
    notesFilled: notesFilled, feedbackCount: fbCount,
    injuryAthletes: Object.keys(injSet).length, maxPain: maxPain, painParts: Object.keys(painParts),
    sleepShort: sleepShort, hydrationFlag: hydrFlag, lights: lights,
    competitions: compList, compCount: compList.length, compParticipants: compParts, medals: medals
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

  var submitted = [], missing = [], lights = { green: 0, yellow: 0, red: 0 }, encourages = [];
  var declining = [], worthEncouraging = [];
  athletes.forEach(function (a) {
    var r = byAthlete[String(a.athleteId)];
    if (r) {
      var light = r.status || lightOf(r.totalScore);
      var history = historyByAthlete[String(a.athleteId)] || [];
      var isDeclining = history.length >= 3 &&
        Number(history[0].totalScore) < Number(history[1].totalScore) &&
        Number(history[1].totalScore) < Number(history[2].totalScore);
      lights[light] = (lights[light] || 0) + 1;
      submitted.push({
        athleteId: a.athleteId, name: a.name, totalScore: r.totalScore, status: light,
        moodIndex: r.moodIndex, recordId: r.recordId, declining: isDeclining,
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
      if (light === 'green' && Number(r.totalScore) >= 4.3)
        worthEncouraging.push({ athleteId: a.athleteId, name: a.name, totalScore: r.totalScore });
      if (r.encourageMsg && String(r.encourageMsg).trim())
        encourages.push({ from: a.name, to: r.encourageName || '', msg: String(r.encourageMsg) });
    } else {
      missing.push({ athleteId: a.athleteId, name: a.name });
    }
  });
  return {
    ok: true, date: date,
    total: athletes.length, submittedCount: submitted.length, missingCount: missing.length,
    completionRate: athletes.length ? Math.round(submitted.length / athletes.length * 100) : 0,
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

  recs.forEach(function (r) {
    var t = Number(r.totalScore) || 0;
    if (t > 0) { totalSum += t; totalN++; }
    var l = r.status || lightOf(r.totalScore); lights[l] = (lights[l] || 0) + 1;
    DIMK.forEach(function (k) { var v = Number(r[k]) || 0; if (v > 0) { dimSum[k] += v; dimN[k]++; } });
    var ds = byDate[r.date] || (byDate[r.date] = { sum: 0, n: 0 });
    if (t > 0) { ds.sum += t; ds.n++; }
    (perA[r.athleteId] || (perA[r.athleteId] = [])).push(r);
  });

  // 每位選手摘要
  var athleteRows = athletes.map(function (a) {
    var rs = (perA[a.athleteId] || []).slice().sort(function (x, y) { return String(x.date).localeCompare(String(y.date)); });
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
  var pro = crow !== -1 && effectivePlan(readAll(SHEETS.coaches)[crow - 2]) === 'pro';
  return { ok: true, team: { teamId: t.teamId, teamName: t.teamName, sport: t.sport }, athletes: athletes, items: KPI_ITEMS, pro: pro };
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
  var recs = readAll(SHEETS.records).filter(function (r) {
    return String(r.teamId) === String(t.teamId) && String(r.athleteId) === aId;
  }).sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
  return { ok: true, records: recs.slice(0, Number(d.limit || 14)) };
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

  var scores = d.scores || {};
  var date = d.date || todayStr();

  // 計分：每面向 5 項平均、總分 6 面向等權平均
  var dimAvg = {};
  KPI_DIMENSIONS.forEach(function (dim, di) {
    var items = KPI_ITEMS.slice(di * 5, di * 5 + 5);
    var sum = 0, n = 0;
    items.forEach(function (k) { var v = Number(scores[k]); if (v >= 1 && v <= 5) { sum += v; n++; } });
    dimAvg[dim] = n ? +(sum / n).toFixed(2) : '';
  });
  var dims = KPI_DIMENSIONS.map(function (k) { return Number(dimAvg[k]) || 0; });
  var filled = dims.filter(function (v) { return v > 0; }).length;
  var total = filled ? +(dims.reduce(function (s, v) { return s + v; }, 0) / filled).toFixed(2) : 0;
  var baseStatus = lightOf(total);

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
  var quality = qualityMetrics(d, scores, total, dimAvg, athleteHistory, pain, sleep);
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
    rawJson: JSON.stringify(scores)
  };
  rec.coachSuggestion = coachSuggestionFor(rec);
  KPI_ITEMS.forEach(function (k) { rec[k] = Number(scores[k]) || ''; });
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
