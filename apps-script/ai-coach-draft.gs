/**
 * TeamPro 教練戰情室 — 真 AI 教練回饋草稿（路線 B）
 * 後端 Claude 串接：前端 app.html 的「✨ 用真 AI 生成回饋（Claude）」會呼叫 action='aiCoachDraft'。
 *
 * 安裝步驟：
 * 1. 把本檔內容貼進你的 GAS 專案（可新增一個 .gs 檔，或併進 Code.gs）。
 * 2. 設定金鑰（不要寫進程式碼）：
 *    GAS 編輯器 → 專案設定 → 指令碼屬性 → 新增
 *      屬性：ANTHROPIC_API_KEY
 *      值　：sk-ant-...（你的 Anthropic 金鑰）
 * 3. 在你的 doPost 路由加上一行分派（依你現有寫法回傳 JSON）：
 *      if (action === 'aiCoachDraft') return jsonOut_(aiCoachDraft(body));
 *    （jsonOut_ 換成你專案實際的 JSON 輸出函式；body 換成你解析後的請求物件）
 * 4. 部署 → 管理部署 → 編輯 → 版本：新版本（务必，否則不生效）。
 *
 * 安全：本函式只回傳文字草稿、不寫入任何資料；建議仍以教練 token 驗證來防止金鑰被濫用。
 */

function aiCoachDraft(data) {
  data = data || {};
  try {
    // ── 驗證教練身分（防止他人盜用你的 API 金鑰）──
    // 換成你專案既有的「token → coachId」函式；若你的 doPost 已先驗證，可刪除這段。
    if (typeof coachIdFromToken_ === 'function') {
      var coachId = coachIdFromToken_(data.token);
      if (!coachId) return { ok: false, error: '未登入或登入已過期' };
    }

    var apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
    if (!apiKey) return { ok: false, error: '後端尚未設定 ANTHROPIC_API_KEY（請在指令碼屬性新增）' };

    var system =
      '你是台灣青少年運動隊的「教練助理」，協助主教練撰寫每日／每週給選手的回饋草稿。\n' +
      '語氣專業、溫暖、具體、正向；用繁體中文。請依教練提供的真實數據撰寫，不要編造未提供的數字。\n' +
      '一律輸出三段，各段以標題開頭、彼此空一行：\n' +
      '【給教練的重點】3 句內，點出今天最該注意的 1–2 件事與建議的訓練調整。\n' +
      '【給家長的摘要】2–3 句，溫和、不揭露原始分數與敏感細節，著重關心與陪伴方向。\n' +
      '【給選手的鼓勵】2 句內，正向、具體、可執行，像教練親口對他說。\n' +
      '安全守則：若有疼痛或傷勢風險，提醒降載並由教練／家長確認，必要時就醫；' +
      '不得提供醫療、心理診斷或治療指示，只給訓練管理層面的建議。';

    var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      muteHttpExceptions: true,
      payload: JSON.stringify({
        model: 'claude-opus-4-8',   // 教練若要更省成本可改 'claude-haiku-4-5'
        max_tokens: 1024,
        system: system,
        messages: [{ role: 'user', content: buildCoachPrompt_(data) }]
      })
    });

    var code = res.getResponseCode();
    var out = JSON.parse(res.getContentText() || '{}');
    if (code !== 200) return { ok: false, error: (out.error && out.error.message) || ('Claude API 錯誤 ' + code) };
    if (out.stop_reason === 'refusal') return { ok: false, error: '內容被安全機制擋下，請調整輸入後再試' };

    var text = (out.content || [])
      .filter(function (b) { return b.type === 'text'; })
      .map(function (b) { return b.text; }).join('\n').trim();
    if (!text) return { ok: false, error: 'AI 沒有回傳內容，請再試一次' };

    return { ok: true, draft: text, usage: out.usage || null };
  } catch (err) {
    return { ok: false, error: '生成失敗：' + (err && err.message ? err.message : err) };
  }
}

function buildCoachPrompt_(data) {
  var name = data.athleteName || '這位選手';
  var r = data.record || {};
  var risk = data.risk || null;
  var lines = ['選手：' + name, '今日／最近回報數據：'];
  if (r.totalScore) lines.push('・最近狀態總分：' + r.totalScore + '（5 分最佳）');
  if (r.fatigue) lines.push('・疲勞指數：' + r.fatigue + '/10');
  if (r.sleep) lines.push('・睡眠：' + r.sleep);
  if (Number(r.painScore) > 0) lines.push('・疼痛：' + r.painScore + '/10' + (r.painAreas ? '（' + r.painAreas + '）' : ''));
  else if (r.painAreas && r.painAreas !== '無受傷') lines.push('・不適部位：' + r.painAreas);
  if (r.hydrationRisk && r.hydrationRisk !== 'green') lines.push('・水分狀態偏差（' + r.hydrationRisk + '）');
  if (r.trainingNotes) lines.push('・訓練心得：' + r.trainingNotes);
  if (r.reflection) lines.push('・想請教練幫忙：' + r.reflection);

  if (risk) {
    var lightTxt = risk.light === 'red' ? '偏高' : (risk.light === 'yellow' ? '需留意' : '安全');
    lines.push('');
    lines.push('AI 傷害／過載風險預測：' + risk.score + '/100（' + lightTxt + '）');
    if (risk.reasons && risk.reasons.length) lines.push('主因：' + risk.reasons.join('；'));
    if (risk.action) lines.push('建議行動：' + risk.action);
  }
  lines.push('');
  lines.push('請依上述真實數據，產生三段回饋草稿。');
  return lines.join('\n');
}
