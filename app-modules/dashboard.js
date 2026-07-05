import { escapeHtml } from './legacy-frame.js';

const APP_VERSION = 'v2026.07.04';
const esc = escapeHtml;

let CURRENT = null; // 最近一次摘要，供家長摘要/健康檢查使用
let CURRENT_CTX = null;

export async function mountDashboard(ctx) {
  CURRENT_CTX = ctx;
  const root = document.getElementById('dashboardMount');
  root.innerHTML = skeleton();
  const teamId = (document.getElementById('dashTeam') && document.getElementById('dashTeam').value) || '';
  const date = ctx.today();
  const cacheKey = 'teampro_shell_todaySummary_' + (ctx.coachKey ? ctx.coachKey() : 'coach') + '_' + teamId + '_' + date;
  const cached = readSummary(cacheKey);
  if (cached) renderSummary(root, cached, true, ctx);
  if (ctx.demo) {
    const demo = cached || demoSummary(date);
    if (!cached) writeSummary(cacheKey, demo);
    renderSummary(root, demo, false, ctx, { offline: false, demo: true });
    return;
  }
  if (!TP.getUrl()) {
    // 後端網址尚未設定：不報錯，顯示引導 + 可用離線資料
    renderSummary(root, cached || demoSummary(date), false, ctx, { offline: true, noBackend: true });
    return;
  }
  const r = await TP.callAuth('warroom', { teamId, date });
  if (!r || !r.ok) {
    if (cached) {
      renderSummary(root, cached, true, ctx, { offline: true });
      return;
    }
    renderSummary(root, demoSummary(date), false, ctx, { offline: true, error: true });
    return;
  }
  const summary = toTodaySummary(r, date);
  writeSummary(cacheKey, summary);
  renderSummary(root, summary, false, ctx, { offline: false });
}

function skeleton() {
  return '<div class="three-things">' +
    '<div class="shell-card"><div class="muted">今天誰需要關心</div><div class="skel w-40"></div><div class="skel w-70"></div></div>' +
    '<div class="shell-card"><div class="muted">誰還沒回報 / 缺席</div><div class="skel w-40"></div><div class="skel w-70"></div></div>' +
    '<div class="shell-card"><div class="muted">今天可以傳給家長</div><div class="skel w-90"></div><div class="skel w-40"></div></div>' +
  '</div>';
}

function readSummary(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; }
}
function writeSummary(key, summary) {
  try { localStorage.setItem(key, JSON.stringify(summary)); } catch (e) {}
  try { localStorage.setItem('teampro_lastTodaySummary', JSON.stringify(summary)); } catch (e) {}
  try { localStorage.setItem('teampro_lastSyncAt', new Date().toISOString()); } catch (e) {}
}
function toTodaySummary(r, date) {
  const submitted = r.submitted || [];
  const missing = r.missing || [];
  return {
    date,
    totalAthletes: Number(r.totalAthletes || submitted.length + missing.length || 0),
    submittedCount: Number(r.submittedCount || submitted.length || 0),
    notSubmittedCount: Number(r.missingCount || missing.length || 0),
    redCount: Number((r.lights && r.lights.red) || 0),
    yellowCount: Number((r.lights && r.lights.yellow) || 0),
    greenCount: Number((r.lights && r.lights.green) || 0),
    painCount: submitted.filter(s => Number(s.painScore) >= 4).length,
    fatigueHighCount: submitted.filter(s => Number(s.fatigueLevel || s.fatigue) >= 8).length,
    unreadCoachReplyCount: submitted.filter(s => !String(s.coachFeedback || s.coachComment || '').trim()).length,
    attendanceDone: false,
    concern: buildConcern(submitted),
    missingNames: (missing || []).map(m => (m && (m.name || m)) || '').filter(Boolean).slice(0, 20),
    updatedAt: new Date().toISOString()
  };
}
function buildConcern(submitted) {
  return submitted.filter(s => s.status === 'red' || Number(s.painScore) >= 4 || (Number(s.sleepDurationMinutes) > 0 && Number(s.sleepDurationMinutes) < 360))
    .slice(0, 8)
    .map(s => ({
      name: s.name,
      level: (s.status === 'red' || Number(s.painScore) >= 6) ? 'red' : 'yellow',
      reason: concernReason(s)
    }));
}
function concernReason(s) {
  const parts = [];
  if (Number(s.painScore) >= 4) parts.push('疼痛偏高');
  if (s.status === 'red') parts.push('狀態紅燈');
  if (Number(s.sleepDurationMinutes) > 0 && Number(s.sleepDurationMinutes) < 360) parts.push('睡眠不足');
  if (Number(s.fatigueLevel || s.fatigue) >= 8) parts.push('疲勞偏高');
  return parts.join('、') || '需關心';
}
function demoSummary(date) {
  return {
    date,
    totalAthletes: 28,
    submittedCount: 25,
    notSubmittedCount: 3,
    redCount: 1,
    yellowCount: 3,
    greenCount: 21,
    painCount: 1,
    fatigueHighCount: 1,
    unreadCoachReplyCount: 6,
    attendanceDone: false,
    concern: [
      { name: '王小明', level: 'red', reason: '疼痛偏高、狀態紅燈' },
      { name: '陳柏鈞', level: 'yellow', reason: '睡眠不足' }
    ],
    missingNames: ['林冠霖', '張瀚忠', '李承恩'],
    updatedAt: new Date().toISOString()
  };
}

