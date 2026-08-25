const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:4173';
const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });

async function mockGas(page, handler) {
  await page.route('https://script.google.com/macros/s/**/exec', async (route) => {
    let data = {};
    try { data = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
    const action = data.action || '';
    const result = await handler(action, data);
    await route.fulfill({
      status: result.status || 200,
      contentType: 'application/json',
      body: JSON.stringify(result.body || result),
    });
  });
}

async function seedVerifiedSession(page, coachId = 'c_test') {
  await page.evaluate((coachIdArg) => {
    localStorage.setItem('teampro_token', 'valid-test-token');
    localStorage.setItem('teampro_auth_verified', new Date().toISOString());
    localStorage.setItem('teampro_shell_coach', JSON.stringify({
      coachId: coachIdArg,
      email: 'coach@example.test',
      name: '測試教練',
      planName: '測試版',
    }));
  }, coachId);
}

test('unauthenticated shell does not load athlete data or feature iframes', async ({ page }) => {
  await page.goto(`${BASE_URL}/app.html`);
  await expect(page.locator('#authPanel')).toBeVisible();
  await expect(page.locator('#featurePanel')).toBeHidden();
  await expect(page.locator('text=尚未登入')).toBeVisible();

  for (const tab of ['tracking', 'athletes', 'attendance', 'report']) {
    await page.locator(`#mobileTabbar button[data-tab="${tab}"]`).click();
    await expect(page.locator('#authPanel')).toBeVisible();
    await expect(page.locator('#featurePanel')).toBeHidden();
  }
});

test('priority retest 1: more and return-to-today cannot bypass login', async ({ page }) => {
  await mockGas(page, () => ({ ok: false, error: 'unauthorized', needLogin: true }));
  await page.goto(`${BASE_URL}/app.html`);
  await expect(page.locator('#authPanel')).toBeVisible();

  await page.locator('#shellMore').click();
  await expect(page.locator('#authPanel')).toBeVisible();
  await expect(page.locator('#featurePanel')).toBeHidden();
  await expect(page.locator('text=請先登入後再開啟功能。')).toBeVisible();

  await page.evaluate(({ today }) => {
    localStorage.setItem(`teampro_shell_todaySummary_c_cached__${today}`, JSON.stringify({
      ok: true,
      date: today,
      totalAthletes: 1,
      submittedCount: 1,
      athletes: [{ athleteId: 'a_hidden', recordId: 'r_hidden', name: '未授權敏感選手', status: 'red', painScore: 9, fatigue: 9, motivation: 1 }],
      missingNames: [],
      updatedAt: new Date().toISOString(),
    }));
  }, { today: TODAY });
  await page.locator('#mobileTabbar button[data-tab="dashboard"]').click();
  await expect(page.locator('#authPanel')).toBeVisible();
  await expect(page.locator('text=未授權敏感選手')).toHaveCount(0);
  await expect(page.locator('#featurePanel iframe')).toHaveCount(0);
});

test('invalid token clears sensitive cache before dashboard render', async ({ page }) => {
  await page.route('https://script.google.com/macros/s/**/exec', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: 'unauthorized', needLogin: true }),
    });
  });
  await page.goto(`${BASE_URL}/app.html`);
  await page.evaluate(({ today }) => {
    localStorage.setItem('teampro_token', 'invalid-token');
    localStorage.setItem('teampro_auth_verified', new Date().toISOString());
    localStorage.setItem('teampro_shell_coach', JSON.stringify({ coachId: 'c_cached', name: 'Cached Coach', planName: 'Pro' }));
    localStorage.setItem(`teampro_shell_todaySummary_c_cached__${today}`, JSON.stringify({
      ok: true,
      date: today,
      totalAthletes: 1,
      submittedCount: 1,
      athletes: [{ athleteId: 'a_sensitive', recordId: 'r_sensitive', name: '敏感測試選手', status: 'red', painScore: 9, fatigue: 9, motivation: 1 }],
      missingNames: [],
      updatedAt: new Date().toISOString(),
    }));
  }, { today: TODAY });

  await page.reload();
  await expect(page.locator('#authPanel')).toBeVisible();
  await expect(page.locator('text=敏感測試選手')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('teampro_token'))).toBeNull();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('teampro_shell_coach'))).toBeNull();
});

