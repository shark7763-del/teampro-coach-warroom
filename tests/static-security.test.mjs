import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const api = readFileSync(new URL('../api.js', import.meta.url), 'utf8');
const shell = readFileSync(new URL('../app-shell.20260627e.js', import.meta.url), 'utf8');
const dashboard = readFileSync(new URL('../app-modules/dashboard.js', import.meta.url), 'utf8');
const full = readFileSync(new URL('../app-full.20260627f.js', import.meta.url), 'utf8');

assert.match(api, /function logoutLocal\(\)/, 'api exposes local logout cleanup');
assert.match(api, /clearSensitiveCache/, 'api exposes sensitive cache cleanup');
assert.match(api, /decisions_/, 'local coach decision cache is cleared on logout');
assert.match(api, /r\.needLogin \|\| r\.error === 'unauthorized'/, 'callAuth clears unauthorized sessions');

assert.match(shell, /const ok = await verifySession\(\)/, 'shell verifies session before opening dashboard');
assert.doesNotMatch(shell, /state\.coach = cachedCoach\(\) \|\| \{ name: '教練'/, 'shell no longer trusts cached coach as login proof');
assert.match(shell, /TP\.isAuthVerified/, 'shell gates feature loading on verified auth');

assert.doesNotMatch(dashboard, /renderSummary\(root, demoSummary\(date\), false, ctx, \{ offline: true, error: true \}\)/, 'dashboard does not show demo data on backend failure');
assert.match(dashboard, /離線資料 \/ 非即時/, 'dashboard labels stale data as non-realtime');

for (const realLookingName of ['陳柏宇', '林冠廷', '黃于軒', '張承恩', '吳宥辰', '李芷瑄', '王思妤', '蔡承翰', '周子晴', '許哲維', '郭庭瑄', '鄭宇翔', '何品妤', '羅冠宇', '謝語恩']) {
  assert.equal(full.includes(realLookingName) || dashboard.includes(realLookingName), false, `demo/template should not include ${realLookingName}`);
}

console.log('static-security: all assertions passed');