/* ============ 主畫面：今日三件事 ============ */
function renderSummary(root, s, stale, ctx, opts) {
  CURRENT = s;
  opts = opts || {};
  const rate = s.totalAthletes ? Math.round(s.submittedCount / s.totalAthletes * 100) : 0;
  const concern = s.concern || [];
  const redYellow = concern.length;
  const dispOpen = openDispositions().length;

  const banner = opts.noBackend
    ? '<div class="shell-sync-note" style="border-color:rgba(245,158,11,.4);background:rgba(245,158,11,.08);color:#fcd34d;">尚未設定後端網址，目前顯示範例資料。請至「更多 → 設定」由系統管理者填入後端網址。</div>'
    : opts.offline
      ? '<div class="shell-sync-note" style="border-color:rgba(245,158,11,.4);background:rgba(245,158,11,.08);color:#fcd34d;">目前無法連線到後端，已暫存並顯示上次資料，請稍後重新同步。</div>'
      : stale
        ? '<div class="shell-sync-note" id="dashSyncNote">已先顯示上次資料，正在更新最新狀態…</div>'
        : '<div class="shell-sync-note fresh" id="dashSyncNote">已更新最新狀態' + (opts.demo ? '（展示資料）' : '') + '</div>';

  root.innerHTML =
    banner +
    // ── 第一次使用任務 ──
    renderOnboarding() +
    // ── 今日三件事 ──
    '<h2 class="section-title">📌 今日三件事</h2>' +
    '<div class="three-things">' +
      // 1. 誰需要關心
      '<div class="shell-card tt-card ' + (redYellow ? 'tt-alert' : 'tt-ok') + '">' +
        '<div class="tt-head"><span class="tt-icon">' + (redYellow ? '🔴' : '🟢') + '</span><b>今天誰需要關心</b></div>' +
        (redYellow
          ? '<div class="tt-big">' + redYellow + ' <span class="tt-unit">位需關注</span></div>' +
            '<div class="concern-chips">' + concern.slice(0, 4).map((c, i) =>
              '<button class="concern-chip ' + c.level + '" data-concern="' + i + '">' +
                '<span class="dot"></span>' + esc(c.name) + '<small>' + esc(c.reason) + '</small></button>').join('') +
            '</div>' +
            '<button class="btn btn-sm btn-block tt-btn" id="ttOpenDisposition">記錄處置與追蹤</button>'
          : '<div class="tt-big-ok">全隊狀態穩</div><p class="muted">今天沒有人亮紅燈或黃燈。</p>') +
        (dispOpen ? '<div class="tt-followup" id="ttFollowupBadge">📋 追蹤中案件 ' + dispOpen + ' 件・點此查看</div>' : '') +
      '</div>' +
      // 2. 誰還沒回報
      '<div class="shell-card tt-card ' + (s.notSubmittedCount ? 'tt-warn' : 'tt-ok') + '">' +
        '<div class="tt-head"><span class="tt-icon">' + (s.notSubmittedCount ? '🟡' : '✅') + '</span><b>誰還沒回報 / 缺席</b></div>' +
        '<div class="tt-big">' + s.notSubmittedCount + ' <span class="tt-unit">位未回報</span></div>' +
        '<div class="summary-row"><span class="summary-pill">' + s.submittedCount + ' 已回報</span><span class="summary-pill">完成率 ' + rate + '%</span></div>' +
        (s.missingNames && s.missingNames.length
          ? '<p class="muted tt-names">' + s.missingNames.slice(0, 8).map(esc).join('、') + (s.missingNames.length > 8 ? '…' : '') + '</p>'
          : (s.notSubmittedCount ? '' : '<p class="muted">今天大家都回報了。</p>')) +
        '<button class="btn btn-sm btn-block tt-btn" id="ttGoAttendance">去點名 / 催回報</button>' +
      '</div>' +
      // 3. 傳給家長
      '<div class="shell-card tt-card tt-parent">' +
        '<div class="tt-head"><span class="tt-icon">💬</span><b>今天可以傳給家長</b></div>' +
        '<p class="muted">一鍵產生本週摘要，可直接貼到 LINE。<b>不含</b>其他學生姓名與敏感原始分數。</p>' +
        '<button class="btn btn-primary btn-sm btn-block tt-btn" id="ttParentSummary">產生今日家長摘要</button>' +
        '<div id="ttParentOut" class="parent-out hidden"></div>' +
      '</div>' +
    '</div>' +

    // ── 今日概況（次要）──
    '<h2 class="section-title">今日概況</h2>' +
    '<div class="shell-grid">' +
      '<div class="shell-card"><div class="muted">今日完成率</div><div class="metric-big">' + rate + '%</div>' +
        '<div class="summary-row"><span class="summary-pill">' + s.submittedCount + ' 已回報</span><span class="summary-pill">' + s.notSubmittedCount + ' 未回報</span></div></div>' +
      '<div class="shell-card"><div class="muted">紅黃綠燈摘要</div>' +
        '<div class="summary-row"><span class="summary-pill">🟢 ' + s.greenCount + ' 綠</span><span class="summary-pill">🟡 ' + s.yellowCount + ' 黃</span><span class="summary-pill">🔴 ' + s.redCount + ' 紅</span></div></div>' +
      '<div class="shell-card"><div class="muted">疼痛 / 疲勞警示</div>' +
        '<div class="summary-row"><span class="summary-pill">' + s.painCount + ' 疼痛≥4</span><span class="summary-pill">' + s.fatigueHighCount + ' 疲勞高</span><span class="summary-pill">' + s.unreadCoachReplyCount + ' 待回覆</span></div></div>' +
      '<div class="shell-card"><div class="muted">快速點名</div><p class="muted" style="margin:8px 0;">只載入必要名單，點擊後才進入點名。</p><button class="btn btn-primary btn-block" id="dashQuickAttendance">快速點名</button></div>' +
    '</div>' +

    // ── 隱私提醒 ──
    '<div class="privacy-note">🔒 疼痛、傷勢、睡眠、情緒等資料僅供教練關懷與訓練調整使用，不建議公開於群組或轉傳給非相關人員。家長通知請使用系統整理後的摘要。</div>' +

    // ── 系統健康檢查 ──
    renderHealth(s, opts) +

    // ── 處置追蹤區塊掛載點 ──
    '<div id="dispositionSection"></div>';

  // 事件綁定
  const bind = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
  bind('dashQuickAttendance', () => document.getElementById('quickAttendance').click());
  bind('ttGoAttendance', () => document.getElementById('quickAttendance').click());
  bind('ttOpenDisposition', () => openDispositionForm(null, ctx));
  bind('ttFollowupBadge', () => { renderDispositionSection(ctx); scrollToId('dispositionSection'); });
  bind('ttParentSummary', () => { markStep('parent'); toggleParentSummary(s); });
  bindOnboarding(ctx);
  bind('healthTest', () => testConnection());
  bind('healthRefresh', () => mountDashboard(ctx));
  document.querySelectorAll('[data-concern]').forEach(btn => {
    btn.onclick = () => {
      const c = concern[Number(btn.dataset.concern)];
      openDispositionForm(c, ctx);
    };
  });

  renderDispositionSection(ctx);
}

