(function () {
  var $ = TP.$, esc = TP.esc, toast = TP.toast;
  var APP_VERSION = 'v2026-06-27-speed-1';
  var authView = $('#authView'), appView = $('#appView');
  var mode = 'login';
  var state = { coach: null, teams: [], athletes: [], kpiMeta: {}, importRows: [], importFileName: '' };
  var dataLoaded = { teams: false, athletes: false, privacy: false, trial: false };
  var xlsxPromise = null;
  var signupJustCompleted = false;
  var params = new URLSearchParams(location.search);
  var DEMO = params.get('demo') === '1';
  function localToday() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function parentNoticeKey() { return 'teampro_parent_notice_count_' + String((state.coach && (state.coach.coachId || state.coach.email)) || 'guest'); }
  function coachKey() { return String((state.coach && (state.coach.coachId || state.coach.email)) || 'guest'); }
  function coachLS(suffix) { return 'teampro_' + suffix + '_' + coachKey(); }
  function planKey() { return (state.coach && state.coach.effectivePlan) || 'free'; }
  function planCfg() { return (TP.planLimits && TP.planLimits[planKey()]) || (TP.getPlanLimits ? TP.getPlanLimits(planKey()) : null) || TP.planLimits.free; }

  // 免費版曝光：LINE 分享文字底部浮水印 / 報告角落浮水印
  function lineWatermark() { return planKey() === 'free' ? '\n\n本紀錄由 TeamPro 教練戰情室產生\n免費管理你的隊伍，從點名開始。' : ''; }
  function freeReportBadge() { return planKey() === 'free' ? '<div style="position:absolute;right:14px;bottom:10px;font-size:11px;color:#94a3b8;font-weight:700;">TeamPro 教練戰情室｜免費版</div>' : ''; }

  /* 教練跨裝置設定（自訂課程清單、LINE 連結…）：存後端 coaches.settings */
  function coachSettings() { return (state.coach && state.coach.settings) || {}; }
  function isAssistantMode() { return !!(state.coach && state.coach.isAsst); }
  function isDemoMode() { return !!(state.coach && (state.coach.email === 'demo@teampro.tw' || (state.coach.settings && state.coach.settings.isDemo))); }
  async function saveCoachSettings(patch) {
    if (DEMO || isAssistantMode()) return;
    state.coach.settings = Object.assign({}, coachSettings(), patch);
    var r = await TP.callAuth('saveSettings', { settings: state.coach.settings });
    if (r && r.ok && r.settings) state.coach.settings = r.settings;
  }
  function importHint(text, isErr) {
    var box = $('#athleteImportHint');
    if (!box) return;
    box.textContent = text || '';
    box.style.color = isErr ? 'var(--red)' : 'var(--muted)';
  }
  function hideBootSplash() {
    var boot = document.getElementById('bootSplash');
    if (boot) boot.remove();
  }
  function idle(fn, timeout) {
    if ('requestIdleCallback' in window) requestIdleCallback(fn, { timeout: timeout || 1500 });
    else setTimeout(fn, 0);
  }
  function ensureXlsx() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    if (xlsxPromise) return xlsxPromise;
    xlsxPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
      s.async = true;
      s.onload = function () { resolve(window.XLSX); };
      s.onerror = function () { reject(new Error('Excel 解析套件載入失敗')); };
      document.head.appendChild(s);
    });
    return xlsxPromise;
  }
  function athleteImportTemplateRows() {
    return [
      ['teamName', 'name', 'gradeClass', 'grp', 'lastPerformanceVisibility'],
      ['跆拳道隊', '陳柏宇', '八年級', 'A', 'self_coach_only'],
      ['跆拳道隊', '林冠廷', '八年級', 'A', 'coach_assistant']
    ];
  }
  function downloadBlob(name, blob) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name; a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(url);
      a.remove();
    }, 0);
  }
  function downloadAthleteTemplate() {
    if (!window.XLSX) {
      var csv = athleteImportTemplateRows().map(function (row) {
        return row.map(function (cell) {
          var s = String(cell == null ? '' : cell);
          if (/[",\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
          return s;
        }).join(',');
      }).join('\n');
      downloadBlob('TeamPro選手名單範本.csv', new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      toast('已下載 CSV 範本，可直接用 Excel 開啟');
      return;
    }
    var wb = XLSX.utils.book_new();
    var ws = XLSX.utils.aoa_to_sheet(athleteImportTemplateRows());
    XLSX.utils.book_append_sheet(wb, ws, '選手名單');
    var note = XLSX.utils.aoa_to_sheet([
      ['TeamPro 選手匯入範本'],
      ['請保留第一列欄位名稱。'],
      ['teamName 請填團隊名稱，name 請填選手姓名。'],
      ['lastPerformanceVisibility 可留空，預設為 self_coach_only。']
    ]);
    XLSX.utils.book_append_sheet(wb, note, '說明');
    var out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    downloadBlob('TeamPro選手名單範本.xlsx', new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  }
  function readFileAsArrayBuffer(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(fr.error || new Error('讀檔失敗')); };
      fr.readAsArrayBuffer(file);
    });
  }
  function readFileAsText(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(fr.error || new Error('讀檔失敗')); };
      fr.readAsText(file, 'utf-8');
    });
  }
  function normalizeImportRow(row, rowNo) {
    row = row || {};
    var pick = function () {
      for (var i = 0; i < arguments.length; i++) {
        var key = arguments[i];
        if (row[key] != null && String(row[key]).trim() !== '') return String(row[key]).trim();
      }
      return '';
    };
    return {
      rowNo: rowNo,
      teamName: pick('teamName', 'team', '團隊名稱', '所屬團隊'),
      teamId: pick('teamId', '團隊ID'),
      name: pick('name', 'athleteName', '姓名', '選手姓名'),
      gradeClass: pick('gradeClass', 'grade', '年級班級', '班級'),
      grp: pick('grp', 'group', '組別'),
      lastPerformanceVisibility: pick('lastPerformanceVisibility', 'visibility', '上次表現可見')
    };
  }
  async function parseAthleteImportFile(file) {
    if (!file) return [];
    var ext = (file.name.split('.').pop() || '').toLowerCase();
    if (window.XLSX && ['xlsx', 'xls'].indexOf(ext) !== -1) {
      var data = await readFileAsArrayBuffer(file);
      var wb = XLSX.read(data, { type: 'array' });
      var sheet = wb.Sheets[wb.SheetNames[0]];
      var rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      return rows.map(function (r, idx) { return normalizeImportRow(r, idx + 2); });
    }
    if (window.XLSX && ['csv', 'tsv'].indexOf(ext) !== -1) {
      var txt = await readFileAsText(file);
      var wb2 = XLSX.read(txt, { type: 'string' });
      var sheet2 = wb2.Sheets[wb2.SheetNames[0]];
      var rows2 = XLSX.utils.sheet_to_json(sheet2, { defval: '' });
      return rows2.map(function (r, idx) { return normalizeImportRow(r, idx + 2); });
    }
    var text = await readFileAsText(file);
    var lines = text.split(/\r?\n/).filter(function (ln) { return String(ln).trim() !== ''; });
    if (!lines.length) return [];
    var header = lines.shift().split(',').map(function (s) { return s.trim(); });
    return lines.map(function (line, idx) {
      var cols = line.split(',');
      var obj = {};
      header.forEach(function (k, i) { obj[k] = (cols[i] || '').trim(); });
      return normalizeImportRow(obj, idx + 2);
    });
  }
  function unlockedFeatures(cfg) {
    return [
      '點名 ' + cfg.maxAthletes + ' 位・KPI ' + cfg.kpiAthletes + ' 位',
      cfg.report7Days ? '7 日報告' : '',
      cfg.report30Days ? '30 日報告' : '',
      cfg.pdfExport ? 'PDF 匯出' : '',
      cfg.multiTeam ? '多隊伍' : '',
      cfg.customKpi ? '自訂 KPI' : '',
      cfg.assistantAccounts ? '助理帳號' : '',
      cfg.lineNotifyPerDay === 'unlimited' ? 'LINE 通知不限次' : 'LINE 通知 1 次/日'
    ].filter(Boolean);
  }
  function lockedFeatures(cfg) {
    return [
      !cfg.report30Days ? '30 日報告' : '',
      !cfg.pdfExport ? 'PDF 匯出' : '',
      !cfg.multiTeam ? '多隊伍管理' : '',
      !cfg.customKpi ? '自訂 KPI 題目' : '',
      cfg.lineNotifyPerDay === 1 ? '每日 LINE 通知次數' : ''
    ].filter(Boolean);
  }
  function currentUpgradeTarget(reason) {
    var cfg = planCfg();
    if (reason === 'multiTeam') return cfg.upgradePlan === 'coach' ? 'coach' : (cfg.upgradePlan || 'team');
    if (reason === 'customKpi') return cfg.upgradePlan === 'team' ? 'team' : 'pro';
    if (reason === 'pdfExport' || reason === 'report30Days') return cfg.upgradePlan || 'coach';
    if (reason === 'lineNotify') return cfg.upgradePlan || 'coach';
    return cfg.upgradePlan || 'coach';
  }
  function openUpgradeModal(opts) {
    opts = opts || {};
    var cfg = planCfg();
    var target = opts.toPlan || currentUpgradeTarget(opts.reason || '');
    var targetCfg = TP.planLimits[target] || TP.planLimits.coach;
    var titleMap = {
      athletes: '已達選手上限',
      report30Days: '30 日報告需要升級',
      pdfExport: 'PDF 匯出需要升級',
      multiTeam: '多隊伍管理需要升級',
      customKpi: '自訂 KPI 需要升級',
      lineNotify: 'LINE 通知次數已達上限'
    };
    var reasonMap = {
      athletes: '目前方案已達選手數上限，暫時不能再新增。',
      report30Days: '免費版只保留 7 日報告，30 日報告屬於付費方案功能。',
      pdfExport: '免費版可以看報告，但不能直接匯出 PDF。',
      multiTeam: '目前方案僅支援單一隊伍，升級後可同時管理多隊伍。',
      customKpi: '目前方案不支援自訂 KPI 題目。',
      lineNotify: '免費版每日僅能發送 1 次 LINE 通知。'
    };
    $('#upTitle').textContent = titleMap[opts.reason] || '升級解鎖更多功能';
    $('#upPlanLine').textContent = '目前方案：' + cfg.name + '。建議升級至：' + targetCfg.name + '。';
    $('#upReason').textContent = opts.message || reasonMap[opts.reason] || '升級後可解鎖更多教練常用功能，讓日常管理更省時間。';
    $('#upUnlocks').innerHTML = unlockedFeatures(targetCfg).map(function (x) {
      return '<span class="pill green">' + esc(x) + '</span>';
    }).join('');
    var benefitMap = {
      athletes: '升級後可繼續新增選手，不會卡在人數上限。',
      report30Days: '你可以直接看 30 日趨勢，方便追蹤訓練節奏。',
      pdfExport: '可以直接把報告存成 PDF，方便傳給家長或校方。',
      multiTeam: '可同時管理多個隊伍，不必分帳號處理。',
      customKpi: '可依項目調整 KPI 名稱，報告與導引更貼近實務。',
      lineNotify: '可持續發送 LINE 催繳與家長通知，不必等到隔天。'
    };
    $('#upList').innerHTML = '<li>' + esc(benefitMap[opts.reason] || '升級後可立即解鎖目前被限制的功能。') + '</li>' +
      '<li>推薦方案：' + esc(targetCfg.name) + '</li>' +
      '<li>目前方案：' + esc(cfg.name) + '</li>';
    $('#upApply').href = 'https://docs.google.com/forms/d/e/1FAIpQLSc2WhGQP1BQhWMgTJFtnR_gznolKA-KDqYVqXzBEfuxZI7OHA/viewform';
    $('#upgradeModal').classList.remove('hidden');
  }
  function closeUpgradeModal() { $('#upgradeModal').classList.add('hidden'); }
  function markTask(key, done) {
    localStorage.setItem(coachLS('task_' + key), done ? '1' : '0');
  }
  function taskDone(key) { return localStorage.getItem(coachLS('task_' + key)) === '1'; }
  function notifyCountKey() { return coachLS('line_notify_' + localToday()); }
  function lineNotifyAllowed() {
    var cfg = planCfg();
    var limit = cfg.lineNotifyPerDay;
    if (limit === 'unlimited') return true;
    var cnt = Number(localStorage.getItem(notifyCountKey()) || 0);
    return cnt < Number(limit || 0);
  }
  function consumeLineNotify() {
    var cfg = planCfg();
    if (cfg.lineNotifyPerDay === 'unlimited') return true;
    var key = notifyCountKey();
    var cnt = Number(localStorage.getItem(key) || 0);
    if (cnt >= Number(cfg.lineNotifyPerDay || 0)) return false;
    localStorage.setItem(key, String(cnt + 1));
    return true;
  }
  function copyLineText(text, reason) {
    if (planKey() === 'free' && !lineNotifyAllowed()) {
      openUpgradeModal({ reason: reason || 'lineNotify', message: '免費版每日僅能發送 1 次 LINE 通知。' });
      return false;
    }
    if (!consumeLineNotify()) {
      openUpgradeModal({ reason: reason || 'lineNotify', message: '今日 LINE 通知次數已達上限。' });
      return false;
    }
    if (window.TPNative && TPNative.isNative) { TPNative.share({ title: 'TeamPro 通知', text: text }); }
    else { TP.copy(text); }
    return true;
  }
  function defaultKpiLabels() { return ['技術執行', '戰術理解', '體能負荷', '心理狀態', '訓練態度', '生理恢復']; }
  function customKpiLabels() {
    var cfg = planCfg();
    var raw = String(localStorage.getItem(coachLS('custom_kpi')) || '').trim();
    if (!cfg.customKpi || !raw) return defaultKpiLabels();
    var parts = raw.split(/[\n,，、]+/).map(function (s) { return s.trim(); }).filter(Boolean);
    var labels = defaultKpiLabels();
    for (var i = 0; i < Math.min(6, parts.length); i++) labels[i] = parts[i];
    return labels;
  }

  /* ---------- 啟動 ---------- */
  function boot() {
    if (DEMO) { enterDemo(); return; }
    if (params.get('signup') === '1') mode = 'signup';
    if (TP.getToken()) {
      TP.callAuth('me').then(function (r) {
        if (r.ok) { state.coach = r.coach; if (state.coach) state.coach.isAsst = !!r.isAsst; showApp(); }
        else { showAuth(); }
      });
    } else { showAuth(); }
  }

  function showAuth() {
    authView.classList.remove('hidden'); appView.classList.add('hidden');
    hideBootSplash();
    $('#appVersionAuth').textContent = APP_VERSION;
    $('#cfgUrl').value = TP.getUrl();
    setMode(mode);
  }
  function setMode(m) {
    mode = m;
    $('#tabLogin').className = 'btn' + (m === 'login' ? ' btn-primary' : '');
    $('#tabSignup').className = 'btn' + (m === 'signup' ? ' btn-primary' : '');
    $('#signupFields').classList.toggle('hidden', m !== 'signup');
    $('#authSubmit').textContent = (m === 'signup') ? '免費註冊' : '登入';
    $('#authHint').textContent = (m === 'signup')
      ? '註冊即免費開通；示範資料使用獨立前端模式，不會寫入你的正式帳號。'
      : '';
    requestAnimationFrame(function () {
      if (m === 'signup') $('#suName').focus();
      else $('#auEmail').focus();
    });
  }

  $('#tabLogin').onclick = function () { setMode('login'); };
  $('#tabSignup').onclick = function () { setMode('signup'); };
  $('#cfgSave').onclick = function () { TP.setUrl($('#cfgUrl').value); toast('已儲存後端網址'); };
  $('#btnGoTeams').onclick = function () { switchTab('teams'); $('#ntName').focus(); };
  $('#btnDismissSignupWelcome').onclick = function () {
    $('#signupWelcome').classList.add('hidden');
    localStorage.setItem('teampro_signup_welcome_dismissed', '1');
  };

  $('#authSubmit').onclick = async function () {
    if (!TP.getUrl()) { toast('請先在下方系統設定貼上後端網址', true); return; }
    var email = $('#auEmail').value.trim(), pw = $('#auPassword').value;
    if (!email || !pw) { toast('請輸入 email 與密碼', true); return; }
    var btn = this;
    var r;
    btn.disabled = true;
    try {
      if (mode === 'signup') {
        var name = $('#suName').value.trim();
        if (!name) { toast('請輸入教練姓名', true); return; }
        if (!$('#suAgree').checked) { toast('請先閱讀並勾選同意服務條款與隱私權政策', true); return; }
        r = await TP.call('register', { email: email, password: pw, name: name });
      } else {
        r = await TP.call('login', { email: email, password: pw });
      }
      if (!r.ok) { toast(r.error || '失敗', true); return; }
      TP.setToken(r.token); state.coach = r.coach;
      signupJustCompleted = (mode === 'signup');
      toast(mode === 'signup' ? '註冊成功，歡迎！' : '登入成功');
      showApp();
    } finally {
      btn.disabled = false;
    }
  };

  /* ---------- 主後台 ---------- */
  function showApp() {
    authView.classList.add('hidden'); appView.classList.remove('hidden');
    hideBootSplash();
    $('#appVersion').textContent = APP_VERSION;
    document.body.classList.toggle('assistant-mode', isAssistantMode());
    $('#coachName').textContent = state.coach.name + '（' + state.coach.email + '）';
    $('#assistantBanner').classList.toggle('hidden', !isAssistantMode());
    var welcome = $('#signupWelcome');
    var dismissed = localStorage.getItem('teampro_signup_welcome_dismissed') === '1';
    welcome.classList.toggle('hidden', !(signupJustCompleted && !dismissed));
    $('#setName').value = state.coach.name || '';
    $('#setEmail').value = state.coach.email || '';
    if (coachSettings().lineUrl) TP.setLineUrl(coachSettings().lineUrl); // 跨裝置同步 LINE 連結
    $('#rpSchool').value = coachSettings().school || '';
    var cs = coachSettings();
    $('#logAffiliation').value = cs.logAffiliation || '';
    $('#logPeClass').value = cs.logPeClass || '體育班';
    if (cs.logWeather) $('#logWeather').value = cs.logWeather;
    $('#logHours').value = cs.logHours || 2;
    if (cs.logGender) $('#logGender').value = cs.logGender;
    $('#setUrl').value = TP.getUrl();
    $('#setLineUrl').value = TP.getLineUrl();
    $('#setLineOpen').href = TP.getLineUrl();
    $('#customKpiText').value = localStorage.getItem(coachLS('custom_kpi')) || '';
    $('#kpiCadence').value = coachSettings().kpiCadence === 'daily' ? 'daily' : 'weekly';
    $('#kpiVersion').value = coachSettings().kpiVersion === 'v2' ? 'v2' : 'v1';
    $('#kpiCadenceWrap').classList.toggle('hidden', coachSettings().kpiVersion === 'v2');
    $('#tab-settings').classList.toggle('hidden', isAssistantMode());
    $('#btnPrint').classList.toggle('hidden', isAssistantMode());
    $('#demoGuide').classList.toggle('hidden', !isDemoMode());
    state.importRows = [];
    state.importFileName = '';
    importHint('');
    renderPlan();
    $('#warDate').value = localToday();
    $('#pendingReplyList').innerHTML = skeletonRows(2);
    $('#repliedList').innerHTML = skeletonRows(1);
    $('#missList').innerHTML = '';
    loadTeams().then(function () {
      loadWarroom();
      idle(function () { if (!dataLoaded.trial) loadTrialSummary(); }, 1800);
      var lazyTab = params.get('lazyTab');
      if (lazyTab) setTimeout(function () { switchTab(lazyTab); }, 0);
    });
    signupJustCompleted = false;
  }

  function renderPlan() {
    var c = state.coach;
    var cfg = planCfg();
    $('#planLabel').textContent = c.planName + (c.expired ? '（已到期，暫以免費版限制）' : '');
    $('#planQuota').textContent = ' · 點名 ' + c.activeAthletes + ' / ' + cfg.maxAthletes + ' · 狀態追蹤 ' + cfg.kpiAthletes;
    var pct = Math.min(100, Math.round(c.activeAthletes / cfg.maxAthletes * 100));
    var fill = $('#quotaFill'); fill.style.width = pct + '%';
    fill.className = pct >= 100 ? 'full' : (pct >= 80 ? 'warn' : '');
    $('#planExpiryNote').textContent = c.planExpiry ? ('到期日：' + String(c.planExpiry).slice(0, 10)) : '';
    $('#planNamePretty').textContent = cfg.name;
    $('#planUsagePretty').textContent = '點名 ' + c.activeAthletes + ' / ' + cfg.maxAthletes + '　KPI ' + cfg.kpiAthletes;
    $('#planUpgradePretty').textContent = cfg.multiTeam
      ? '已開啟多隊伍與自訂 KPI，適合多隊並行管理。'
      : '先把第一個隊伍與第一位選手建立起來，升級後可解鎖更多功能。';
    $('#planFeatureList').innerHTML = [
      { ok: true, text: '7 日報告' },
      { ok: !!cfg.report30Days, text: '30 日報告' },
      { ok: !!cfg.pdfExport, text: 'PDF 匯出' },
      { ok: !!cfg.multiTeam, text: '多隊伍管理' },
      { ok: !!cfg.customKpi, text: '自訂 KPI 題目' },
      { ok: !!cfg.assistantAccounts, text: '助理帳號' },
      { ok: cfg.lineNotifyPerDay === 'unlimited', text: 'LINE 通知不限次' }
    ].map(function (x) {
      return '<div class="plan-feat' + (x.ok ? '' : ' locked') + '">' +
        (x.ok ? '✅ ' : '🔒 ') + esc(x.text) + '</div>';
    }).join('');
    $('#customKpiHint').textContent = cfg.customKpi ? '你現在可以儲存自訂 KPI 題目。' : '團隊版以上才可自訂 KPI 題目。';
    $('#btnSaveKpi').disabled = !cfg.customKpi;
    $('#customKpiText').disabled = !cfg.customKpi;
    $('#planInsight').style.display = '';
  }

  async function refreshMe() {
    var r = await TP.callAuth('me'); if (r.ok) { state.coach = r.coach; if (state.coach) state.coach.isAsst = !!r.isAsst; renderPlan(); }
  }

  function onboardingState() {
    return {
      team: state.teams.length > 0,
      athlete: state.athletes.filter(function (a) { return String(a.active) !== 'false' && a.active !== false; }).length > 0,
      rollcall: taskDone('rollcall'),
      link: taskDone('link'),
      firstReport: taskDone('first_report') || Number(localStorage.getItem(coachLS('first_report_seen')) || 0) > 0,
      report7: taskDone('report7')
    };
  }

  function renderOnboarding() {
    if (!state.coach || DEMO || localStorage.getItem(coachLS('onboard_hidden')) === '1') {
      $('#onboardWrap').classList.add('hidden');
      return;
    }
    var st = onboardingState();
    var tasks = [
      { key: 'team', title: '第一步：建立隊伍', desc: '先建一隊（籃球隊、田徑隊、游泳隊、跆拳道隊都可以），不用一次設定完整系統。', done: st.team, btn: '去建立隊伍', action: function () { switchTab('teams'); $('#ntName').focus(); } },
      { key: 'athlete', title: '第二步：新增選手', desc: '把名單建起來，免費版先放 5 位也能完整體驗。', done: st.athlete, btn: '新增選手', action: function () { switchTab('athletes'); $('#naName').focus(); } },
      { key: 'rollcall', title: '第三步：今天先點一次名', desc: '每天 10 秒點名，先從點名開始就好，資料會自動累積成報告。', done: st.rollcall, btn: '開始 10 秒點名', action: function () { switchTab('attendance'); } },
      { key: 'link', title: '第四步：把回報連結貼給選手／家長', desc: '選手每天花 1 分鐘回報狀態，教練不用追問也能掌握。', done: st.link, btn: '複製回報連結', action: function () { switchTab('teams'); copyFirstTeamLink(); } },
      { key: 'report7', title: '第五步：看一次報告範例', desc: '平常點名與回報，月底自動整理成報告，先看一次效果。', done: st.report7, btn: '看報告範例', action: function () { switchTab('report'); $('#rpRange').value = '7'; $('#rpType').value = 'athlete'; $('#rpType').onchange(); $('#btnGenReport').click(); } }
    ];
    $('#onboardGrid').innerHTML = tasks.map(function (t) {
      return '<div class="onboard-card' + (t.done ? ' done' : '') + '">' +
        '<div><div class="step">任務</div><div class="title">' + (t.done ? '✅ ' : '○ ') + esc(t.title) + '</div>' +
        '<div class="status muted">' + esc(t.desc) + '</div></div>' +
        '<div class="actions"><button class="btn btn-sm ' + (t.done ? 'btn-ghost' : 'btn-primary') + '" data-onboard="' + t.key + '">' + esc(t.btn) + '</button></div>' +
      '</div>';
    }).join('');
    $('#onboardWrap').classList.toggle('hidden', tasks.every(function (t) { return t.done; }));
    TP.$all('[data-onboard]', $('#onboardGrid')).forEach(function (b) {
      var task = tasks.filter(function (t) { return t.key === b.dataset.onboard; })[0];
      if (task) b.onclick = task.action;
    });
  }

  function switchTab(tab) {
    if (tab === 'settings' && isAssistantMode()) {
      toast('助教模式不能進入設定', true);
      tab = 'warroom';
    }
    TP.$all('.tab-btn').forEach(function (x) { x.classList.remove('active'); });
    var btn = TP.$('.tab-btn[data-tab="' + tab + '"]');
    if (btn) { btn.classList.add('active');
      if (btn.scrollIntoView) btn.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' }); }
    ['warroom', 'attendance', 'athletes', 'teams', 'report', 'settings'].forEach(function (t) {
      $('#tab-' + t).classList.toggle('hidden', t !== tab);
    });
    if (tab === 'settings' && !DEMO) loadAthletesOnce().then(loadPrivacyRequests);
    if (tab === 'athletes') loadAthletesOnce();
    if (tab === 'report') loadAthletesOnce();
    if (tab === 'attendance') loadAthletesOnce().then(loadAttendance);
    syncMobileTabbar(tab);
  }

  /* ---------- 手機底部 5 分頁 ---------- */
  function syncMobileTabbar(tab) {
    TP.$all('#mobileTabbar button').forEach(function (b) {
      b.classList.toggle('active', b.dataset.tab === tab);
    });
  }
  TP.$all('#mobileTabbar button').forEach(function (b) {
    b.onclick = function () {
      var t = b.dataset.tab;
      if (t === '__more') { showMoreSheet(); return; }
      switchTab(t);
    };
  });
  function showMoreSheet() {
    var items = [['teams', '👥 團隊與連結']];
    if (!isAssistantMode()) items.push(['settings', '⚙️ 設定 / 方案 / 個資請求']);
    var ov = TP.el('div', { class: 'modal-overlay' },
      '<div class="modal-box card" style="max-width:420px;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;"><h3 style="margin:0;">更多</h3>' +
        '<button class="btn btn-sm btn-ghost" id="moreClose">✕</button></div>' +
        items.map(function (it) { return '<button class="btn btn-block" style="margin-top:10px;text-align:left;" data-more="' + it[0] + '">' + it[1] + '</button>'; }).join('') +
      '</div>');
    document.body.appendChild(ov);
    ov.onclick = function (e) { if (e.target === ov) ov.remove(); };
    ov.querySelector('#moreClose').onclick = function () { ov.remove(); };
    TP.$all('[data-more]', ov).forEach(function (b) {
      b.onclick = function () { switchTab(b.dataset.more); ov.remove(); };
    });
  }

  function copyFirstTeamLink() {
    if (!state.teams.length) { toast('請先建立團隊', true); return; }
    var url = shareUrl(state.teams[0].shareToken);
    TP.copy(url);
    markTask('link', true);
    renderOnboarding();
  }

  $('#btnLogout').onclick = async function () {
    if (DEMO) { location.href = 'index.html'; return; }
    await TP.callAuth('logout'); TP.clearToken(); location.reload();
  };

  $('#btnResetDemo').onclick = async function () {
    if (!confirm('這只會重置 Demo 測試資料，不會影響正式資料，是否繼續？')) return;
    this.disabled = true; var old = this.textContent; this.textContent = '重置中…';
    var r = await TP.callAuth('resetDemo');
    this.disabled = false; this.textContent = old;
    if (r && r.ok) { toast('Demo 資料已重置，重新載入中…'); setTimeout(function () { location.reload(); }, 800); }
    else { toast((r && r.error) || '重置失敗', true); }
  };

  // tabs
  TP.$all('.tab-btn').forEach(function (b) {
    b.onclick = function () {
      switchTab(b.dataset.tab);
    };
  });

  /* ---------- 團隊 ---------- */
  async function loadTeams() {
    var r = await TP.callAuth('listTeams');
    state.teams = (r.ok && r.teams) || [];
    dataLoaded.teams = true;
    var opts = '<option value="">全部團隊</option>' + state.teams.map(function (t) {
      return '<option value="' + t.teamId + '">' + esc(t.teamName) + '</option>';
    }).join('');
    $('#warTeam').innerHTML = opts;
    $('#naTeam').innerHTML = state.teams.length
      ? state.teams.map(function (t) { return '<option value="' + t.teamId + '">' + esc(t.teamName) + '</option>'; }).join('')
      : '<option value="">（請先建立團隊）</option>';
    $('#rpTeam').innerHTML = '<option value="">全部團隊</option>' + state.teams.map(function (t) {
      return '<option value="' + t.teamId + '">' + esc(t.teamName) + '</option>';
    }).join('');
    renderTeams();
    renderOnboarding();
  }

  async function loadAthletesOnce(force) {
    if (dataLoaded.athletes && !force) return state.athletes;
    await loadAthletes();
    dataLoaded.athletes = true;
    return state.athletes;
  }

  function shareUrl(token) {
    var publicBase = 'https://shark7763-del.github.io/teampro-coach-warroom/';
    var base = location.protocol === 'file:'
      ? publicBase + 'join.html'
      : new URL('join.html', location.href).href;
    base += '?t=' + encodeURIComponent(token);
    // 後端網址已內建於 api.js（DEFAULT_URL），join.html 開啟即可用，
    // 不需再把 &api= 塞進連結 → 連結大幅縮短。
    return base;
  }

  function asstUrl(token) {
    var publicBase = 'https://shark7763-del.github.io/teampro-coach-warroom/';
    var base = location.protocol === 'file:'
      ? publicBase + 'assistant.html'
      : new URL('assistant.html', location.href).href;
    return base + '?t=' + encodeURIComponent(token);
  }

  function renderTeams() {
    var box = $('#teamList');
    if (!state.teams.length) { box.innerHTML = '<p class="muted">目前尚無團隊，請先建立團隊，再分享填寫連結給選手。</p>'; return; }
    box.innerHTML = state.teams.map(function (t) {
      var url = shareUrl(t.shareToken);
      var aurl = asstUrl(t.shareToken);
      var hasAsst = t.hasAsstPin === true || t.hasAsstPin === 'true';
      var asstLine = hasAsst
        ? '<div class="link-box" style="flex:1;min-width:280px;">' +
            '<input readonly value="' + esc(aurl) + '">' +
            '<button class="btn btn-sm" data-asst-copy="' + esc(aurl) + '">複製</button>' +
            '<button class="btn btn-sm" data-asst-set="' + t.teamId + '">變更 PIN</button>' +
            '<button class="btn btn-sm btn-danger" data-asst-clear="' + t.teamId + '">關閉</button>' +
          '</div>'
        : '<button class="btn btn-sm" data-asst-set="' + t.teamId + '">開啟助教權限（設定 PIN）</button>';
      return '<div class="row" style="flex-direction:column;align-items:stretch;gap:8px;">' +
        '<div><b>' + esc(t.teamName) + '</b> <span class="muted">· ' + esc(t.sport) + (t.sportCategory ? ' · ' + esc(t.sportCategory) : '') + '</span></div>' +
        '<div class="link-box" style="flex:1;min-width:280px;">' +
          '<input readonly value="' + esc(url) + '">' +
          '<button class="btn btn-sm" data-copy="' + esc(url) + '">複製</button>' +
          '<button class="btn btn-sm btn-danger" data-reset="' + t.teamId + '">重設連結</button>' +
          '<button class="btn btn-sm btn-danger" data-del="' + t.teamId + '" data-name="' + esc(t.teamName) + '">刪除</button>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">' +
          '<span class="muted" style="font-size:13px;white-space:nowrap;">🧑‍🏫 助教連結（⚠️ 此 PIN 可進入完整後台，等同帳號權限）· ' + (hasAsst ? '<span style="color:var(--green)">已開啟</span>' : '未開啟') + '</span>' +
          asstLine +
        '</div>' +
      '</div>';
    }).join('');
    TP.$all('[data-asst-copy]', box).forEach(function (b) { b.onclick = function () { TP.copy(b.dataset.asstCopy); }; });
    TP.$all('[data-asst-set]', box).forEach(function (b) {
      b.onclick = async function () {
        if (DEMO) { demoBlock(); return; }
        var pin = prompt('⚠️ 注意：助教用這組 PIN 可進入「完整教練後台」，等同你的帳號權限（含設定、方案訂閱、帳單、名單增刪、刪隊）。請只給信任的人。\n\n設定 4 位數助教 PIN：');
        if (pin == null) return;
        pin = String(pin).trim();
        if (!/^\d{4}$/.test(pin)) { toast('PIN 需為 4 位數字', true); return; }
        var r = await TP.callAuth('setAssistantPin', { teamId: b.dataset.asstSet, pin: pin });
        if (r.ok) { toast('助教權限已開啟，把連結與 PIN 給助教即可'); loadTeams(); } else { toast(r.error, true); }
      };
    });
    TP.$all('[data-asst-clear]', box).forEach(function (b) {
      b.onclick = async function () {
        if (DEMO) { demoBlock(); return; }
        if (!confirm('關閉後，現有助教連結與 PIN 立即失效，助教將無法再進入後台。確定？')) return;
        var r = await TP.callAuth('setAssistantPin', { teamId: b.dataset.asstClear, clear: true });
        if (r.ok) { toast('已關閉助教權限'); loadTeams(); } else { toast(r.error, true); }
      };
    });
    TP.$all('[data-copy]', box).forEach(function (b) {
      b.onclick = function () {
        TP.copy(b.dataset.copy);
        markTask('link', true);
        renderOnboarding();
      };
    });
    TP.$all('[data-reset]', box).forEach(function (b) {
      b.onclick = async function () {
        if (DEMO) { demoBlock(); return; }
        if (!confirm('重設後舊連結立即失效，需重新分享給選手。確定？')) return;
        var r = await TP.callAuth('resetShareToken', { teamId: b.dataset.reset });
        if (r.ok) { toast('連結已重設'); loadTeams(); } else { toast(r.error, true); }
      };
    });
    TP.$all('[data-del]', box).forEach(function (b) {
      b.onclick = async function () {
        if (DEMO) { demoBlock(); return; }
        var cnt = state.athletes.filter(function (a) { return String(a.teamId) === String(b.dataset.del); }).length;
        if (!confirm('確定刪除團隊「' + b.dataset.name + '」？\n會一併刪除該隊 ' + cnt + ' 位選手與其所有填寫紀錄，無法復原。')) return;
        var r = await TP.callAuth('deleteTeam', { teamId: b.dataset.del });
        if (r.ok) { toast('已刪除（選手 ' + r.deletedAthletes + '、紀錄 ' + r.deletedRecords + '）'); await refreshMe(); loadTeams(); loadAthletes(); }
        else { toast(r.error, true); }
      };
    });
  }

  $('#btnCreateTeam').onclick = async function () {
    if (DEMO) { demoBlock(); return; }
    if (state.teams.length >= (planCfg().maxTeams || 1)) {
      openUpgradeModal({ reason: 'multiTeam', toPlan: 'team',
        message: planKey() === 'free'
          ? '免費版可建立 1 個隊伍。升級團隊版後，可以管理多隊伍，適合校隊、社團與道館使用。'
          : '目前方案最多 ' + (planCfg().maxTeams || 1) + ' 個隊伍，升級團隊版後可管理更多隊伍。' });
      return;
    }
    var name = $('#ntName').value.trim();
    if (!name) { toast('請輸入團隊名稱', true); return; }
    // 前端防呆：同名團隊已存在就擋（後端另有最終把關）
    if (state.teams.some(function (t) { return String(t.teamName).trim() === name; })) {
      toast('已有同名團隊「' + name + '」', true); return;
    }
    var sport = ($('#ntSystem').value === '全中運項目') ? $('#ntEvent').value : $('#ntSport').value.trim();
    if (!sport) { toast('請選擇或輸入競技項目', true); return; }
    var btn = this; btn.disabled = true;
    var r = await TP.callAuth('createTeam', {
      teamName: name, sport: sport,
      competitionSystem: $('#ntSystem').value, sportCategory: $('#ntCategory').value,
      memberTerm: $('#ntMemberTerm').value
    });
    if (r.ok) { $('#ntName').value = ''; toast('團隊已建立'); loadTeams(); }
    else if (r.error === 'plan_limit_reached' || r.error === 'multi_team_locked') { openUpgradeModal({ reason: 'multiTeam', message: r.message || '目前方案不支援多隊伍管理。' }); }
    else { toast(r.error, true); }
    btn.disabled = false;
  };

  /* 建立團隊：競賽體系 / 運動分類 / 正式項目 / 專項模板提示 */
  var SPORTS_ROC = ['田徑', '游泳', '體操', '桌球', '羽球', '網球', '跆拳道', '柔道', '空手道', '拳擊', '角力', '擊劍',
    '武術', '武術（套路）', '武術（散打）', '舉重', '射箭', '軟式網球',
    '射擊', '輕艇', '划船', '自由車', '木球', '滑輪溜冰', '卡巴迪'];
  var TEMPLATE_HINTS = {
    '田徑與體能型': '專項模板：主項、今日成績、秒數／距離、訓練量、配速、恢復狀態。',
    '水上運動': '專項模板：主項、今日成績、秒數／距離、訓練量、配速、恢復狀態。',
    '技擊武道': '專項模板：量級、體重、對抗狀態、技術重點、傷勢部位、賽前降重風險。',
    '球類團隊': '專項模板：位置、出賽時間、團隊配合、戰術執行、攻防表現、傷病風險。',
    '球拍與隔網': '專項模板：發接球、相持能力、落點控制、節奏、移位、傷病風險。',
    '精準與瞄準': '專項模板：穩定性、專注狀態、命中率、比賽節奏、心理壓力、動作一致性。',
    '體操與技巧表現': '專項模板：動作完成度、協調性、柔軟度、爆發力、失誤率、心理穩定。',
    '綜合項目': '可使用共通 6 大表現指標，並依專項需求自訂題目。'
  };
  var TERM_SUGGEST = { '球類團隊': '球員', '技擊武道': '選手', '田徑與體能型': '運動員', '水上運動': '運動員' };

  function syncTeamForm() {
    var sys = $('#ntSystem'), ev = $('#ntEvent'), sp = $('#ntSport'), cat = $('#ntCategory').value;
    if (sys.value === '全中運項目') {
      ev.style.display = ''; sp.style.display = 'none';
      if (!ev.options.length) ev.innerHTML = SPORTS_ROC.map(function (s) { return '<option>' + s + '</option>'; }).join('');
    } else {
      ev.style.display = 'none'; sp.style.display = '';
      if (!sp.value) sp.value = '跆拳道';
    }
    $('#ntTemplateHint').textContent = '🏷️ ' + (TEMPLATE_HINTS[cat] || '');
  }
  if ($('#ntSystem')) {
    $('#ntSystem').onchange = syncTeamForm;
    $('#ntCategory').onchange = function () {
      syncTeamForm();
      var t = TERM_SUGGEST[$('#ntCategory').value]; if (t) $('#ntMemberTerm').value = t;
    };
    syncTeamForm();
  }

  /* ---------- 選手 ---------- */
  async function loadAthletes() {
    var r = await TP.callAuth('listAthletes');
    state.athletes = (r.ok && r.athletes) || [];
    state.kpiMeta = r.ok ? r : {};
    dataLoaded.athletes = !!r.ok;
    if (r.ok) {
      try {
        localStorage.setItem('teampro_lastAthleteBasicList', JSON.stringify(state.athletes.map(function (a) {
          return { athleteId: a.athleteId, name: a.name, group: a.grp || a.group || '', teamId: a.teamId, active: a.active };
        })));
      } catch (e) {}
    }
    if (r.ok && state.coach) {
      $('#planQuota').textContent = ' · 點名 ' + state.coach.activeAthletes + ' / ' + planCfg().maxAthletes + ' · 狀態追蹤 ' + r.kpiUsed + ' / ' + r.kpiLimit;
      $('#planUsagePretty').textContent = '點名 ' + state.coach.activeAthletes + ' / ' + planCfg().maxAthletes + '　KPI ' + r.kpiUsed + ' / ' + r.kpiLimit;
    }
    renderAthletes();
    renderQuotaWarn();
    fillReportAthletes();
    fillPrivacyAthletes();
    renderOnboarding();
  }

  function fillReportAthletes() {
    var actives = state.athletes.filter(function (a) { return String(a.active) !== 'false' && a.active !== false; });
    $('#rpAthlete').innerHTML = actives.length
      ? actives.map(function (a) { return '<option value="' + a.athleteId + '">' + esc(a.name) + '</option>'; }).join('')
      : '<option value="">（尚無選手）</option>';
  }

  function fillPrivacyAthletes() {
    var select = $('#prAthlete');
    if (!select) return;
    select.innerHTML = state.athletes.length
      ? state.athletes.map(function (a) { return '<option value="' + a.athleteId + '">' + esc(a.name) + '</option>'; }).join('')
      : '<option value="">（尚無選手）</option>';
  }

  function renderQuotaWarn() {
    var c = state.coach;
    var cfg = planCfg();
    var box = $('#quotaWarn');
    if (c.activeAthletes >= cfg.maxAthletes) {
      box.innerHTML = '<div class="upgrade">' + (c.effectivePlan === 'free'
        ? '免費版可管理 ' + cfg.maxAthletes + ' 位選手點名。你的隊伍已超過免費人數，升級教練版即可管理 30 位選手。'
        : '你已達' + esc(c.planName) + ' ' + cfg.maxAthletes + ' 位選手點名上限，請升級方案後再新增。') +
        ' <a href="https://docs.google.com/forms/d/e/1FAIpQLSc2WhGQP1BQhWMgTJFtnR_gznolKA-KDqYVqXzBEfuxZI7OHA/viewform" target="_blank" rel="noopener">填寫升級申請表</a></div>';
    } else {
      var used = Number(state.kpiMeta.kpiUsed || 0), limit = Number(state.kpiMeta.kpiLimit || cfg.kpiAthletes);
      box.innerHTML = '<div class="upgrade"><b>狀態追蹤 ' + used + '/' + limit + '</b>：全隊每日做輕量回報，只有開啟追蹤的選手每週多做一次完整狀態回報。</div>';
    }
    $('#btnAddAthlete').disabled = c.activeAthletes >= cfg.maxAthletes;
  }

  function athleteEditHTML(a) {
    var opts = state.teams.map(function (t) {
      return '<option value="' + t.teamId + '"' + (String(t.teamId) === String(a.teamId) ? ' selected' : '') + '>' + esc(t.teamName) + '</option>';
    }).join('');
    var curVis = TP.normVisibility(a.lastPerformanceVisibility);
    var visOpts = Object.keys(TP.VISIBILITY_LABELS).map(function (k) {
      return '<option value="' + k + '"' + (k === curVis ? ' selected' : '') + '>' + esc(TP.VISIBILITY_LABELS[k]) + '</option>';
    }).join('');
    return '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;width:100%;">' +
        '<input data-e-name style="flex:1;min-width:120px;" value="' + esc(a.name) + '" placeholder="姓名">' +
        '<select data-e-team style="width:auto;flex:0 0 auto;">' + opts + '</select>' +
        '<input data-e-grade style="width:130px;flex:0 0 auto;" value="' + esc(a.gradeClass || '') + '" placeholder="年級/班別">' +
        '<label style="margin:0;width:auto;flex:0 0 auto;display:flex;align-items:center;gap:4px;font-size:12px;">🔒上次表現可見' +
          '<select data-e-vis style="width:auto;">' + visOpts + '</select></label>' +
        (a.hasPerfPin ? '<button class="btn btn-sm btn-danger" data-e-resetpin="' + a.athleteId + '" data-name="' + esc(a.name) + '">重設 PIN</button>' : '') +
        '<button class="btn btn-sm btn-primary" data-e-save="' + a.athleteId + '">儲存</button>' +
        '<button class="btn btn-sm" data-e-cancel>取消</button>' +
      '</div>';
  }

  function renderAthletes() {
    var box = $('#athleteList');
    if (!state.athletes.length) {
      box.innerHTML = '<div class="empty-state">還沒有選手。<br>新增第一位，就能開始點名與追蹤狀態。' +
        '<div style="margin-top:12px;"><button class="btn btn-primary btn-sm" id="emptyAddAthlete">＋ 新增第一位選手</button></div></div>';
      var ea = $('#emptyAddAthlete'); if (ea) ea.onclick = function () { var n = $('#naName'); if (n) { n.scrollIntoView({ block: 'center', behavior: 'smooth' }); n.focus(); } };
      return;
    }
    var teamName = {}; state.teams.forEach(function (t) { teamName[t.teamId] = t.teamName; });
    box.innerHTML = state.athletes.map(function (a) {
      var active = String(a.active) !== 'false' && a.active !== false;
      var vis = TP.normVisibility(a.lastPerformanceVisibility);
      var visBadge = vis !== TP.DEFAULT_LAST_PERF_VISIBILITY
        ? ' <span class="muted" style="font-size:11px;">🔒 ' + esc(TP.visibilityText(vis)) + '</span>' : '';
      var ks = a.kpiWeekStatus === 'completed' ? '<span class="pill green">上週已完成</span>' :
        (a.kpiWeekStatus === 'due' ? '<span class="pill yellow">上週待評估</span>' :
        (a.kpiWeekStatus === 'suspended' ? '<span class="pill red">超額暫停</span>' : '<span class="muted" style="font-size:11px;">未追蹤 KPI</span>'));
      return '<div class="row" data-arow="' + a.athleteId + '">' +
        '<div style="display:flex;align-items:flex-start;gap:10px;"><input type="checkbox" data-kpi-select="' + a.athleteId + '"' + (!active ? ' disabled' : '') + ' style="width:18px;height:18px;margin-top:3px;">' +
        '<div><b>' + esc(a.name) + '</b> <span class="muted">· ' + esc(teamName[a.teamId] || '未分隊') +
          (a.gradeClass ? ' · ' + esc(a.gradeClass) : '') + '</span>' + visBadge +
          (active ? '' : ' <span class="pill red">已停用</span>') + '<div style="margin-top:5px;">' + ks + '</div></div></div>' +
        '<div style="display:flex;gap:6px;">' +
          '<button class="btn btn-sm' + (a.kpiEnabled ? ' btn-primary' : '') + '" data-kpi="' + a.athleteId + '" data-enabled="' + (!!a.kpiEnabled) + '"' + (!active ? ' disabled' : '') + '>' +
            (a.kpiEnabled ? '停止 KPI' : '開啟 KPI') + '</button>' +
          '<button class="btn btn-sm" data-edit="' + a.athleteId + '">修改</button>' +
          '<button class="btn btn-sm" data-toggle="' + a.athleteId + '" data-active="' + active + '">' +
            (active ? '停用' : '恢復') + '</button>' +
          '<button class="btn btn-sm btn-danger" data-del="' + a.athleteId + '" data-name="' + esc(a.name) + '">刪除</button>' +
        '</div>' +
        '</div>';
    }).join('');

    TP.$all('[data-edit]', box).forEach(function (b) {
      b.onclick = function () {
        if (DEMO) { demoBlock(); return; }
        var id = b.dataset.edit;
        var a = state.athletes.filter(function (x) { return String(x.athleteId) === String(id); })[0];
        if (!a) return;
        var rowEl = box.querySelector('[data-arow="' + id + '"]');
        rowEl.innerHTML = athleteEditHTML(a);
        rowEl.querySelector('[data-e-cancel]').onclick = function () { renderAthletes(); };
        var resetBtn = rowEl.querySelector('[data-e-resetpin]');
        if (resetBtn) resetBtn.onclick = async function () {
          if (!confirm('重設「' + resetBtn.dataset.name + '」的近期表現 PIN？\n重設後該選手下次查看近期表現時需重新設定一組新 PIN。')) return;
          var rr = await TP.callAuth('updateAthlete', { athleteId: id, name: a.name, resetPerfPin: true });
          if (rr.ok) { toast('已重設 PIN'); loadAthletes(); } else { toast(rr.message || rr.error, true); }
        };
        rowEl.querySelector('[data-e-save]').onclick = async function () {
          var name = rowEl.querySelector('[data-e-name]').value.trim();
          if (!name) { toast('請輸入姓名', true); return; }
          var r = await TP.callAuth('updateAthlete', {
            athleteId: id, name: name,
            teamId: rowEl.querySelector('[data-e-team]').value,
            gradeClass: rowEl.querySelector('[data-e-grade]').value.trim(),
            lastPerformanceVisibility: rowEl.querySelector('[data-e-vis]').value
          });
          if (r.ok) { toast('已更新選手資料'); loadTeams(); loadAthletes(); loadWarroom(); }
          else { toast(r.message || r.error, true); }
        };
      };
    });

    TP.$all('[data-toggle]', box).forEach(function (b) {
      b.onclick = async function () {
        if (DEMO) { demoBlock(); return; }
        var want = b.dataset.active === 'false'; // 目前停用→要恢復
        var r = await TP.callAuth('setAthleteActive', { athleteId: b.dataset.toggle, active: want });
        if (r.ok) { toast('已更新'); await refreshMe(); loadAthletes(); }
        else { toast(r.message || r.error, true); }
      };
    });
    TP.$all('[data-kpi]', box).forEach(function (b) {
      b.onclick = async function () {
        if (DEMO) { demoBlock(); return; }
        var want = b.dataset.enabled !== 'true';
        if (want && !confirm('開啟後，此選手每週會多一份 狀態回報。確定開啟？')) return;
        var r = await TP.callAuth('setKpiTracking', { athleteId: b.dataset.kpi, enabled: want });
        if (r.ok) { toast(want ? '已開啟 狀態追蹤' : '已停止 狀態追蹤，歷史資料保留'); loadAthletes(); loadWarroom(); }
        else if (r.error === 'kpi_limit_reached') openUpgradeModal({ reason: 'kpi', toPlan: 'coach', message: r.message });
        else toast(r.message || r.error, true);
      };
    });
    TP.$all('[data-del]', box).forEach(function (b) {
      b.onclick = async function () {
        if (DEMO) { demoBlock(); return; }
        if (!confirm('確定刪除選手「' + b.dataset.name + '」？\n\n該選手及其所有回報紀錄將永久刪除，無法復原。\n（若只是離隊／畢業，建議改用「停用」即可保留歷史。）')) return;
        var r = await TP.callAuth('deleteAthlete', { athleteId: b.dataset.del });
        if (r.ok) { toast('已刪除選手（紀錄 ' + (r.deletedRecords || 0) + ' 筆）'); await refreshMe(); loadTeams(); loadAthletes(); loadWarroom(); }
        else { toast(r.message || r.error, true); }
      };
    });
  }

  function selectedKpiAthleteIds() {
    return TP.$all('[data-kpi-select]:checked', $('#athleteList')).map(function (x) { return x.dataset.kpiSelect; });
  }
  $('#kpiSelectAll').onclick = function () {
    TP.$all('[data-kpi-select]:not(:disabled)', $('#athleteList')).forEach(function (x) { x.checked = true; });
  };
  $('#kpiSelectNone').onclick = function () {
    TP.$all('[data-kpi-select]', $('#athleteList')).forEach(function (x) { x.checked = false; });
  };
  async function bulkSetKpi(enabled) {
    if (DEMO) { demoBlock(); return; }
    var ids = selectedKpiAthleteIds();
    if (!ids.length) { toast('請先勾選選手', true); return; }
    if (!enabled && !confirm('確定停止這 ' + ids.length + ' 位選手的狀態追蹤？\n歷史狀態紀錄不會被刪除。')) return;
    if (enabled) {
      var addCount = state.athletes.filter(function (a) { return ids.indexOf(String(a.athleteId)) !== -1 && !a.kpiEnabled; }).length;
      if (Number(state.kpiMeta.kpiUsed || 0) + addCount > Number(state.kpiMeta.kpiLimit || planCfg().kpiAthletes)) {
        toast('這次會超過 狀態追蹤上限，請減少勾選人數。', true); return;
      }
    }
    var r = await TP.callAuth('setKpiTrackingBulk', { athleteIds: ids, enabled: enabled });
    // 後端尚未重新部署時，暫以現有單筆 API 相容。
    if (!r.ok && String(r.error || '').indexOf('未知 action') !== -1) {
      var changed = 0, failed = '';
      for (var i = 0; i < ids.length; i++) {
        var one = await TP.callAuth('setKpiTracking', { athleteId: ids[i], enabled: enabled });
        if (!one.ok) { failed = one.message || one.error; break; }
        changed++;
      }
      r = failed ? { ok: false, error: failed } : { ok: true, changed: changed };
    }
    if (r.ok) {
      toast((enabled ? '已批量開啟 ' : '已批量停止 ') + r.changed + ' 位選手狀態追蹤');
      await loadAthletes(); loadWarroom();
    } else if (r.error === 'kpi_limit_reached') openUpgradeModal({ reason: 'kpi', toPlan: 'coach', message: r.message });
    else toast(r.message || r.error, true);
  }
  $('#kpiBulkEnable').onclick = function () { bulkSetKpi(true); };
  $('#kpiBulkDisable').onclick = function () { bulkSetKpi(false); };

  $('#btnAddAthlete').onclick = async function () {
    if (DEMO) { demoBlock(); return; }
    var cfg = planCfg(), cur = state.coach.activeAthletes;
    // 情境1：點名人數硬上限（擋）
    if (cur >= cfg.maxAthletes) {
      renderQuotaWarn();
      openUpgradeModal({ reason: 'roster', toPlan: 'coach', message: '免費版可管理 ' + cfg.maxAthletes + ' 位選手點名。你的隊伍已經超過免費人數，升級教練版即可管理 30 位選手。' });
      return;
    }
    var name = $('#naName').value.trim();
    if (!name) { toast('請輸入選手姓名', true); return; }
    var teamId = $('#naTeam').value;
    if (state.athletes.some(function (a) {
      return String(a.teamId) === String(teamId) && String(a.name).trim() === name &&
             (String(a.active) !== 'false' && a.active !== false);
    })) { toast('此團隊已有同名選手「' + name + '」', true); return; }
    var btn = this; btn.disabled = true;
    var r = await TP.callAuth('addAthlete', {
      name: name, teamId: $('#naTeam').value, gradeClass: $('#naGrade').value.trim()
    });
    if (r.ok) {
      $('#naName').value = ''; $('#naGrade').value = '';
      toast('已新增選手'); await refreshMe(); loadAthletes();
    } else if (r.error === 'plan_limit_reached') {
      toast(r.message || '已達方案上限', true); await refreshMe(); renderQuotaWarn();
    } else { toast(r.error, true); }
    btn.disabled = false;
  };

  $('#btnDownloadAthleteTemplate').onclick = function () {
    if (DEMO) { demoBlock(); return; }
    downloadAthleteTemplate();
  };
  $('#btnPickAthleteImport').onclick = function () {
    if (DEMO) { demoBlock(); return; }
    var f = $('#athleteImportFile');
    if (f) f.click();
  };
  $('#athleteImportFile').onchange = async function () {
    if (DEMO) { demoBlock(); this.value = ''; return; }
    var file = this.files && this.files[0];
    this.value = '';
    if (!file) return;
    if (!window.XLSX && /\.(xlsx|xls)$/i.test(file.name)) {
      importHint('載入 Excel 解析套件…');
      try { await ensureXlsx(); }
      catch (err) { toast(err.message || 'Excel 解析套件載入失敗，請改用 CSV 匯入', true); return; }
    }
    importHint('讀取中…');
    try {
      var rows = await parseAthleteImportFile(file);
      state.importRows = rows;
      state.importFileName = file.name;
      var valid = rows.filter(function (r) { return r.name && (r.teamName || r.teamId); }).length;
      var msg = '已讀取 ' + rows.length + ' 筆。有效候選 ' + valid + ' 筆。';
      importHint(msg);
      if (!rows.length) { toast('檔案裡沒有可匯入的資料', true); return; }
      if (!confirm('已讀取 ' + rows.length + ' 筆，現在要匯入嗎？')) return;
      var btn = $('#btnPickAthleteImport');
      btn.disabled = true; btn.textContent = '匯入中…';
      var r = await TP.callAuth('bulkAddAthletes', { rows: rows });
      btn.disabled = false; btn.textContent = '選擇檔案並匯入';
      if (r.ok) {
        var extra = r.skipped ? '，跳過 ' + r.skipped + ' 筆' : '';
        importHint('完成：新增 ' + r.created + ' 筆' + extra + '。', false);
        if (r.skippedRows && r.skippedRows.length) {
          importHint('完成：新增 ' + r.created + ' 筆，跳過 ' + r.skipped + ' 筆（' + r.skippedRows.slice(0, 3).map(function (x) { return '第' + x.rowNo + '列 ' + x.reason; }).join('；') + '）', false);
        }
        state.importRows = [];
        state.importFileName = '';
        toast('已批次新增 ' + r.created + ' 位選手');
        await refreshMe(); loadAthletes();
      } else if (r.error === 'plan_limit_reached') {
        importHint(r.message || '已達方案上限', true);
        toast(r.message || '已達方案上限', true);
      } else {
        importHint(r.message || r.error || '匯入失敗', true);
        toast(r.message || r.error || '匯入失敗', true);
      }
    } catch (err) {
      importHint('讀取失敗：' + err.message, true);
      toast('讀取失敗：' + err.message, true);
    }
  };

  /* ---------- 戰情室 ---------- */
  $('#warRefresh').onclick = loadWarroom;
  $('#warTeam').onchange = loadWarroom;
  $('#warDate').onchange = loadWarroom;

  var lastWar = null;
  function skeletonRows(n) {
    var one = '<div class="skel-card"><div class="skel w-40"></div><div class="skel w-90"></div><div class="skel w-70"></div></div>';
    return new Array(n).fill(one).join('');
  }
  function warroomCacheKey() { return coachLS('warcache_' + ($('#warTeam').value || '') + '_' + ($('#warDate').value || '')); }
  async function loadWarroom() {
    if (DEMO) { renderWarroom(DEMO_DATA.warroom); return; }
    // 體感加速：先用上次快取「秒開」，背景再抓最新覆蓋
    var ck = warroomCacheKey(), cached = null;
    try { cached = JSON.parse(localStorage.getItem(ck) || 'null'); } catch (e) {}
    if (cached && cached.ok) renderWarroom(cached);
    else { $('#pendingReplyList').innerHTML = skeletonRows(2); $('#repliedList').innerHTML = skeletonRows(1); $('#missList').innerHTML = ''; }
    var r = await TP.callAuth('warroom', { teamId: $('#warTeam').value, date: $('#warDate').value });
    if (!r.ok) {
      if (cached && cached.ok) { toast('更新失敗，顯示的是上次資料', true); return; }
      $('#pendingReplyList').innerHTML = '<div class="empty-state">載入失敗，可能是網路或連線問題。<div style="margin-top:12px;"><button class="btn btn-sm" id="warRetry">↻ 重新載入</button></div></div>';
      var rt = $('#warRetry'); if (rt) rt.onclick = loadWarroom;
      toast(r.error, true); return;
    }
    try { localStorage.setItem(ck, JSON.stringify(r)); } catch (e) {}
    renderWarroom(r);
  }
  function renderWarroom(r) {
    lastWar = r;
    if (r.submittedCount > 0) {
      localStorage.setItem(coachLS('first_report_seen'), '1');
      markTask('first_report', true);
    }
    $('#stCompletion').textContent = r.completionRate + '%';
    $('#stSubmitted').textContent = r.submittedCount || 0;
    $('#stMissing').textContent = r.missingCount || 0;
    $('#stGreen').textContent = r.lights.green || 0;
    $('#stYellow').textContent = r.lights.yellow || 0;
    $('#stRed').textContent = r.lights.red || 0;
    var sub = r.submitted || [];
    sub.forEach(function (s) {
      var fb = s.coachFeedback || s.coachComment || s.coachReply || s.feedbackText || s.coachNote || '';
      s.coachFeedback = fb;
      s.coachComment = fb;
      s.coachReplyStatus = String(fb || '').trim() ? 'replied' : (s.coachReplyStatus || 'none');
    });
    var replied = sub.filter(function (s) { return s.coachReplyStatus === 'replied'; }), pendingReply = sub.filter(function (s) { return s.coachReplyStatus !== 'replied'; });
    $('#stReplied').textContent = replied.length; $('#stPendingReply').textContent = pendingReply.length;
    $('#stPain').textContent = sub.filter(function (s) { return Number(s.painScore) >= 4; }).length;
    $('#stSleep').textContent = sub.filter(function (s) { return Number(s.sleepDurationMinutes) > 0 && Number(s.sleepDurationMinutes) < 360; }).length;
    $('#missCount').textContent = '（' + r.missingCount + '）';
    $('#taskRed').textContent = (r.lights.red || 0) ? (r.lights.red + ' 位需要先關心') : '✅ 今天沒有人亮紅燈，全隊狀態穩';
    $('#taskMissing').textContent = r.missingCount ? (r.missingCount + ' 位尚未完成') : '今天全員已完成';
    var wk = r.weeklyKpi || {};
    var daily = wk.cadence === 'daily';
    $('#kpiNudgeTitle').textContent = daily ? '今日 KPI' : '上週 狀態回報';
    $('#weeklyKpiProgress').textContent = (wk.completed || 0) + '/' + (wk.total || 0);
    $('#weeklyKpiRange').textContent = wk.weekStart
      ? ((daily ? '今日 ' + wk.weekStart : '評估週 ' + wk.weekStart + ' ～ ' + wk.weekEnd) + (wk.missing ? '，尚有 ' + wk.missing + ' 位未完成' : '，已全數完成'))
      : '尚未開啟 狀態追蹤';

    var priority = r.priority || {};
    var concern = sub.filter(function (s) { return s.status === 'red' || Number(s.painScore) >= 4 || (Number(s.sleepDurationMinutes) > 0 && Number(s.sleepDurationMinutes) < 360) || Number(s.moodIndex) <= 2 || s.declining; });
    var stable = sub.filter(function (s) { return s.status === 'green' && Number(s.painScore) < 4 && !(Number(s.sleepDurationMinutes) > 0 && Number(s.sleepDurationMinutes) < 360) && !s.declining; });
    renderPriority('#priorityRed', concern, '✅ 今天沒有人亮紅燈，全隊狀態穩');
    renderPriority('#priorityPendingReply', pendingReply, '目前沒有待回覆，教練已全部處理完成');
    renderPriority('#priorityStable', stable, '沒有人連續下滑，維持得不錯');

    renderWarroomLists(r);

    var enc = r.encourages || [];
    $('#encourageCard').style.display = enc.length ? '' : 'none';
    $('#encourageList').innerHTML = enc.map(function (e) {
      return '<div class="row"><span>💪 <b>' + esc(e.from) + '</b>' + (e.to ? ' → ' + esc(e.to) : '') + '</span>' +
        '<span class="muted" style="max-width:60%;text-align:right;">' + esc(e.msg) + '</span></div>';
    }).join('');
    renderOnboarding();
  }

  var currentRiskFilter = 'all';
  var waterLabels = { very_little:'很少（<1,000 cc）', normal:'普通（1,000–1,499 cc）', enough:'足夠（1,500–2,499 cc）', a_lot:'很多（≥2,500 cc）' };
  var sweatLabels = { low:'少', normal:'普通', high:'多', very_high:'非常多' };
  var urineLabels = { clear:'透明／很淡', pale_yellow:'淡黃色', yellow:'黃色', dark:'深黃色／琥珀色', abnormal:'茶色／紅色／異常混濁' };

  function hasHydrationFlag(s, flag) { return String(s.hydrationFlags || '').split(',').indexOf(flag) !== -1; }
  function matchRiskFilter(s, filter) {
    if (filter === 'all') return true;
    if (filter === 'pending_reply') return s.coachReplyStatus !== 'replied';
    if (filter === 'replied') return s.coachReplyStatus === 'replied';
    if (filter === 'red') return s.status === 'red';
    if (filter === 'pain') return Number(s.painScore) >= 4;
    if (filter === 'sleep') return Number(s.sleepDurationMinutes) > 0 && Number(s.sleepDurationMinutes) < 360;
    if (filter === 'quality') return !!s.reportQualityLabel && s.reportQualityLabel !== '正常';
    if (filter === 'hydration_red') return s.hydrationRisk === 'red';
    if (filter === 'urine_dark') return s.urineColor === 'dark' || s.urineColor === 'abnormal';
    if (filter === 'sweat_water') return hasHydrationFlag(s, 'high_sweat_low_water');
    if (filter === 'hydration_repeat') return hasHydrationFlag(s, 'consecutive_dark');
    return true;
  }

  function renderWarroomLists(r) {
    var showMissing = currentRiskFilter === 'all' || currentRiskFilter === 'missing';
    function formatSubmittedAt(ts) {
      if (!ts) return '';
      var d = new Date(ts);
      if (isNaN(d.getTime())) return '';
      return d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
    }
    $('#missList').innerHTML = showMissing && r.missing.length
      ? r.missing.map(function (m) { return '<div class="row"><span><b>' + esc(m.name) + '</b><small class="reply-status missing">尚未回報</small></span><button class="btn btn-sm" data-remind-one="' + esc(m.name) + '">複製催繳 LINE</button></div>'; }).join('')
      : '<div class="empty-state">' + (currentRiskFilter === 'missing' || !r.missing.length ? '✅ 今日全員已完成回報' : '此篩選不含未回報選手。') + '</div>';
    var rows = currentRiskFilter === 'missing' ? [] : r.submitted.filter(function (s) { return matchRiskFilter(s, currentRiskFilter); });
    function priorityScore(s) { var pending=s.coachReplyStatus !== 'replied', sleep=Number(s.sleepDurationMinutes)>0&&Number(s.sleepDurationMinutes)<360; if (pending && s.status==='red') return 0; if (pending && Number(s.painScore)>=4) return 1; if (pending && sleep) return 2; if (pending && s.status==='yellow') return 3; if (pending) return 4; return 6; }
    rows.sort(function(a,b){ return priorityScore(a)-priorityScore(b); });
    function card(s) {
      var l = s.status || TP.lightOf(s.totalScore);
      var sleep = s.sleepDurationText || (s.sleepDurationMinutes ? Math.floor(Number(s.sleepDurationMinutes) / 60) + ' 小時 ' + (Number(s.sleepDurationMinutes) % 60) + ' 分' : '未填');
      var pain = Number(s.painScore || 0) + ' 分' + (s.painAreas ? '（' + s.painAreas + '）' : '');
      var quality = s.reportQualityScore === '' || s.reportQualityScore == null ? '舊資料' : s.reportQualityScore + '・' + (s.reportQualityLabel || '正常');
      var hydrationLabel = hasHydrationFlag(s, 'severe_dehydration_risk') && s.hydrationRisk !== 'red'
        ? '水分黃燈偏紅' : '水分' + TP.lightText(s.hydrationRisk || 'green');
      var submittedAt = formatSubmittedAt(s.submittedAt);
      var urineTime = submittedAt && (s.urineColor === 'dark' || s.urineColor === 'abnormal')
        ? '<span>回報時間：' + esc(submittedAt) + '</span>'
        : '';
      var replied=s.coachReplyStatus === 'replied', feedbackTime=formatSubmittedAt(s.coachFeedbackAt);
      return '<div class="athlete-risk-card ' + (l === 'red' ? 'reply-critical' : replied ? 'reply-done' : 'reply-pending') + '" data-fb="' + s.athleteId + '" data-rec="' + (s.recordId || '') + '" data-name="' + esc(s.name) + '">' +
        '<div class="risk-head"><b><span class="dot ' + l + '"></span> ' + esc(s.name) + '</b><span class="reply-status ' + (replied ? 'done' : 'pending') + '">' + (replied ? '✅ 已回覆' : '🟡 待回覆') + '</span></div>' +
        '<div class="risk-meta"><span class="pill ' + l + '">' + TP.lightText(l) + '</span><span>睡眠：' + esc(sleep) + '</span><span>疼痛：' + esc(pain) + '</span><span>疲勞：' + esc(s.fatigueLevel || s.fatigue || '未填') + '</span><span>心情：' + esc(s.mood || s.moodIndex || '未填') + '</span></div>' +
        '<div class="risk-meta"><span class="pill ' + esc(s.hydrationRisk || 'green') + '">' + esc(hydrationLabel) + '</span>' +
        '<span>喝水：' + esc(waterLabels[s.waterAmount] || '未填') + '</span><span>流汗：' + esc(sweatLabels[s.sweatAmount] || '未填') + '</span><span>尿液：' + esc(urineLabels[s.urineColor] || '未填') + '</span>' + urineTime + '</div>' +
        (replied ? '<div class="risk-advice"><b>教練回覆' + (feedbackTime ? '（' + esc(feedbackTime) + '）' : '') + '：</b>' + esc(s.coachFeedback || '') + '</div>' : '<div class="risk-advice"><b>今日重點：</b>' + esc(s.coachSuggestion || s.reportQualityReasons || '依今日狀態安排訓練並持續觀察。') + '</div>') +
        '<button class="btn btn-sm" style="margin-top:9px;" data-fb="' + s.athleteId + '" data-rec="' + (s.recordId || '') + '" data-name="' + esc(s.name) + '">' + (replied ? '查看 / 修改回饋' : '寫教練回饋') + '</button></div>';
    }
    var pending=rows.filter(function(s){return s.coachReplyStatus !== 'replied';}), replied=rows.filter(function(s){return s.coachReplyStatus === 'replied';});
    $('#pendingReplyCount').textContent='（'+pending.length+'）'; $('#repliedCount').textContent='（'+replied.length+'）';
    $('#pendingReplyList').innerHTML=pending.length ? pending.map(card).join('') : '<div class="empty-state">目前沒有待回覆，教練已全部處理完成</div>';
    $('#repliedList').innerHTML=replied.length ? replied.map(card).join('') : '<div class="empty-state">尚未有教練回覆。</div>';
    TP.$all('[data-fb]', $('#pendingReplyList')).concat(TP.$all('[data-fb]', $('#repliedList'))).forEach(function (el) {
      el.onclick = function () { openFeedback(el.dataset.fb, el.dataset.name, el.dataset.rec); };
    });
    TP.$all('[data-remind-one]', $('#missList')).forEach(function(b){ b.onclick=function(){ copyLineText('您好，今天尚未收到 '+b.dataset.remindOne+' 的訓練回報，麻煩協助提醒完成，謝謝。'+lineWatermark(), 'lineNotify'); }; });
  }

  TP.$all('[data-risk-filter]', $('#riskFilters')).forEach(function (b) {
    b.onclick = function () {
      currentRiskFilter = b.dataset.riskFilter;
      TP.$all('[data-risk-filter]', $('#riskFilters')).forEach(function (x) { x.classList.toggle('active', x === b); });
      if (lastWar) renderWarroomLists(lastWar);
    };
  });
  // 首頁儀表數字（疼痛/睡眠）點了直接套用對應篩選
  TP.$all('.war-risk [data-jump]').forEach(function (b) {
    b.onclick = function () { var f = TP.$('[data-risk-filter="' + b.dataset.jump + '"]'); if (f) f.click(); };
  });

  function renderPriority(selector, list, emptyText) {
    var el = $(selector); if (!el) return;
    el.innerHTML = list.length
      ? list.map(function (x) { return '<span class="pill ' + (selector === '#priorityRed' ? 'red' : '') + '" style="margin:2px;">' + esc(x.name) + '</span>'; }).join('')
      : '<div class="empty-state">' + esc(emptyText) + '</div>';
  }

  $('#btnRemind').onclick = function () {
    if (!lastWar || !lastWar.missing.length) { toast('目前沒有未回報的選手'); return; }
    var names = lastWar.missing.map(function (m) { return m.name; }).join('、');
    var text = '以下選手今日尚未完成回報：' + names + '，請今天訓練前完成填寫，謝謝。' + lineWatermark();
    copyLineText(text, 'lineNotify');
  };

  $('#btnWarLine').onclick = function () {
    if (!lastWar) { toast('請先載入戰情室'); return; }
    var sub=lastWar.submitted || [], missing=lastWar.missing || [], pending=sub.filter(function(s){return s.coachReplyStatus !== 'replied';}), replied=sub.filter(function(s){return s.coachReplyStatus === 'replied';});
    var team=(state.teams || []).filter(function(t){return String(t.teamId)===String($('#warTeam').value);})[0] || {};
    function detail(s){ var l=TP.lightText(s.status || 'green'); var sleep=s.sleepDurationText || (s.sleepDurationMinutes ? (Number(s.sleepDurationMinutes)/60).toFixed(1) : '未填'); return '- '+s.name+'｜'+l+'｜睡眠 '+sleep+'｜疼痛 '+Number(s.painScore || 0); }
    var concern=sub.filter(function(s){return s.status==='red'||Number(s.painScore)>=4||(Number(s.sleepDurationMinutes)>0&&Number(s.sleepDurationMinutes)<360)||Number(s.moodIndex)<=2||s.declining;});
    var text='【TeamPro 今日回報總結】\n日期：'+$('#warDate').value+'\n隊伍：'+(team.teamName || '')+'\n\n今日完成率：'+(lastWar.completionRate||0)+'%\n已回報：'+sub.length+' 人\n未回報：'+missing.length+' 人\n\n教練已回覆：'+replied.length+' 人\n待教練回覆：'+pending.length+' 人\n\n綠燈：'+(lastWar.lights.green||0)+' 人\n黃燈：'+(lastWar.lights.yellow||0)+' 人\n紅燈：'+(lastWar.lights.red||0)+' 人\n\n尚未回報：\n'+(missing.length?missing.map(function(m){return '- '+m.name;}).join('\n'):'（無）')+'\n\n待教練回覆：\n'+(pending.length?pending.map(detail).join('\n'):'（無）')+'\n\n今日需要關心：\n'+(concern.length?concern.map(detail).join('\n'):'今天沒有人亮紅燈，全隊狀態穩。')+lineWatermark();
    copyLineText(text, 'lineNotify');
  };

  $('#btnParentNotify').onclick = function () {
    if (!lastWar) { toast('請先載入戰情室'); return; }
    var messages = lastWar.submitted.map(parentMessage).concat(lastWar.missing.map(function (m) {
      return m.name + '家長您好，' + m.name + '今天的訓練狀態還沒回報，麻煩提醒孩子在訓練前完成，讓我能先掌握今天的身體狀況，謝謝。';
    }));
    if (!messages.length) { toast('目前沒有可產生通知的選手'); return; }
    if (!copyLineText(messages.join('\n\n---\n\n'), 'lineNotify')) return;
    localStorage.setItem(parentNoticeKey(), String(Number(localStorage.getItem(parentNoticeKey()) || 0) + messages.length));
    loadTrialSummary();
  };

  // 家長通知文字：走共用家長摘要規則（不含原始分數/燈號/敏感原文）
  function parentMessage(s) {
    var light = s.status || TP.lightOf(s.totalScore);
    return s.name + '家長您好，' + TP.parentSummary({ name: s.name, light: light }) + lineWatermark();
  }

  async function loadTrialSummary() {
    dataLoaded.trial = true;
    if (DEMO) { renderTrialSummary(DEMO_DATA.trialSummary); return; }
    var r = await TP.callAuth('trialSummary');
    if (r.ok) renderTrialSummary(r);
  }

  function renderTrialSummary(r) {
    var card = $('#trialSummary');
    card.classList.toggle('hidden', !r.visible && !DEMO);
    if (!r.visible && !DEMO) return;
    var noticeCount = DEMO ? r.parentNotificationCount : Number(localStorage.getItem(parentNoticeKey()) || 0);
    var stats = [
      [r.athleteCount, '已追蹤選手'], [r.reportCount, '完成回報'],
      [r.redAthleteCount, '今日需要關心'], [noticeCount, '產生家長通知'],
      [r.estimatedMinutes + ' 分', '預估節省時間']
    ];
    $('#trialStats').innerHTML = stats.map(function (x) {
      return '<div><b>' + esc(x[0]) + '</b><span class="muted">' + esc(x[1]) + '</span></div>';
    }).join('');
    $('#trialUpgrade').textContent = r.upgradeMessage;
  }

  /* ---------- 成果報告 ---------- */
  $('#rpType').onchange = function () {
    var v = $('#rpType').value, teamLevel = (v === 'team' || v === 'visit');
    $('#rpAthleteWrap').style.display = teamLevel ? 'none' : '';   // 個人/家長/日誌用選手選單；團隊/訪視用團隊
    $('#rpTeamWrap').style.display = teamLevel ? '' : 'none';
    $('#rpVisitWrap').style.display = (v === 'visit') ? '' : 'none';
    $('#rpSchoolWrap').style.display = (v === 'visit' || v === 'log') ? '' : 'none';  // 日誌也要學校名
    $('#rpLogWrap').style.display = (v === 'log') ? '' : 'none';
  };
  $('#rpRange').onchange = function () {
    var custom = $('#rpRange').value === 'custom';
    $('#rpCustomFrom').style.display = custom ? '' : 'none';
    $('#rpCustomTo').style.display = custom ? '' : 'none';
  };
  $('#rpVisitVer').onchange = function () { if ($('#rpType').value === 'visit' && $('#reportArea').innerHTML.trim()) $('#btnGenReport').click(); };
  $('#btnPrint').onclick = function () {
    if (isAssistantMode()) { toast('助教模式不能列印或存成 PDF', true); return; }
    if (!$('#reportArea').innerHTML.trim()) { toast('請先產生報告', true); return; }
    if (!planCfg().pdfExport) { openUpgradeModal({ reason: 'pdfExport', toPlan: 'team', message: 'PDF 成果報告為團隊版功能。升級團隊版後，可匯出月報、週報與家長溝通報告。' }); return; }
    window.print();
  };

  function dateRange() {
    var to = new Date(), from = new Date();
    var v = $('#rpRange').value;
    if (v === 'custom') {
      from = $('#rpFrom').value ? new Date($('#rpFrom').value) : from;
      to = $('#rpTo').value ? new Date($('#rpTo').value) : to;
    } else { from.setDate(to.getDate() - (Number(v) - 1)); }
    var f = from.toISOString().slice(0, 10), t = to.toISOString().slice(0, 10);
    var days = Math.round((new Date(t) - new Date(f)) / 86400000) + 1;
    return { from: f, to: t, days: days };
  }

  var DIMS = [['technicalAvg', '技術執行'], ['tacticalAvg', '戰術理解'], ['physicalAvg', '體能負荷'],
              ['mentalAvg', '心理狀態'], ['attitudeAvg', '訓練態度'], ['physiologicalAvg', '生理恢復']];

  $('#btnGenReport').onclick = async function () {
    var range = dateRange();
    if (planKey() === 'free' && range.days > 7) {
      openUpgradeModal({ reason: 'report30Days', message: '免費版只能產生 7 日報告。' });
      return;
    }
    $('#reportArea').innerHTML = '<div class="report-doc"><p class="muted">產生中…</p></div>';
    if ($('#rpType').value === 'visit') {
      var vTeamId = DEMO ? '' : $('#rpTeam').value;
      var vTeamName = DEMO ? '示範隊' : (vTeamId ? $('#rpTeam').options[$('#rpTeam').selectedIndex].text : '全部團隊');
      var vs = DEMO ? demoVisitSummary(range) : await TP.callAuth('visitSummary', { teamId: vTeamId, from: range.from, to: range.to });
      if (!vs.ok) { toast(vs.error || '產生失敗', true); return; }
      renderVisitReport(vTeamName, range, vs);
      renderOnboarding();
      return;
    }
    if ($('#rpType').value === 'log') {
      var lAId = $('#rpAthlete').value;
      if (!DEMO && !lAId) { toast('請選擇選手', true); return; }
      var lAthlete = state.athletes.filter(function (a) { return a.athleteId === lAId; })[0] || state.athletes[0] || {};
      // 記住固定欄位（跨裝置）
      if ($('#rpSchool').value.trim()) saveCoachSettings({ school: $('#rpSchool').value.trim() });
      saveCoachSettings({
        logAffiliation: $('#logAffiliation').value.trim(),
        logPeClass: $('#logPeClass').value.trim(),
        logWeather: $('#logWeather').value,
        logHours: $('#logHours').value,
        logGender: $('#logGender').value
      });
      var lRecs;
      if (DEMO) {
        lRecs = demoRecords(range);
      } else {
        var lr = await TP.callAuth('athleteRecords', { athleteId: lAId, limit: 31 });
        if (!lr.ok) { toast(lr.error || '產生失敗', true); return; }
        lRecs = (lr.records || []).filter(function (x) { return x.date >= range.from && x.date <= range.to; });
      }
      lRecs = lRecs.sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); });
      renderTrainingLog(lAthlete, range, lRecs);
      renderOnboarding();
      return;
    }
    if (DEMO) {
      if ($('#rpType').value === 'team') { renderTeamReport('示範・兩隊合計', range, DEMO_DATA.teamReport); if (range.days === 7) markTask('report7', true); }
      else {
        var da = state.athletes.filter(function (a) { return a.athleteId === $('#rpAthlete').value; })[0] || state.athletes[0];
        if ($('#rpType').value === 'parent') renderParentReport(da, range, demoRecords(range));
        else renderReport(da, range, demoRecords(range));
        if (range.days === 7) markTask('report7', true);
      }
      renderOnboarding();
      return;
    }
    if ($('#rpType').value === 'team') {
      if (!planCfg().multiTeam && state.teams.length > 1) {
        openUpgradeModal({ reason: 'multiTeam', message: '目前方案僅可看單一隊伍或全部合併，無法做多隊伍管理。' });
        return;
      }
      var teamId = $('#rpTeam').value;
      var teamName = teamId ? ($('#rpTeam').options[$('#rpTeam').selectedIndex].text) : '全部團隊';
      var tr = await TP.callAuth('teamReport', { teamId: teamId, from: range.from, to: range.to, days: range.days });
      if (!tr.ok) { toast(tr.error, true); return; }
      renderTeamReport(teamName, range, tr);
      if (range.days === 7) markTask('report7', true);
      renderOnboarding();
      return;
    }
    var aId = $('#rpAthlete').value;
    if (!aId) { toast('請選擇選手', true); return; }
    var athlete = state.athletes.filter(function (a) { return a.athleteId === aId; })[0] || {};
    var isParent = $('#rpType').value === 'parent';
    var r = await TP.callAuth(isParent ? 'athleteRecords' : 'athleteWeeklyKpis', { athleteId: aId, limit: 120 });
    if (!r.ok) { toast(r.error, true); return; }
    var recs = (r.records || []).filter(function (x) {
      return isParent ? (x.date >= range.from && x.date <= range.to) :
        (x.weekEnd >= range.from && x.weekStart <= range.to);
    }).map(function (x) { if (!isParent && !x.date) x.date = x.weekStart; return x; })
      .sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); });
    if (range.days === 7) markTask('report7', true);
    renderOnboarding();
    if (isParent) renderParentReport(athlete, range, recs);
    else renderReport(athlete, range, recs);
  };

  // 體育署訓練日誌（個人）：把選手每日回報的課表與心得，攤成仿官方表格，一天一頁可列印
  function renderTrainingLog(athlete, range, recs) {
    var teamName = (state.teams.filter(function (t) { return String(t.teamId) === String(athlete.teamId); })[0] || {}).teamName || '';
    var school = $('#rpSchool').value.trim() || coachSettings().school || '';
    var affiliation = $('#logAffiliation').value.trim() || coachSettings().logAffiliation || '';
    var peClass = $('#logPeClass').value.trim() || coachSettings().logPeClass || '體育班';
    var weather = $('#logWeather').value || '晴天';
    var hours = $('#logHours').value || '2';
    var gender = $('#logGender').value || '男';
    var gradeClass = athlete.gradeClass || '';

    if (!recs.length) {
      $('#reportArea').innerHTML = '<div class="report-doc tlog"><h2>查無資料</h2><p>' + esc(athlete.name || '') +
        ' 在 ' + range.from + ' ~ ' + range.to + ' 期間沒有訓練回報紀錄，無法產生訓練日誌。</p></div>';
      return;
    }

    function field(v) {
      return (v == null || String(v).trim() === '')
        ? '<div class="tl-blank">（無回報，可列印後手寫補充）</div>'
        : '<div class="tl-content">' + esc(v) + '</div>';
    }
    function bodyStatus(r) {
      var bits = [];
      if (r.sleepHours !== '' && r.sleepHours != null) bits.push('睡眠 ' + esc(r.sleepHours) + ' 小時');
      if (r.fatigue) bits.push('疲勞 ' + esc(r.fatigue));
      if (r.painScore !== '' && r.painScore != null && String(r.painScore) !== '0') bits.push('疼痛指數 ' + esc(r.painScore));
      if (r.injuryAreas && r.injuryAreas !== '無受傷') bits.push('傷勢：' + esc(r.injuryAreas) + (r.injuryNote ? '（' + esc(r.injuryNote) + '）' : ''));
      var t = num(r.totalScore);
      if (t > 0) { var l = r.status || TP.lightOf(t); bits.push('當日狀態 ' + t.toFixed(1) + '（' + TP.lightText(l) + '）'); }
      return bits.length ? bits.join('；') : '當日無身體狀況回報';
    }

    var days = recs.map(function (r, i) {
      var notes = [r.trainingNotes, r.reflection].filter(function (x) { return x && String(x).trim(); }).join('\n');
      return '<div class="tlog-day"><table>' +
        '<caption>第 ' + (i + 1) + ' 天　訓練日誌</caption>' +
        '<tr><th>隸屬範圍</th><td>' + esc(affiliation || '—') + '</td><th>學校</th><td colspan="3">' + esc(school || '—') + '</td></tr>' +
        '<tr><th>體育班名稱</th><td>' + esc(peClass) + '</td><th>團隊名稱</th><td colspan="3">' + esc(teamName || '—') + '</td></tr>' +
        '<tr><th>訓練日期</th><td>' + esc(r.date) + '</td><th>氣候</th><td>' + esc(weather) + '</td><th>訓練時數</th><td>' + esc(hours) + ' 小時</td></tr>' +
        '<tr><th>班級</th><td>' + esc(gradeClass || '—') + '</td><th>選手姓名</th><td>' + esc(athlete.name || '') + '</td><th>性別</th><td>' + esc(gender) + '</td></tr>' +
        '<tr><th>晨間活動內容</th><td colspan="5">' + field('') + '</td></tr>' +
        '<tr><th>上午訓練內容</th><td colspan="5">' + field(r.trainingAM) + '</td></tr>' +
        '<tr><th>下午訓練內容</th><td colspan="5">' + field(r.trainingPM) + '</td></tr>' +
        '<tr><th>晚間／自主訓練</th><td colspan="5">' + field(r.trainingEve) + '</td></tr>' +
        '<tr class="tl-auto"><th>出席與身體狀況</th><td colspan="5">' + esc(bodyStatus(r)) + '</td></tr>' +
        '<tr><th>訓練心得／檢討</th><td colspan="5">' + field(notes) + '</td></tr>' +
        (r.coachComment ? '<tr><th>教練回饋</th><td colspan="5"><div class="tl-content">' + esc(r.coachComment) + '</div></td></tr>' : '') +
        '<tr class="tl-sign"><th>選手簽名</th><td colspan="2"></td><th>教練簽章</th><td colspan="2"></td></tr>' +
        '</table></div>';
    }).join('');

    $('#reportArea').innerHTML =
      '<div class="report-doc tlog">' +
        '<div class="tlog-cover">' +
          '<div class="rp-brand"><img src="assets/logo.png" alt="" loading="lazy" decoding="async" width="22" height="22">TeamPro 教練戰情室</div>' +
          '<h2>體育署 體育班訓練日誌（個人）</h2>' +
          '<div class="muted">' + esc(school || '') + (school ? '　' : '') + esc(athlete.name || '') +
            '　｜　' + range.from + ' ~ ' + range.to + '　｜　共 ' + recs.length + ' 個訓練日</div>' +
        '</div>' +
        days +
      '</div>';
  }

  // 家長溝通報告：溫和摘要，不顯示原始 KPI 分數、心情、壓力、體重、傷勢細節
  function renderParentReport(athlete, range, recs) {
    if (!recs.length) {
      $('#reportArea').innerHTML = '<div class="report-doc"><h2>查無資料</h2><p>' + esc(athlete.name) +
        ' 在 ' + range.from + ' ~ ' + range.to + ' 期間沒有填寫紀錄。</p></div>';
      return;
    }
    var filled = recs.length, rate = Math.round(filled / range.days * 100);
    var attentionDays = recs.filter(function (r) { return r.status === 'red' || r.status === 'yellow'; }).length;
    var lastRec = recs[recs.length - 1];
    var light = lastRec.status || TP.lightOf(num(lastRec.totalScore));
    var hasSensitive = light === 'red' || recs.some(function (r) { return r.injuryAreas && r.injuryAreas !== '無受傷'; });
    var comment = $('#rpComment').value.trim();
    var rpNo = reportNo(state.coach.name + '|家長|' + athlete.name + '|' + range.from + '|' + range.to);

    $('#reportArea').innerHTML = '<div class="report-doc">' +
      '<div class="rp-head"><div>' +
        '<div class="rp-brand"><img src="assets/logo.png" alt="" loading="lazy" decoding="async" width="22" height="22">TeamPro 教練戰情室</div>' +
        '<h2 style="margin:4px 0;">家長溝通報告</h2></div>' +
        '<div style="text-align:right;"><div><b>' + esc(athlete.name) + '</b></div>' +
        '<div class="muted" style="color:#5b6675;">' + range.from + ' ~ ' + range.to + '</div>' +
        '<div class="rp-no">報告編號 ' + rpNo + '</div></div>' +
      '</div>' +
      '<div class="rp-grid">' +
        '<div class="rp-stat"><div class="n">' + rate + '%</div><div class="l">回報完成率</div></div>' +
        '<div class="rp-stat"><div class="n">' + filled + '</div><div class="l">回報天數</div></div>' +
        '<div class="rp-stat"><div class="n"><span class="rp-light ' + light + '">' + TP.lightText(light) + '</span></div><div class="l">最近整體狀態</div></div>' +
        '<div class="rp-stat"><div class="n">' + attentionDays + '</div><div class="l">需留意天數</div></div>' +
      '</div>' +
      '<div class="rp-section"><h3>給家長的話</h3><div class="rp-comment">' +
        esc(TP.parentSummary({ name: athlete.name, light: light, private: hasSensitive })) + '</div></div>' +
      (comment ? '<div class="rp-section"><h3>教練的話</h3><div class="rp-comment">' + esc(comment) + '</div></div>' : '') +
      '<div class="rp-foot"><span class="rp-wm-foot">Generated by TeamPro Coach Warroom</span> · 報告編號：' + rpNo +
        '<br>教練：' + esc(state.coach.name) + ' · 選手：' + esc(athlete.name) + ' · 產生日期：' + localToday() +
        '<br>本報告為家長溝通版，僅呈現整體狀態摘要；完整訓練數據由教練保留與說明。</div>' +
      freeReportBadge() +
      '</div>';
  }

  /* ===== 專任教練訪視報告（Phase 1：自動彙整現有資料） ===== */
  var VISIT_ITEMS = [
    ['1-1', '建置選手訓練歷程檔案', 'auto'], ['1-2', '擬定運動訓練計畫及執行情形', 'auto'],
    ['1-3', '指導選手參加競賽之情形', 'comp'], ['1-4', '輔導選手撰寫訓練日誌之情形', 'auto'],
    ['1-5', '協助選手課業情形', 'need'], ['1-6', '輔導選手生活照護情形並落實紀錄', 'auto'],
    ['1-7', '運動傷害防護與保健情形', 'auto'], ['1-8', '性平與反霸凌教育', 'need'],
    ['2-1', '每年度參加訓練指導相關知能研習達 18 小時', 'need'], ['2-2', '學生畢業後從事專項運動之銜接輔導情形', 'need'],
    ['2-3', '專項運動訓練場地、器材維護情形', 'need'], ['2-4', '支援運動賽會情形', 'need'],
    ['2-5', '協助學校專項運動社團組成與運動情形', 'need'], ['2-6', '協助推動每週 150 分鐘體育課外活動情形', 'need']
  ];
  function visitStatus(code, kind, vs) {
    if (kind === 'comp') return (vs.compCount > 0) ? '已完成' : '本月尚無紀錄';
    if (kind === 'need') return '本月尚無紀錄';
    if (code === '1-2') return vs.trainingDays > 0 ? '已完成' : '資料不足';
    if (code === '1-4') return vs.notesFilled > 0 ? '已完成' : '資料不足';
    return vs.reportCount > 0 || vs.trainingDays > 0 ? '已完成' : '資料不足';
  }
  function visitStatusLight(s) { return s === '已完成' ? 'green' : (s === '資料不足' ? 'yellow' : 'red'); }
  function visitText(code, vs, ver) {
    var P = vs.painParts && vs.painParts.length ? vs.painParts.join('、') : '—';
    var CS = vs.courses && vs.courses.length ? vs.courses.join('、') : '—';
    if (code === '1-3' && !(vs.compCount > 0)) return '本期系統內尚無比賽紀錄。選手可在每日回報的「🏆 比賽紀錄」自行登錄比賽日、成績與心得，即會自動彙整於此。';
    if (code === '1-3') {
      var cs = vs.competitions || [], m = vs.medals || { gold: 0, silver: 0, bronze: 0 };
      var names = cs.map(function (c) { return c.name; }).join('、') || '—';
      var medal = (m.gold + m.silver + m.bronze) > 0 ? '，獲 🥇' + m.gold + ' 🥈' + m.silver + ' 🥉' + m.bronze : '';
      if (ver === 'short') return '本期參加 ' + vs.compCount + ' 場比賽、' + vs.compParticipants + ' 人次參賽' + medal + '。';
      if (ver === 'evidence') return '佐證：比賽 ' + vs.compCount + ' 場（' + cs.map(function (c) { return c.name + ' ' + c.date; }).join('；') + '）；參賽 ' + vs.compParticipants + ' 人次；獎牌 🥇' + m.gold + '/🥈' + m.silver + '/🥉' + m.bronze + '。';
      return '指導選手參加 ' + vs.compCount + ' 場競賽（' + names + '），共 ' + vs.compParticipants + ' 人次參賽' + medal + '。各場成績與賽後心得由選手於每日回報即時登錄。';
    }
    var T = {
      '1-1': {
        short: '已為 ' + vs.athleteCount + ' 位選手建置訓練歷程，累積 ' + vs.reportCount + ' 筆每日回報與 ' + (vs.weeklyKpiCount || 0) + ' 筆週狀態。',
        formal: '本隊已為 ' + vs.athleteCount + ' 位選手建立訓練歷程，期間累積 ' + vs.reportCount + ' 筆每日安全與恢復回報，另有 ' + (vs.weeklyKpiCount || 0) + ' 筆每週表現評估，可分開呈現日常風險與中期成長趨勢。',
        evidence: '佐證：選手名單 ' + vs.athleteCount + ' 人；每日回報 ' + vs.reportCount + ' 筆；週狀態 ' + (vs.weeklyKpiCount || 0) + ' 筆。'
      },
      '1-2': {
        short: '本期點名 ' + vs.trainingDays + ' 天，涵蓋 ' + (vs.courses.length) + ' 種訓練課程，平均到課率 ' + vs.attendanceRate + '%。',
        formal: '依訓練計畫執行，本期共完成 ' + vs.trainingDays + ' 天點名，訓練課程包含 ' + CS + '，平均到課率 ' + vs.attendanceRate + '%，訓練計畫與實際執行情形均有紀錄可查。',
        evidence: '佐證：點名紀錄 ' + vs.trainingDays + ' 天；課程種類：' + CS + '；到課率 ' + vs.attendanceRate + '%。'
      },
      '1-4': {
        short: '選手每日回報率 ' + vs.reportRate + '%，其中 ' + vs.notesFilled + ' 筆填寫訓練心得。',
        formal: '輔導選手落實每日訓練回報，期間回報率達 ' + vs.reportRate + '%，其中 ' + vs.notesFilled + ' 筆含訓練心得與反思，並有教練回饋 ' + vs.feedbackCount + ' 則，形成完整訓練日誌循環。',
        evidence: '佐證：回報率 ' + vs.reportRate + '%；訓練心得 ' + vs.notesFilled + ' 筆；教練回饋 ' + vs.feedbackCount + ' 則。'
      },
      '1-6': {
        short: '落實每日出缺勤與生活狀態追蹤（睡眠、水分、出席），異常即關心。',
        formal: '輔導並落實選手生活照護紀錄，每日掌握出缺勤、睡眠、水分與生活狀態，期間 ' + vs.sleepShort + ' 人次睡眠不足、' + vs.hydrationFlag + ' 人次水分不足均即時關心，必要時通知家長協助。',
        evidence: '佐證：點名 ' + vs.trainingDays + ' 天；睡眠不足提醒 ' + vs.sleepShort + ' 人次；水分不足提醒 ' + vs.hydrationFlag + ' 人次。'
      },
      '1-7': {
        short: '本期傷勢追蹤 ' + vs.injuryAthletes + ' 人次，均提供處理與防護建議。',
        formal: '落實運動傷害防護與保健，期間共追蹤 ' + vs.injuryAthletes + ' 人次回報疼痛（疼痛 4 分以上）' + (vs.maxPain ? '，最高疼痛 ' + vs.maxPain + ' 分' : '') + (vs.painParts && vs.painParts.length ? '，部位包含 ' + P : '') + '，均依疼痛分級提供降低訓練強度、防護或就醫建議。',
        evidence: '佐證：傷勢追蹤 ' + vs.injuryAthletes + ' 人次；最高疼痛 ' + vs.maxPain + ' 分；部位：' + P + '。（個別敏感資料僅呈現摘要）'
      }
    };
    if (!T[code]) return '本期系統內尚無此項紀錄，建議於後續「訪視紀錄」模組補登相關資料與佐證（即將推出）。';
    return T[code][ver] || T[code].formal;
  }

  function renderVisitReport(teamName, range, vs) {
    var ver = $('#rpVisitVer').value || 'formal';
    var school = $('#rpSchool').value.trim() || (coachSettings().school || '—');
    if ($('#rpSchool').value.trim()) saveCoachSettings({ school: $('#rpSchool').value.trim() });
    var comment = $('#rpComment').value.trim();
    var rpNo = reportNo(state.coach.name + '|訪視|' + teamName + '|' + range.from + '|' + range.to);
    var lights = vs.lights || { green: 0, yellow: 0, red: 0 };

    var table = VISIT_ITEMS.map(function (it) {
      var s = visitStatus(it[0], it[2], vs);
      return '<div class="rp-dim"><span class="name" style="width:42px;">' + it[0] + '</span>' +
        '<span style="flex:1;">' + esc(it[1]) + '</span>' +
        '<span class="rp-light ' + visitStatusLight(s) + '">' + s + '</span></div>';
    }).join('');

    var summaries = VISIT_ITEMS.map(function (it) {
      var s = visitStatus(it[0], it[2], vs);
      return '<div class="rp-section" style="margin-top:12px;"><h3 style="font-size:15px;">' + it[0] + '　' + esc(it[1]) +
        ' <span class="rp-light ' + visitStatusLight(s) + '" style="font-size:11px;">' + s + '</span></h3>' +
        '<div class="rp-comment" style="white-space:normal;">' + esc(visitText(it[0], vs, ver)) + '</div></div>';
    }).join('');

    var evidence = ['每日訓練回報 ' + vs.reportCount + ' 筆、週狀態 ' + (vs.weeklyKpiCount || 0) + ' 筆', '點名紀錄 ' + vs.trainingDays + ' 天、課程 ' + (vs.courses.length) + ' 種',
      '到課率 ' + vs.attendanceRate + '%、選手回報率 ' + vs.reportRate + '%', '教練回饋 ' + vs.feedbackCount + ' 則',
      '傷勢追蹤 ' + vs.injuryAthletes + ' 人次、睡眠/水分提醒 ' + (vs.sleepShort + vs.hydrationFlag) + ' 人次'];

    var todo = [];
    if (vs.reportRate < 70) todo.push('每日回報率偏低（' + vs.reportRate + '%），建議加強提醒選手完成回報。');
    VISIT_ITEMS.forEach(function (it) { if (it[2] === 'need') todo.push(it[0] + ' ' + it[1] + '：建議於「訪視紀錄」補登資料與佐證。'); });

    $('#reportArea').innerHTML = '<div class="report-doc">' +
      '<div class="rp-head"><div>' +
        '<div class="rp-brand"><img src="assets/logo.png" alt="" loading="lazy" decoding="async" width="22" height="22">TeamPro 教練戰情室</div>' +
        '<h2 style="margin:4px 0;">專任運動教練訪視報告</h2></div>' +
        '<div style="text-align:right;"><div><b>' + esc(school) + '</b></div>' +
        '<div class="muted" style="color:#5b6675;">' + esc(teamName) + '　教練：' + esc(state.coach.name) + '</div>' +
        '<div class="muted" style="color:#5b6675;">' + range.from + ' ~ ' + range.to + '</div>' +
        '<div class="rp-no">報告編號 ' + rpNo + '</div></div>' +
      '</div>' +

      '<div class="rp-section"><h3>一頁總覽</h3><div class="rp-grid">' +
        '<div class="rp-stat"><div class="n">' + vs.trainingDays + '</div><div class="l">本期訓練天數</div></div>' +
        '<div class="rp-stat"><div class="n">' + vs.attendanceRate + '%</div><div class="l">點名到課率</div></div>' +
        '<div class="rp-stat"><div class="n">' + vs.reportRate + '%</div><div class="l">選手回報率</div></div>' +
        '<div class="rp-stat"><div class="n">' + vs.injuryAthletes + '</div><div class="l">傷勢追蹤人次</div></div>' +
      '</div><div class="rp-grid">' +
        '<div class="rp-stat"><div class="n">' + vs.athleteCount + '</div><div class="l">選手人數</div></div>' +
        '<div class="rp-stat"><div class="n">' + (vs.compCount || 0) + '</div><div class="l">比賽場次</div></div>' +
        '<div class="rp-stat"><div class="n">' + vs.feedbackCount + '</div><div class="l">教練回饋</div></div>' +
        '<div class="rp-stat"><div class="n" style="font-size:18px;"><span class="rp-light green">' + (lights.green || 0) + '</span> <span class="rp-light yellow">' + (lights.yellow || 0) + '</span> <span class="rp-light red">' + (lights.red || 0) + '</span></div><div class="l">狀態燈號分布</div></div>' +
      '</div></div>' +

      '<div class="rp-section"><h3>訪視項目總表（1-1 ～ 2-6）</h3>' + table + '</div>' +
      '<div class="rp-section"><h3>各項目摘要（' + (ver === 'short' ? '簡短版' : ver === 'evidence' ? '佐證版' : '正式版') + '）</h3>' + summaries + '</div>' +
      '<div class="rp-section"><h3>佐證資料清單</h3><ul style="margin:6px 0;padding-left:18px;color:#1a2230;">' +
        evidence.map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') + '</ul></div>' +
      ((vs.awardPhotos && vs.awardPhotos.length) ? '<div class="rp-section"><h3>比賽佐證照片</h3>' +
        '<div style="display:flex;flex-wrap:wrap;gap:10px;">' + vs.awardPhotos.map(function (p) {
          return '<div style="text-align:center;font-size:11px;color:#5b6675;">' +
            '<a href="' + esc(p.url) + '" target="_blank" rel="noopener"><img src="' + esc(p.url) + '" loading="lazy" decoding="async" width="120" height="120" style="width:120px;height:120px;object-fit:cover;border-radius:8px;border:1px solid #d6dce4;"></a>' +
            '<div>' + esc(p.name) + '・' + esc(p.comp) + '</div></div>';
        }).join('') + '</div></div>' : '') +
      '<div class="rp-section"><h3>待改善事項與下月重點</h3><div class="rp-comment" style="white-space:pre-wrap;">' +
        (comment ? esc(comment) + '\n\n' : '') + esc(todo.join('\n')) + '</div></div>' +

      '<div class="rp-foot"><span class="rp-wm-foot">Generated by TeamPro Coach Warroom</span> · 報告編號：' + rpNo +
        '<br>學校：' + esc(school) + ' · 教練：' + esc(state.coach.name) + ' · 產生日期：' + localToday() +
        '<br>本訪視報告由系統自動彙整每日訓練資料生成；敏感個資（傷勢/心理/體重）僅呈現整體摘要，不揭露個別原始內容。</div>' +
      freeReportBadge() +
      '</div>';
  }

  function demoVisitSummary(range) {
    return { ok: true, athleteCount: 12, days: range.days, trainingDays: Math.min(range.days, 20), courses: ['晨操', '專長訓練', '體能訓練', '技術訓練'],
      attendanceRate: 91, reportCount: 180, reportRate: 84, notesFilled: 150, feedbackCount: 36,
      injuryAthletes: 4, maxPain: 6, painParts: ['膝蓋', '腳踝'], sleepShort: 9, hydrationFlag: 5, lights: { green: 120, yellow: 45, red: 15 },
      competitions: [{ name: '全中運跆拳道', date: range.to, location: '林口體育館' }, { name: '北區錦標賽', date: range.from }], compCount: 2, compParticipants: 6, medals: { gold: 2, silver: 1, bronze: 1 } };
  }

  function mean(arr) { return arr.length ? arr.reduce(function (s, v) { return s + v; }, 0) / arr.length : 0; }
  function num(v) { return Number(v) || 0; }

  function sparkline(vals) {
    if (vals.length < 2) return '';
    var w = 340, h = 64, pad = 7, max = 5, min = 1;
    var xy = vals.map(function (v, i) {
      var x = pad + i * (w - 2 * pad) / (vals.length - 1);
      var cv = Math.max(min, Math.min(max, Number(v) || min));
      var y = h - pad - (cv - min) / (max - min) * (h - 2 * pad);
      return [x, y];
    });
    var line = xy.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' ');
    var area = 'M' + xy[0][0].toFixed(1) + ',' + (h - pad).toFixed(1) +
      xy.map(function (p) { return ' L' + p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join('') +
      ' L' + xy[xy.length - 1][0].toFixed(1) + ',' + (h - pad).toFixed(1) + ' Z';
    var last = xy[xy.length - 1];
    var gid = 'spk' + Math.random().toString(36).slice(2, 7);
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" style="margin-top:6px;width:100%;max-width:340px;height:auto;display:block;">' +
      '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="#16a34a" stop-opacity=".22"/><stop offset="100%" stop-color="#16a34a" stop-opacity="0"/></linearGradient></defs>' +
      '<path d="' + area + '" fill="url(#' + gid + ')"/>' +
      '<polyline points="' + line + '" fill="none" stroke="#16a34a" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>' +
      '<circle cx="' + last[0].toFixed(1) + '" cy="' + last[1].toFixed(1) + '" r="3.2" fill="#16a34a"/></svg>';
  }

  function isPro() { return state.coach && state.coach.effectivePlan === 'pro'; }

  /* 純 SVG 六角雷達圖（dims: [{name, value(0–5)}]） */
  function radarSvg(dims) {
    var n = dims.length, cx = 110, cy = 110, R = 78, max = 5;
    function pt(i, r) { var a = -Math.PI / 2 + i * 2 * Math.PI / n; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; }
    var rings = '';
    for (var g = 1; g <= 5; g++) {
      var poly = []; for (var i = 0; i < n; i++) { var p = pt(i, R * g / 5); poly.push(p[0].toFixed(1) + ',' + p[1].toFixed(1)); }
      rings += '<polygon points="' + poly.join(' ') + '" fill="none" stroke="#e0e5ec" stroke-width="1"/>';
    }
    var axes = '', labels = '';
    for (var i = 0; i < n; i++) {
      var p = pt(i, R); axes += '<line x1="' + cx + '" y1="' + cy + '" x2="' + p[0].toFixed(1) + '" y2="' + p[1].toFixed(1) + '" stroke="#e0e5ec"/>';
      var lp = pt(i, R + 17);
      labels += '<text x="' + lp[0].toFixed(1) + '" y="' + lp[1].toFixed(1) + '" font-size="12" fill="#5b6675" text-anchor="middle" dominant-baseline="middle">' + esc(dims[i].name) + '</text>';
    }
    var vp = []; for (var j = 0; j < n; j++) { var v = Math.max(0, Math.min(max, num(dims[j].value))); var q = pt(j, R * v / max); vp.push(q[0].toFixed(1) + ',' + q[1].toFixed(1)); }
    var val = '<polygon points="' + vp.join(' ') + '" fill="rgba(22,163,74,.25)" stroke="#16a34a" stroke-width="2"/>';
    return '<div style="text-align:center;"><svg viewBox="0 0 220 220" width="260" height="260" style="max-width:100%;">' + rings + axes + val + labels + '</svg></div>';
  }

  function radarBlock(dims) {
    if (isPro()) return '<div class="rp-section"><h3>能力雷達圖</h3>' + radarSvg(dims) + '</div>';
    return '<div class="rp-section no-print"><h3>能力雷達圖</h3>' +
      '<div style="background:#f3f5f8;border-radius:10px;padding:22px;text-align:center;color:#5b6675;">🔒 雷達圖與進階數據圖為<b>專業版</b>功能，升級即可解鎖</div></div>';
  }

  function deltaTag(d) {
    if (d > 0.15) return '<span class="rp-delta up">▲ +' + d.toFixed(1) + '</span>';
    if (d < -0.15) return '<span class="rp-delta down">▼ ' + d.toFixed(1) + '</span>';
    return '<span class="rp-delta flat">— 持平</span>';
  }

  // 報告編號 TP-YYYYMMDD-XXXX；XXXX 由教練/主體/區間雜湊而來，同一份報告可重現相同編號
  function reportNo(seed) {
    var d = localToday().replace(/-/g, '');
    var h = 5381, s = String(seed || '');
    for (var i = 0; i < s.length; i++) { h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; }
    var x = ('000' + (h % 10000)).slice(-4);
    return 'TP-' + d + '-' + x;
  }

  function renderReport(athlete, range, recs) {
    if (!recs.length) {
      $('#reportArea').innerHTML = '<div class="report-doc"><h2>查無資料</h2>' +
        '<p>' + esc(athlete.name) + ' 在 ' + range.from + ' ~ ' + range.to + ' 期間沒有填寫紀錄。</p></div>';
      return;
    }
    var totals = recs.map(function (r) { return num(r.totalScore); });
    var avg = mean(totals), first = totals[0], last = totals[totals.length - 1];
    var filled = recs.length, expectedWeeks = Math.max(1, Math.ceil(range.days / 7)), rate = Math.min(100, Math.round(filled / expectedWeeks * 100));
    var lights = { green: 0, yellow: 0, red: 0 };
    recs.forEach(function (r) { var l = r.status || TP.lightOf(r.totalScore); lights[l] = (lights[l] || 0) + 1; });
    var moods = recs.map(function (r) { return num(r.moodIndex); }).filter(function (v) { return v > 0; });

    var firstRec = recs[0], lastRec = recs[recs.length - 1];
    var labels = customKpiLabels();
    var dimRows = DIMS.map(function (d, idx) {
      var vals = recs.map(function (r) { return num(r[d[0]]); }).filter(function (v) { return v > 0; });
      var a = mean(vals), delta = num(lastRec[d[0]]) - num(firstRec[d[0]]);
      return { name: labels[idx] || d[1], avg: a, delta: delta };
    });
    var best = dimRows.slice().sort(function (x, y) { return y.avg - x.avg; })[0];
    var worst = dimRows.slice().sort(function (x, y) { return x.avg - y.avg; })[0];
    var comment = $('#rpComment').value.trim();
    var rpNo = reportNo(state.coach.name + '|' + athlete.name + '|' + range.from + '|' + range.to);

    var html = '<div class="report-doc">' +
      '<div class="rp-head"><div>' +
        '<div class="rp-brand"><img src="assets/logo.png" alt="" loading="lazy" decoding="async" width="22" height="22">TeamPro 教練戰情室</div>' +
        '<h2 style="margin:4px 0;">選手成果報告</h2></div>' +
        '<div style="text-align:right;"><div><b>' + esc(athlete.name) + '</b></div>' +
        '<div class="muted" style="color:#5b6675;">' + esc(athlete.gradeClass || '') + '</div>' +
        '<div class="muted" style="color:#5b6675;">' + range.from + ' ~ ' + range.to + '</div>' +
        '<div class="rp-no">報告編號 ' + rpNo + '</div></div>' +
      '</div>' +

      '<div class="rp-grid">' +
        '<div class="rp-stat"><div class="n">' + avg.toFixed(1) + '</div><div class="l">平均總分</div></div>' +
        '<div class="rp-stat"><div class="n">' + deltaTag(last - first) + '</div><div class="l">期間進步</div></div>' +
        '<div class="rp-stat"><div class="n">' + rate + '%</div><div class="l">週狀態 完成率 (' + filled + '/' + expectedWeeks + '週)</div></div>' +
        '<div class="rp-stat"><div class="n">' + filled + '</div><div class="l">有效週評估</div></div>' +
      '</div>' +

      '<div class="rp-section"><h3>總分趨勢</h3>' + sparkline(totals) +
        '<div class="muted" style="color:#5b6675;font-size:12px;">起 ' + first.toFixed(1) + ' → 末 ' + last.toFixed(1) + '</div></div>' +

      '<div class="rp-section"><h3>六大面向</h3>' +
        dimRows.map(function (d) {
          return '<div class="rp-dim"><span class="name">' + d.name + '</span>' +
            '<span class="rp-bar"><i style="width:' + (d.avg / 5 * 100) + '%"></i></span>' +
            '<span class="val">' + d.avg.toFixed(1) + ' ' + deltaTag(d.delta) + '</span></div>';
        }).join('') + '</div>' +

      radarBlock(dimRows.map(function (d) { return { name: d.name, value: d.avg }; })) +

      '<div class="rp-section rp-grid" style="grid-template-columns:1fr 1fr;">' +
        '<div class="rp-stat" style="text-align:left;"><div class="l">💪 最佳面向</div><div class="n" style="font-size:18px;">' + best.name + '（' + best.avg.toFixed(1) + '）</div></div>' +
        '<div class="rp-stat" style="text-align:left;"><div class="l">🎯 待加強面向</div><div class="n" style="font-size:18px;">' + worst.name + '（' + worst.avg.toFixed(1) + '）</div></div>' +
      '</div>' +

      '<div class="rp-section"><h3>狀態燈號分布</h3>' +
        '<span class="rp-light green">綠燈 ' + lights.green + ' 週</span> ' +
        '<span class="rp-light yellow">黃燈 ' + lights.yellow + ' 週</span> ' +
        '<span class="rp-light red">紅燈 ' + lights.red + ' 週</span></div>' +

      (comment ? '<div class="rp-section"><h3>教練評語</h3><div class="rp-comment">' + esc(comment) + '</div></div>' : '') +

      '<div class="rp-foot"><span class="rp-wm-foot">Generated by TeamPro Coach Warroom</span>' +
        ' · 報告編號：' + rpNo +
        '<br>教練：' + esc(state.coach.name) + ' · 選手：' + esc(athlete.name) + ' · 產生日期：' + localToday() +
        '<br>評分制：六大面向各 1–5 分（5 為最佳），總分為六面向等權平均。</div>' +
      freeReportBadge() +
      '</div>';

    $('#reportArea').innerHTML = html;
  }

  function renderTeamReport(teamName, range, tr) {
    if (!tr.athleteCount) {
      $('#reportArea').innerHTML = '<div class="report-doc"><h2>查無選手</h2><p>此團隊沒有啟用中的選手。</p></div>';
      return;
    }
    var labels = customKpiLabels();
    var dimKeys = ['technicalAvg', 'tacticalAvg', 'physicalAvg', 'mentalAvg', 'attitudeAvg', 'physiologicalAvg'];
    var dimDefaults = { technicalAvg: '技術執行', tacticalAvg: '戰術理解', physicalAvg: '體能負荷', mentalAvg: '心理狀態', attitudeAvg: '訓練態度', physiologicalAvg: '生理恢復' };
    var dimMap = {};
    dimKeys.forEach(function (k, i) { dimMap[k] = labels[i] || dimDefaults[k]; });
    var trendVals = (tr.trend || []).map(function (x) { return num(x.avg); });
    var rows = (tr.athletes || []).slice();
    var comment = $('#rpComment').value.trim();
    var attention = rows.filter(function (a) { return a.lastStatus === 'red' || (a.avgTotal && a.avgTotal < 3); });
    var rpNo = reportNo(state.coach.name + '|' + teamName + '|' + range.from + '|' + range.to);

    var html = '<div class="report-doc">' +
      '<div class="rp-head"><div>' +
        '<div class="rp-brand"><img src="assets/logo.png" alt="" loading="lazy" decoding="async" width="22" height="22">TeamPro 教練戰情室</div>' +
        '<h2 style="margin:4px 0;">團隊成果報告</h2></div>' +
        '<div style="text-align:right;"><div><b>' + esc(teamName) + '</b></div>' +
        '<div style="color:#5b6675;">' + tr.athleteCount + ' 位選手</div>' +
        '<div style="color:#5b6675;">' + range.from + ' ~ ' + range.to + '</div>' +
        '<div class="rp-no">報告編號 ' + rpNo + '</div></div>' +
      '</div>' +

      '<div class="rp-grid">' +
        '<div class="rp-stat"><div class="n">' + num(tr.teamAvg).toFixed(1) + '</div><div class="l">全隊平均總分</div></div>' +
        '<div class="rp-stat"><div class="n">' + tr.completionRate + '%</div><div class="l">每日回報率 (' + tr.totalReports + '/' + tr.expectedReports + ')</div></div>' +
        '<div class="rp-stat"><div class="n">' + tr.athleteCount + '</div><div class="l">選手人數</div></div>' +
        '<div class="rp-stat"><div class="n">' + (tr.weeklyKpiReports || 0) + '</div><div class="l">週狀態 筆數</div></div>' +
      '</div>' +

      '<div class="rp-section"><h3>全隊每週狀態 趨勢</h3>' + sparkline(trendVals) + '</div>' +

      '<div class="rp-section"><h3>六大面向（全隊平均）</h3>' +
        Object.keys(dimMap).map(function (k) {
          var v = num(tr.dimAvg[k]);
          return '<div class="rp-dim"><span class="name">' + dimMap[k] + '</span>' +
            '<span class="rp-bar"><i style="width:' + (v / 5 * 100) + '%"></i></span>' +
            '<span class="val">' + v.toFixed(1) + '</span></div>';
        }).join('') + '</div>' +

      radarBlock(Object.keys(dimMap).map(function (k) { return { name: dimMap[k], value: num(tr.dimAvg[k]) }; })) +

      '<div class="rp-section"><h3>狀態燈號分布（期間總筆數）</h3>' +
        '<span class="rp-light green">綠燈 ' + (tr.lights.green || 0) + '</span> ' +
        '<span class="rp-light yellow">黃燈 ' + (tr.lights.yellow || 0) + '</span> ' +
        '<span class="rp-light red">紅燈 ' + (tr.lights.red || 0) + '</span></div>' +

      (attention.length ? '<div class="rp-section"><h3>🎯 需要關心（最近紅燈或平均偏低）</h3>' +
        attention.map(function (a) { return '<span class="rp-light red" style="margin:2px;">' + esc(a.name) + ' ' + num(a.avgTotal).toFixed(1) + '</span>'; }).join(' ') + '</div>' : '') +

      '<div class="rp-section"><h3>選手週狀態 摘要</h3>' +
        '<table style="width:100%;border-collapse:collapse;font-size:13px;">' +
        '<tr style="border-bottom:1px solid #d6dce4;color:#5b6675;"><th style="text-align:left;padding:6px;">選手</th><th>有效週數</th><th>個人平均</th><th>變化</th><th>最近狀態</th></tr>' +
        rows.map(function (a) {
          var l = a.lastStatus || 'green';
          var dt = num(a.delta);
          var dtxt = dt > 0.15 ? '<span style="color:#16a34a;">▲+' + dt.toFixed(1) + '</span>' : (dt < -0.15 ? '<span style="color:#dc2626;">▼' + dt.toFixed(1) + '</span>' : '—');
          return '<tr style="border-bottom:1px solid #eef1f5;"><td style="padding:6px;">' + esc(a.name) + '</td>' +
            '<td style="text-align:center;">' + a.filledDays + '</td>' +
            '<td style="text-align:center;font-weight:700;">' + num(a.avgTotal).toFixed(1) + '</td>' +
            '<td style="text-align:center;">' + dtxt + '</td>' +
            '<td style="text-align:center;"><span class="rp-light ' + l + '">' + TP.lightText(l) + '</span></td></tr>';
        }).join('') + '</table></div>' +

      (comment ? '<div class="rp-section"><h3>教練評語</h3><div class="rp-comment">' + esc(comment) + '</div></div>' : '') +

      '<div class="rp-foot"><span class="rp-wm-foot">Generated by TeamPro Coach Warroom</span>' +
        ' · 報告編號：' + rpNo +
        '<br>教練：' + esc(state.coach.name) + ' · 團隊：' + esc(teamName) + ' · 產生日期：' + localToday() +
        '<br>評分制：六大面向各 1–5 分（5 為最佳），總分為六面向等權平均；填寫率＝實際回報筆數 ÷（人數×天數）。</div>' +
      freeReportBadge() +
      '</div>';

    $('#reportArea').innerHTML = html;
  }

  /* ---------- 教練回饋 + AI 教練模組 ---------- */
  var fbCtx = { recordId: '', record: null };

  // AI 教練模組：依該筆資料產生客製化草稿
  var AI_MODULES = [
    { key: '🔥 激勵打氣', build: function (r, name) {
        var top = bestDim(r);
        return name + '，今天' + (top ? '你的「' + top + '」很亮眼，' : '') + '看得出你有認真投入！保持這股氣勢，明天我們再往上推一階，我相信你做得到 💪'; } },
    { key: '🛠️ 技術指導', build: function (r, name) {
        var w = worstDim(r);
        return name + '，今天整體不錯。下一個重點放在「' + (w || '動作細節') + '」：訓練時放慢動作確認軌跡，寧可慢而正確，再逐步加速。明天我會特別看你這塊。'; } },
    { key: '🧘 恢復關懷', build: function (r, name) {
        var parts = [];
        if (Number(r.fatigue) >= 7) parts.push('疲勞指數偏高');
        if (Number(r.sleepHours) && Number(r.sleepHours) < 7) parts.push('睡眠不太夠');
        var head = parts.length ? '今天看到你' + parts.join('、') + '，' : '';
        return name + '，' + head + '今晚請早點休息、補充水分與蛋白質，明天訓練量我會幫你斟酌。身體是本錢，別硬撐，有不舒服一定要說。'; } },
    { key: '❤️ 心理支持', build: function (r, name) {
        return name + '，謝謝你誠實回報。狀態起伏很正常，重點是你願意面對。有任何壓力或想法都可以跟我說，我們一起想辦法。今天先把自己照顧好。'; } },
    { key: '🩹 傷勢關注', build: function (r, name) {
        var area = r.injuryAreas && r.injuryAreas !== '無受傷' ? r.injuryAreas : '不適部位';
        return name + '，注意到你回報「' + area + '」。請先降低該部位負荷、做好冰敷與防護，明天訓練前讓我看一下狀況，必要時就醫評估，不要勉強。'; } },
    { key: '🎯 目標設定', build: function (r, name) {
        var w = worstDim(r);
        return name + '，幫你設下一個小目標：本週把「' + (w || '弱項') + '」從現在的水準提升 0.5 分。每天訓練挑一個動作專注改善，週末我們一起檢視成果。'; } }
  ];
  function dimScore(r, key) { return Number(r[key + 'Avg']) || 0; }
  function bestDim(r) { return pickDim(r, true); }
  function worstDim(r) { return pickDim(r, false); }
  function pickDim(r, best) {
    var names = { technical: '技術執行', tactical: '戰術理解', physical: '體能負荷', mental: '心理狀態', attitude: '訓練態度', physiological: '生理恢復' };
    var keys = Object.keys(names), pick = null, val = best ? -1 : 99;
    keys.forEach(function (k) { var v = dimScore(r, k); if (!v) return; if (best ? v > val : v < val) { val = v; pick = names[k]; } });
    return pick;
  }

  /* ============================================================
     真・傷害／過度訓練風險預測引擎（運動科學驗證方法，非範本）
     - ACWR 急慢性負荷比（Gabbett/Hulin）：acute 7 日 / chronic 28 日
     - 訓練單調度 monotony 與張力 strain（Foster）
     - 個人化基線異常偵測：用「這位選手自己」的均值與標準差算 z 分數，
       不是用全體固定門檻，所以同一個分數對不同選手代表的意義不同
     輸出 0–100 風險分、燈號、可解釋原因，給未來 7 天的傷害／過載前瞻。
     ============================================================ */
  function rkNum(v) { var n = Number(v); return isFinite(n) ? n : null; }
  function rkMean(a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : 0; }
  function rkSd(a) {
    if (a.length < 2) return 0;
    var m = rkMean(a);
    return Math.sqrt(a.reduce(function (s, x) { return s + (x - m) * (x - m); }, 0) / (a.length - 1));
  }
  // 線性回歸斜率（趨勢）：x = 0,1,2,…
  function rkSlope(a) {
    var n = a.length; if (n < 2) return 0;
    var mx = (n - 1) / 2, my = rkMean(a), num = 0, den = 0;
    for (var i = 0; i < n; i++) { num += (i - mx) * (a[i] - my); den += (i - mx) * (i - mx); }
    return den ? num / den : 0;
  }
  function rkSleepHrs(rec) {
    var m = rkNum(rec.sleepDurationMinutes); if (m != null && m > 0) return m / 60;
    var h = rkNum(rec.sleepHours); return (h != null && h > 0) ? h : null;
  }
  // 內部訓練負荷代理 = 當日訓練時段數 × 疲勞(當作 session-RPE)；非訓練日=0
  function rkDaySessions(rec) {
    var slots = [rec.trainingAM, rec.trainingPM, rec.trainingEve], any = false, n = 0;
    slots.forEach(function (s) {
      if (s != null && String(s).trim() !== '') { any = true; if (String(s).trim() !== '無訓練') n++; }
    });
    if (!any) return rec.sessionType === 'rest' ? 0 : 1;   // 沒填時段：用是否訓練日推估
    return n;
  }
  function rkDayLoad(rec) {
    var sessions = rkDaySessions(rec); if (sessions === 0) return 0;
    var rpe = rkNum(rec.fatigue); if (rpe == null || rpe <= 0) rpe = 5;   // 疲勞缺值給中位
    return sessions * rpe;
  }
  function rkDateStr(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  // 主引擎：records = 該選手紀錄（新到舊或舊到新皆可），回傳風險物件或 null（資料太少）
  function riskEngine(records) {
    var recs = (records || []).filter(function (r) { return r && r.date; })
      .slice().sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); });
    if (recs.length < 3) return { insufficient: true, days: recs.length };

    // 以「最後一筆日期」為今天，往回 28 天建立每日負荷（沒紀錄的日子＝休息=0）
    var byDate = {}; recs.forEach(function (r) { byDate[String(r.date)] = r; });
    var today = new Date(String(recs[recs.length - 1].date) + 'T00:00:00');
    var loads = [];                       // index 0 = 27天前 … 27 = 今天
    for (var i = 27; i >= 0; i--) {
      var d = new Date(today.getTime()); d.setDate(d.getDate() - i);
      var r = byDate[rkDateStr(d)];
      loads.push(r ? rkDayLoad(r) : 0);
    }
    var last7 = loads.slice(-7), last28 = loads;
    var acute = rkMean(last7), chronic = rkMean(last28);
    var acwr = chronic > 0 ? acute / chronic : null;
    // Foster monotony/strain（用近 7 日有訓練的負荷，避免休息日把 SD 灌大）
    var sd7 = rkSd(last7), monotony = sd7 > 0 ? acute / sd7 : (acute > 0 ? 2.5 : 0);
    var strain = last7.reduce(function (x, y) { return x + y; }, 0) * monotony;

    // 睡眠（近 7 個有填的日子）
    var sleepArr = recs.slice(-7).map(rkSleepHrs).filter(function (x) { return x != null; });
    var avgSleep = sleepArr.length ? rkMean(sleepArr) : null;
    var lowSleepDays = sleepArr.filter(function (h) { return h < 7; }).length;

    // 疼痛趨勢（近 7 筆）
    var painArr = recs.slice(-7).map(function (r) { return rkNum(r.painScore) || 0; });
    var curPain = painArr.length ? painArr[painArr.length - 1] : 0;
    var painSlope = rkSlope(painArr);
    var latest = recs[recs.length - 1];
    var injuryReported = latest.injuryAreas && latest.injuryAreas !== '無受傷';

    // 個人化基線異常偵測：用這位選手自己的 totalScore 均值/標準差算 z 分數
    var scoreSeries = recs.map(function (r) { return rkNum(r.totalScore); }).filter(function (x) { return x != null && x > 0; });
    var baseMean = scoreSeries.length ? rkMean(scoreSeries) : null;
    var baseSd = scoreSeries.length >= 3 ? rkSd(scoreSeries) : 0;
    var curScore = scoreSeries.length ? scoreSeries[scoreSeries.length - 1] : null;
    var scoreZ = (baseSd > 0 && curScore != null) ? (curScore - baseMean) / baseSd : 0;

    // ---- 風險合成 0–100，每條都附可解釋原因 ----
    var risk = 0, reasons = [];
    if (acwr != null) {
      if (acwr > 1.5) { risk += 35; reasons.push({ w: 35, t: '急慢性負荷比 ' + acwr.toFixed(2) + '（>1.5 高受傷風險區）— 近期訓練量相對暴增' }); }
      else if (acwr > 1.3) { risk += 20; reasons.push({ w: 20, t: '急慢性負荷比 ' + acwr.toFixed(2) + '（1.3–1.5 偏高，留意加量速度）' }); }
      else if (acwr < 0.8 && chronic > 0) { risk += 10; reasons.push({ w: 10, t: '急慢性負荷比 ' + acwr.toFixed(2) + '（<0.8 訓練量偏低，體能與抗傷能力可能流失）' }); }
    }
    if (monotony >= 4) { risk += 20; reasons.push({ w: 20, t: '訓練單調度 ' + monotony.toFixed(1) + '（≥4 過高）— 每天都差不多、缺乏輕重變化，過度訓練風險升高' }); }
    else if (monotony >= 3) { risk += 10; reasons.push({ w: 10, t: '訓練單調度 ' + monotony.toFixed(1) + '（偏高，建議安排明顯的輕／重日交替）' }); }
    if (avgSleep != null) {
      if (avgSleep < 6) { risk += 22; reasons.push({ w: 22, t: '近 7 天平均睡眠 ' + avgSleep.toFixed(1) + ' 小時（<6，恢復嚴重不足）' }); }
      else if (avgSleep < 7) { risk += 11; reasons.push({ w: 11, t: '近 7 天平均睡眠 ' + avgSleep.toFixed(1) + ' 小時（<7，恢復偏不足）' }); }
    }
    if (lowSleepDays >= 3) { risk += 8; reasons.push({ w: 8, t: '近 7 天有 ' + lowSleepDays + ' 天睡眠不足 7 小時，睡眠債累積' }); }
    if (curPain >= 7) { risk += 32; reasons.push({ w: 32, t: '目前疼痛 ' + curPain + '/10（高，靜止時可能也痛，不建議專項訓練）' }); }
    else if (curPain >= 4) { risk += 20; reasons.push({ w: 20, t: '目前疼痛 ' + curPain + '/10（中度，動作出力受影響）' }); }
    if (painSlope >= 0.5 && curPain > 0) { risk += 10; reasons.push({ w: 10, t: '疼痛近期呈上升趨勢（每次回報平均 +' + painSlope.toFixed(1) + '）— 可能是累積性傷害前兆' }); }
    if (injuryReported) { risk += 8; reasons.push({ w: 8, t: '最近一次回報有不適部位：' + latest.injuryAreas }); }
    if (scoreZ <= -1.5) { risk += 12; reasons.push({ w: 12, t: '個人化基線異常：目前狀態明顯低於這位選手平時水準（z=' + scoreZ.toFixed(1) + '）' }); }
    else if (scoreZ <= -1) { risk += 7; reasons.push({ w: 7, t: '個人化基線：目前狀態略低於平時水準（z=' + scoreZ.toFixed(1) + '）' }); }

    // 安全底線：急性高疼痛或新報傷一律至少紅燈（傷害預防寧可過度警覺，不可漏接）
    if (curPain >= 7) risk = Math.max(risk, 65);
    else if (curPain >= 4 && injuryReported) risk = Math.max(risk, 60);
    risk = Math.max(0, Math.min(100, Math.round(risk)));
    reasons.sort(function (a, b) { return b.w - a.w; });
    var light = risk >= 60 ? 'red' : (risk >= 35 ? 'yellow' : 'green');

    // 主因 → 對應的可執行建議
    var action;
    if (curPain >= 4 || injuryReported) action = '優先處理疼痛/不適部位：今天降載或改恢復性訓練，必要時就醫評估後再恢復強度。';
    else if (acwr != null && acwr > 1.5) action = '近期加量太快：未來幾天先把訓練量拉回（約降 10–20%），用 1–2 天輕鬆日讓身體追上。';
    else if (monotony >= 3) action = '課表太單調：安排明顯的輕／重日交替，給身體高低起伏才能適應。';
    else if (avgSleep != null && avgSleep < 7) action = '恢復不足的根源是睡眠：本週把睡眠拉到平均 7 小時以上，比加練更有效。';
    else if (light === 'green') action = '各項指標在安全區，維持目前節奏即可，繼續穩定累積。';
    else action = '多項指標輕微偏高，本週安排一次完整恢復、留意睡眠與訓練量平衡。';

    return {
      risk: risk, light: light,
      acwr: acwr, monotony: monotony, strain: strain,
      avgSleep: avgSleep, curPain: curPain, painSlope: painSlope,
      scoreZ: scoreZ, days: recs.length, reasons: reasons, action: action
    };
  }

  function renderRiskForecast(records) {
    var box = $('#riskForecast'); if (!box) return;
    var rk = riskEngine(records);
    if (!rk || rk.insufficient) {
      box.innerHTML = '<div style="border:1px solid var(--line);border-radius:12px;padding:12px;font-size:13px;color:var(--muted);">' +
        '🔮 <b>AI 傷害風險預測</b>：目前只有 ' + ((rk && rk.days) || 0) + ' 天紀錄，至少累積 3 天才能建立基線並預測。再填幾天就會出現。</div>';
      return;
    }
    var label = rk.light === 'red' ? '偏高' : (rk.light === 'yellow' ? '需留意' : '安全');
    var color = rk.light === 'red' ? 'var(--red)' : (rk.light === 'yellow' ? 'var(--yellow)' : 'var(--green)');
    var chips = [];
    if (rk.acwr != null) chips.push('急慢性負荷比 ' + rk.acwr.toFixed(2));
    chips.push('單調度 ' + rk.monotony.toFixed(1));
    if (rk.avgSleep != null) chips.push('睡眠 ' + rk.avgSleep.toFixed(1) + 'h');
    if (rk.curPain > 0) chips.push('疼痛 ' + rk.curPain + '/10');
    var reasonHtml = rk.reasons.length
      ? rk.reasons.slice(0, 4).map(function (x) { return '<li style="margin:2px 0;">' + esc(x.t) + '</li>'; }).join('')
      : '<li style="margin:2px 0;color:var(--green);">各項指標都在安全區。</li>';
    box.innerHTML =
      '<div style="border:1px solid ' + color + ';border-radius:12px;padding:12px;background:rgba(127,127,127,.04);">' +
        '<div style="display:flex;align-items:center;gap:12px;">' +
          '<div style="text-align:center;min-width:74px;">' +
            '<div style="font-size:30px;font-weight:800;line-height:1;color:' + color + ';">' + rk.risk + '</div>' +
            '<div style="font-size:11px;color:var(--muted);">風險分</div>' +
          '</div>' +
          '<div style="flex:1;">' +
            '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">' +
              '<b style="font-size:14px;">🔮 AI 未來 7 天傷害／過載風險</b>' +
              '<span class="pill ' + rk.light + '">' + esc(label) + '</span></div>' +
            '<div style="height:7px;background:var(--panel-2);border-radius:999px;margin:7px 0;overflow:hidden;">' +
              '<div style="height:100%;width:' + rk.risk + '%;background:' + color + ';"></div></div>' +
            '<div style="font-size:11px;color:var(--muted);">' + esc(chips.join('　·　')) + '　·　基於 ' + rk.days + ' 天個人化基線</div>' +
          '</div>' +
        '</div>' +
        '<ul style="margin:10px 0 0;padding-left:18px;font-size:12.5px;line-height:1.5;">' + reasonHtml + '</ul>' +
        '<div style="margin-top:8px;font-size:13px;background:rgba(56,189,248,.1);border-radius:8px;padding:8px 10px;">' +
          '<b>建議行動：</b>' + esc(rk.action) + '</div>' +
        '<div style="margin-top:6px;font-size:11px;color:var(--muted);">方法：ACWR 急慢性負荷比（Gabbett）＋ 訓練單調度／張力（Foster）＋ 個人化基線異常偵測。供訓練決策參考，非醫療診斷。</div>' +
      '</div>';
  }

  /* ---- AI 成長目標：規則引擎（成長導向、單一可量化週目標、零 API） ---- */
  function gcSleepHrs(rec) {
    if (rec.sleepDurationMinutes) return Number(rec.sleepDurationMinutes) / 60;
    if (rec.sleepHours) return Number(rec.sleepHours);
    return null;
  }
  function gcDaysAgo(n) {
    var d = new Date(); d.setDate(d.getDate() - n);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function goalCoach(rec, records, coachObs) {
    records = records || [];
    var d7 = gcDaysAgo(7), d30 = gcDaysAgo(30);
    var rep7 = records.filter(function (x) { return String(x.date) >= d7; }).length;
    var rep30 = records.filter(function (x) { return String(x.date) >= d30; }).length;
    var reportingDrop = rep30 >= 4 && rep7 <= 1;
    var kpi = Number(rec.totalScore) || 0;
    var pain = Number(rec.painScore) || 0;
    var fatigue = Number(rec.fatigue) || 0;
    var sleep = gcSleepHrs(rec);
    var hydrationBad = rec.hydrationRisk && rec.hydrationRisk !== 'green';
    // 自評代理：本筆 KPI，無則取最近一筆有 KPI 的紀錄
    var self = kpi;
    if (!self) { var k = records.filter(function (x) { return Number(x.totalScore) > 0; })[0]; if (k) self = Number(k.totalScore) || 0; }
    var coach = (coachObs === '' || coachObs == null) ? null : Number(coachObs);
    var o = {};
    if (pain >= 6 || fatigue >= 8) {
      o.state = '優先關注';
      o.observation = '近期身體恢復狀況較不足' + (pain >= 6 ? '，疼痛回報達 ' + pain + '/10' : '') + (fatigue >= 8 ? '，疲勞偏高' : '') + '。先把身體照顧好，表現才走得遠。';
      o.goal = (sleep != null && sleep < 7) ? '本週睡眠平均達 7 小時以上' : '本週安排 2 次恢復訓練或完整伸展';
      o.reminder = '優先安排恢復、適度調整訓練量，避免疲勞累積影響表現。';
      o.motivation = '穩定比爆發更重要。';
    } else if (coach != null && self > 0 && Math.abs(self - coach) >= 2) {
      o.state = '需要調整';
      o.observation = '近期自我感受與實際表現存在一些差異（選手自評 ' + self.toFixed(1) + '、教練觀察 ' + coach + '）。這不是對錯問題，而是校正觀察角度的好時機。';
      o.goal = '本週用影片回看或訓練紀錄，做 2 次自評對照校正';
      o.reminder = '透過客觀紀錄校正，未來能更精準掌握自身狀態。';
      o.motivation = '專注當下每一次修正。';
    } else if (kpi >= 4 && rep7 >= 2) {
      o.state = '穩定成長';
      var wd = worstDim(rec) || '動作細節';
      o.observation = '整體狀態維持良好，基礎能力已具備競爭力。接下來把重點放在動作細節與穩定度。';
      o.goal = '本週每次訓練針對「' + wd + '」做 1 個細節修正';
      o.reminder = '不需大改，每一次小修正都是邁向更高層級的一步。';
      o.motivation = '專注當下每一次修正。';
    } else if (kpi >= 3 || (rep7 >= 2 && !reportingDrop)) {
      o.state = '持續累積';
      o.observation = '近期訓練投入度逐漸提升，方向是對的。保持目前節奏，進步會更明顯。';
      o.goal = '本週增加 1 次自主訓練';
      o.reminder = '持續比一次到位更重要，維持節奏就會看到變化。';
      o.motivation = '今天的累積，會成為明天的實力。';
    } else {
      o.state = '需要調整';
      o.observation = '最近訓練參與度較低，先不用追求完美。把目標拆小，完成比完美更重要。';
      o.goal = '本週完成 3 次訓練與 1 次自主練習';
      o.reminder = '先求有、再求好；每完成一次就是一次前進。';
      o.motivation = '每一次練習，都在縮短與目標的距離。';
    }
    // 非受傷模式下，若有更急的可量化生理缺口，優先設為本週目標
    if (o.state !== '優先關注') {
      if (sleep != null && sleep < 7) o.goal = '本週睡眠平均達 7 小時以上';
      else if (hydrationBad) o.goal = '本週每日飲水達 2000ml 以上';
    }
    return o;
  }
  function goalCoachText(o) {
    return '成長狀態：' + o.state + '\n本週觀察：' + o.observation + '\n本週目標：' + o.goal + '\n教練提醒：' + o.reminder + '\n激勵語：' + o.motivation;
  }
  function renderGoalCoach(o) {
    var cls = o.state === '穩定成長' ? 'green' : o.state === '持續累積' ? 'brand' : o.state === '需要調整' ? 'yellow' : 'red';
    $('#goalCoachOut').innerHTML =
      '<div class="goal-card">' +
        '<div class="goal-state goal-' + cls + '">' + esc(o.state) + '</div>' +
        '<div class="goal-row"><span class="goal-k">本週觀察</span><span>' + esc(o.observation) + '</span></div>' +
        '<div class="goal-row goal-target"><span class="goal-k">🎯 本週目標</span><span>' + esc(o.goal) + '</span></div>' +
        '<div class="goal-row"><span class="goal-k">教練提醒</span><span>' + esc(o.reminder) + '</span></div>' +
        '<div class="goal-mot">「' + esc(o.motivation) + '」</div>' +
        '<div class="goal-actions"><button class="btn btn-sm" id="goalCopy">複製</button>' +
          '<button class="btn btn-sm" id="goalApply">帶入回饋草稿</button></div>' +
      '</div>';
    $('#goalCopy').onclick = function () { TP.copy(goalCoachText(o)); };
    $('#goalApply').onclick = function () {
      $('#fbText').value = '本週觀察：' + o.observation + '\n本週目標：' + o.goal + '\n教練提醒：' + o.reminder;
      var t = $('#fbText'); t.classList.remove('ai-fade'); void t.offsetWidth; t.classList.add('ai-fade');
      $('#aiDraftBadge').classList.remove('hidden');
    };
  }

  async function openFeedback(athleteId, name, recordId) {
    fbCtx = { recordId: recordId || '', record: null, records: [], coachObs: '' };
    $('#fbTitle').textContent = '回饋給 ' + name;
    $('#fbMeta').textContent = '—…';
    $('#fbDetail').innerHTML = ''; $('#fbText').value = ''; $('#goalCoachOut').innerHTML = ''; $('#riskForecast').innerHTML = ''; setCoachObs('');
    $('#fbModal').classList.remove('hidden');
    // 取該選手紀錄；示範模式用合成的 28 天歷史展示 AI 風險預測（送出時才提示註冊）
    var rec = null, recList = [];
    if (DEMO) {
      var ds = DEMO_DATA.warroom.submitted.filter(function (x) { return x.athleteId === athleteId; })[0] || { athleteId: athleteId, name: name, totalScore: 3.8 };
      recList = demoRecordsFor(ds);
      rec = recList[recList.length - 1];
    } else {
      var r = await TP.callAuth('athleteRecords', { athleteId: athleteId, limit: 30 });
      if (r.ok && r.records.length) rec = recordId ? (r.records.filter(function (x) { return x.recordId === recordId; })[0] || r.records[0]) : r.records[0];
      if (!rec) { $('#fbMeta').textContent = '查無紀錄'; return; }
      recList = r.records || [];
    }
    fbCtx.record = rec; fbCtx.recordId = rec.recordId || recordId; fbCtx.records = recList; fbCtx.name = name;
    renderRiskForecast(fbCtx.records);
    setCoachObs(rec.coachObservation || '');
    var light = rec.status || TP.lightOf(rec.totalScore);
    $('#fbMeta').innerHTML = esc(rec.date) + (Number(rec.totalScore) > 0 ? '　最近狀態 <b>' + Number(rec.totalScore).toFixed(1) + '</b>' : '　今日輕量回報') + ' <span class="pill ' + light + '">' + TP.lightText(light) + '</span>';
    var bits = [];
    if (rec.fatigue) bits.push('疲勞 ' + rec.fatigue + '/10');
    if (rec.sleepDurationText || rec.sleepHours) bits.push('睡眠 ' + (rec.sleepDurationText || rec.sleepHours + 'h'));
    if (Number(rec.painScore) > 0) bits.push('疼痛 ' + rec.painScore + '/10 ' + (rec.painAreas || ''));
    else if (rec.injuryAreas && rec.injuryAreas !== '無受傷') bits.push('傷:' + rec.injuryAreas);
    if (rec.hydrationRisk && rec.hydrationRisk !== 'green') bits.push('水分' + TP.lightText(rec.hydrationRisk));
    if (rec.reportQualityLabel && rec.reportQualityLabel !== '正常') bits.push('可信度:' + rec.reportQualityLabel);
    if (rec.trainingNotes) bits.push('心得:' + rec.trainingNotes);
    $('#fbDetail').innerHTML = bits.length ? '<span class="muted">' + esc(bits.join('　')) + '</span>' : '';
    $('#fbText').value = rec.coachComment || '';
    $('#aiDraftBadge').classList.add('hidden');
    // 渲染 AI 模組按鈕
    $('#aiModules').innerHTML = '';
    AI_MODULES.forEach(function (m) {
      var b = TP.el('button', {}, esc(m.key));
      b.onclick = function () {
        if (b.disabled) return;
        var orig = b.textContent;
        b.disabled = true; b.textContent = '✨ 生成中…';
        setTimeout(function () {
          var t = $('#fbText');
          t.value = m.build(rec, name);
          t.classList.remove('ai-fade'); void t.offsetWidth; t.classList.add('ai-fade');
          $('#aiDraftBadge').classList.remove('hidden');
          b.disabled = false; b.textContent = orig;
        }, 240);
      };
      $('#aiModules').appendChild(b);
    });
  }

  function setCoachObs(v) {
    fbCtx.coachObs = (v == null ? '' : String(v));
    TP.$all('#coachObsBtns button').forEach(function (b) {
      b.classList.toggle('sel', b.dataset.obs !== '' && b.dataset.obs === fbCtx.coachObs);
    });
  }
  TP.$all('#coachObsBtns button').forEach(function (b) {
    b.onclick = function () { setCoachObs(b.dataset.obs); };
  });

  $('#goalGenBtn').onclick = function () {
    if (!fbCtx.record) { toast('尚未載入選手資料', true); return; }
    var b = this;
    b.disabled = true; b.textContent = '✨ 分析中…';
    setTimeout(function () {
      renderGoalCoach(goalCoach(fbCtx.record, fbCtx.records, fbCtx.coachObs));
      b.disabled = false; b.textContent = '重新生成';
    }, 260);
  };
  $('#fbText').addEventListener('input', function () { $('#aiDraftBadge').classList.add('hidden'); });
  $('#fbClose').onclick = function () { $('#fbModal').classList.add('hidden'); };
  $('#fbModal').onclick = function (e) { if (e.target === $('#fbModal')) $('#fbModal').classList.add('hidden'); };
  // 真 AI 生成（路線 B）：把該選手實際數據＋風險引擎結果交給後端 Claude 生成回饋草稿
  $('#aiRealGen').onclick = async function () {
    if (DEMO) { demoBlock(); return; }
    if (!fbCtx.record) { toast('尚未載入選手資料', true); return; }
    var btn = this, orig = btn.textContent;
    btn.disabled = true; btn.textContent = '✨ AI 生成中…';
    var rec = fbCtx.record, rk = riskEngine(fbCtx.records || []);
    var payload = {
      athleteName: fbCtx.name || '這位選手',
      record: {
        date: rec.date, totalScore: rec.totalScore, fatigue: rec.fatigue,
        sleep: rec.sleepDurationText || (rec.sleepHours ? rec.sleepHours + ' 小時' : ''),
        painScore: rec.painScore, painAreas: rec.painAreas || rec.injuryAreas,
        hydrationRisk: rec.hydrationRisk, trainingNotes: rec.trainingNotes, reflection: rec.reflection
      },
      risk: (rk && !rk.insufficient) ? {
        score: rk.risk, light: rk.light,
        reasons: rk.reasons.slice(0, 4).map(function (x) { return x.t; }), action: rk.action
      } : null
    };
    var r = await TP.callAuth('aiCoachDraft', payload);
    btn.disabled = false; btn.textContent = orig;
    if (!r || !r.ok) { toast((r && r.error) || 'AI 生成失敗，可改用下方範本', true); return; }
    var t = $('#fbText');
    t.value = r.draft;
    t.classList.remove('ai-fade'); void t.offsetWidth; t.classList.add('ai-fade');
    $('#aiDraftBadge').classList.remove('hidden');
  };

  $('#fbSend').onclick = async function () {
    if (DEMO) { demoBlock(); return; }
    if (!fbCtx.recordId) { toast('找不到紀錄 id（可能是舊資料）', true); return; }
    var btn = this; btn.disabled = true;
    var r = await TP.callAuth('coachFeedback', { recordId: fbCtx.recordId, feedback: $('#fbText').value.trim(), coachObservation: fbCtx.coachObs || '' });
    btn.disabled = false;
    if (r.ok) { toast('已送出回饋'); $('#fbModal').classList.add('hidden'); localStorage.removeItem(warroomCacheKey()); await loadWarroom(); }
    else { toast(r.error, true); }
  };

  /* ---------- 個資請求 ---------- */
  var privacyTypeLabels = { hide_record: '隱藏紀錄', delete_record: '刪除紀錄', correct_data: '更正資料', stop_use: '停止使用' };
  var privacyStatusLabels = { pending: '待處理', handled: '已處理', rejected: '已駁回' };

  async function loadPrivacyRequests() {
    if (DEMO || !TP.getToken()) return;
    if (dataLoaded.privacy) return;
    var box = $('#privacyRequestList');
    if (!box) return;
    var r = await TP.callAuth('listPrivacyRequests');
    if (!r.ok) { box.innerHTML = '<span class="muted">' + esc(r.error || '載入失敗') + '</span>'; return; }
    dataLoaded.privacy = true;
    var rows = r.requests || [];
    if (!rows.length) { box.innerHTML = '<span class="muted">目前沒有個資請求。</span>'; return; }
    box.innerHTML = rows.map(function (item) {
      var pending = String(item.status) === 'pending';
      return '<div class="row" style="align-items:flex-start;gap:12px;border-top:1px solid var(--line);padding:12px 0;">' +
        '<div style="flex:1;min-width:220px;"><b>' + esc(item.athleteName) + '</b> · ' + esc(privacyTypeLabels[item.requestType] || item.requestType) +
        ' <span class="pill ' + (pending ? 'yellow' : (item.status === 'handled' ? 'green' : 'red')) + '">' + esc(privacyStatusLabels[item.status] || item.status) + '</span>' +
        '<div class="muted" style="font-size:13px;margin-top:4px;">範圍：' + esc(item.scope) + ' · 建立：' + esc(String(item.createdAt || '').slice(0, 10)) + '</div>' +
        (item.note ? '<div style="font-size:13px;margin-top:4px;">說明：' + esc(item.note) + '</div>' : '') +
        (item.resolutionNote ? '<div style="font-size:13px;margin-top:4px;">處理結果：' + esc(item.resolutionNote) + '</div>' : '') + '</div>' +
        (pending ? '<div><button class="btn btn-sm" data-pr-resolve="' + item.requestId + '" data-pr-status="handled">處理完成</button> ' +
          '<button class="btn btn-sm btn-ghost" data-pr-resolve="' + item.requestId + '" data-pr-status="rejected">駁回</button></div>' : '') + '</div>';
    }).join('');
    TP.$all('[data-pr-resolve]', box).forEach(function (b) {
      b.onclick = async function () {
        var label = b.dataset.prStatus === 'handled' ? '處理說明' : '駁回原因';
        var note = prompt('請填寫' + label + '：');
        if (note === null) return;
        note = note.trim();
        if (!note) { toast('請填寫' + label, true); return; }
        var rr = await TP.callAuth('resolvePrivacyRequest', { requestId: b.dataset.prResolve, status: b.dataset.prStatus, resolutionNote: note });
        if (rr.ok) { toast('個資請求已結案'); dataLoaded.privacy = false; loadPrivacyRequests(); } else { toast(rr.error, true); }
      };
    });
  }

  $('#btnCreatePrivacy').onclick = async function () {
    if (DEMO) { demoBlock(); return; }
    var athleteId = $('#prAthlete').value, scope = $('#prScope').value.trim();
    if (!athleteId) { toast('請先建立或選擇選手', true); return; }
    if (!scope) { toast('請填寫資料範圍', true); return; }
    var r = await TP.callAuth('createPrivacyRequest', {
      athleteId: athleteId, requestType: $('#prType').value, scope: scope, note: $('#prNote').value.trim()
    });
    if (r.ok) {
      $('#prScope').value = ''; $('#prNote').value = '';
      toast('已建立個資請求'); dataLoaded.privacy = false; loadPrivacyRequests();
    } else { toast(r.error, true); }
  };

  /* ---------- 帳號設定 ---------- */
  $('#btnSaveName').onclick = async function () {
    if (DEMO) { demoBlock(); return; }
    var name = $('#setName').value.trim();
    if (!name) { toast('請輸入姓名', true); return; }
    var r = await TP.callAuth('updateProfile', { name: name });
    if (r.ok) {
      state.coach = r.coach;
      $('#coachName').textContent = state.coach.name + '（' + state.coach.email + '）';
      toast('已更新名稱');
    } else { toast(r.message || r.error, true); }
  };

  $('#btnChangePw').onclick = async function () {
    if (DEMO) { demoBlock(); return; }
    var cur = $('#pwCurrent').value, n1 = $('#pwNew').value, n2 = $('#pwNew2').value;
    if (!cur || !n1) { toast('請輸入目前密碼與新密碼', true); return; }
    if (n1.length < 6) { toast('新密碼至少 6 碼', true); return; }
    if (n1 !== n2) { toast('兩次新密碼不一致', true); return; }
    var r = await TP.callAuth('changePassword', { currentPassword: cur, newPassword: n1 });
    if (r.ok) {
      $('#pwCurrent').value = ''; $('#pwNew').value = ''; $('#pwNew2').value = '';
      toast('密碼已更新');
    } else { toast(r.message || r.error, true); }
  };

  /* ---------- 設定 ---------- */
  $('#setUrlSave').onclick = function () { TP.setUrl($('#setUrl').value); toast('已儲存，重新整理生效'); };
  $('#kpiVersion').onchange = async function () {
    if (DEMO) { $('#kpiVersion').value = 'v1'; demoBlock(); return; }
    var v = $('#kpiVersion').value === 'v2' ? 'v2' : 'v1';
    await saveCoachSettings({ kpiVersion: v });
    $('#kpiCadenceWrap').classList.toggle('hidden', v === 'v2');
    toast(v === 'v2' ? '已切換為新版 15 題錨點（選手今天起每天填）' : '已切回經典 30 題');
    if (!$('#tab-warroom').classList.contains('hidden')) loadWarroom();
  };
  $('#kpiCadence').onchange = async function () {
    if (DEMO) { $('#kpiCadence').value = 'weekly'; demoBlock(); return; }
    var v = $('#kpiCadence').value === 'daily' ? 'daily' : 'weekly';
    await saveCoachSettings({ kpiCadence: v });
    toast(v === 'daily' ? '已切換為每天回報，選手今天起每天可填' : '已切換為每週狀態');
    if (typeof loadWarroom === 'function' && !$('#tab-warroom').classList.contains('hidden')) loadWarroom();
  };
  $('#setLineCopy').onclick = function () { TP.copy(TP.getLineUrl()); };
  $('#setLineOpen').onclick = function (e) {
    if (!TP.getLineUrl()) { e.preventDefault(); toast('尚未設定官方 LINE 連結', true); }
  };
  $('#btnSaveKpi').onclick = function () {
    if (!planCfg().customKpi) { openUpgradeModal({ reason: 'customKpi', message: '團隊版以上才可自訂 KPI 題目。' }); return; }
    localStorage.setItem(coachLS('custom_kpi'), $('#customKpiText').value.trim());
    toast('KPI 題目已儲存');
  };
  var KPI_TEMPLATES = {
    wushu_taolu: ['動作規格', '編排節奏', '體能爆發', '臨場穩定', '訓練投入', '恢復狀態'],
    wushu_sanda: ['拳腿技術', '距離戰術', '體能抗打', '抗壓膽識', '訓練投入', '降重恢復'],
    'default': ['技術執行', '戰術理解', '體能負荷', '心理狀態', '訓練態度', '生理恢復']
  };
  TP.$all('[data-kpitpl]').forEach(function (b) {
    b.onclick = function () {
      if (!planCfg().customKpi) { openUpgradeModal({ reason: 'customKpi', message: '團隊版以上才可自訂 KPI 題目。' }); return; }
      $('#customKpiText').value = KPI_TEMPLATES[b.dataset.kpitpl].join('、');
      toast('已帶入範本，確認後按「儲存 KPI 題目」');
    };
  });
  $('#btnHideOnboard').onclick = function () {
    localStorage.setItem(coachLS('onboard_hidden'), '1');
    $('#onboardWrap').classList.add('hidden');
  };
  $('#upLater').onclick = closeUpgradeModal;
  $('#upgradeModal').onclick = function (e) { if (e.target === $('#upgradeModal')) closeUpgradeModal(); };

  /* ============================================================
     示範模式（demo=1）：免註冊、唯讀、塞範例資料
     ============================================================ */
  function demoBlock() { toast('這是示範模式，免費註冊後即可實際操作 🙂'); }

  /* Demo 用：替每位示範選手合成 28 天訓練歷史，讓 AI 傷害風險預測在示範模式也能完整展示。
     劇本對應戰情室既有情境：d8 急性踝傷、d3/d12 過度訓練、d13 睡眠債、d2 中度疼痛。 */
  var DEMO_RISK_STORY = { d8: 'injury', d3: 'overload', d12: 'overload', d13: 'sleep', d2: 'pain' };
  function dr1(n) { return Math.round(n * 10) / 10; }
  function demoRecordsFor(s) {
    s = s || {};
    var story = DEMO_RISK_STORY[s.athleteId] || 'stable';
    var todayScore = Number(s.totalScore) || 3.8, out = [], base = new Date();
    for (var i = 27; i >= 0; i--) {
      var d = new Date(base.getTime()); d.setDate(d.getDate() - i);
      var ds = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      var rest = d.getDay() === 0, ago = i;
      var rec = {
        date: ds, sessionType: rest ? 'rest' : 'training',
        trainingAM: rest ? '無訓練' : '晨操', trainingPM: rest ? '無訓練' : '專項', trainingEve: '',
        fatigue: rest ? 3 : 5, sleepDurationMinutes: 450, painScore: 0, injuryAreas: '無受傷',
        totalScore: dr1(todayScore + Math.sin(i) * 0.15)
      };
      if (story === 'injury') {
        var ramp = [8, 6, 4, 3, 2];
        if (ago <= 4) rec.painScore = ramp[ago];
        if (ago <= 1) rec.injuryAreas = '腳踝';
        if (ago <= 2) rec.sleepDurationMinutes = 300;
        if (ago <= 4) rec.totalScore = dr1(3.4 - (4 - ago) * 0.15);
      } else if (story === 'overload') {
        if (ago <= 7 && !rest) { rec.trainingEve = '實戰'; rec.fatigue = 9; rec.sleepDurationMinutes = 330; }
        if (ago <= 7) rec.totalScore = dr1(4.0 - (7 - ago) * 0.06);
      } else if (story === 'sleep') {
        rec.sleepDurationMinutes = rest ? 380 : 315;
        // 前期維持平時水準、近 7 天明顯下滑 → 製造「低於自己基線」的個人化異常
        rec.totalScore = ago > 6 ? dr1(3.5 + Math.sin(i) * 0.1) : dr1(3.3 - (6 - ago) * 0.13);
      } else if (story === 'pain') {
        if (ago <= 3) rec.painScore = 5;
        if (ago === 0) rec.injuryAreas = '右膝';
      }
      out.push(rec);
    }
    // 最後一天對齊戰情室今日快照（疼痛/睡眠/分數），讓 demo 前後一致
    var last = out[out.length - 1];
    if (s.painScore != null && s.painScore !== '') last.painScore = Number(s.painScore);
    if (s.painAreas) { last.painAreas = s.painAreas; if (Number(last.painScore) > 0) last.injuryAreas = s.painAreas; }
    if (Number(s.sleepDurationMinutes) > 0) last.sleepDurationMinutes = Number(s.sleepDurationMinutes);
    if (s.sleepDurationText) last.sleepDurationText = s.sleepDurationText;
    last.totalScore = todayScore;
    last.status = s.status || TP.lightOf(todayScore);
    last.recordId = 'demo-' + (s.athleteId || 'x');
    return out;
  }

  var DEMO_DATA = {
    coach: { name: '示範教練', email: 'demo', plan: 'pro', effectivePlan: 'pro',
             planName: '專業版', maxAthletes: 100, activeAthletes: 15, planExpiry: '', expired: false },
    teams: [
      { teamId: 'demoA', coachId: 'demo', teamName: '飛鷹競技隊', sport: '跆拳道', shareToken: 'demo-a', status: 'active' },
      { teamId: 'demoB', coachId: 'demo', teamName: '飛鷹培訓隊', sport: '跆拳道', shareToken: 'demo-b', status: 'active' }
    ],
    athletes: [
      { athleteId: 'd1', teamId: 'demoA', name: '陳柏宇', gradeClass: '八年級', active: true },
      { athleteId: 'd2', teamId: 'demoA', name: '林冠廷', gradeClass: '八年級', active: true },
      { athleteId: 'd3', teamId: 'demoA', name: '黃于軒', gradeClass: '九年級', active: true },
      { athleteId: 'd4', teamId: 'demoA', name: '張承恩', gradeClass: '九年級', active: true },
      { athleteId: 'd5', teamId: 'demoA', name: '吳宥辰', gradeClass: '七年級', active: true },
      { athleteId: 'd6', teamId: 'demoA', name: '李芷瑄', gradeClass: '八年級', active: true },
      { athleteId: 'd7', teamId: 'demoA', name: '王思妤', gradeClass: '九年級', active: true },
      { athleteId: 'd8', teamId: 'demoA', name: '蔡承翰', gradeClass: '七年級', active: true },
      { athleteId: 'd9', teamId: 'demoB', name: '周子晴', gradeClass: '七年級', active: true },
      { athleteId: 'd10', teamId: 'demoB', name: '許哲維', gradeClass: '八年級', active: true },
      { athleteId: 'd11', teamId: 'demoB', name: '郭庭瑄', gradeClass: '七年級', active: true },
      { athleteId: 'd12', teamId: 'demoB', name: '鄭宇翔', gradeClass: '九年級', active: true },
      { athleteId: 'd13', teamId: 'demoB', name: '何品妤', gradeClass: '八年級', active: true },
      { athleteId: 'd14', teamId: 'demoB', name: '羅冠宇', gradeClass: '七年級', active: true },
      { athleteId: 'd15', teamId: 'demoB', name: '謝語恩', gradeClass: '九年級', active: true }
    ],
    warroom: {
      ok: true, date: localToday(),
      total: 15, submittedCount: 11, missingCount: 4, completionRate: 73,
      lights: { green: 5, yellow: 4, red: 2 },
      submitted: [
        { athleteId: 'd1', name: '陳柏宇', totalScore: 4.7, status: 'green', sleepDurationMinutes:460, sleepDurationText:'7 小時 40 分', sleepRisk:'green', painScore:0, painRisk:'green', waterAmount:'enough', sweatAmount:'normal', urineColor:'pale_yellow', hydrationRisk:'green', reportQualityScore:92, reportQualityLabel:'正常', coachSuggestion:'今日狀態穩定，可依原定計畫訓練並持續觀察。', coachFeedback:'狀態穩定，維持原定訓練節奏。', coachFeedbackAt:localToday()+'T08:20:00', coachReplyStatus:'replied' },
        { athleteId: 'd2', name: '林冠廷', totalScore: 4.5, status: 'yellow', sleepDurationMinutes:380, sleepDurationText:'6 小時 20 分', sleepRisk:'yellow', painAreas:'右膝', painScore:5, painRisk:'yellow', waterAmount:'normal', sweatAmount:'high', urineColor:'dark', hydrationRisk:'yellow', hydrationFlags:'dark_urine,high_sweat_low_water', hydrationAdvice:'今日訓練前後加強補水。', reportQualityScore:88, reportQualityLabel:'正常', coachSuggestion:'今日降低高衝擊與疼痛部位負荷，訓練中持續觀察。' },
        { athleteId: 'd7', name: '王思妤', totalScore: 4.4, status: 'green' },
        { athleteId: 'd9', name: '周子晴', totalScore: 4.3, status: 'green', coachFeedback:'回報完整，明天持續觀察睡眠。', coachFeedbackAt:localToday()+'T08:35:00', coachReplyStatus:'replied' },
        { athleteId: 'd10', name: '許哲維', totalScore: 4.2, status: 'green' },
        { athleteId: 'd11', name: '郭庭瑄', totalScore: 4.0, status: 'green' },
        { athleteId: 'd3', name: '黃于軒', totalScore: 3.7, status: 'yellow', declining: true },
        { athleteId: 'd5', name: '吳宥辰', totalScore: 3.4, status: 'yellow' },
        { athleteId: 'd12', name: '鄭宇翔', totalScore: 3.1, status: 'yellow', declining: true },
        { athleteId: 'd8', name: '蔡承翰', totalScore: 2.7, status: 'red', sleepDurationMinutes:280, sleepDurationText:'4 小時 40 分', sleepRisk:'red', painAreas:'腳踝', painScore:8, painRisk:'red', waterAmount:'very_little', sweatAmount:'very_high', urineColor:'abnormal', hydrationRisk:'red', hydrationFlags:'abnormal_urine,high_sweat_low_water', reportQualityScore:55, reportQualityLabel:'疑似敷衍', reportQualityReasons:'心得過短、高疼痛但狀態分數過高', coachSuggestion:'建議停止專項訓練，立即確認疼痛並通知教練／家長。' },
        { athleteId: 'd13', name: '何品妤', totalScore: 2.5, status: 'red', sleepDurationMinutes:330, sleepDurationText:'5 小時 30 分', sleepRisk:'yellow', painScore:0, painRisk:'green', waterAmount:'normal', sweatAmount:'high', urineColor:'dark', hydrationRisk:'red', hydrationFlags:'dark_urine,consecutive_dark', reportQualityScore:70, reportQualityLabel:'需確認', reportQualityReasons:'KPI 與昨日高度相同', coachSuggestion:'水分狀態需立即確認並加強補水。' }
      ],
      missing: [ { athleteId: 'd4', name: '張承恩' }, { athleteId: 'd6', name: '李芷瑄' }, { athleteId: 'd14', name: '羅冠宇' }, { athleteId: 'd15', name: '謝語恩' } ],
      priority: {
        red: [ { name: '蔡承翰' }, { name: '何品妤' } ],
        missing: [ { name: '張承恩' }, { name: '李芷瑄' }, { name: '羅冠宇' }, { name: '謝語恩' } ],
        declining: [ { name: '黃于軒' }, { name: '鄭宇翔' } ],
        encouraging: [ { name: '陳柏宇' }, { name: '王思妤' }, { name: '周子晴' } ]
      },
      encourages: [
        { from: '陳柏宇', to: '蔡承翰', msg: '今天實戰很拚，下次一定更好！' },
        { from: '王思妤', to: '吳宥辰', msg: '你的踢靶很有力，繼續加油！' }
      ]
    },
    teamReport: {
      ok: true, athleteCount: 15, teamAvg: 3.7, completionRate: 81, totalReports: 170, expectedReports: 210,
      dimAvg: { technicalAvg: 3.8, tacticalAvg: 3.5, physicalAvg: 4.0, mentalAvg: 3.4, attitudeAvg: 4.2, physiologicalAvg: 3.3 },
      lights: { green: 48, yellow: 32, red: 12 },
      trend: [ { avg: 3.3 }, { avg: 3.4 }, { avg: 3.5 }, { avg: 3.6 }, { avg: 3.5 }, { avg: 3.8 }, { avg: 3.9 } ],
      athletes: [
        { name: '陳柏宇', filledDays: 13, avgTotal: 4.4, delta: 0.6, lastStatus: 'green' },
        { name: '林冠廷', filledDays: 12, avgTotal: 4.1, delta: 0.3, lastStatus: 'green' },
        { name: '王思妤', filledDays: 14, avgTotal: 3.9, delta: 0.4, lastStatus: 'green' },
        { name: '黃于軒', filledDays: 11, avgTotal: 3.6, delta: 0.1, lastStatus: 'yellow' },
        { name: '吳宥辰', filledDays: 10, avgTotal: 3.4, delta: -0.2, lastStatus: 'yellow' },
        { name: '蔡承翰', filledDays: 9, avgTotal: 2.8, delta: -0.4, lastStatus: 'red' },
        { name: '何品妤', filledDays: 8, avgTotal: 2.7, delta: -0.5, lastStatus: 'red' }
      ]
    },
    trialSummary: {
      visible: true, athleteCount: 15, reportCount: 34, redAthleteCount: 3,
      parentNotificationCount: 11, estimatedMinutes: 68,
      upgradeMessage: '三天內你已經掌握整隊重點。升級教練版，每月 299 元，持續使用家長通知、歷史趨勢與成果報告。'
    }
  };

  // 為個人報告產生一段有上升趨勢的範例紀錄
  function demoRecords(range) {
    var out = [], base = 3.0;
    for (var i = 0; i < 12; i++) {
      var d = new Date(); d.setDate(d.getDate() - (11 - i));
      var v = Math.min(5, +(base + i * 0.12 + (i % 3 === 0 ? 0.2 : 0)).toFixed(1));
      var amOpts = ['熱身慢跑 15 分鐘＋動態伸展，基本步法與位移', '核心肌群訓練、平衡墊穩定度', '柔軟度與關節活動，技術分解動作'];
      var pmOpts = ['橫踢、下壓踢靶 10 組，實戰對打 3 回合', '速度與爆發力課表：跳箱、衝刺 8 趟', '戰術情境演練與計分對練'];
      var eveOpts = ['伸展放鬆、滾筒按摩，今日影像複盤', '自主重量訓練（下肢）', '休息恢復，補充水分與蛋白質'];
      var noteOpts = ['踢擊速度有進步，左側防守仍需加強。', '今日體能稍累但完成全部課表。', '對打節奏掌握不錯，下次加強反擊時機。'];
      out.push({
        date: d.toISOString().slice(0, 10), totalScore: v, status: TP.lightOf(v),
        technicalAvg: v, tacticalAvg: Math.max(1, v - 0.3), physicalAvg: Math.min(5, v + 0.2),
        mentalAvg: Math.max(1, v - 0.4), attitudeAvg: Math.min(5, v + 0.3), physiologicalAvg: Math.max(1, v - 0.2),
        moodIndex: Math.min(5, Math.round(v)),
        trainingAM: amOpts[i % 3], trainingPM: pmOpts[i % 3], trainingEve: eveOpts[i % 3],
        trainingNotes: noteOpts[i % 3], sleepHours: 7 + (i % 3) * 0.5, fatigue: ['輕度', '中度', '輕度'][i % 3],
        injuryAreas: i % 4 === 0 ? '右腳踝輕微痠痛' : '無受傷'
      });
    }
    return out;
  }

  function enterDemo() {
    authView.classList.add('hidden'); appView.classList.remove('hidden');
    // 示範橫幅
    var banner = TP.el('div', { class: 'plan-banner', style: 'border-color:var(--brand);background:rgba(34,197,94,.08);' });
    banner.innerHTML = '<div>🔍 <b>示範模式</b>　你看到的是範例資料，所有操作不會儲存。</div>' +
      '<a class="btn btn-primary btn-sm" href="app.html?signup=1">免費建立我的隊伍 →</a>';
    appView.insertBefore(banner, appView.querySelector('.plan-banner'));

    state.coach = DEMO_DATA.coach;
    state.teams = DEMO_DATA.teams;
    state.athletes = DEMO_DATA.athletes;
    $('#coachName').textContent = '示範教練（示範模式）';
    $('#btnLogout').textContent = '結束示範';
    renderPlan();
    $('#warDate').value = localToday();

    var teamOpts = '<option value="">全部團隊</option>' + state.teams.map(function (t) {
      return '<option value="' + t.teamId + '">' + esc(t.teamName) + '</option>'; }).join('');
    $('#warTeam').innerHTML = teamOpts;
    $('#rpTeam').innerHTML = teamOpts;
    $('#naTeam').innerHTML = state.teams.map(function (t) { return '<option value="' + t.teamId + '">' + esc(t.teamName) + '</option>'; }).join('');
    fillReportAthletes();
    renderTeams();
    renderAthletes();
    renderWarroom(DEMO_DATA.warroom);
    renderTrialSummary(DEMO_DATA.trialSummary);
  }

  /* ========================================================
     📋 快速點名中心（點名存後端同步；課程清單存本機；與戰情室互通）
     ======================================================== */
  var ATT_LIST = [['present', '出席'], ['late', '遲到'], ['early_leave', '早退'], ['official_leave', '公假'], ['personal_leave', '事假'], ['sick_leave', '病假'], ['absent', '未到'], ['not_required', '不需出席']];
  var ATT_S7 = { present: '✅', late: '🟡', early_leave: '↩️', official_leave: '🏛️', personal_leave: '📝', sick_leave: '🤒', absent: '⚫', not_required: '－' };
  var ATT_SESSIONS = ['晨操', '上午訓練', '下午訓練', '晚上道館', '暑期輔導', '專長訓練', '比賽', '移地訓練', '自訂'];
  var atState = { teamId: '', date: '', sessionId: '', sessionName: '上午訓練', startTime: '09:30', endTime: '11:30', marks: {}, roster: [], wById: {}, missingSet: {}, history: [], sessions: [], filter: 'all', touched: {}, dirty: false, lineText: '', view: localStorage.getItem('teampro_att_view') || 'list' };

  function attLabel(s) { for (var i = 0; i < ATT_LIST.length; i++) if (ATT_LIST[i][0] === s) return ATT_LIST[i][1]; return '出席'; }
  function attDaysAgo(n) { var d = new Date(); d.setDate(d.getDate() - n); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
  function attMin(m) { m = Number(m) || 0; return Math.floor(m / 60) + ' 小時 ' + (m % 60) + ' 分'; }

  function attConsecutiveAbsent(aid) {
    var n = 0;
    for (var i = 0; i <= 6; i++) {
      var dt = attDaysAgo(i);
      var m = dt === atState.date ? atState.marks[aid] : (atState.history.filter(function (r) { return String(r.date) === dt; })[0] || { marks: {} }).marks[aid];
      if (m && m.s === 'absent') n++; else if (m) break; else break;
    }
    return n;
  }

  function attFlags(a) {
    var w = atState.wById[a.athleteId], f = [];
    if (atState.missingSet[a.athleteId] && !w) f.push({ icon: '⚠️', why: '今日未回報' });
    if (w) {
      if (Number(w.sleepDurationMinutes) > 0 && Number(w.sleepDurationMinutes) < 300) f.push({ icon: '💤', why: '睡眠 ' + attMin(w.sleepDurationMinutes) });
      if (Number(w.painScore) >= 4) f.push({ icon: '🩹', why: '疼痛 ' + w.painScore + ' 分' + (w.painAreas ? '（' + w.painAreas + '）' : '') });
      if (w.hydrationRisk === 'red' || w.waterAmount === 'very_little') f.push({ icon: '💧', why: '飲水不足' });
      if (w.urineColor === 'dark' || w.urineColor === 'abnormal') f.push({ icon: '🟡', why: '尿液偏深' });
      if (Number(w.moodIndex) > 0 && Number(w.moodIndex) <= 2) f.push({ icon: '😔', why: '心理低落' });
    }
    if (attConsecutiveAbsent(a.athleteId) >= 2) f.push({ icon: '🚫', why: '連續缺席' });
    return f;
  }

  function attLight(a) {
    if (((atState.marks[a.athleteId] || {}).s) === 'absent') return '⚫';
    var w = atState.wById[a.athleteId];
    var health = attFlags(a).filter(function (x) { return x.icon !== '🚫'; });
    if (w && (Number(w.painScore) >= 7 || w.painImpact === 'cannot_sport' || w.painImpact === 'daily_affected')) return '🔴';
    if (w && w.status === 'red' && health.length >= 2) return '🔴';
    if (health.length >= 2 || (w && w.status === 'red')) return '🟠';
    if (health.length >= 1 || (w && w.status === 'yellow')) return '🟡';
    if (!w) return '🟡';
    return '🟢';
  }

  function att7day(a) {
    var out = '';
    for (var i = 6; i >= 0; i--) {
      var dt = attDaysAgo(i);
      var m = dt === atState.date ? atState.marks[a.athleteId] : (atState.history.filter(function (r) { return String(r.date) === dt; })[0] || { marks: {} }).marks[a.athleteId];
      out += m ? (ATT_S7[m.s] || '·') : '·';
    }
    return out;
  }

  async function loadAttendance() {
    var teamSel = $('#atTeam');
    teamSel.innerHTML = (state.teams || []).map(function (t) { return '<option value="' + t.teamId + '">' + esc(t.teamName) + '</option>'; }).join('') || '<option value="">（尚無團隊）</option>';
    if (!atState.teamId) atState.teamId = teamSel.value; else teamSel.value = atState.teamId;
    if (!atState.date) atState.date = localToday();
    $('#atDate').value = atState.date;
    renderAttSessionInputs();
    $('#atBatch').innerHTML = '<option value="">批次設為…</option>' + ATT_LIST.map(function (s) { return '<option value="' + s[0] + '">' + s[1] + '</option>'; }).join('');
    await loadAttDay();
  }

  function renderAttSessionInputs() {
    $('#atSessionName').innerHTML = ATT_SESSIONS.map(function (n) { return '<option value="' + esc(n) + '"' + (n === atState.sessionName ? ' selected' : '') + '>' + esc(n) + '</option>'; }).join('');
    $('#atStartTime').value = atState.startTime || '09:30'; $('#atEndTime').value = atState.endTime || '11:30';
    $('#atCustomWrap').classList.toggle('hidden', $('#atSessionName').value !== '自訂');
  }
  function attCurrentName() { return $('#atSessionName').value === '自訂' ? $('#atCustomSession').value.trim() : $('#atSessionName').value; }
  function attSessionKey(s) { return [s.sessionName, s.startTime, s.endTime].join('|'); }
  function attConfirmDiscard(next) { if (!atState.dirty || confirm('目前點名尚未儲存，是否離開？')) { next(); return true; } return false; }
  function renderAttSessions() {
    var sessions = atState.sessions || [];
    $('#atSessions').innerHTML = sessions.length ? sessions.map(function (s) { var n = Object.keys(s.marks || {}).length, done = n ? ('已點名 ' + n + ' / ' + atState.roster.length) : '尚未完成'; return '<div class="att-session-item ' + (s.sessionId === atState.sessionId ? 'active' : '') + '"><span>' + esc(s.sessionName) + ' ' + esc(s.startTime) + '–' + esc(s.endTime) + '｜' + done + '</span><button class="btn btn-sm" data-session="' + esc(s.sessionId) + '">編輯</button></div>'; }).join('') : '尚未建立時段。';
    TP.$all('[data-session]', $('#atSessions')).forEach(function (b) { b.onclick = function () { var s = sessions.filter(function (x) { return x.sessionId === b.dataset.session; })[0]; if (s) attConfirmDiscard(function () { openAttSession(s); }); }; });
  }
  function openAttSession(s) { atState.sessionId = s.sessionId || ''; atState.sessionName = s.sessionName; atState.startTime = s.startTime; atState.endTime = s.endTime; atState.filter = 'all'; atState.dirty = false; renderAttSessionInputs(); loadAttDay(); }

  async function loadAttDay() {
    $('#atList').className = ''; $('#atList').innerHTML = skeletonRows(3);
    $('#atSummaryCard').classList.add('hidden');
    atState.roster = (state.athletes || []).filter(function (a) { return String(a.teamId) === String(atState.teamId) && String(a.active) !== 'false' && a.active !== false; });
    atState.wById = {}; atState.missingSet = {}; atState.marks = {}; atState.touched = {}; atState.history = [];
    if (DEMO) {
      ((DEMO_DATA.warroom && DEMO_DATA.warroom.submitted) || []).forEach(function (s) { atState.wById[s.athleteId] = s; });
    } else {
      var w = await TP.callAuth('warroom', { teamId: atState.teamId, date: atState.date });
      if (w.ok) { (w.submitted || []).forEach(function (s) { atState.wById[s.athleteId] = s; }); (w.missing || []).forEach(function (m) { atState.missingSet[m.athleteId] = true; }); }
      var g = await TP.callAuth('getAttendance', { teamId: atState.teamId, date: atState.date, sessionId: atState.sessionId, sessionName: atState.sessionName, startTime: atState.startTime, endTime: atState.endTime });
      if (g.ok && g.found) { atState.sessionId = g.sessionId || atState.sessionId; Object.keys(g.marks || {}).forEach(function (id) { atState.marks[id] = { s: g.marks[id].s, n: g.marks[id].n || '' }; atState.touched[id] = true; }); }
      var h = await TP.callAuth('attendanceRange', { teamId: atState.teamId, from: attDaysAgo(6), to: atState.date });
      if (h.ok) { atState.history = h.records || []; atState.sessions = atState.history.filter(function (r) { return r.date === atState.date; }); renderAttSessions(); }
    }
    atState.roster.forEach(function (a) { if (!atState.marks[a.athleteId]) atState.marks[a.athleteId] = { s: 'present', n: '' }; });
    try {
      localStorage.setItem('teampro_lastAttendanceList', JSON.stringify(atState.roster.map(function (a) {
        return { athleteId: a.athleteId, name: a.name, group: a.grp || a.group || '', todayAttendanceStatus: (atState.marks[a.athleteId] || {}).s || '' };
      })));
    } catch (e) {}
    atState.dirty = false; renderAttList();
  }

  function renderAttList() {
    $('#atList').className = atState.view === 'grid' ? 'att-grid' : '';
    $('#atViewToggle').textContent = atState.view === 'grid' ? '☰ 清單' : '🔲 棋盤';
    if (!atState.roster.length) { $('#atList').className = '';
      $('#atList').innerHTML = '<div class="empty-state">此隊伍還沒有啟用中的選手。<br>到「選手」頁新增或啟用，名單就會出現在這裡。' +
        '<div style="margin-top:12px;"><button class="btn btn-primary btn-sm" id="emptyGotoAthletes">前往選手頁 →</button></div></div>';
      var ga = $('#emptyGotoAthletes'); if (ga) ga.onclick = function () { switchTab('athletes'); };
      return; }
    var list = atState.roster.filter(function (a) {
      if (atState.filter === 'unmarked') return !atState.touched[a.athleteId];
      if (atState.filter === 'abnormal') { var L = attLight(a); return L === '🟠' || L === '🔴' || L === '⚫'; }
      return true;
    });
    $('#atFilterAll').classList.toggle('hidden', atState.filter === 'all');
    if (!list.length) { $('#atList').className = ''; $('#atList').innerHTML = '<div class="empty-state">此篩選目前沒有選手。</div>'; return; }
    $('#atList').innerHTML = list.map(function (a) {
      var m = atState.marks[a.athleteId] || { s: 'present', n: '' };
      var icons = attFlags(a).map(function (x) { return x.icon; }).join('');
      var picker = ATT_LIST.map(function (s) { return '<button data-set="' + s[0] + '"' + (s[0] === m.s ? ' class="sel"' : '') + '>' + s[1] + '</button>'; }).join('');
      return '<div class="att-row" data-aid="' + a.athleteId + '">' +
        '<div class="att-top"><div class="att-name">' + attLight(a) + ' ' + esc(a.name) + ' <span class="att-icons">' + icons + '</span></div>' +
        '<button class="att-chip ' + m.s + '" data-chip="' + a.athleteId + '">' + attLabel(m.s) + ' ▾</button></div>' +
        '<div class="att-7day">最近7天 ' + att7day(a) + '</div>' +
        '<div class="att-picker" data-picker="' + a.athleteId + '">' + picker + '</div>' +
        '<input class="att-note" data-note="' + a.athleteId + '" placeholder="助教回覆／備註（選填）" value="' + esc(m.n || '') + '">' +
        '</div>';
    }).join('');
    var box = $('#atList');
    TP.$all('[data-chip]', box).forEach(function (b) {
      b.onclick = function () {
        var p = box.querySelector('[data-picker="' + b.dataset.chip + '"]'), open = p.classList.contains('open');
        TP.$all('.att-picker', box).forEach(function (x) { x.classList.remove('open'); });
        if (!open) p.classList.add('open');
      };
    });
    TP.$all('[data-picker]', box).forEach(function (p) {
      TP.$all('button', p).forEach(function (b) {
        b.onclick = function () { var aid = p.dataset.picker; atState.marks[aid] = atState.marks[aid] || { s: 'present', n: '' }; atState.marks[aid].s = b.dataset.set; atState.touched[aid] = true; atState.dirty = true; renderAttList(); };
      });
    });
    TP.$all('[data-note]', box).forEach(function (inp) {
      inp.oninput = function () { var aid = inp.dataset.note; atState.marks[aid] = atState.marks[aid] || { s: 'present', n: '' }; atState.marks[aid].n = inp.value; atState.touched[aid] = true; atState.dirty = true; };
    });
  }

  function attSetAll(s, needConfirm) {
    if (needConfirm && !confirm('確定將全員設為「' + attLabel(s) + '」？')) return;
    atState.roster.forEach(function (a) { atState.marks[a.athleteId] = { s: s, n: (atState.marks[a.athleteId] || {}).n || '' }; atState.touched[a.athleteId] = true; });
    atState.dirty = true; renderAttList();
  }

  function attCounts() {
    var c = { present: 0, late: 0, early_leave: 0, official_leave: 0, personal_leave: 0, sick_leave: 0, absent: 0, not_required: 0 };
    atState.roster.forEach(function (a) { var s = (atState.marks[a.athleteId] || {}).s || 'present'; c[s] = (c[s] || 0) + 1; });
    return c;
  }
  function attStat(l, n) { return '<div class="stat"><div class="num">' + n + '</div><div class="lbl">' + l + '</div></div>'; }
  function attNeedAttention() {
    return atState.roster.filter(function (a) { var L = attLight(a); return L === '🟠' || L === '🔴'; }).map(function (a) {
      var fl = attFlags(a);
      return { name: a.name, reason: fl.length ? fl.map(function (x) { return x.why; }).join('、') : '狀態需關注' };
    });
  }

  function renderAttSummary() {
    var c = attCounts(), team = (state.teams.filter(function (t) { return t.teamId === atState.teamId; })[0] || {}).teamName || '';
    var expected = atState.roster.length - c.official_leave - c.not_required, actual = c.present + c.late + c.early_leave, na = attNeedAttention();
    $('#atSummaryCard').classList.remove('hidden');
    $('#atSummary').innerHTML =
      '<div class="muted" style="font-size:13px;">隊伍：' + esc(team) + '　時段：' + esc(atState.sessionName) + ' ' + atState.startTime + '–' + atState.endTime + '　日期：' + atState.date + '</div>' +
      '<div class="att-summary-grid">' + attStat('應到', expected) + attStat('出席', c.present) + attStat('遲到', c.late) + attStat('早退', c.early_leave) + attStat('公假', c.official_leave) + attStat('事假', c.personal_leave) + attStat('病假', c.sick_leave) + attStat('未到', c.absent) + '</div>' +
      '<h4 style="margin:10px 0 6px;">今日需關注</h4>' +
      (na.length ? na.map(function (x) { return '<div class="row"><span>' + esc(x.name) + '</span><span class="muted">' + esc(x.reason) + '</span></div>'; }).join('') : '<p class="muted">今天沒有需要特別關注的選手 👍</p>');
    var exceptions = atState.roster.filter(function(a) { var s=(atState.marks[a.athleteId]||{}).s; return s && s !== 'present' && s !== 'not_required'; }).map(function(a){ return '- ' + a.name + '：' + attLabel(atState.marks[a.athleteId].s); });
    atState.lineText = '【TeamPro 點名回報】\n日期：' + atState.date + '\n隊伍：' + team + '\n時段：' + atState.sessionName + ' ' + atState.startTime + '–' + atState.endTime +
      '\n\n✅ 出席：' + c.present + '人\n遲到：' + c.late + '人\n早退：' + c.early_leave + '人\n公假：' + c.official_leave + '人\n事假：' + c.personal_leave + '人\n病假：' + c.sick_leave + '人\n⚫ 未到：' + c.absent + '人\n\n需注意名單：\n' + (exceptions.length ? exceptions.join('\n') : '（無）') + lineWatermark();
    renderAttParentNotify();
  }

  function renderAttParentNotify() {
    var rows = [];
    atState.roster.forEach(function (a) {
      var s = (atState.marks[a.athleteId] || {}).s, w = atState.wById[a.athleteId], msg = '';
      if (s === 'absent') msg = '您好，今天 ' + a.name + ' 未出席訓練，麻煩協助確認原因，謝謝。';
      else if (s === 'late') msg = '您好，今天 ' + a.name + ' 訓練遲到，提醒孩子下次提早準備，謝謝。';
      else if (s === 'injured_watch' || (w && Number(w.painScore) >= 4)) msg = '您好，今天 ' + a.name + ' 回報身體不適或疼痛，教練會協助調整訓練，也請家中協助觀察恢復狀況。';
      else if (atState.missingSet[a.athleteId] && !w) msg = '您好，' + a.name + ' 最近未完成訓練回報，麻煩協助提醒孩子完成每日回報，方便教練掌握狀態。';
      if (msg) rows.push({ name: a.name, msg: msg });
    });
    if (!rows.length) { $('#atParentNotify').innerHTML = ''; return; }
    $('#atParentNotify').innerHTML = '<h4 style="margin:6px 0;">家長通知（點即複製）</h4>' +
      rows.map(function (r) { return '<div class="row"><span>' + esc(r.name) + '</span><button class="btn btn-sm" data-pmsg="' + esc(r.msg) + '">複製</button></div>'; }).join('') +
      '<button class="btn btn-sm" id="atBatchParent" style="margin-top:8px;">批次複製全部家長通知（升級）</button>';
    TP.$all('[data-pmsg]', $('#atParentNotify')).forEach(function (b) { b.onclick = function () { TP.copy(b.dataset.pmsg); }; });
    $('#atBatchParent').onclick = function () { if (!planCfg().pdfExport) { openUpgradeModal({ reason: 'pdfExport', message: '批次家長通知為升級功能。' }); return; } TP.copy(rows.map(function (r) { return r.msg; }).join('\n\n')); };
  }

  async function renderAttMonth() {
    if (DEMO) { demoBlock(); return; }
    if (!planCfg().report30Days) { openUpgradeModal({ reason: 'report30Days', message: '月出席統計為升級功能，升級後可看每位選手本月出席率與 PDF 月報。' }); return; }
    $('#atMonth').innerHTML = '<p class="muted">統計中…</p>';
    var ym = attDateKey(atState.date).slice(0, 7), from = ym + '-01', to = attMonthEnd(ym);
    var h = await TP.callAuth('attendanceRange', { teamId: atState.teamId, from: from, to: to });
    var recs = (h.ok && h.records) || [];
    recs = recs.filter(function (r) { return attDateKey(r.date).slice(0, 7) === ym; });
    if (!recs.length) { $('#atMonth').innerHTML = '<p class="muted">本月尚無點名紀錄。請確認已按「儲存此時段點名」，或切換到有點名資料的隊伍 / 月份。</p>'; return; }
    var rows = atState.roster.map(function (a) { return calculateMonthlyAttendanceRate(recs, a.athleteId, ym, a.name); });
    var sessionCount = recs.length;
    $('#atMonth').innerHTML = '<p class="muted" style="margin:0 0 8px;">統計月份：' + ym + '｜已讀取 ' + sessionCount + ' 個點名時段</p><div class="att-month-scroll"><table class="att-month-table"><thead><tr><th>姓名</th><th>應出席<br>時段</th><th>實際<br>點數</th><th>出席</th><th>遲到</th><th>早退</th><th>公假</th><th>事假</th><th>病假</th><th>未到</th><th>不需<br>出席</th><th>出席率</th><th>狀態</th></tr></thead><tbody>' + rows.map(function (r) { var label = r.attendanceRate >= 95 ? ['穩定','stable'] : r.attendanceRate >= 90 ? ['需提醒','remind'] : r.attendanceRate >= 80 ? ['需追蹤','track'] : ['高風險','risk']; return '<tr><td><b>' + esc(r.athleteName) + '</b></td><td>' + r.requiredSessions + '</td><td>' + r.attendedScore + '</td><td>' + r.presentCount + '</td><td>' + r.lateCount + '</td><td>' + r.earlyLeaveCount + '</td><td>' + r.officialLeaveCount + '</td><td>' + r.personalLeaveCount + '</td><td>' + r.sickLeaveCount + '</td><td>' + r.absentCount + '</td><td>' + r.notRequiredCount + '</td><td><b>' + r.attendanceRate + '%</b></td><td><span class="att-risk ' + label[1] + '">' + label[0] + '</span></td></tr>'; }).join('') + '</tbody></table></div>';
  }

  function attDateKey(v) {
    if (v instanceof Date && !isNaN(v.getTime())) return v.getFullYear() + '-' + String(v.getMonth() + 1).padStart(2, '0') + '-' + String(v.getDate()).padStart(2, '0');
    var s = String(v == null ? '' : v).trim();
    var m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
    if (m) return m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0');
    var d = new Date(s);
    if (!isNaN(d.getTime())) return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    return s;
  }
  function attMonthEnd(ym) {
    var p = String(ym || '').split('-'), d = new Date(Number(p[0]), Number(p[1]), 0);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function calculateMonthlyAttendanceRate(records, athleteId, yearMonth, athleteName) {
    var out = { athleteId: athleteId, athleteName: athleteName || '', requiredSessions: 0, attendedScore: 0, presentCount: 0, lateCount: 0, earlyLeaveCount: 0, officialLeaveCount: 0, personalLeaveCount: 0, sickLeaveCount: 0, absentCount: 0, notRequiredCount: 0, attendanceRate: 0 };
    (records || []).filter(function(r) { return attDateKey(r.date).slice(0, 7) === yearMonth; }).forEach(function(r) { var m=(r.marks || {})[athleteId]; if (!m) return; var s=m.s || m.status || 'present'; if (s === 'leave') s = 'personal_leave'; if (s === 'injured_watch' || s === 'adjust_training') s = 'not_required'; if (s === 'present') { out.requiredSessions++; out.attendedScore++; out.presentCount++; } else if (s === 'late') { out.requiredSessions++; out.attendedScore += .5; out.lateCount++; } else if (s === 'early_leave') { out.requiredSessions++; out.attendedScore += .5; out.earlyLeaveCount++; } else if (s === 'official_leave') out.officialLeaveCount++; else if (s === 'not_required') out.notRequiredCount++; else if (s === 'personal_leave') { out.requiredSessions++; out.personalLeaveCount++; } else if (s === 'sick_leave') { out.requiredSessions++; out.sickLeaveCount++; } else { out.requiredSessions++; out.absentCount++; } });
    out.attendedScore = Number(out.attendedScore.toFixed(1)); out.attendanceRate = out.requiredSessions ? Number((out.attendedScore / out.requiredSessions * 100).toFixed(1)) : 0; return out;
  }

  $('#atTeam').onchange = function () { var el=this, v=el.value; if (!attConfirmDiscard(function () { atState.teamId = v; atState.sessionId = ''; atState.filter = 'all'; loadAttDay(); })) el.value = atState.teamId; };
  $('#atDate').onchange = function () { var el=this, v=el.value; if (!attConfirmDiscard(function () { atState.date = v; atState.sessionId = ''; atState.filter = 'all'; loadAttDay(); })) el.value = atState.date; };
  $('#atSessionName').onchange = function () { $('#atCustomWrap').classList.toggle('hidden', this.value !== '自訂'); };
  $('#atOpenSession').onclick = function () { var name=attCurrentName(), start=$('#atStartTime').value, end=$('#atEndTime').value; if (!name || !start || !end) { toast('請完整填寫時段名稱與時間', true); return; } attConfirmDiscard(function () { var found=(atState.sessions || []).filter(function(s){ return s.sessionName===name && s.startTime===start && s.endTime===end; })[0]; openAttSession(found || { sessionId:'', sessionName:name, startTime:start, endTime:end, marks:{} }); }); };
  $('#atAllPresent').onclick = function () { attSetAll('present', false); };
  $('#atAllAbsent').onclick = function () { attSetAll('absent', true); };
  $('#atCopyLast').onclick = function () {
    var past = atState.history.filter(function (r) { return String(r.date) < atState.date; });
    if (!past.length) { toast('沒有更早的點名可複製'); return; }
    var last = past[past.length - 1];
    atState.roster.forEach(function (a) { var m = last.marks[a.athleteId]; if (m) { atState.marks[a.athleteId] = { s: m.s, n: m.n || '' }; atState.touched[a.athleteId] = true; } });
    renderAttList(); toast('已複製 ' + last.date + ' 的點名');
  };
  $('#atFilterUnmarked').onclick = function () { atState.filter = 'unmarked'; renderAttList(); };
  $('#atFilterAbnormal').onclick = function () { atState.filter = 'abnormal'; renderAttList(); };
  $('#atFilterAll').onclick = function () { atState.filter = 'all'; renderAttList(); };
  $('#atViewToggle').onclick = function () { atState.view = atState.view === 'grid' ? 'list' : 'grid'; localStorage.setItem('teampro_att_view', atState.view); renderAttList(); };
  $('#atBatch').onchange = function () {
    var s = this.value; this.value = ''; if (!s) return;
    var visible = atState.roster.filter(function (a) { if (atState.filter === 'unmarked') return !atState.touched[a.athleteId]; if (atState.filter === 'abnormal') { var L = attLight(a); return L === '🟠' || L === '🔴' || L === '⚫'; } return true; });
    visible.forEach(function (a) { atState.marks[a.athleteId] = { s: s, n: (atState.marks[a.athleteId] || {}).n || '' }; atState.touched[a.athleteId] = true; });
    atState.dirty = true; renderAttList();
  };
  $('#atSave').onclick = async function () {
    if (DEMO) { demoBlock(); return; }
    var btn = this; btn.disabled = true; btn.textContent = '儲存中…';
    var r = await TP.callAuth('saveAttendance', { teamId: atState.teamId, date: atState.date, sessionId: atState.sessionId, sessionName: atState.sessionName, startTime: atState.startTime, endTime: atState.endTime, marks: atState.marks });
    btn.disabled = false; btn.textContent = '💾 儲存此時段點名';
    if (r.ok) { atState.dirty = false; toast('點名已儲存'); markTask('rollcall', true); renderOnboarding(); renderAttSummary(); await loadAttDay(); } else { toast(r.error || '儲存失敗', true); }
  };
  $('#atCopyLine').onclick = function () { if (atState.lineText) TP.copy(atState.lineText); else toast('請先儲存點名'); };
  $('#atCopyTodayLine').onclick = function () { var sessions=atState.sessions || []; if (!sessions.length) { toast('今日尚無已儲存時段'); return; } var team=(state.teams.filter(function(t){return t.teamId===atState.teamId;})[0]||{}).teamName||''; var lines=sessions.map(function(s){ var c={present:0,late:0,personal_leave:0,sick_leave:0,official_leave:0,absent:0}; Object.keys(s.marks||{}).forEach(function(id){var x=(s.marks[id]||{}).s; c[x]=(c[x]||0)+1;}); return s.sessionName+' '+s.startTime+'–'+s.endTime+'\n✅ 出席 '+c.present+'｜遲到 '+c.late+'｜請假 '+(c.personal_leave+c.sick_leave+c.official_leave)+'｜⚫ 未到 '+c.absent; }); TP.copy('【TeamPro 今日點名總結】\n日期：'+atState.date+'\n隊伍：'+team+'\n\n'+lines.join('\n\n')+'\n\n本日提醒：\n請確認未到與請假名單，必要時聯繫家長。'+lineWatermark()); };
  $('#atMonthBtn').onclick = renderAttMonth;

  boot();
})();
