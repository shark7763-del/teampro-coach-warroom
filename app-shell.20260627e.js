const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));

const state = { coach: null, teams: null };
const params = new URLSearchParams(location.search);
const DEMO = params.get('demo') === '1';
let routeWriteLock = false;
let bootstrapPromise = null;
let bootstrapData = null;
const featureMap = {
  attendance: { title: '快速點名', module: './app-modules/attendance.js' },
  athletes: { title: '選手管理', module: './app-modules/athletes.js' },
  teams: { title: '團隊與連結', module: './app-modules/teams.js' },
  report: { title: '成果報告', module: './app-modules/reports.js' },
  settings: { title: '更多 / 設定 / 隱私', module: './app-modules/settings.js' },
  more: { title: '更多 / 設定 / 隱私', module: './app-modules/settings.js' },
};

boot();

function today() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

async function boot() {
  bindAuth();
  bindTabs();
  if (DEMO) {
    state.coach = demoCoach();
    TP.setAuthVerified && TP.setAuthVerified(true);
    showDashboard();
    return;
  }
  if (!TP.getToken()) {
    showAuth();
    return;
  }
  const cached = cachedCoach();
  if (TP.hasRecentAuth && TP.hasRecentAuth() && cached && (cached.coachId || cached.email)) {
    state.coach = cached;
    $('#shellCoach').textContent = `${cached.name || '教練'}｜${cached.planName || ''}`;
    startBootstrap();
    openInitialRoute();
    return;
  }
  $('#shellCoach').textContent = '驗證登入中…';
  const ok = await startBootstrap();
  if (ok) openInitialRoute();
  else showAuth('登入狀態已失效或暫時無法驗證，請重新登入。');
}

function bindAuth() {
  $('#loginBtn').onclick = async () => {
    if (!TP.getUrl()) {
      TP.toast('請先設定後端網址', true);
      return;
    }
    const email = $('#loginEmail').value.trim();
    const password = $('#loginPassword').value;
    if (!email || !password) {
      TP.toast('請輸入 email 與密碼', true);
      return;
    }
    const btn = $('#loginBtn');
    btn.disabled = true;
    btn.textContent = '登入中…';
    const r = await TP.call('login', { email, password });
    btn.disabled = false;
    btn.textContent = '登入';
    if (!r || !r.ok) {
      TP.toast((r && r.error) || '登入失敗', true);
      return;
    }
    TP.clearSensitiveCache && TP.clearSensitiveCache();
    TP.setToken(r.token);
    TP.setAuthVerified && TP.setAuthVerified(true);
    state.coach = r.coach;
    cacheCoach(r.coach);
    bootstrapData = { coach: r.coach, teams: null, warroom: null };
    showDashboard();
  };
  $('#shellLogout').onclick = async () => {
    await TP.callAuth('logout');
    if (TP.logoutLocal) TP.logoutLocal();
    else TP.clearToken();
    location.reload();
  };
  $('#quickAttendance').onclick = () => openFeature('attendance');
  const moreBtn = $('#shellMore');
  if (moreBtn) moreBtn.onclick = () => openFeature('more');
  $('#backDashboard').onclick = () => showDashboard();
  const focusTraining = $('#focusTrainingNote');
  if (focusTraining) focusTraining.onclick = () => $('#quickTrainingText').focus();
  const organizeBtn = $('#organizeAiBtn');
  if (organizeBtn) organizeBtn.onclick = organizeTrainingText;
  const aiNow = $('#aiOrganizeNow');
  if (aiNow) aiNow.onclick = organizeTrainingText;
  $$('.flow-step[data-tab]').forEach(btn => btn.onclick = () => {
    const tab = btn.dataset.tab;
    if (tab === 'tracking') openTracking();
    else if (tab === 'dashboard') showDashboard();
    else openFeature(tab);
  });
  $$('.mode-entry[data-tab]').forEach(btn => btn.onclick = () => {
    const tab = btn.dataset.tab;
    if (tab === 'dashboard') showDashboard();
    else openFeature(tab);
  });
}

function bindTabs() {
  $$('#mobileTabbar button').forEach(btn => {
    btn.onclick = () => {
      const tab = btn.dataset.tab;
      if (tab === 'dashboard') showDashboard();
      else if (tab === 'training') openTraining();
      else if (tab === 'tracking') openTracking();
      else openFeature(tab);
    };
  });
  window.addEventListener('popstate', () => {
    if (!DEMO && !(TP.isAuthVerified && TP.isAuthVerified())) {
      showAuth();
      return;
    }
    routeWriteLock = true;
    openRoute(routeFromLocation() || 'dashboard').finally(() => { routeWriteLock = false; });
  });
}