/* ============ 第一次使用任務 ============ */
const ONBOARD_STEPS = [
  { key: 'team', label: '建立團隊', hint: '先建立一支隊伍', tab: 'teams' },
  { key: 'athletes', label: '新增 3 位選手', hint: '把選手名單放進來', tab: 'athletes' },
  { key: 'link', label: '產生選手填寫連結', hint: '讓選手自己回報', tab: 'teams' },
  { key: 'attendance', label: '完成一次點名', hint: '10 秒點今天的名', tab: 'attendance' },
  { key: 'parent', label: '產生第一份家長摘要', hint: '一鍵產生安全摘要', action: 'parent' },
  { key: 'gap', label: '產生學校缺漏檢查表', hint: '看學校還缺什麼', href: 'school.html' }
];
function onboardState() {
  try { return JSON.parse(localStorage.getItem('teampro_onboard') || '{}'); } catch (e) { return {}; }
}
function markStep(key) {
  const st = onboardState();
  if (st[key]) return;
  st[key] = true;
  try { localStorage.setItem('teampro_onboard', JSON.stringify(st)); } catch (e) {}
}
function renderOnboarding() {
  const st = onboardState();
  if (st.dismissed) return '';
  const done = ONBOARD_STEPS.filter(s => st[s.key]).length;
  if (done >= ONBOARD_STEPS.length) return '';
  return '<details class="onboard-card" ' + (done === 0 ? 'open' : '') + '>' +
    '<summary>🚀 第一次使用任務（' + done + ' / ' + ONBOARD_STEPS.length + ' 完成）</summary>' +
    '<div class="onboard-list">' + ONBOARD_STEPS.map((s, i) => {
      const isDone = !!st[s.key];
      const status = isDone ? '<span class="status-chip done">已完成</span>' : '<span class="status-chip check">未開始</span>';
      return '<div class="onboard-step ' + (isDone ? 'done' : '') + '">' +
        '<span class="onboard-no">' + (i + 1) + '</span>' +
        '<div class="onboard-main"><b>' + esc(s.label) + '</b><small class="muted">' + esc(s.hint) + '</small></div>' +
        status +
        (isDone ? '' : '<button class="btn btn-sm onboard-go" data-obkey="' + s.key + '">去完成</button>') +
      '</div>';
    }).join('') + '</div>' +
    '<button class="btn btn-sm btn-ghost" id="onboardDismiss" style="margin-top:8px;">我已熟悉，關閉導引</button>' +
  '</details>';
}
function bindOnboarding(ctx) {
  document.querySelectorAll('.onboard-go').forEach(btn => {
    btn.onclick = (e) => {
      e.preventDefault();
      const key = btn.dataset.obkey;
      const step = ONBOARD_STEPS.find(s => s.key === key);
      if (!step) return;
      markStep(key);
      if (step.action === 'parent') { const b = document.getElementById('ttParentSummary'); if (b) b.click(); mountDashboard(ctx); return; }
      if (step.href) { location.href = step.href; return; }
      const q = document.getElementById('quickAttendance');
      if (step.tab === 'attendance' && q) { q.click(); return; }
      // 其他 tab：透過底部導航
      const nav = document.querySelector('#mobileTabbar button[data-tab="' + step.tab + '"]');
      if (nav) nav.click();
      else if (q) q.click();
    };
  });
  const d = document.getElementById('onboardDismiss');
  if (d) d.onclick = () => {
    const st = onboardState(); st.dismissed = true;
    try { localStorage.setItem('teampro_onboard', JSON.stringify(st)); } catch (e) {}
    const card = document.querySelector('.onboard-card'); if (card) card.remove();
  };
}

