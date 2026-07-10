import { escapeHtml } from './legacy-frame.js';

const APP_VERSION = 'v2026.07.04';
const esc = escapeHtml;

let CURRENT = null; // 最近一次摘要，供家長摘要/健康檢查使用
let CURRENT_CTX = null;

export async function mountDashboard(ctx) {
  CURRENT_CTX = ctx;
  injectReadinessCss();
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
    athletes: submitted.map(normalizeAthlete),
    missingNames: (missing || []).map(m => (m && (m.name || m)) || '').filter(Boolean).slice(0, 20),
    updatedAt: new Date().toISOString()
  };
}

/* 把 warroom 回傳的逐人資料正規化成狀態卡需要的欄位（多種欄名防呆） */
function normalizeAthlete(s) {
  s = s || {};
  return {
    athleteId: String(s.athleteId || s.id || s.name || ''),
    recordId: String(s.recordId || ''),
    name: s.name || '',
    group: s.group || s.teamName || '',
    status: s.status || s.lightStatus || 'green',
    painScore: numOr0(s.painScore),
    painImpact: s.painImpact || '',
    painAreas: s.painAreas || s.injuryAreas || '',
    sleepMin: numOr0(s.sleepDurationMinutes),
    sleepText: s.sleepDurationText || '',
    fatigue: numOr0(s.fatigueLevel != null ? s.fatigueLevel : s.fatigue),
    mood: numOr0(s.mood != null ? s.mood : s.moodIndex),
    motivation: numOr0(s.motivation),
    expectedCompletion: s.expectedCompletion === 0 ? 0 : numOr0(s.expectedCompletion),
    athleteMessage: s.athleteMessage || '',
    hydrationRisk: s.hydrationRisk || '',
    declining: !!s.declining,
    coachReplyStatus: s.coachReplyStatus || (String(s.coachFeedback || s.coachComment || '').trim() ? 'replied' : 'none'),
    coachFeedback: s.coachFeedback || s.coachComment || '',
    coachDecision: s.coachDecision || '',
    coachSuggestion: s.coachSuggestion || '',
    quality: s.reportQualityLabel || ''
  };
}
function numOr0(v) { const n = Number(v); return isNaN(n) ? 0 : n; }
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
      { name: '許晨熙', level: 'red', reason: '疼痛偏高、狀態紅燈' },
      { name: '王柏鈞', level: 'yellow', reason: '睡眠不足、連續疲勞' }
    ],
    athletes: [
      { athleteId: 'd_sc', recordId: 'd_sc', name: '許晨熙', group: '對打組', status: 'red', painScore: 8, painImpact: '影響旋踢', painAreas: '右大腿', sleepMin: 300, fatigue: 5, mood: 2, motivation: 2, expectedCompletion: 40, athleteMessage: '右大腿旋踢時會痛，昨天練完更明顯。', declining: true, coachReplyStatus: 'none', coachFeedback: '' },
      { athleteId: 'd_wpj', recordId: 'd_wpj', name: '王柏鈞', group: '對打組', status: 'yellow', painScore: 6, painImpact: '踢擊時緊繃', painAreas: '右大腿', sleepMin: 330, fatigue: 4, mood: 3, motivation: 3, expectedCompletion: 70, athleteMessage: '睡不太好，但想練。', declining: true, coachReplyStatus: 'none', coachFeedback: '' },
      { athleteId: 'd_lch', recordId: 'd_lch', name: '劉承翰', group: '品勢組', status: 'yellow', painScore: 0, painImpact: '', sleepMin: 345, fatigue: 4, mood: 3, motivation: 4, expectedCompletion: 85, athleteMessage: '', declining: false, coachReplyStatus: 'none', coachFeedback: '' },
      { athleteId: 'd_thx', recordId: 'd_thx', name: '唐霈昕', group: '品勢組', status: 'green', painScore: 0, painImpact: '', sleepMin: 465, fatigue: 2, mood: 5, motivation: 5, expectedCompletion: 100, athleteMessage: '今天狀態很好！', declining: false, coachReplyStatus: 'replied', coachFeedback: '保持這個狀態，很好！', coachDecision: '正常訓練' },
      { athleteId: 'd_cyt', recordId: 'd_cyt', name: '陳宥廷', group: '對打組', status: 'green', painScore: 0, painImpact: '', sleepMin: 450, fatigue: 2, mood: 4, motivation: 4, expectedCompletion: 95, athleteMessage: '', declining: false, coachReplyStatus: 'none', coachFeedback: '' }
    ].map(normalizeAthlete),
    missingNames: ['林冠霖', '張瀚忠', '李承恩'],
    updatedAt: new Date().toISOString()
  };
}

