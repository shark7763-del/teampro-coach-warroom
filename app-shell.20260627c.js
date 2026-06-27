const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));

const state = { coach: null, teams: null };
const params = new URLSearchParams(location.search);
const DEMO = params.get('demo') === '1';
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
    showDashboard();
    return;
  }
  if (!TP.getToken()) {
    showAuth();
    return;
  }
  state.coach = cachedCoach() || { name: '教練', planName: '載入中' };
  showDashboard();
  refreshMeInBackground();
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
    TP.setToken(r.token);
    state.coach = r.coach;
    cacheCoach(r.coach);
    showDashboard();
    refreshMeInBackground();
  };
  $('#shellLogout').onclick = async () => {
    await TP.callAuth('logout');
    TP.clearToken();
    location.reload();
  };
  $('#quickAttendance').onclick = () => openFeature('attendance');
  $('#backDashboard').onclick = () => showDashboard();
}

function bindTabs() {
  $$('#mobileTabbar button').forEach(btn => {
    btn.onclick = () => {
      const tab = btn.dataset.tab;
      if (tab === 'dashboard') showDashboard();
      else openFeature(tab);
    };
  });
}

function setActiveTab(tab) {
  $$('#mobileTabbar button').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tab));
}

function showAuth() {
  $('#shellCoach').textContent = '尚未登入';
  $('#shellLogout').classList.add('hidden');
  $('#authPanel').classList.remove('hidden');
  $('#dashboardPanel').classList.add('hidden');
  $('#featurePanel').classList.add('hidden');
  setActiveTab('dashboard');
}

async function showDashboard() {
  $('#shellCoach').textContent = state.coach ? `${state.coach.name || '教練'}｜${state.coach.planName || ''}` : '已登入';
  $('#shellLogout').classList.remove('hidden');
  $('#authPanel').classList.add('hidden');
  $('#featurePanel').classList.add('hidden');
  $('#dashboardPanel').classList.remove('hidden');
  setActiveTab('dashboard');
  const mod = await import('./app-modules/dashboard.js?v=20260627-shell3');
  await mod.mountDashboard({ ensureTeams, today, coachKey, demo: DEMO });
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
  const r = await TP.callAuth('me');
  if (!r || !r.ok) {
    if (!cachedCoach()) { TP.clearToken(); showAuth(); }
    return;
  }
  state.coach = r.coach;
  cacheCoach(r.coach);
  $('#shellCoach').textContent = `${state.coach.name || '教練'}｜${state.coach.planName || ''}`;
}

async function ensureTeams() {
  if (state.teams) return state.teams;
  const r = await TP.callAuth('listTeams');
  state.teams = (r && r.ok && r.teams) || [];
  return state.teams;
}

async function openFeature(tab) {
  if (!TP.getToken()) {
    showAuth();
    return;
  }
  const cfg = featureMap[tab] || featureMap.more;
  $('#authPanel').classList.add('hidden');
  $('#dashboardPanel').classList.add('hidden');
  $('#featurePanel').classList.remove('hidden');
  $('#featureTitle').textContent = cfg.title;
  $('#featureMount').innerHTML = '<div class="shell-card shell-loading">載入 ' + TP.esc(cfg.title) + '…</div>';
  setActiveTab(tab === 'more' ? 'more' : tab);
  const mod = await import(cfg.module + '?v=20260627-shell3');
  mod.mount($('#featureMount'));
}
