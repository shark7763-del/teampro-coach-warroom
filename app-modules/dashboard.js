import { escapeHtml } from './legacy-frame.js';

export async function mountDashboard(ctx) {
  const root = document.getElementById('dashboardMount');
  root.innerHTML = skeleton();
  const teams = await ctx.ensureTeams();
  const teamId = (document.getElementById('dashTeam') && document.getElementById('dashTeam').value) || '';
  const date = ctx.today();
  const r = await TP.callAuth('warroom', { teamId, date });
  if (!r || !r.ok) {
    root.innerHTML = '<div class="shell-card">今日戰情室載入失敗。<button class="btn btn-sm" id="dashRetry">重新整理</button></div>';
    document.getElementById('dashRetry').onclick = () => mountDashboard(ctx);
    return;
  }
  render(root, r, teams, ctx);
}

function skeleton() {
  return '<div class="shell-grid">' +
    '<div class="shell-card"><div class="skel w-40"></div><div class="skel w-90"></div></div>' +
    '<div class="shell-card"><div class="skel w-40"></div><div class="skel w-70"></div></div>' +
    '<div class="shell-card"><div class="skel w-40"></div><div class="skel w-90"></div></div>' +
  '</div>';
}

function render(root, r, teams, ctx) {
  const submitted = r.submitted || [];
  const missing = r.missing || [];
  const red = (r.lights && r.lights.red) || 0;
  const yellow = (r.lights && r.lights.yellow) || 0;
  const green = (r.lights && r.lights.green) || 0;
  const concern = submitted.filter(s =>
    s.status === 'red' ||
    Number(s.painScore) >= 4 ||
    (Number(s.sleepDurationMinutes) > 0 && Number(s.sleepDurationMinutes) < 360)
  ).slice(0, 6);
  root.innerHTML =
    '<div class="shell-grid">' +
      '<div class="shell-card"><div class="muted">今日完成率</div><div class="metric-big">' + Number(r.completionRate || 0) + '%</div>' +
        '<div class="summary-row"><span class="summary-pill">' + submitted.length + ' 已回報</span><span class="summary-pill">' + missing.length + ' 未回報</span></div></div>' +
      '<div class="shell-card"><div class="muted">紅黃綠燈摘要</div>' +
        '<div class="summary-row"><span class="summary-pill">🟢 ' + green + ' 綠</span><span class="summary-pill">🟡 ' + yellow + ' 黃</span><span class="summary-pill">🔴 ' + red + ' 紅</span></div></div>' +
      '<div class="shell-card"><div class="muted">尚未回報</div>' +
        (missing.length ? '<div class="priority-list">' + missing.slice(0, 5).map(m => '<div class="priority-item"><b>' + escapeHtml(m.name) + '</b><span class="muted">尚未回報</span></div>').join('') + '</div>' : '<p>✅ 今日全員已完成回報</p>') +
      '</div>' +
    '</div>' +
    '<div class="shell-card" style="margin-top:12px;"><div style="display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap;">' +
      '<div><b>今日需要先處理</b><div class="muted" style="font-size:13px;">紅燈、疼痛 ≥ 4、睡眠不足會排在這裡。</div></div>' +
      '<button class="btn btn-sm" id="dashRefresh">重新整理</button></div>' +
      (concern.length ? '<div class="priority-list">' + concern.map(s => '<div class="priority-item"><b>' + escapeHtml(s.name) + '</b><span class="muted">' + escapeHtml(TP.lightText(s.status || 'green')) + '</span></div>').join('') + '</div>' : '<p class="muted">今天沒有人亮紅燈，全隊狀態穩。</p>') +
    '</div>';
  document.getElementById('dashRefresh').onclick = () => mountDashboard(ctx);
}
