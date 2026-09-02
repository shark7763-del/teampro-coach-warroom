import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const api = readFileSync(new URL('../api.js', import.meta.url), 'utf8');
const shell = readFileSync(new URL('../app-shell.20260627e.js', import.meta.url), 'utf8');
const dashboard = readFileSync(new URL('../app-modules/dashboard.js', import.meta.url), 'utf8');
const full = readFileSync(new URL('../app-full.20260627f.js', import.meta.url), 'utf8');
const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const worker = readFileSync(new URL('../cloudflare-worker.js', import.meta.url), 'utf8');
const headers = readFileSync(new URL('../_headers', import.meta.url), 'utf8');
const gas = readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
const pwa = readFileSync(new URL('../pwa.js', import.meta.url), 'utf8');

assert.match(api, /function logoutLocal\(\)/, 'api exposes local logout cleanup');
assert.match(api, /clearSensitiveCache/, 'api exposes sensitive cache cleanup');
assert.match(api, /decisions_/, 'local coach decision cache is cleared on logout');
assert.match(api, /r\.needLogin \|\| r\.error === 'unauthorized'/, 'callAuth clears unauthorized sessions');

assert.match(shell, /const ok = await startBootstrap\(\)/, 'cold shell verifies through bootstrap before opening dashboard');
assert.doesNotMatch(shell, /const ok = await verifySession\(\)/, 'shell no longer forces me before dashboard startup');
assert.match(shell, /Promise\.all\(\[\s*TP\.callAuth\('me'\),\s*TP\.callAuth\('listTeams'\),\s*TP\.callAuth\('warroom'/s, 'legacy fallback requests me/listTeams/warroom in parallel');
assert.doesNotMatch(shell, /state\.coach = cachedCoach\(\) \|\| \{ name: '教練'/, 'shell no longer trusts cached coach as login proof');
assert.match(shell, /TP\.isAuthVerified/, 'shell gates feature loading on verified auth');
assert.match(shell, /TP\.hasRecentAuth/, 'shell supports recent-auth fast startup');

assert.doesNotMatch(dashboard, /renderSummary\(root, demoSummary\(date\), false, ctx, \{ offline: true, error: true \}\)/, 'dashboard does not show demo data on backend failure');
assert.match(dashboard, /離線資料 \/ 非即時/, 'dashboard labels stale data as non-realtime');
assert.match(dashboard, /refreshWarroom\(root, ctx, cacheKey, date, teamId, cached\)/, 'dashboard refreshes warroom in the background after rendering cache');
assert.match(dashboard, /readiness-rules\.js\?v=20260826-perf1/, 'dashboard imports readiness rules with a version');
assert.match(dashboard, /legacy-frame\.js\?v=20260826-perf1/, 'dashboard imports legacy-frame with a version');

assert.match(sw, /'\/app', '\/join'/, 'service worker precaches extensionless app and join routes');
assert.match(sw, /function isFastShell/, 'service worker has a fast shell route classifier');
assert.match(sw, /if \(req\.method !== 'GET'\) return;/, 'service worker leaves POST APIs network-only');
assert.match(sw, /stale-while-revalidate=86400/, 'service worker uses SWR for app/join shells');
assert.match(sw, /teampro-v22-daily-slim/, 'service worker cache version is bumped for the slimmed daily report');
assert.ok(sw.includes("'app-shell.20260627e.js?v=20260902-ia3'"), 'service worker precaches the shell script at the current version');
assert.ok(sw.includes("'app-full.20260627f.js?v=20260902-ia3'"), 'service worker precaches the full app script at the current version');
assert.match(pwa, /reg\.update\(\)/, 'PWA registration actively checks for service worker updates');
assert.match(pwa, /controllerchange[\s\S]*tp_sw_updated/, 'PWA records when a new service worker takes control without interrupting current work');
assert.match(worker, /url\.pathname === \"\/sw\.js\"[\s\S]*?no-cache/, 'worker keeps sw.js no-cache');
assert.match(worker, /function isFastShell/, 'worker marks app/join shell routes separately');
assert.match(headers, /\/sw\.js[\s\S]*?Cache-Control: no-cache/, '_headers keeps sw.js no-cache');
assert.match(headers, /\/app[\s\S]*?stale-while-revalidate=86400/, '_headers marks /app shell as SWR');
assert.match(headers, /\/app-modules\/\*\.js[\s\S]*?immutable/, '_headers marks versioned app modules immutable');

for (const name of readdirSync(new URL('../app-modules/', import.meta.url)).filter((f) => f.endsWith('.js'))) {
  const src = readFileSync(new URL('../app-modules/' + name, import.meta.url), 'utf8');
  assert.doesNotMatch(src, /from ['"]\.\/[^'"]+\.js['"]/, `${name} must not import local modules without a version query`);
}

assert.match(gas, /case 'bootstrap':\s+return jsonOut\(withCoach\(d, bootstrap\)\)/, 'GAS exposes authenticated bootstrap');
assert.match(gas, /function bootstrap\(c, d\)[\s\S]*?coach:[\s\S]*?teams:[\s\S]*?warroom:/, 'bootstrap returns coach, teams, and warroom together');
assert.match(gas, /CacheService\.getScriptCache\(\)\.get/, 'warroom uses CacheService reads');
assert.match(gas, /CacheService\.getScriptCache\(\)\.put/, 'warroom uses CacheService writes');
assert.match(gas, /clearWarroomCache_\(c\.coachId, rec\.teamId/, 'coach feedback clears warroom cache');
assert.match(gas, /clearWarroomCache_\(t\.coachId, t\.teamId, date\)/, 'athlete report writes clear warroom cache');

for (const realLookingName of ['陳柏宇', '林冠廷', '黃于軒', '張承恩', '吳宥辰', '李芷瑄', '王思妤', '蔡承翰', '周子晴', '許哲維', '郭庭瑄', '鄭宇翔', '何品妤', '羅冠宇', '謝語恩']) {
  assert.equal(full.includes(realLookingName) || dashboard.includes(realLookingName), false, `demo/template should not include ${realLookingName}`);
}

console.log('static-security: all assertions passed');
