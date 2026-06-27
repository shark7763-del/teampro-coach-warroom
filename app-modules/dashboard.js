import { escapeHtml } from './legacy-frame.js';

export async function mountDashboard(ctx) {
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
    renderSummary(root, demo, !!cached, ctx);
    return;
  }
  const r = await TP.callAuth('warroom', { teamId, date });
  if (!r || !r.ok) {
    if (cached) {
      const note = document.getElementById('dashSyncNote');
      if (note) note.textContent = '更新失敗，目前顯示上次資料。';
      return;
    }
    root.innerHTML = '<div class="shell-card">今日戰情室載入失敗。<button class="btn btn-sm" id="dashRetry">重新整理</button></div>';
    document.getElementById('dashRetry').onclick = () => mountDashboard(ctx);
    return;
  }
  const summary = toTodaySummary(r, date);
  writeSummary(cacheKey, summary);
  renderSummary(root, summary, false, ctx);
}

function skeleton() {
  return '<div class="shell-grid">' +
    '<div class="shell-card"><div class="muted">今日完成率</div><div class="skel w-40"></div><div class="skel w-70"></div></div>' +
    '<div class="shell-card"><div class="muted">紅黃綠燈</div><div class="skel w-90"></div><div class="skel w-70"></div></div>' +
    '<div class="shell-card"><div class="muted">疼痛 / 疲勞警示</div><div class="skel w-70"></div><div class="skel w-40"></div></div>' +
    '<div class="shell-card"><div class="muted">快速點名</div><div class="skel w-90"></div><div class="skel w-40"></div></div>' +
  '</div>';
}

function readSummary(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; }
}
function writeSummary(key, summary) {
  try { localStorage.setItem(key, JSON.stringify(summary)); } catch (e) {}
  try { localStorage.setItem('teampro_lastTodaySummary', JSON.stringify(summary)); } catch (e) {}
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
    concernNames: submitted.filter(s => s.status === 'red' || Number(s.painScore) >= 4 || (Number(s.sleepDurationMinutes) > 0 && Number(s.sleepDurationMinutes) < 360)).slice(0, 5).map(s => s.name),
    updatedAt: new Date().toISOString()
  };
}
function demoSummary(date) {
  return {
    date,
    totalAthletes: 28,
    submittedCount: 27,
    notSubmittedCount: 1,
    redCount: 0,
    yellowCount: 3,
    greenCount: 24,
    painCount: 0,
    fatigueHighCount: 1,
    unreadCoachReplyCount: 9,
    attendanceDone: false,
    concernNames: [],
    updatedAt: new Date().toISOString()
  };
}
function renderSummary(root, s, stale, ctx) {
  const rate = s.totalAthletes ? Math.round(s.submittedCount / s.totalAthletes * 100) : 0;
  const concern = s.concernNames || [];
  root.innerHTML =
    (stale ? '<div class="shell-sync-note" id="dashSyncNote">已先顯示上次資料，正在更新最新狀態…</div>' : '<div class="shell-sync-note fresh" id="dashSyncNote">已更新最新狀態</div>') +
    '<div class="shell-grid">' +
      '<div class="shell-card"><div class="muted">今日完成率</div><div class="metric-big">' + rate + '%</div>' +
        '<div class="summary-row"><span class="summary-pill">' + s.submittedCount + ' 已回報</span><span class="summary-pill">' + s.notSubmittedCount + ' 未回報</span></div></div>' +
      '<div class="shell-card"><div class="muted">紅黃綠燈摘要</div>' +
        '<div class="summary-row"><span class="summary-pill">🟢 ' + s.greenCount + ' 綠</span><span class="summary-pill">🟡 ' + s.yellowCount + ' 黃</span><span class="summary-pill">🔴 ' + s.redCount + ' 紅</span></div></div>' +
      '<div class="shell-card"><div class="muted">疼痛 / 疲勞警示</div>' +
        '<div class="summary-row"><span class="summary-pill">' + s.painCount + ' 疼痛≥4</span><span class="summary-pill">' + s.fatigueHighCount + ' 疲勞高</span><span class="summary-pill">' + s.unreadCoachReplyCount + ' 待回覆</span></div></div>' +
      '<div class="shell-card"><div class="muted">快速點名</div><p class="muted" style="margin:8px 0;">只載入必要名單，點擊後才進入點名。</p><button class="btn btn-primary btn-block" id="dashQuickAttendance">快速點名</button></div>' +
    '</div>' +
    '<div class="shell-card" style="margin-top:12px;"><div style="display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap;">' +
      '<div><b>今日需要先處理</b><div class="muted" style="font-size:13px;">紅燈、疼痛 ≥ 4、睡眠不足會排在這裡。</div></div>' +
      '<button class="btn btn-sm" id="dashRefresh">重新整理</button></div>' +
      (concern.length ? '<div class="priority-list">' + concern.map(name => '<div class="priority-item"><b>' + escapeHtml(name) + '</b><span class="muted">需關心</span></div>').join('') + '</div>' : '<p class="muted">今天沒有人亮紅燈，全隊狀態穩。</p>') +
    '</div>';
  document.getElementById('dashRefresh').onclick = () => mountDashboard(ctx);
  document.getElementById('dashQuickAttendance').onclick = () => document.getElementById('quickAttendance').click();
}
