// 簡化版資訊架構（3 分頁）與選手日報主流程的靜態守門測試。
// 目的：避免把「今日 / 選手 / 更多」再度膨脹回一排分頁，
// 也避免選手日報的量表入口被整個藏掉（曾經發生過）。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

const appHtml = read('app.html');
const shell = read('app-shell.20260627e.js');
const fullHtml = read('app-full.html');
const full = read('app-full.20260627f.js');
const join = read('join.html');
const sw = read('sw.js');

const ASSET_VERSION = '20260902-ia3';

function tabbarTabs(html) {
  const nav = html.match(/<nav class="mobile-tabbar"[\s\S]*?<\/nav>/);
  assert.ok(nav, 'page has a mobile tabbar');
  return Array.from(nav[0].matchAll(/data-tab="([^"]+)"/g)).map((m) => m[1]);
}

/* ---------- 模組化殼層 app.html ---------- */
assert.deepEqual(tabbarTabs(appHtml), ['dashboard', 'athletes', 'more'], 'shell keeps exactly 3 primary tabs');
assert.match(shell, /function renderMoreHub\(\)/, 'shell renders a 更多 hub instead of extra tabs');
for (const tab of ['attendance', 'tracking', 'report', 'teams', 'settings']) {
  assert.ok(
    new RegExp("tab: '" + tab + "'").test(shell),
    'more hub still offers ' + tab,
  );
}
assert.match(shell, /const primary = \(tab === 'dashboard' \|\| tab === 'athletes'\) \? tab : 'more'/, 'secondary features highlight the 更多 tab');
assert.match(appHtml, /<details class="shell-card advanced-daily">/, 'daily page keeps low-frequency entries collapsed');

/* ---------- 單檔完整版 app-full.html ---------- */
assert.deepEqual(tabbarTabs(fullHtml), ['warroom', 'athletes', '__more'], 'full app keeps exactly 3 primary tabs');
const desktopTabs = Array.from(
  (fullHtml.match(/<div class="tabs">[\s\S]*?<\/div>/) || [''])[0].matchAll(/data-tab="([^"]+)"/g),
).map((m) => m[1]);
assert.deepEqual(desktopTabs, ['warroom', 'athletes', '__more'], 'full app desktop tabs match the mobile tabbar');
assert.match(full, /if \(tab === '__more'\) \{\s*showMoreSheet\(\);/, 'full app routes __more to the sheet');
for (const tab of ['attendance', 'report', 'teams']) {
  assert.ok(
    new RegExp("\\['" + tab + "',").test(full.slice(full.indexOf('function showMoreSheet'))),
    'more sheet still offers ' + tab,
  );
}

/* ---------- 選手日報 join.html ---------- */
assert.match(join, /id="dailyQuickScale"/, 'join page mounts the quick 1-5 scales');
const metrics = (join.match(/var QUICK_METRICS = \[[\s\S]*?\];/) || [''])[0];
for (const key of ['sleep', 'energy', 'fatigue', 'pain', 'mood', 'performance']) {
  assert.ok(metrics.includes("'" + key + "'"), 'quick scale covers ' + key);
}
assert.match(join, /id="improveToday"/, 'join page asks what to improve today');

// 量表是唯一輸入來源：下面的選填區塊不可以再問一次同一件事
for (const [id, label] of [
  ['sleepQuality', '睡眠品質下拉'],
  ['fatigue"', '疲勞滑桿'],
  ['painScore', '疼痛分數滑桿'],
  ['moodRow', '心情表情列'],
  ['painStatusChoices', '今日是否有疼痛'],
]) {
  assert.equal(join.includes('id="' + id), false, label + ' 與六題量表重複，應該只留量表');
}
assert.match(join, /var derived = \{ sleepQuality/, 'mapped values live in derived, not in duplicated inputs');
assert.match(join, /sleepQuality: derived\.sleepQuality/, 'submit sends the derived sleep quality');
assert.match(join, /fatigue: derived\.fatigue/, 'submit sends the derived fatigue');

// 比賽紀錄已從每日回報移除
for (const id of ['hasCompChoices', 'compBlock', 'compSelect', 'compPhotoBtn', 'compAwardLink']) {
  assert.equal(join.includes('id="' + id + '"'), false, '比賽紀錄欄位 ' + id + ' 應已從日報移除');
}
assert.equal(join.includes('collectCompName'), false, 'daily payload no longer collects competition fields');
assert.match(join, /function syncKpiEntry\(\)/, 'join page still exposes the KPI form when it is due');
assert.match(
  join,
  /b\.classList\.toggle\('hidden', !\(ctx\.kpiState && ctx\.kpiState\.kpiDue\)\)/,
  'KPI entry visibility follows kpiDue instead of being hard-hidden',
);
// showResult / showKpi2Result 都要走 syncKpiEntry，否則量表會完全沒有入口。
assert.equal((join.match(/syncKpiEntry\(\);/g) || []).length >= 3, true, 'both result screens sync the KPI entry');

/* ---------- 版本同步：HTML 與 service worker 要指到同一版 ---------- */
for (const [name, html, asset] of [
  ['app.html', appHtml, 'app-shell.20260627e.js'],
  ['app.html', appHtml, 'app-shell.20260627e.css'],
  ['app-full.html', fullHtml, 'app-full.20260627f.js'],
]) {
  assert.ok(html.includes(asset + '?v=' + ASSET_VERSION), name + ' loads ' + asset + ' at ' + ASSET_VERSION);
  assert.ok(sw.includes("'" + asset + '?v=' + ASSET_VERSION + "'"), 'sw precaches ' + asset + ' at ' + ASSET_VERSION);
}

console.log('simple-ia: all assertions passed');
