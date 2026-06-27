(function () {
  function download(name, type, text) {
    var blob = new Blob([text], { type: type + ';charset=utf-8' });
    downloadBlob(name, blob);
  }
  function downloadBlob(name, blob) {
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
  function officialCsv(kind) {
    var rows = {
      students: '\ufeff學校,學生姓名,出生日期,國籍別,身分證字號/外籍證號,學生年級,班級,教練,是否為身心障礙學生,運動種類,身分,狀態\nTeamPro高中,陳柏宇,2010-01-01,本國籍,A123456789,九年級,體育班,王教練,否,跆拳道,體育班學生,在學\n',
      competitions: '\ufeff比賽開始日期,比賽結束日期,選手姓名,教練,運動種類,運動項目,學年度,賽會級別,比賽名稱,比賽天數,名次,成績,備註,狀態,檔案列表\n2026-05-01,2026-05-03,陳柏宇,王教練,跆拳道,對打,115,縣市級,縣市中等學校運動會,3,第一名,,獎狀清楚含姓名名次,可供上傳參考,獎狀.pdf\n',
      officialLeave: '\ufeff學生姓名,隊伍/專項,日期,公假日數,事由,佐證\n陳柏宇,跆拳道隊,2026-05-01,3,縣市中等學校運動會,公假單.pdf\n',
      facility: '\ufeff日期,場地/設備,維護內容,照片/佐證,狀態\n2026-06-01,重量訓練室,器材安全檢查,照片.jpg,完成\n',
      graduateTracking: '\ufeff畢業學生,畢業學年度,銜續學校/隊伍,是否持續訓練,備註\n林冠霖,114,市立高中代表隊,是,持續專項訓練\n'
    };
    return rows[kind] || rows.students;
  }
  function selfReviewHtml() {
    return '<!doctype html><meta charset="utf-8"><title>TeamPro 自評文字草稿</title><h1>體育班評鑑自評文字草稿</h1><p>本文件為官方系統填報前準備資料，需由學校承辦人確認後再填入官方系統。</p><h2>設班現況</h2><p>本校依學生運動員專項需求建立隊伍與訓練紀錄。</p><h2>運作情形</h2><p>日常點名、訓練日誌、傷病追蹤與輔導紀錄已逐步電子化。</p><h2>訓練績效</h2><p>競賽成果與訓練績效資料已依官方欄位整理，可供填報參考。</p>';
  }
  function handoverHtml() {
    return '<!doctype html><meta charset="utf-8"><title>TeamPro 體育組長交接包</title><h1>體育組長交接包</h1><p>產生日期：' + today() + '</p><ol>' +
      ['本校體育班基本資料','各專項隊伍名冊','教練名單','學生名冊','年度訓練紀錄','比賽成果','傷病紀錄','補課紀錄','場地設備紀錄','評鑑缺漏狀態','重要文件清單','下一任待辦事項'].map(function (x) { return '<li>' + x + '</li>'; }).join('') +
      '</ol><h2>下一任待辦</h2><ul><li>補齊獎狀附件</li><li>確認場地設備照片</li><li>追蹤連續疼痛學生</li></ul>';
  }
  function crcTable() {
    var table = [];
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  }
  var CRC_TABLE = crcTable();
  function crc32(bytes) {
    var c = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function u16(n) { return [n & 255, (n >>> 8) & 255]; }
  function u32(n) { return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]; }
  function concatBytes(parts) {
    var len = parts.reduce(function (s, p) { return s + p.length; }, 0);
    var out = new Uint8Array(len);
    var offset = 0;
    parts.forEach(function (p) { out.set(p, offset); offset += p.length; });
    return out;
  }
  function makeZip(files) {
    var enc = new TextEncoder();
    var locals = [], centrals = [], offset = 0;
    files.forEach(function (file) {
      var name = enc.encode(file.name);
      var data = enc.encode(file.content);
      var crc = crc32(data);
      var local = concatBytes([
        new Uint8Array([80, 75, 3, 4]), new Uint8Array(u16(20)), new Uint8Array(u16(0)), new Uint8Array(u16(0)),
        new Uint8Array(u16(0)), new Uint8Array(u16(0)), new Uint8Array(u16(0)), new Uint8Array(u32(crc)),
        new Uint8Array(u32(data.length)), new Uint8Array(u32(data.length)), new Uint8Array(u16(name.length)),
        new Uint8Array(u16(0)), name, data
      ]);
      var central = concatBytes([
        new Uint8Array([80, 75, 1, 2]), new Uint8Array(u16(20)), new Uint8Array(u16(20)), new Uint8Array(u16(0)),
        new Uint8Array(u16(0)), new Uint8Array(u16(0)), new Uint8Array(u16(0)), new Uint8Array(u32(crc)),
        new Uint8Array(u32(data.length)), new Uint8Array(u32(data.length)), new Uint8Array(u16(name.length)),
        new Uint8Array(u16(0)), new Uint8Array(u16(0)), new Uint8Array(u16(0)), new Uint8Array(u16(0)),
        new Uint8Array(u32(0)), new Uint8Array(u32(offset)), name
      ]);
      locals.push(local);
      centrals.push(central);
      offset += local.length;
    });
    var centralSize = centrals.reduce(function (s, p) { return s + p.length; }, 0);
    var end = concatBytes([
      new Uint8Array([80, 75, 5, 6]), new Uint8Array(u16(0)), new Uint8Array(u16(0)),
      new Uint8Array(u16(files.length)), new Uint8Array(u16(files.length)),
      new Uint8Array(u32(centralSize)), new Uint8Array(u32(offset)), new Uint8Array(u16(0))
    ]);
    return new Blob([concatBytes(locals.concat(centrals).concat([end]))], { type: 'application/zip' });
  }
  function evidenceZip() {
    var payload = evidencePayload();
    return makeZip([
      { name: 'README.txt', content: 'TeamPro 評鑑佐證包\n用途：官方系統填報前準備與佐證整理。\n注意：本 ZIP 不是官方送出檔，仍需由學校承辦人登入官方系統確認、上傳與送出。\n' },
      { name: '評鑑佐證清單.json', content: JSON.stringify(payload, null, 2) },
      { name: '學生基本資料.csv', content: officialCsv('students') },
      { name: '比賽紀錄.csv', content: officialCsv('competitions') },
      { name: '學生公假日數.csv', content: officialCsv('officialLeave') },
      { name: '場地維護紀錄.csv', content: officialCsv('facility') },
      { name: '畢業銜續訓練統計.csv', content: officialCsv('graduateTracking') }
    ]);
  }
  document.querySelectorAll('[data-remind]').forEach(function (b) {
    b.onclick = function () { alert('已產生提醒文字：請教練補齊對應資料，避免評鑑扣分。'); };
  });
  var ev = document.getElementById('exportEvidence');
  if (ev) ev.onclick = function () { downloadBlob('TeamPro評鑑佐證包-' + today() + '.zip', evidenceZip()); };
  var csv = document.getElementById('exportCompletion');
  if (csv) csv.onclick = function () { download('各隊資料完成率-' + today() + '.csv', 'text/csv', completionCsv()); };
  var ho = document.getElementById('exportHandover');
  if (ho) ho.onclick = function () { download('體育組長交接包-' + today() + '.html', 'text/html', handoverHtml()); };
  document.querySelectorAll('[data-export]').forEach(function (b) {
    b.onclick = function () {
      var kind = b.dataset.export;
      if (kind === 'selfReview') download('自評文字草稿-' + today() + '.html', 'text/html', selfReviewHtml());
      else download(kind + '-' + today() + '.csv', 'text/csv', officialCsv(kind));
    };
  });
})();
