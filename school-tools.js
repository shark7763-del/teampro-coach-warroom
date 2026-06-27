(function () {
  function download(name, type, text) {
    var blob = new Blob([text], { type: type + ';charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }
  function today() { return new Date().toISOString().slice(0, 10); }
  function evidencePayload() {
    return {
      generatedAt: new Date().toISOString(),
      school: 'TeamPro Demo School',
      readiness: 82,
      missing: [
        '武術隊：6 月訓練日誌缺 3 天',
        '跆拳道隊：縣市賽獎狀照片未上傳',
        '田徑隊：傷病追蹤缺家長通知紀錄'
      ],
      mapping: {
        attendance: ['出席統計', '公假統計', '月報', '評鑑佐證'],
        trainingLog: ['每日紀錄', '週報', '學期成果', '年度成果', '評鑑自評文字'],
        injury: ['學生追蹤', '家長通知', '防護紀錄', '個人歷程', '評鑑佐證'],
        competition: ['學生運動員成果', '隊伍績效', '學校成果', '獎狀歸檔', '評鑑競賽成果表']
      }
    };
  }
  function completionCsv() {
    return '\ufeff隊伍,完成率,缺漏,狀態\n跆拳道隊,88%,獎狀附件,黃\n武術隊,76%,訓練日誌,黃\n田徑隊,64%,傷病追蹤,紅\n游泳隊,94%,無,綠\n';
  }
  function handoverHtml() {
    return '<!doctype html><meta charset="utf-8"><title>TeamPro 體育組長交接包</title><h1>體育組長交接包</h1><p>產生日期：' + today() + '</p><ol>' +
      ['本校體育班基本資料','各專項隊伍名冊','教練名單','學生名冊','年度訓練紀錄','比賽成果','傷病紀錄','補課紀錄','場地設備紀錄','評鑑缺漏狀態','重要文件清單','下一任待辦事項'].map(function (x) { return '<li>' + x + '</li>'; }).join('') +
      '</ol><h2>下一任待辦</h2><ul><li>補齊獎狀附件</li><li>確認場地設備照片</li><li>追蹤連續疼痛學生</li></ul>';
  }
  document.querySelectorAll('[data-remind]').forEach(function (b) {
    b.onclick = function () { alert('已產生提醒文字：請教練補齊對應資料，避免評鑑扣分。'); };
  });
  var ev = document.getElementById('exportEvidence');
  if (ev) ev.onclick = function () { download('TeamPro評鑑佐證包-' + today() + '.json', 'application/json', JSON.stringify(evidencePayload(), null, 2)); };
  var csv = document.getElementById('exportCompletion');
  if (csv) csv.onclick = function () { download('各隊資料完成率-' + today() + '.csv', 'text/csv', completionCsv()); };
  var ho = document.getElementById('exportHandover');
  if (ho) ho.onclick = function () { download('體育組長交接包-' + today() + '.html', 'text/html', handoverHtml()); };
})();
