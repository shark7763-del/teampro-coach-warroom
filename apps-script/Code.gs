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
  audit:    'audit'
};

/* ---------- 表頭 ---------- */
var H = {
  coaches:  ['coachId', 'email', 'passwordHash', 'salt', 'name', 'plan', 'planExpiry', 'status', 'createdAt', 'lastLogin'],
  sessions: ['token', 'coachId', 'expiresAt'],
  teams:    ['teamId', 'coachId', 'teamName', 'sport', 'shareToken', 'status', 'createdAt'],
  athletes: ['athleteId', 'coachId', 'teamId', 'name', 'gradeClass', 'grp', 'active', 'createdAt'],
  audit:    ['time', 'actor', 'action', 'target', 'detail']
};

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
    // 產出
    'nutritionAdvice', 'studentLineText', 'parentLineText', 'coachLineText',
    'rawJson'
  ]);

/* ---------- 方案設定（寫死，不進 Sheet） ---------- */
var PLANS = {
  free: { name: '免費版', maxAthletes: 5,   price: 0 },
  coach:{ name: '教練版', maxAthletes: 15,  price: 299 },
  team: { name: '團隊版', maxAthletes: 40,  price: 699 },
  pro:  { name: '專業版', maxAthletes: 100, price: 1299 }
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

    /* ---- 團隊 ---- */
    case 'listTeams':       return jsonOut(withCoach(d, listTeams));
    case 'createTeam':      return jsonOut(withCoach(d, createTeam));
    case 'resetShareToken': return jsonOut(withCoach(d, resetShareToken));

    /* ---- 選手 ---- */
    case 'listAthletes':    return jsonOut(withCoach(d, listAthletes));
    case 'addAthlete':      return jsonOut(withCoach(d, addAthlete));
    case 'setAthleteActive':return jsonOut(withCoach(d, setAthleteActive));

    /* ---- 戰情室 / 報告 ---- */
    case 'warroom':         return jsonOut(withCoach(d, warroom));
    case 'athleteRecords':  return jsonOut(withCoach(d, athleteRecords));
    case 'teamReport':      return jsonOut(withCoach(d, teamReport));

    /* ---- 選手填寫（公開，靠 shareToken 限定團隊） ---- */
    case 'joinInfo':        return jsonOut(joinInfo(d));
    case 'submitRecord':    return jsonOut(submitRecord(d));
    case 'lastRecord':      return jsonOut(lastRecord(d));
    case 'myRecords':       return jsonOut(myRecords(d));

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
    if (s.getLastRow() === 0 || s.getRange(1, 1).getValue() !== headers[0]) {
      s.getRange(1, 1, 1, headers.length).setValues([headers]); s.setFrozenRows(1);
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
    seedDemo(coachId);              // 註冊即給示範團隊，避免空白後台
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
    activeAthletes: countActiveAthletes(coachId)
  };
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
    // 防呆：同教練底下不可有同名團隊（防重複建立 / 連點兩下）
    var dup = readAll(SHEETS.teams).some(function (t) {
      return String(t.coachId) === String(c.coachId) && String(t.teamName).trim() === teamName;
    });
    if (dup) return { ok: false, error: '已有同名團隊「' + teamName + '」，請換個名稱' };
    var team = {
      teamId: uid('tm_'), coachId: c.coachId, teamName: teamName,
      sport: String(d.sport || '跆拳道'), shareToken: uid('sh_'), status: 'active', createdAt: now()
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

/* ============================================================
   選手（含配額鎖）
   ============================================================ */
function listAthletes(c, d) {
  var list = readAll(SHEETS.athletes).filter(function (a) {
    return String(a.coachId) === String(c.coachId) && (!d.teamId || String(a.teamId) === String(d.teamId));
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
      return { ok: false, error: 'plan_limit_reached', limit: max, plan: plan,
               message: '已達 ' + PLANS[plan].name + ' 上限（' + max + ' 人），請升級方案' };
    }
    var a = {
      athleteId: uid('a_'), coachId: c.coachId, teamId: teamId, name: name,
      gradeClass: String(d.gradeClass || ''), grp: String(d.grp || ''), active: true, createdAt: now()
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
  var todays = readAll(SHEETS.records).filter(function (r) {
    return String(r.coachId) === String(c.coachId) && String(r.date) === String(date);
  });
  var byAthlete = {};
  todays.forEach(function (r) { byAthlete[String(r.athleteId)] = r; });

  var submitted = [], missing = [], lights = { green: 0, yellow: 0, red: 0 };
  athletes.forEach(function (a) {
    var r = byAthlete[String(a.athleteId)];
    if (r) {
      var light = r.status || lightOf(r.totalScore);
      lights[light] = (lights[light] || 0) + 1;
      submitted.push({ athleteId: a.athleteId, name: a.name, totalScore: r.totalScore, status: light,
                       moodIndex: r.moodIndex, recordId: r.recordId });
    } else {
      missing.push({ athleteId: a.athleteId, name: a.name });
    }
  });
  return {
    ok: true, date: date,
    total: athletes.length, submittedCount: submitted.length, missingCount: missing.length,
    completionRate: athletes.length ? Math.round(submitted.length / athletes.length * 100) : 0,
    lights: lights, submitted: submitted, missing: missing
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

/* 團隊整體報告：彙整某期間全隊（或單一團隊）資料 */
function teamReport(c, d) {
  var teamId = d.teamId || '';
  var from = String(d.from || ''), to = String(d.to || '');
  var days = Number(d.days) || 1;

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

function joinInfo(d) {
  var t = teamFromShareToken(d.t || d.shareToken);
  if (!t) return { ok: false, error: '連結無效或已被重設，請向教練索取新連結' };
  var athletes = readAll(SHEETS.athletes).filter(function (a) {
    return String(a.teamId) === String(t.teamId) && (String(a.active) !== 'false' && a.active !== false);
  }).map(function (a) { return { athleteId: a.athleteId, name: a.name }; });
  return { ok: true, team: { teamId: t.teamId, teamName: t.teamName, sport: t.sport }, athletes: athletes, items: KPI_ITEMS };
}

/* 回上次紀錄（供「帶入上次分數」降低填寫摩擦） */
function lastRecord(d) {
  var t = teamFromShareToken(d.t || d.shareToken);
  if (!t) return { ok: false, error: '連結無效' };
  var aId = String(d.athleteId || '');
  var recs = readAll(SHEETS.records).filter(function (r) {
    return String(r.teamId) === String(t.teamId) && String(r.athleteId) === aId;
  }).sort(function (a, b) { return String(b.timestamp).localeCompare(String(a.timestamp)); });
  return { ok: true, record: recs[0] || null };
}

/* 選手查自己的近期紀錄（公開：靠 shareToken 限定團隊，只回自己的） */
function myRecords(d) {
  var t = teamFromShareToken(d.t || d.shareToken);
  if (!t) return { ok: false, error: '連結無效' };
  var aId = String(d.athleteId || '');
  var arow = findRow(SHEETS.athletes, 'athleteId', aId);
  if (arow === -1 || String(readAll(SHEETS.athletes)[arow - 2].teamId) !== String(t.teamId))
    return { ok: false, error: '選手不屬於此團隊' };
  var recs = readAll(SHEETS.records).filter(function (r) {
    return String(r.teamId) === String(t.teamId) && String(r.athleteId) === aId;
  }).sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
  return { ok: true, records: recs.slice(0, Number(d.limit || 14)) };
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
  var status = lightOf(total);

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
    sleepHours: d.sleepHours || '', fatigue: Number(d.fatigue) || '', injuryAreas: d.injuryAreas || '', injuryNote: d.injuryNote || '',
    nutritionAdvice: d.nutritionAdvice || '', studentLineText: d.studentLineText || '',
    parentLineText: d.parentLineText || '', coachLineText: d.coachLineText || '',
    rawJson: JSON.stringify(scores)
  };
  KPI_ITEMS.forEach(function (k) { rec[k] = Number(scores[k]) || ''; });

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
    return { ok: true, updated: true, totalScore: total, status: status, dimAvg: dimAvg };
  }
  appendObj(SHEETS.records, rec);
  return { ok: true, updated: false, totalScore: total, status: status, dimAvg: dimAvg };
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
  var q = String(d.q || '').trim().toLowerCase();
  var coaches = readAll(SHEETS.coaches).map(function (c) {
    return {
      coachId: c.coachId, email: c.email, name: c.name, plan: c.plan,
      planName: PLANS[c.plan] ? PLANS[c.plan].name : c.plan,
      planExpiry: c.planExpiry, expired: isExpired(c), status: c.status,
      createdAt: c.createdAt, lastLogin: c.lastLogin,
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
      if (t > Date.now() && t < soon) expiringSoon.push({ email: c.email, name: c.name, plan: c.plan, planExpiry: c.planExpiry });
    }
  });
  return { ok: true, totalCoaches: coaches.length, activeCoaches: active, byPlan: byPlan, mrr: mrr, expiringSoon: expiringSoon };
}

/* ============================================================
   Demo seed：註冊即送示範團隊 + 3 位假選手 + 今日假紀錄
   ============================================================ */
function seedDemo(coachId) {
  var teamId = uid('tm_');
  appendObj(SHEETS.teams, {
    teamId: teamId, coachId: coachId, teamName: '示範隊（可刪）', sport: '跆拳道',
    shareToken: uid('sh_'), status: 'active', createdAt: now()
  });
  var demos = [
    { name: '示範-小宇', total: 4.3 },
    { name: '示範-阿哲', total: 3.4 },
    { name: '示範-小美', total: 2.7 }
  ];
  demos.forEach(function (dm) {
    var aId = uid('a_');
    appendObj(SHEETS.athletes, {
      athleteId: aId, coachId: coachId, teamId: teamId, name: dm.name,
      gradeClass: '八年級', grp: '示範', active: true, createdAt: now()
    });
    var rec = {
      recordId: uid('r_'), coachId: coachId, teamId: teamId, athleteId: aId, name: dm.name,
      date: todayStr(), timestamp: now(), sessionType: 'training',
      technicalAvg: dm.total, tacticalAvg: dm.total, physicalAvg: dm.total,
      mentalAvg: dm.total, attitudeAvg: dm.total, physiologicalAvg: dm.total,
      totalScore: dm.total, status: lightOf(dm.total),
      moodIndex: 4, gratitude: '感謝教練', rawJson: '{}'
    };
    KPI_ITEMS.forEach(function (k) { rec[k] = Math.round(dm.total); });
    appendObj(SHEETS.records, rec);
  });
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
   sessions / teams / athletes / records。正式帳號不受影響。
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

  audit('admin', 'cleanupTestData', ids.join(','), JSON.stringify(report));
  return '已清除 ' + ids.length + ' 個測試教練。刪除列數：' +
    'coaches=' + report.coaches + '、sessions=' + report.sessions +
    '、teams=' + report.teams + '、athletes=' + report.athletes + '、records=' + report.records + '。';
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
