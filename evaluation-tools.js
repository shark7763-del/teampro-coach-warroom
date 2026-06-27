(function () {
  var steps = [
    '指標表封面','學校基本資料','目錄','填表說明及注意事項','壹、設班現況','貳、運作情形','參、訓練績效','肆、其他特色加分項目','檢附資料一','畢業學生銜續訓練統計表','學生參賽記錄表','訓練績效積分表（教練填寫）','訓練績效積分表（體育組長/主管檢視）'
  ];
  var states = ['done','done','done','check','done','check','missing','check','evidence','missing','check','done','check'];
  var labels = { done:'完成', missing:'缺資料', check:'待確認', evidence:'已有佐證' };
  var box = document.getElementById('evalSteps');
  if (box) box.innerHTML = steps.map(function (s, i) {
    var st = states[i];
    var exportable = st === 'done' || st === 'evidence';
    return '<div class="eval-step"><div class="top"><b>' + (i + 1) + '. ' + s + '</b><span class="status-chip ' + st + '">' + labels[st] + '</span></div>' +
      '<p class="muted">可匯出：' + (exportable ? '是' : '否') + '｜缺漏提醒：' + (st === 'missing' ? '需補官方欄位與佐證' : st === 'check' ? '需人工確認內容' : '目前可供上傳參考') + '</p></div>';
  }).join('');
  var btn = document.getElementById('evalAiBtn');
  if (btn) btn.onclick = function () {
    var raw = (document.getElementById('evalAiInput').value || '').trim();
    if (!raw) return alert('請先輸入內容');
    document.getElementById('evalAiOutput').classList.remove('hidden');
    document.getElementById('evalAiOutput').innerHTML =
      '<b>評鑑自評文字草稿</b><p>本校依體育班運作需求持續累積訓練日誌、學生照顧、競賽成果與佐證資料。' + raw + '</p>' +
      '<b>缺漏補件提醒</b><p>請優先確認比賽佐證是否包含比賽名稱、學生姓名、獲獎名次、日期與組別；畢業銜續與場地維護資料需由行政端最後確認。</p>' +
      '<b>成果摘要草稿</b><p>可依日常紀錄延伸產生每月、學期與年度成果摘要，供成果報告與官方填報前準備使用。</p>' +
      '<b>改善追蹤回覆草稿</b><p>針對委員建議，本校已建立內部追蹤清單，並於正式填報前補齊佐證與主管確認紀錄。</p>';
  };
})();
