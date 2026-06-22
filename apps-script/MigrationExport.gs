/**
 * One-time Supabase migration export.
 *
 * Run this function manually from the Apps Script editor attached to the
 * production spreadsheet. The generated Drive file is private by default.
 * Active session tokens are intentionally excluded.
 */
function exportTeamProForSupabase() {
  var exportKeys = [
    'coaches', 'teams', 'athletes', 'records', 'weeklyKpi', 'attendance',
    'competitions', 'audit', 'contacts', 'privacyRequests'
  ];
  var payload = {
    format: 'teampro-gas-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    sheets: {}
  };

  exportKeys.forEach(function (key) {
    var sheetName = SHEETS[key];
    if (sheetName) payload.sheets[key] = readAll(sheetName);
  });

  var timestamp = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyyMMdd-HHmmss');
  var blob = Utilities.newBlob(
    JSON.stringify(payload),
    'application/json',
    'teampro-supabase-export-' + timestamp + '.json'
  );
  var file = DriveApp.createFile(blob);
  console.log('Export created: ' + file.getUrl());
  return file.getUrl();
}