/* ============ 主畫面：今日戰情室（逐人狀態卡） ============ */
function renderSummary(root, s, stale, ctx, opts) {
  CURRENT = s;
  opts = opts || {};
  const date = s.date;
  const rate = s.totalAthletes ? Math.round(s.submittedCount / s.totalAthletes * 100) : 0;
  const dispOpen = openDispositions().length;

  // 逐人準備度計算 + 依關注優先度排序
  const ath = (s.athletes || []).map(a => ({ a, r: computeReadiness(a) }));
  ath.sort((x, y) => y.r.priority - x.r.priority);
  const avg = ath.length ? Math.round(ath.reduce((n, o) => n + o.r.score, 0) / ath.length) : 0;
  const concernCount = ath.filter(o => o.r.level !== 'green').length;
  const replyPending = (s.athletes || []).filter(a =>
    a.coachReplyStatus !== 'replied' && !((getDecision(a.athleteId, date) || {}).reply)).length;

  const banner = opts.noBackend
    ? '<div class="shell-sync-note" style="border-color:rgba(245,158,11,.4);background:rgba(245,158,11,.08);color:#fcd34d;">尚未設定後端網址，目前顯示範例資料。請至「更多 → 設定」由系統管理者填入後端網址。</div>'
    : opts.offline
      ? '<div class="shell-sync-note" style="border-color:rgba(245,158,11,.4);background:rgba(245,158,11,.08);color:#fcd34d;">目前無法連線到後端，已暫存並顯示上次資料，請稍後重新同步。</div>'
      : stale
        ? '<div class="shell-sync-note" id="dashSyncNote">已先顯示上次資料，正在更新最新狀態…</div>'
        : '<div class="shell-sync-note fresh" id="dashSyncNote">已更新最新狀態' + (opts.demo ? '（展示資料）' : '') + '</div>';

  // 置頂一句話摘要
  const headline = concernCount || s.notSubmittedCount || replyPending
    ? '今天有 <b>' + concernCount + '</b> 位需要優先關注、<b>' + s.notSubmittedCount + '</b> 位尚未回報、<b>' + replyPending + '</b> 位等待教練回覆。'
    : '全隊今天狀態穩定，沒有需要優先處理的選手。';

  root.innerHTML =
    banner +
    renderOnboarding() +
    // ── 今日戰情室標題 + 一句話 ──
    '<div class="war-headline">' + headline + '</div>' +
    // ── 置頂摘要條 ──
    '<div class="tp-summary-bar">' +
      metricTile(s.totalAthletes, '全隊人數') +
      metricTile(s.submittedCount, '已回報') +
      metricTile(s.notSubmittedCount, '未回報', s.notSubmittedCount ? 'warn' : '') +
      metricTile(concernCount, '需要注意', concernCount ? 'alert' : '') +
      metricTile(replyPending, '待回覆', replyPending ? 'warn' : '') +
      metricTile(avg || '—', '今日平均準備度') +
    '</div>' +
    '<div class="summary-actions">' +
      '<button class="btn btn-primary btn-sm" id="warAttendance">快速點名 / 催回報</button>' +
      (dispOpen ? '<button class="btn btn-sm btn-ghost" id="ttFollowupBadge">📋 追蹤中案件 ' + dispOpen + ' 件</button>' : '') +
    '</div>' +
    (s.missingNames && s.missingNames.length
      ? '<p class="muted war-missing">尚未回報：' + s.missingNames.slice(0, 10).map(esc).join('、') + (s.missingNames.length > 10 ? ' …' : '') + '</p>'
      : '') +

    // ── 逐人今日狀態卡 ──
    '<h2 class="section-title">🎯 今日選手狀態</h2>' +
    (ath.length
      ? ath.map(o => renderAthleteCard(o.a, o.r, date)).join('')
      : '<div class="empty-state"><p>今天還沒有選手回報。</p><button class="btn btn-sm" id="warAttendance2">去點名 / 催回報</button></div>') +

    // ── 傳給家長 ──
    '<h2 class="section-title">💬 今天可以傳給家長</h2>' +
    '<div class="shell-card tt-parent">' +
      '<p class="muted">一鍵產生本週摘要，可直接貼到 LINE。<b>不含</b>其他學生姓名與敏感原始分數。</p>' +
      '<button class="btn btn-primary btn-sm" id="ttParentSummary">產生今日家長摘要</button>' +
      '<div id="ttParentOut" class="parent-out hidden"></div>' +
    '</div>' +

    // ── 隱私提醒 ──
    '<div class="privacy-note">🔒 疼痛、傷勢、睡眠、情緒等資料僅供教練關懷與訓練調整使用，不建議公開於群組或轉傳給非相關人員。家長通知請使用系統整理後的摘要。</div>' +

    // ── 系統健康檢查 ──
    renderHealth(s, opts) +

    // ── 處置追蹤區塊掛載點 ──
    '<div id="dispositionSection"></div>' +

    // ── 行政 / 評鑑入口（降級收納）──
    renderAdminEntry();

  // 事件綁定
  const bind = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
  const goAttendance = () => document.getElementById('quickAttendance').click();
  bind('warAttendance', goAttendance);
  bind('warAttendance2', goAttendance);
  bind('ttFollowupBadge', () => { renderDispositionSection(ctx); scrollToId('dispositionSection'); });
  bind('ttParentSummary', () => { markStep('parent'); toggleParentSummary(s); });
  bindOnboarding(ctx);
  bind('healthTest', () => testConnection());
  bind('healthRefresh', () => mountDashboard(ctx));
  bindAthleteCards(root, ctx, date);

  renderDispositionSection(ctx);
}