// 「紀錄」分頁：回今日頁並聚焦訓練日誌 composer（60 秒流程的訓練紀錄）
async function openTraining() {
  await showDashboard();
  setActiveTab('training');
  setRoute('training');
  const el = $('#quickTrainingText');
  if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.focus(); }
}

async function openTracking() {
  showDashboard();
  setActiveTab('tracking');
  setRoute('tracking');
  requestAnimationFrame(() => {
    const el = $('#dailyActionPanel') || $('#dispositionSection');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function setActiveTab(tab) {
  $$('#mobileTabbar button').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tab));
}

function showAuth(message) {
  $('#shellCoach').textContent = '尚未登入';
  $('#shellLogout').classList.add('hidden');
  $('#authPanel').classList.remove('hidden');
  $('#dashboardPanel').classList.add('hidden');
  $('#featurePanel').classList.add('hidden');
  if (message) TP.toast(message, true);
  setActiveTab('dashboard');
}

async function showDashboard() {
  if (!DEMO && !(TP.isAuthVerified && TP.isAuthVerified())) {
    showAuth('請先登入後再查看戰情室。');
    return;
  }
  $('#shellCoach').textContent = state.coach ? `${state.coach.name || '教練'}｜${state.coach.planName || ''}` : '已登入';
  $('#shellLogout').classList.remove('hidden');
  $('#authPanel').classList.add('hidden');
  $('#featurePanel').classList.add('hidden');
  $('#dashboardPanel').classList.remove('hidden');
  setActiveTab('dashboard');
  setRoute('dashboard');
  const mod = await import('./app-modules/dashboard.js?v=20260826-perf1');
  mod.mountDashboard({ ensureTeams, today, coachKey, demo: DEMO, getBootstrap, getBootstrapPromise });
}

async function openInitialRoute() {
  const tab = routeFromLocation() || 'dashboard';
  await openRoute(tab);
}

async function openRoute(tab) {
  if (tab === 'dashboard') return showDashboard();
  if (tab === 'training') return openTraining();
  if (tab === 'tracking') return openTracking();
  return openFeature(tab);
}

function routeFromLocation() {
  const raw = String(location.hash || '').replace(/^#/, '');
  const m = raw.match(/(?:^|&)tab=([^&]+)/);
  const tab = m ? decodeURIComponent(m[1]) : '';
  return ['dashboard', 'tracking', 'attendance', 'athletes', 'training', 'report', 'teams', 'settings', 'more'].indexOf(tab) !== -1 ? tab : '';
}

function setRoute(tab) {
  if (routeWriteLock) return;
  const hash = '#tab=' + encodeURIComponent(tab || 'dashboard');
  if (location.hash === hash) return;
  history.pushState({ tab }, '', hash);
}

function coachKey() {
  return String((state.coach && (state.coach.coachId || state.coach.email)) || 'guest');
}

function cachedCoach() {
  try { return JSON.parse(localStorage.getItem('teampro_shell_coach') || 'null'); } catch (e) { return null; }
}
function cacheCoach(coach) {
  try { if (coach) localStorage.setItem('teampro_shell_coach', JSON.stringify(coach)); } catch (e) {}
}
function demoCoach() {
  return { coachId: 'demo-shell', email: 'demo@teampro.tw', name: 'Demo 教練', planName: '展示模式' };
}
async function refreshMeInBackground() {
  return startBootstrap();
}

async function verifySession() {
  const r = await TP.callAuth('me');
  if (!r || !r.ok) {
    TP.setAuthVerified && TP.setAuthVerified(false);
    if (r && (r.needLogin || r.error === 'unauthorized')) {
      if (TP.logoutLocal) TP.logoutLocal();
      else TP.clearToken();
    }
    state.coach = null;
    return false;
  }
  state.coach = r.coach;
  TP.setAuthVerified && TP.setAuthVerified(true);
  cacheCoach(r.coach);
  $('#shellCoach').textContent = `${state.coach.name || '教練'}｜${state.coach.planName || ''}`;
  return true;
}

function getBootstrap() {
  return bootstrapData;
}

function getBootstrapPromise() {
  return bootstrapPromise;
}

function startBootstrap() {
  if (bootstrapPromise) return bootstrapPromise;
  const date = today();
  bootstrapPromise = TP.callAuth('bootstrap', { date }).then(async (r) => {
    if (!r || !r.ok || !r.coach) {
      if (r && (r.needLogin || r.error === 'unauthorized')) return false;
      const fallback = await Promise.all([
        TP.callAuth('me'),
        TP.callAuth('listTeams'),
        TP.callAuth('warroom', { date })
      ]);
      const meRes = fallback[0], teamsRes = fallback[1], warroomRes = fallback[2];
      if (!meRes || !meRes.ok) return false;
      r = {
        ok: true,
        coach: meRes.coach,
        teams: teamsRes && teamsRes.ok ? teamsRes.teams : [],
        warroom: warroomRes && warroomRes.ok ? warroomRes : null
      };
    }
    state.coach = r.coach;
    state.teams = r.teams || [];
    bootstrapData = r;
    TP.setAuthVerified && TP.setAuthVerified(true);
    cacheCoach(r.coach);
    $('#shellCoach').textContent = `${state.coach.name || '教練'}｜${state.coach.planName || ''}`;
    return true;
  }).catch(() => false).finally(() => { bootstrapPromise = null; });
  return bootstrapPromise;
}

async function ensureTeams() {
  if (state.teams) return state.teams;
  const r = await TP.callAuth('listTeams');
  state.teams = (r && r.ok && r.teams) || [];
  return state.teams;
}

async function openFeature(tab) {
  if (!DEMO && !(TP.isAuthVerified && TP.isAuthVerified())) {
    showAuth('請先登入後再開啟功能。');
    return;
  }
  const cfg = featureMap[tab] || featureMap.more;
  $('#authPanel').classList.add('hidden');
  $('#dashboardPanel').classList.add('hidden');
  $('#featurePanel').classList.remove('hidden');
  $('#featureTitle').textContent = cfg.title;
  $('#featureMount').innerHTML = '<div class="shell-card shell-loading">載入 ' + TP.esc(cfg.title) + '…</div>';
  setActiveTab(tab === 'more' ? 'more' : tab);
  setRoute(tab);
  try {
    const mod = await import(cfg.module + '?v=20260826-perf1');
    mod.mount($('#featureMount'));
  } catch (err) {
    console.error('TeamPro feature load failed:', tab, err);
    $('#featureMount').innerHTML =
      '<div class="shell-card">' +
        '<h2>功能載入失敗</h2>' +
        '<p class="muted">這通常是瀏覽器快取或網路暫時問題。請重新整理，或先開啟完整管理頁。</p>' +
        '<a class="btn btn-primary btn-block" href="app-full.html?lazyTab=' + encodeURIComponent(tab) + '">開啟完整管理頁</a>' +
      '</div>';
  }
}

function organizeTrainingText() {
  const raw = ($('#quickTrainingText').value || '').trim();
  if (!raw) {
    TP.toast('請先輸入今日訓練紀錄', true);
    $('#quickTrainingText').focus();
    return;
  }
  const names = raw.match(/[\u4e00-\u9fa5]{2,4}/g) || [];
  const injury = /痛|不舒服|受傷|拉傷|扭到/.test(raw);
  const late = /遲到|晚到/.test(raw);
  const good = /很好|穩|進步|佳|不錯/.test(raw);
  const topic = raw.match(/練([^，。,.]+)/);
  const out =
    '<b>今日訓練主題</b><p>' + TP.esc(topic ? topic[1] : '專項訓練與狀態觀察') + '</p>' +
    '<b>訓練內容</b><p>' + TP.esc(raw) + '</p>' +
    '<b>學生狀況</b><p>' + TP.esc(names.slice(0, 6).join('、') || '依今日紀錄追蹤學生運動員狀態') + '</p>' +
    '<b>異常追蹤</b><p>' + (injury ? '有學生回報疼痛或不適，建議列入傷病追蹤。' : '未偵測明顯傷病關鍵字。') + (late ? ' 有學生遲到，建議列入出席提醒。' : '') + '</p>' +
    '<b>後續建議</b><p>' + (good ? '狀態良好者可維持訓練節奏；' : '') + '下次訓練前確認異常學生恢復與出席狀況。</p>';
  const box = $('#aiOrganizedOutput');
  box.innerHTML = out;
  box.classList.remove('hidden');
}