function scrollToId(id) {
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ============ 系統健康檢查 ============ */
function renderHealth(s, opts) {
  const lastSync = (() => {
    try { return localStorage.getItem('teampro_lastSyncAt'); } catch (e) { return null; }
  })();
  const online = !opts.offline && !opts.noBackend;
  const statusChip = opts.noBackend
    ? '<span class="status-chip check">未設定後端</span>'
    : online ? '<span class="status-chip done">連線正常</span>' : '<span class="status-chip missing">連線異常</span>';
  const unsynced = opts.offline ? '<span class="status-chip check">有暫存未同步資料</span>' : '<span class="status-chip done">無</span>';
  return '<details class="health-card"><summary>🩺 系統健康檢查</summary>' +
    '<div class="health-grid">' +
      '<div><span class="muted">後端連線</span>' + statusChip + '</div>' +
      '<div><span class="muted">最後成功同步</span><b>' + esc(fmtTime(lastSync)) + '</b></div>' +
      '<div><span class="muted">今日已同步筆數</span><b>' + (s.submittedCount || 0) + ' 筆</b></div>' +
      '<div><span class="muted">未同步資料</span>' + unsynced + '</div>' +
      '<div><span class="muted">系統版本</span><b>' + APP_VERSION + '</b></div>' +
    '</div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">' +
      '<button class="btn btn-sm" id="healthTest">測試連線</button>' +
      '<button class="btn btn-sm btn-ghost" id="healthRefresh">重新同步</button>' +
    '</div>' +
    '<div id="healthResult" class="muted" style="margin-top:6px;font-size:13px;"></div>' +
  '</details>';
}
function fmtTime(iso) {
  if (!iso) return '尚無紀錄';
  try {
    const d = new Date(iso);
    return d.getFullYear() + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getDate()).padStart(2, '0') +
      ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  } catch (e) { return '—'; }
}
async function testConnection() {
  const out = document.getElementById('healthResult');
  if (out) out.textContent = '測試連線中…';
  if (!TP.getUrl()) { if (out) out.textContent = '⚠ 尚未設定後端網址，請至「更多 → 設定」。'; return; }
  const r = await TP.callAuth('me');
  if (r && r.ok) { if (out) out.textContent = '✅ 後端連線正常。'; try { localStorage.setItem('teampro_lastSyncAt', new Date().toISOString()); } catch (e) {} }
  else { if (out) out.textContent = '❌ 目前無法連線到後端，已暫存資料，請稍後重新同步。'; }
}