/* ============ 今日準備度評分（前端規則引擎） ============ */
// 依 warroom 現有資料算 0–100「今日訓練準備度」，並給出扣分原因與訓練建議。
function computeReadiness(a) {
  a = a || {};
  let score = 100;
  const reasons = [];
  const pain = numOr0(a.painScore);
  const impact = !!(a.painImpact && !/不影響|沒有|無|否|none|no/i.test(String(a.painImpact)));
  if (pain >= 7) { score -= 28; reasons.push('疼痛偏高（' + pain + '/10）'); }
  else if (pain >= 4) { score -= 15; reasons.push('疼痛中等（' + pain + '/10）'); }
  if (impact) { score -= 10; reasons.push('疼痛影響動作' + (a.painAreas ? '（' + a.painAreas + '）' : '')); }
  const sm = numOr0(a.sleepMin);
  if (sm > 0 && sm < 300) { score -= 20; reasons.push('睡眠嚴重不足（' + hoursText(sm) + '）'); }
  else if (sm > 0 && sm < 360) { score -= 12; reasons.push('睡眠不足（' + hoursText(sm) + '）'); }
  const f10 = fatigueTo10(a.fatigue);
  if (f10 >= 8) { score -= 15; reasons.push('疲勞偏高'); }
  else if (f10 >= 6) { score -= 8; reasons.push('疲勞中等'); }
  if (String(a.hydrationRisk) === 'red') { score -= 8; reasons.push('水分不足'); }
  const mood = numOr0(a.mood);
  if (mood && mood <= 2) { score -= 8; reasons.push('情緒 / 心情偏低'); }
  const moti = numOr0(a.motivation);
  if (moti && moti <= 2) { score -= 8; reasons.push('訓練動機偏低'); }
  const canTrain = (typeof a.expectedCompletion === 'number' && a.expectedCompletion > 0) ? a.expectedCompletion : null;
  const cantTrain = canTrain !== null && canTrain <= 30;
  if (canTrain !== null && canTrain <= 50) { score -= 10; reasons.push('自評今日僅能完成約 ' + canTrain + '% 訓練'); }
  if (a.declining) { score -= 6; reasons.push('近期狀態連續下降'); }
  if (String(a.status) === 'red' || cantTrain) score = Math.min(score, 62);
  score = Math.max(0, Math.min(100, Math.round(score)));

  // 分級（含安全覆蓋：高疼痛一律列優先關注）
  let level, bandLabel;
  if (score >= 85) { level = 'green'; bandLabel = '狀態良好'; }
  else if (score >= 70) { level = 'green'; bandLabel = '基本穩定'; }
  else if (score >= 50) { level = 'yellow'; bandLabel = '需要調整'; }
  else { level = 'red'; bandLabel = '優先關注'; }
  if (pain >= 7 || (impact && pain >= 4) || cantTrain || String(a.status) === 'red') { level = 'red'; bandLabel = '優先關注'; }

  let priority = 100 - score;
  if (pain >= 7 || impact) priority += 100;
  if (String(a.status) === 'red') priority += 60;
  if (a.declining) priority += 30;

  return { score, level, bandLabel, reasons, priority, suggestion: readinessSuggestion(a, { level, score }) };
}
function fatigueTo10(f) { f = numOr0(f); if (!f) return 0; return f <= 5 ? f * 2 : f; }
function hoursText(min) { return (Math.round(min / 6) / 10) + ' 小時'; }
function readinessSuggestion(a, r) {
  const pain = numOr0(a.painScore);
  if (pain >= 7) return '訓練前先確認疼痛部位與活動範圍，今日降低高強度踢擊 / 衝刺量，改以技術修正、低衝擊腳步與恢復為主，訓練後再次確認疼痛變化。';
  if (pain >= 4) return '今日留意疼痛部位，避免重複刺激，適度降低爆發動作量，訓練後確認是否加重。';
  if (numOr0(a.sleepMin) > 0 && numOr0(a.sleepMin) < 360) return '睡眠不足，加強熱身與收操，降低最大強度衝刺，注意訓練中專注度與安全。';
  if (fatigueTo10(a.fatigue) >= 8) return '疲勞偏高，建議降低訓練量一級，安排恢復與伸展，觀察隔日恢復狀況。';
  if (r.level === 'green' && r.score >= 85) return '狀態良好，可依原訂計畫正常訓練，維持節奏並持續累積。';
  return '狀態大致穩定，依原訂計畫訓練，留意個別回報的疲勞與睡眠訊號。';
}

