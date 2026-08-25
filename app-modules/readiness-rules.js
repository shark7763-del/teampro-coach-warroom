export const TRAINING_ADVICE_DISCLAIMER = 'AI僅提供訓練管理建議，不是醫療診斷，最終決策由教練完成。';

export function evaluateReadiness(input) {
  const a = input || {};
  const reasons = [];
  const missing = [];
  const pain = num(a.painScore);
  const sleepMin = num(a.sleepMin != null ? a.sleepMin : a.sleepDurationMinutes);
  const fatigue = fatigueTo10(a.fatigue != null ? a.fatigue : a.fatigueLevel);
  const mood = num(a.mood != null ? a.mood : a.moodIndex);
  const motivation = num(a.motivation);
  const expectedCompletion = num(a.expectedCompletion);
  const hasReport = !!(a.recordId || a.reportStatus === 'submitted' || a.submittedAt || a.athleteMessage);

  if (!hasReport) return result(0, 'gray', '尚未回報', ['今天尚未完成回報'], 0, '資料不足，請先確認選手今日回報後再判斷訓練安排。');
  if (!numericPresent(a.painScore)) missing.push('疼痛');
  if (!numericPresent(a.fatigue) && !numericPresent(a.fatigueLevel)) missing.push('疲勞');
  if (!numericPresent(a.motivation)) missing.push('訓練動機');

  let score = 100;
  const painImpact = hasPainImpact(a.painImpact);
  if (pain >= 7) { score -= 35; reasons.push('疼痛偏高（' + pain + '/10）'); }
  else if (pain >= 4) { score -= 18; reasons.push('疼痛中等（' + pain + '/10）'); }
  if (painImpact) { score -= 14; reasons.push('疼痛影響動作' + (a.painAreas ? '（' + a.painAreas + '）' : '')); }

  if (sleepMin > 0 && sleepMin < 300) { score -= 20; reasons.push('睡眠嚴重不足（' + hoursText(sleepMin) + '）'); }
  else if (sleepMin > 0 && sleepMin < 360) { score -= 12; reasons.push('睡眠不足（' + hoursText(sleepMin) + '）'); }

  if (fatigue >= 9) { score -= 22; reasons.push('疲勞很高'); }
  else if (fatigue >= 8) { score -= 16; reasons.push('疲勞偏高'); }
  else if (fatigue >= 6) { score -= 8; reasons.push('疲勞中等'); }

  if (mood && mood <= 2) { score -= 8; reasons.push('心情偏低'); }
  if (motivation && motivation <= 2) { score -= 10; reasons.push('訓練動機偏低'); }
  if (expectedCompletion && expectedCompletion <= 50) { score -= 12; reasons.push('自評今日僅能完成約 ' + expectedCompletion + '% 訓練'); }
  if (a.declining) { score -= 8; reasons.push('近期狀態連續下降'); }
  if (String(a.hydrationRisk || '') === 'red') { score -= 8; reasons.push('水分風險偏高'); }
  if (missing.length >= 2) { score -= 10; reasons.push('關鍵欄位缺漏：' + missing.join('、')); }

  score = clamp(Math.round(score), 0, 100);
  let level = score >= 80 ? 'green' : score >= 60 ? 'yellow' : 'red';
  let bandLabel = level === 'green' ? '狀態良好' : level === 'yellow' ? '需要調整' : '優先關注';

  if (missing.length >= 3) { level = 'gray'; bandLabel = '資料不足'; }
  if (pain >= 7 || (painImpact && pain >= 4) || expectedCompletion <= 30 || String(a.status) === 'red') {
    level = 'red'; bandLabel = '優先關注'; score = Math.min(score, 59);
  } else if (pain >= 4 || fatigue >= 8 || motivation <= 2 || expectedCompletion <= 50 || a.declining) {
    if (level === 'green') { level = 'yellow'; bandLabel = '需要調整'; score = Math.min(score, 79); }
  }

  return result(score, level, bandLabel, reasons.length ? reasons : ['各項指標穩定'], priority(score, level, pain, painImpact, !!a.declining), suggestion({ level, pain, painImpact, sleepMin, fatigue, motivation, expectedCompletion, missing }));
}

function result(score, level, bandLabel, reasons, priorityValue, suggestionText) {
  return { score, level, bandLabel, reasons, priority: priorityValue, suggestion: suggestionText, disclaimer: TRAINING_ADVICE_DISCLAIMER };
}
function suggestion(ctx) {
  if (ctx.level === 'gray') return '資料不足，請先補齊今日回報或由教練人工確認後再安排訓練。';
  if (ctx.pain >= 7 || (ctx.painImpact && ctx.pain >= 4)) return '訓練前先確認疼痛部位與活動範圍，今日降低高強度踢擊、衝刺與重複刺激，改以技術修正、低衝擊動作與恢復為主。';
  if (ctx.fatigue >= 8) return '疲勞偏高，建議降低訓練量一級，安排恢復與伸展，並觀察隔日恢復狀況。';
  if (ctx.sleepMin > 0 && ctx.sleepMin < 360) return '睡眠不足，加強熱身與收操，降低最大強度衝刺，注意訓練中專注度與安全。';
  if (ctx.motivation && ctx.motivation <= 2) return '訓練動機偏低，建議先簡短面談確認原因，今日採較明確、可完成的小目標。';
  if (ctx.expectedCompletion && ctx.expectedCompletion <= 50) return '自評可完成度偏低，建議調整課表目標與負荷，避免硬推完整強度。';
  if (ctx.level === 'green') return '狀態良好，可依原訂計畫正常訓練，維持節奏並持續累積。';
  return '需要調整，請依異常原因降低負荷或調整內容，訓練中持續觀察。';
}
function priority(score, level, pain, impact, declining) {
  let value = 100 - score;
  if (level === 'red') value += 100;
  if (level === 'yellow') value += 30;
  if (pain >= 7 || impact) value += 80;
  if (declining) value += 30;
  return value;
}
function hasPainImpact(v) {
  return !!(v && !/不影響|沒有|無|否|none|no/i.test(String(v)));
}
function fatigueTo10(v) {
  const n = num(v);
  if (!n) return 0;
  return n <= 5 ? n * 2 : n;
}
function hoursText(min) {
  return (Math.round(min / 6) / 10) + ' 小時';
}
function present(v) {
  return v !== undefined && v !== null && String(v).trim() !== '';
}
function numericPresent(v) {
  return present(v) && Number.isFinite(Number(v));
}
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}