/* ============ 家長安全摘要 ============ */
function toggleParentSummary(s) {
  const box = document.getElementById('ttParentOut');
  if (!box) return;
  if (!box.classList.contains('hidden')) { box.classList.add('hidden'); return; }
  const rate = s.totalAthletes ? Math.round(s.submittedCount / s.totalAthletes * 100) : 0;
  const text = buildParentSummary(rate);
  box.innerHTML =
    '<div class="parent-preview">' + esc(text).replace(/\n/g, '<br>') + '</div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">' +
      '<button class="btn btn-sm btn-primary" id="ttParentCopy">複製文字</button>' +
      '<button class="btn btn-sm btn-ghost" id="ttParentClose">收合</button>' +
    '</div>' +
    '<p class="muted" style="font-size:12px;margin-top:6px;">此摘要不含其他學生姓名、心理原始分數、體重與傷勢細節，適合貼到 LINE 群組或私訊。</p>';
  box.classList.remove('hidden');
  document.getElementById('ttParentCopy').onclick = () => {
    if (TP.copy) TP.copy(text); else navigator.clipboard && navigator.clipboard.writeText(text);
    TP.toast && TP.toast('已複製，可貼到 LINE');
  };
  document.getElementById('ttParentClose').onclick = () => box.classList.add('hidden');
}
function buildParentSummary(rate) {
  const attendLine = rate >= 90 ? '本週訓練出席穩定，表現值得肯定。'
    : rate >= 70 ? '本週訓練大致穩定，出席狀況良好。'
    : '本週有幾次未完成回報，會再多提醒孩子。';
  return '家長您好：\n' +
    attendLine + '\n' +
    '本週亮點：孩子在訓練中態度認真、願意配合完成訓練任務。\n' +
    '教練觀察：整體狀態穩定，會持續協助加強技術細節與訓練節奏。\n' +
    '需要家長協助：近期訓練量較高，請協助孩子注意睡眠與恢復、規律作息。\n' +
    '下週提醒：會持續觀察孩子的訓練狀況，若有個別需要會再私訊與您聯繫。\n' +
    '（本訊息由 TeamPro 系統整理，僅供家長參考。）';
}