/* ============ 逐人今日狀態卡 ============ */
const DECISIONS = ['正常訓練', '降低強度一級', '降低強度兩級', '改技術訓練', '改恢復訓練', '暫停部分動作', '訓練前面談', '持續觀察', '建議進一步評估', '自訂'];

function avatarInitial(name) {
  const ch = String(name || '?').trim().slice(-1) || '?';
  return '<span class="ath-ava">' + esc(ch) + '</span>';
}
function renderAthleteCard(a, r, date) {
  const dec = getDecision(a.athleteId, date) || {};
  // 後端已回覆/已決策（教練在別台裝置或上次已處理）也算數
  const decided = dec.decision || a.coachDecision || '';
  const replied = dec.reply || a.coachFeedback || '';
  const sleepDisp = a.sleepMin ? hoursText(a.sleepMin) : '—';
  const fatDisp = a.fatigue ? (fatigueTo10(a.fatigue) + '/10') : '—';
  const painDisp = a.painScore ? (a.painScore + '/10' + (a.painAreas ? '・' + a.painAreas : '')) : '0';
  const motiDisp = a.motivation ? (a.motivation + '/5') : '—';
  return '<div class="ath-card lv-' + r.level + '" data-aid="' + esc(a.athleteId) + '" data-rid="' + esc(a.recordId || '') + '" data-aisug="' + esc(r.suggestion) + '">' +
    '<div class="ath-head">' +
      '<div class="ath-name">' + avatarInitial(a.name) +
        '<span><span class="ath-dot ' + r.level + '"></span>' + esc(a.name) + (a.group ? '<small class="ath-grp">' + esc(a.group) + '</small>' : '') + '</span></div>' +
      '<div class="ath-score"><b>' + r.score + '</b><small>' + r.bandLabel + '</small></div>' +
    '</div>' +
    '<div class="ath-metrics">' +
      mchip('睡眠', sleepDisp) + mchip('疲勞', fatDisp) + mchip('痠痛 / 疼痛', painDisp) + mchip('動機', motiDisp) +
      (typeof a.expectedCompletion === 'number' && a.expectedCompletion > 0 ? mchip('可完成', a.expectedCompletion + '%') : '') +
      mchip('狀態', lightLabel(a.status)) +
    '</div>' +
    (a.athleteMessage ? '<div class="ath-msg">💬 選手留言：' + esc(a.athleteMessage) + '</div>' : '') +
    (r.reasons.length
      ? '<div class="ath-why"><b>AI 判讀</b>今日 ' + r.score + ' 分，主要來自：' + esc(r.reasons.join('、')) + '。</div>'
      : '<div class="ath-why ok"><b>AI 判讀</b>各項指標穩定，今日適合正常投入訓練。</div>') +
    '<div class="ath-advice"><b>AI 建議</b>' + esc(r.suggestion) + '</div>' +
    '<div class="ath-decisions">' + DECISIONS.map(d =>
      '<button class="ath-dec' + (decided === d ? ' sel' : '') + '" data-dec="' + esc(d) + '">' + d + '</button>').join('') + '</div>' +
    '<div class="ath-reply">' +
      '<input class="ath-reply-in" placeholder="給選手的回覆 / 修改原因（選填）" value="' + esc(replied) + '">' +
      '<button class="btn btn-sm ath-reply-btn">回覆選手</button>' +
    '</div>' +
    '<div class="ath-decided muted' + (decided ? '' : ' hidden') + '">已決定：<b>' + esc(decided) + '</b>' + (replied ? '・已回覆選手' : '') + '</div>' +
    '<div class="ath-foot">' +
      '<button class="btn btn-sm btn-ghost ath-disp" data-name="' + esc(a.name) + '" data-level="' + (r.level === 'red' ? 'red' : 'yellow') + '">記錄處置與追蹤</button>' +
    '</div>' +
    '<p class="ai-note muted">AI 僅提供建議，最終決策由教練完成。此為狀態監控，非醫療診斷。</p>' +
  '</div>';
}
function bindAthleteCards(root, ctx, date) {
  root.querySelectorAll('.ath-card').forEach(card => {
    const aid = card.dataset.aid;
    const rid = card.dataset.rid;
    const aisug = card.dataset.aisug;
    const refreshLine = () => {
      const line = card.querySelector('.ath-decided');
      const cur = getDecision(aid, date) || {};
      const d = cur.decision || '';
      if (line) { line.innerHTML = '已決定：<b>' + esc(d || '（未選）') + '</b>' + (cur.reply ? '・已回覆選手' : ''); line.classList.toggle('hidden', !d && !cur.reply); }
    };
    card.querySelectorAll('.ath-dec').forEach(b => b.onclick = () => {
      const d = b.dataset.dec;
      if (d === '自訂') { const inp = card.querySelector('.ath-reply-in'); if (inp) inp.focus(); return; }
      saveDecision(aid, date, { decision: d });
      card.querySelectorAll('.ath-dec').forEach(x => x.classList.remove('sel'));
      b.classList.add('sel');
      refreshLine();
      pushCoachFeedback(rid, { decision: d, aiSuggestion: aisug }, '已記錄決策：' + d);
    });
    const rin = card.querySelector('.ath-reply-in');
    const rbtn = card.querySelector('.ath-reply-btn');
    if (rbtn) rbtn.onclick = () => {
      const v = (rin.value || '').trim();
      saveDecision(aid, date, { reply: v });
      refreshLine();
      pushCoachFeedback(rid, { feedback: v }, v ? '已回覆選手' : '已清除回覆');
    };
    const disp = card.querySelector('.ath-disp');
    if (disp) disp.onclick = () => openDispositionForm({ name: disp.dataset.name, level: disp.dataset.level, reason: '' }, ctx);
  });
}
// 決策 / 回覆同步後端（有 recordId 且非展示模式才送；失敗保留本機、提示離線）
function pushCoachFeedback(recordId, payload, okMsg) {
  const demo = CURRENT_CTX && CURRENT_CTX.demo;
  if (demo || !recordId || !TP.getUrl || !TP.getUrl()) { TP.toast && TP.toast(okMsg + '（本機）'); return; }
  TP.callAuth('coachFeedback', Object.assign({ recordId }, payload)).then(r => {
    if (r && r.ok) TP.toast && TP.toast(okMsg + '，已同步選手');
    else TP.toast && TP.toast(okMsg + '（暫存，稍後重試同步）', true);
  }).catch(() => { TP.toast && TP.toast(okMsg + '（暫存，稍後重試同步）', true); });
}
function metricTile(n, label, cls) {
  return '<div class="tp-metric ' + (cls || '') + '"><div class="n">' + esc(String(n)) + '</div><div class="l">' + esc(label) + '</div></div>';
}
function mchip(label, val) { return '<span class="mchip">' + esc(label) + ' <b>' + esc(val) + '</b></span>'; }
function lightLabel(st) { return st === 'red' ? '🔴 紅燈' : st === 'yellow' ? '🟡 黃燈' : '🟢 綠燈'; }