test('priority retest 2: offline cached dashboard is clearly non-realtime and writes do not fake success', async ({ page }) => {
  await mockGas(page, (action) => {
    if (action === 'me') {
      return { ok: true, coach: { coachId: 'c_cached', email: 'coach@example.test', name: '測試教練', planName: '測試版' } };
    }
    if (action === 'listTeams') return { ok: true, teams: [] };
    if (action === 'coachFeedback') return { ok: false, error: 'mock offline' };
    if (action === 'warroom') return { ok: false, error: 'mock offline' };
    return { ok: false, error: 'mock offline' };
  });

  await page.goto(`${BASE_URL}/app.html`);
  await seedVerifiedSession(page, 'c_cached');
  await page.evaluate(({ today }) => {
    localStorage.setItem('teampro_lastSyncAt', '2026-08-25T01:23:00.000Z');
    localStorage.setItem(`teampro_shell_todaySummary_c_cached__${today}`, JSON.stringify({
      ok: true,
      date: today,
      totalAthletes: 1,
      submittedCount: 1,
      notSubmittedCount: 0,
      athletes: [{
        athleteId: 'a_offline',
        recordId: 'r_offline',
        name: '離線測試選手',
        group: '測試組',
        status: 'red',
        painScore: 8,
        painImpact: '影響動作',
        sleepMin: 300,
        fatigue: 9,
        motivation: 2,
        expectedCompletion: 40,
        athleteMessage: '測試留言',
      }],
      missingNames: [],
      updatedAt: '2026-08-25T01:23:00.000Z',
    }));
  }, { today: TODAY });

  await page.reload();
  await expect(page.locator('#dashboardPanel')).toBeVisible();
  await expect(page.locator('text=離線資料 / 非即時')).toBeVisible();
  await expect(page.locator('.shell-sync-note').first()).toContainText('最後成功同步');
  await expect(page.locator('.ath-card').filter({ hasText: '離線測試選手' })).toBeVisible();

  await page.locator('.ath-reply-in').first().fill('離線時保留輸入');
  await page.locator('.ath-reply-btn').first().click();
  await expect(page.locator('text=mock offline')).toBeVisible();
  await expect(page.locator('text=已同步選手')).toHaveCount(0);
  await expect(page.locator('.ath-reply-in').first()).toHaveValue('離線時保留輸入');
});

test('demo mode uses explicit demo labels only', async ({ page }) => {
  await page.goto(`${BASE_URL}/app.html?demo=1`);
  await expect(page.locator('#dashboardPanel')).toBeVisible();
  await expect(page.locator('.ath-card').filter({ hasText: 'Demo 選手A' })).toBeVisible();
  await expect(page.locator('text=陳柏宇')).toHaveCount(0);
  await expect(page.locator('text=林冠廷')).toHaveCount(0);
});