/* ============ 紅黃綠燈處置流程 ============ */
function dispKey() {
  const k = CURRENT_CTX && CURRENT_CTX.coachKey ? CURRENT_CTX.coachKey() : 'coach';
  return 'teampro_dispositions_' + k;
}
function loadDispositions() {
  try { return JSON.parse(localStorage.getItem(dispKey()) || '[]'); } catch (e) { return []; }
}
function saveDispositions(list) {
  try { localStorage.setItem(dispKey(), JSON.stringify(list)); } catch (e) {}
}
function openDispositions() {
  return loadDispositions().filter(d => d.status !== 'closed');
}

const DISP_TYPES = ['疼痛', '疲勞', '情緒', '缺席', '睡眠', '態度', '其他'];
const DISP_STATUS = { open: '待處理', tracking: '追蹤中', closed: '已結案' };

function openDispositionForm(concern, ctx, existing) {
  const name = existing ? existing.name : (concern ? concern.name : '');
  const level = existing ? existing.level : (concern ? concern.level : 'yellow');
  const overlay = document.createElement('div');
  overlay.className = 'disp-overlay';
  overlay.innerHTML =
    '<div class="disp-modal">' +
      '<div class="disp-modal-head"><b>' + (existing ? '更新處置紀錄' : '新增處置與追蹤') + '</b>' +
        '<button class="disp-x" id="dispClose">✕</button></div>' +
      (concern && concern.reason ? '<div class="disp-reason">異常原因：' + esc(concern.reason) + '</div>' : '') +
      '<label>選手姓名</label><input id="dispName" value="' + esc(name) + '" placeholder="輸入選手姓名">' +
      '<label>異常類型</label>' +
      '<div class="disp-chips" id="dispType">' + DISP_TYPES.map((t, i) =>
        '<button type="button" class="disp-chip' + ((existing && existing.type === t) || (!existing && i === 0) ? ' sel' : '') + '" data-type="' + t + '">' + t + '</button>').join('') + '</div>' +
      '<label>異常程度</label>' +
      '<div class="disp-chips" id="dispLevel">' +
        '<button type="button" class="disp-chip lv-yellow' + (level !== 'red' ? ' sel' : '') + '" data-level="yellow">🟡 黃燈</button>' +
        '<button type="button" class="disp-chip lv-red' + (level === 'red' ? ' sel' : '') + '" data-level="red">🔴 紅燈</button>' +
      '</div>' +
      '<label>教練處置內容</label><textarea id="dispAction" placeholder="例：已詢問疼痛部位，今日改輕量訓練，觀察兩天。">' + (existing ? esc(existing.action || '') : '') + '</textarea>' +
      '<label class="disp-check"><input type="checkbox" id="dispNotify"' + (existing && existing.notifyParent ? ' checked' : '') + '> 已通知家長</label>' +
      '<label>下次追蹤日期</label><input type="date" id="dispFollow" value="' + (existing ? esc(existing.followUpDate || '') : nextWeek()) + '">' +
      '<label>結案狀態</label>' +
      '<div class="disp-chips" id="dispState">' +
        Object.keys(DISP_STATUS).map(k =>
          '<button type="button" class="disp-chip' + ((existing ? existing.status : 'open') === k ? ' sel' : '') + '" data-state="' + k + '">' + DISP_STATUS[k] + '</button>').join('') + '</div>' +
      '<div class="disp-actions">' +
        '<button class="btn btn-primary btn-block" id="dispSave">儲存</button>' +
        (existing ? '<button class="btn btn-ghost btn-sm" id="dispDelete">刪除此紀錄</button>' : '') +
      '</div>' +
    '</div>';
  document.body.appendChild(overlay);

  let selType = existing ? existing.type : DISP_TYPES[0];
  let selLevel = level;
  let selState = existing ? existing.status : 'open';
  overlay.querySelectorAll('#dispType .disp-chip').forEach(b => b.onclick = () => {
    overlay.querySelectorAll('#dispType .disp-chip').forEach(x => x.classList.remove('sel'));
    b.classList.add('sel'); selType = b.dataset.type;
  });
  overlay.querySelectorAll('#dispLevel .disp-chip').forEach(b => b.onclick = () => {
    overlay.querySelectorAll('#dispLevel .disp-chip').forEach(x => x.classList.remove('sel'));
    b.classList.add('sel'); selLevel = b.dataset.level;
  });
  overlay.querySelectorAll('#dispState .disp-chip').forEach(b => b.onclick = () => {
    overlay.querySelectorAll('#dispState .disp-chip').forEach(x => x.classList.remove('sel'));
    b.classList.add('sel'); selState = b.dataset.state;
  });
  const close = () => overlay.remove();
  overlay.querySelector('#dispClose').onclick = close;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  const del = overlay.querySelector('#dispDelete');
  if (del) del.onclick = () => {
    const list = loadDispositions().filter(d => d.id !== existing.id);
    saveDispositions(list); close(); renderDispositionSection(ctx);
    TP.toast && TP.toast('已刪除');
  };
  overlay.querySelector('#dispSave').onclick = () => {
    const nm = overlay.querySelector('#dispName').value.trim();
    if (!nm) { TP.toast && TP.toast('請輸入選手姓名', true); return; }
    const record = {
      id: existing ? existing.id : ('d' + Date.now()),
      name: nm,
      type: selType,
      level: selLevel,
      action: overlay.querySelector('#dispAction').value.trim(),
      notifyParent: overlay.querySelector('#dispNotify').checked,
      followUpDate: overlay.querySelector('#dispFollow').value,
      status: selState,
      createdAt: existing ? existing.createdAt : new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    let list = loadDispositions();
    if (existing) list = list.map(d => d.id === existing.id ? record : d);
    else list.unshift(record);
    saveDispositions(list);
    close();
    renderDispositionSection(ctx);
    scrollToId('dispositionSection');
    TP.toast && TP.toast('已儲存處置紀錄');
  };
}

function nextWeek() {
  const d = new Date(); d.setDate(d.getDate() + 3);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function renderDispositionSection(ctx) {
  const host = document.getElementById('dispositionSection');
  if (!host) return;
  const list = loadDispositions();
  if (!list.length) {
    host.innerHTML = '<div class="shell-card"><div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">' +
      '<b>🗂 處置與追蹤紀錄</b><button class="btn btn-sm" id="dispAddEmpty">新增紀錄</button></div>' +
      '<p class="muted" style="margin-top:8px;">點紅黃燈選手即可建立處置紀錄，這裡會保留完整歷史，評鑑輔導紀錄不用臨時補。</p></div>';
    const b = document.getElementById('dispAddEmpty'); if (b) b.onclick = () => openDispositionForm(null, ctx);
    return;
  }
  const badge = (st) => '<span class="status-chip ' + (st === 'closed' ? 'done' : st === 'tracking' ? 'evidence' : 'check') + '">' + DISP_STATUS[st] + '</span>';
  host.innerHTML = '<div class="shell-card"><div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">' +
    '<b>🗂 處置與追蹤紀錄</b><button class="btn btn-sm" id="dispAdd">新增紀錄</button></div>' +
    '<div class="disp-list">' + list.map(d =>
      '<div class="disp-item" data-id="' + d.id + '">' +
        '<div class="disp-item-top"><span class="dot ' + (d.level === 'red' ? 'red' : 'yellow') + '"></span>' +
          '<b>' + esc(d.name) + '</b><span class="disp-type">' + esc(d.type) + '</span>' + badge(d.status) + '</div>' +
        (d.action ? '<div class="disp-item-action muted">' + esc(d.action) + '</div>' : '<div class="disp-item-action muted">尚未填寫處置內容</div>') +
        '<div class="disp-item-meta muted">' +
          (d.notifyParent ? '✅ 已通知家長' : '⬜ 未通知家長') +
          ' ・ 下次追蹤：' + esc(d.followUpDate || '未設定') + '</div>' +
      '</div>').join('') +
    '</div></div>';
  const add = document.getElementById('dispAdd'); if (add) add.onclick = () => openDispositionForm(null, ctx);
  host.querySelectorAll('.disp-item').forEach(item => {
    item.onclick = () => {
      const rec = loadDispositions().find(d => d.id === item.dataset.id);
      if (rec) openDispositionForm({ name: rec.name, level: rec.level, reason: '' }, ctx, rec);
    };
  });
}