/* 教練決策 / 回覆本機儲存（P0：先存前端 localStorage，之後可接後端同步） */
function decisionKey() {
  const k = CURRENT_CTX && CURRENT_CTX.coachKey ? CURRENT_CTX.coachKey() : 'coach';
  return 'teampro_decisions_' + k;
}
function loadDecisions() { try { return JSON.parse(localStorage.getItem(decisionKey()) || '{}'); } catch (e) { return {}; } }
function getDecision(athleteId, date) { return loadDecisions()[athleteId + '_' + date] || null; }
function saveDecision(athleteId, date, patch) {
  const all = loadDecisions();
  const key = athleteId + '_' + date;
  all[key] = Object.assign({}, all[key], patch, { at: new Date().toISOString() });
  try { localStorage.setItem(decisionKey(), JSON.stringify(all)); } catch (e) {}
  return all[key];
}

/* 行政 / 評鑑入口（從教練主流程降級收納，避免干擾第一線） */
function renderAdminEntry() {
  return '<details class="admin-entry"><summary>🏫 學校行政 / 評鑑 / 官方填報（進階）</summary>' +
    '<p class="muted" style="font-size:13px;margin:6px 0;">教練日常不需進入；體育組長 / 行政在評鑑前使用。</p>' +
    '<div class="ae-links">' +
      '<a class="btn btn-sm btn-ghost" href="school.html">學校評鑑準備</a>' +
      '<a class="btn btn-sm btn-ghost" href="evaluation.html">評鑑準備流程</a>' +
      '<a class="btn btn-sm btn-ghost" href="export.html">官方填報包</a>' +
    '</div>' +
  '</details>';
}