test('priority retest 3: authenticated workflow navigation, history, and reload restore tab state', async ({ page }) => {
  await mockGas(page, (action) => {
    if (action === 'me') {
      return { ok: true, coach: { coachId: 'c_nav', email: 'coach@example.test', name: '測試教練', planName: '測試版' } };
    }
    if (action === 'listTeams') return { ok: true, teams: [] };
    if (action === 'warroom') {
      return {
        ok: true,
        totalAthletes: 0,
        submittedCount: 0,
        missingCount: 0,
        submitted: [],
        missing: [],
        lights: { red: 0, yellow: 0, green: 0 },
      };
    }
    return { ok: true };
  });

  await page.goto(`${BASE_URL}/app.html`);
  await seedVerifiedSession(page, 'c_nav');
  await page.reload();
  await expect(page.locator('#dashboardPanel')).toBeVisible();
  await expect(page.locator('#dailyActionPanel')).toBeVisible();

  await page.locator('#mobileTabbar button[data-tab="tracking"]').click();
  await expect(page).toHaveURL(/#tab=tracking$/);
  await expect(page.locator('#dashboardPanel')).toBeVisible();
  await expect(page.locator('#dailyActionPanel')).toBeVisible();
  await expect(page.locator('#mobileTabbar button[data-tab="tracking"]')).toHaveClass(/active/);

  for (const tab of ['athletes', 'attendance', 'report']) {
    await page.locator(`#mobileTabbar button[data-tab="${tab}"]`).click();
    await expect(page).toHaveURL(new RegExp(`#tab=${tab}$`));
    await expect(page.locator('#featurePanel')).toBeVisible();
    await expect(page.locator('#featurePanel iframe.legacy-frame')).toHaveAttribute('src', new RegExp(`lazyTab=${tab}`));
    await expect(page.locator(`#mobileTabbar button[data-tab="${tab}"]`)).toHaveClass(/active/);
  }

  await page.locator('#mobileTabbar button[data-tab="dashboard"]').click();
  await expect(page).toHaveURL(/#tab=dashboard$/);
  await expect(page.locator('#dashboardPanel')).toBeVisible();
  await expect(page.locator('#featurePanel')).toBeHidden();

  await page.locator('#mobileTabbar button[data-tab="report"]').click();
  await page.reload();
  await expect(page).toHaveURL(/#tab=report$/);
  await expect(page.locator('#featurePanel')).toBeVisible();
  await expect(page.locator('#featurePanel iframe.legacy-frame')).toHaveAttribute('src', /lazyTab=report/);

  await page.goBack();
  await expect(page).toHaveURL(/#tab=dashboard$/);
  await expect(page.locator('#dashboardPanel')).toBeVisible();
});

test('daily action queue prioritizes unhandled red and missing reports', async ({ page }) => {
  await mockGas(page, (action) => {
    if (action === 'me') {
      return { ok: true, coach: { coachId: 'c_queue', email: 'coach@example.test', name: '測試教練', planName: '測試版' } };
    }
    if (action === 'listTeams') return { ok: true, teams: [] };
    if (action === 'warroom') {
      return {
        ok: true,
        totalAthletes: 3,
        submittedCount: 2,
        missingCount: 1,
        submitted: [
          { athleteId: 'a_red', recordId: 'r_red', name: '紅燈測試選手', status: 'red', painScore: 8, painImpact: '影響動作', fatigue: 8, motivation: 2 },
          { athleteId: 'a_green', recordId: 'r_green', name: '綠燈測試選手', status: 'green', painScore: 0, fatigue: 2, motivation: 5, coachFeedback: '已收到' },
        ],
        missing: [{ name: '未回報測試選手' }],
        lights: { red: 1, yellow: 0, green: 1 },
      };
    }
    return { ok: true };
  });

  await page.goto(`${BASE_URL}/app.html`);
  await seedVerifiedSession(page, 'c_queue');
  await page.reload();
  await expect(page.locator('#dailyActionPanel')).toBeVisible();
  await expect(page.locator('#dailyActionPanel')).toContainText('今日處理清單');
  await expect(page.locator('#dailyActionPanel')).toContainText('紅燈測試選手');
  await expect(page.locator('#dailyActionPanel')).toContainText('未回報測試選手');
  await expect(page.locator('.ath-card').filter({ hasText: '紅燈測試選手' })).toContainText('待教練處理');
  await expect(page.locator('.ath-card').filter({ hasText: '綠燈測試選手' })).toContainText('已處理');
});

for (const viewport of [
  { width: 360, height: 740 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1280, height: 800 },
]) {
  test(`basic responsive shell at ${viewport.width}px`, async ({ page }) => {
    const consoleErrors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    await page.setViewportSize(viewport);
    await page.goto(`${BASE_URL}/app.html`);
    await expect(page.locator('#authPanel')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
    expect(overflow).toBe(false);

    await page.goto(`${BASE_URL}/app.html?demo=1`);
    await expect(page.locator('#dashboardPanel')).toBeVisible();
    const demoOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
    expect(demoOverflow).toBe(false);
    expect(consoleErrors.filter((text) => !/favicon|manifest/i.test(text))).toEqual([]);
  });
}
