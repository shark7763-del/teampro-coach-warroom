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
  $('#focusTrainingNote').onclick = () => $('#quickTrainingText').focus();
  $('#organizeAiBtn').onclick = organizeTrainingText;
  $('#aiOrganizeNow').onclick = organizeTrainingText;
  $$('.flow-step[data-tab]').forEach(btn => btn.onclick = () => openFeature(btn.dataset.tab));
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
  const publicFeature = tab === 'more' || tab === 'settings';
  if (!TP.getToken() && !publicFeature) {
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
  try {
    const mod = await import(cfg.module + '?v=20260627-shell4');
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