/* 逐人狀態卡樣式（以 JS 注入，避免 CSS 快取造成新樣式失效） */
function injectReadinessCss() {
  if (document.getElementById('tp-readiness-css')) return;
  const css =
    '.war-headline{font-size:15px;line-height:1.6;margin:6px 0 10px;padding:12px 14px;border-radius:12px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);}' +
    '.war-headline b{color:#fbbf24;font-size:17px;}' +
    '.tp-summary-bar{display:flex;flex-wrap:wrap;gap:8px;margin:4px 0;}' +
    '.tp-metric{flex:1 1 92px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:10px 12px;text-align:center;}' +
    '.tp-metric .n{font-size:22px;font-weight:800;line-height:1.1;}' +
    '.tp-metric .l{font-size:11.5px;opacity:.7;margin-top:2px;}' +
    '.tp-metric.alert .n{color:#f87171;}.tp-metric.warn .n{color:#fbbf24;}' +
    '.summary-actions{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0 4px;}' +
    '.war-missing{font-size:13px;margin:2px 0 6px;}' +
    '.ath-card{border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:14px;margin:10px 0;background:rgba(255,255,255,.03);}' +
    '.ath-card.lv-red{border-left:4px solid #ef4444;}.ath-card.lv-yellow{border-left:4px solid #f59e0b;}.ath-card.lv-green{border-left:4px solid #22c55e;}' +
    '.ath-head{display:flex;justify-content:space-between;align-items:center;gap:10px;}' +
    '.ath-name{font-weight:700;font-size:16px;display:flex;align-items:center;gap:8px;}' +
    '.ath-ava{width:34px;height:34px;border-radius:50%;flex:none;display:inline-flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#2563eb,#22c55e);color:#fff;font-size:15px;font-weight:700;}' +
    '.ath-grp{display:block;font-size:11px;font-weight:500;opacity:.6;margin-top:1px;}' +
    '.ath-msg{font-size:13px;line-height:1.5;margin:8px 0;padding:8px 10px;border-radius:10px;background:rgba(59,130,246,.1);border:1px solid rgba(59,130,246,.2);}' +
    '.ath-dot{width:10px;height:10px;border-radius:50%;flex:none;}' +
    '.ath-dot.red{background:#ef4444;}.ath-dot.yellow{background:#f59e0b;}.ath-dot.green{background:#22c55e;}' +
    '.ath-score{text-align:right;line-height:1.05;}.ath-score b{font-size:26px;font-weight:800;}.ath-score small{display:block;font-size:11px;opacity:.7;}' +
    '.ath-metrics{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0;}' +
    '.mchip{background:rgba(255,255,255,.06);border-radius:8px;padding:5px 9px;font-size:12.5px;}' +
    '.ath-why,.ath-advice{font-size:13px;margin:7px 0;line-height:1.55;}' +
    '.ath-why b,.ath-advice b{display:inline-block;margin-right:6px;font-size:11px;padding:1px 8px;border-radius:6px;background:rgba(255,255,255,.1);vertical-align:1px;}' +
    '.ath-advice b{background:rgba(34,197,94,.18);}' +
    '.ath-decisions{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 6px;}' +
    '.ath-dec{border:1px solid rgba(255,255,255,.18);background:transparent;color:inherit;border-radius:999px;padding:6px 12px;font-size:13px;cursor:pointer;}' +
    '.ath-dec.sel{background:#22c55e;border-color:#22c55e;color:#04140a;font-weight:700;}' +
    '.ath-reply{display:flex;gap:6px;margin:6px 0;}.ath-reply-in{flex:1;min-width:0;}' +
    '.ath-decided{font-size:12.5px;margin-top:4px;}' +
    '.ath-foot{margin-top:8px;}.ai-note{font-size:11px;margin:8px 0 0;opacity:.55;}' +
    '.admin-entry{margin-top:20px;border-top:1px solid rgba(255,255,255,.08);padding-top:12px;}' +
    '.admin-entry summary{cursor:pointer;font-weight:600;opacity:.8;}' +
    '.admin-entry .ae-links{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;}';
  const st = document.createElement('style');
  st.id = 'tp-readiness-css';
  st.textContent = css;
  document.head.appendChild(st);
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
