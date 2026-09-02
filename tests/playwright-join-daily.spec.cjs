const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:4173';

// 選手每日回報是改動最大、原本卻完全沒有瀏覽器測試的畫面。
// 這支測試守住簡化後的主流程：選身分 → 六題快速量表 → 一次送出。
async function mockGas(page, onSubmit) {
  await page.route('https://script.google.com/macros/s/**/exec', async (route) => {
    let data = {};
    try { data = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
    const action = data.action || '';
    let body = { ok: false, error: 'unexpected action: ' + action };

    if (action === 'joinInfo') {
      body = {
        ok: true,
        team: { teamId: 't1', teamName: '示範隊' },
        athletes: [{ athleteId: 'a1', name: '選手甲' }, { athleteId: 'a2', name: '選手乙' }],
        pro: false,
        free: true,
      };
    } else if (action === 'kpi2State' || action === 'kpiFormState') {
      body = { ok: true, kpiDue: false, cadence: 'weekly', completed: true };
    } else if (action === 'teamCompetitions') {
      body = { ok: true, competitions: [] };
    } else if (action === 'submitRecord') {
      onSubmit(data);
      body = { ok: true, status: 'green', quality: { score: 90, label: '良好' } };
    }

    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

test('athlete daily report submits from the quick scales in one step', async ({ page }) => {
  const submitted = [];
  await mockGas(page, (d) => submitted.push(d));

  await page.goto(`${BASE_URL}/join.html?t=demo-token`);
  await expect(page.locator('#step-who')).toBeVisible();

  await page.locator('#whoSelect').selectOption('a1');
  await page.locator('#consent').check();
  await page.locator('#whoNext').click();

  // 主流程只剩今日狀態：六題 1–5 量表直接可按
  await expect(page.locator('#step-body')).toBeVisible();
  await expect(page.locator('#dailyQuickScale .quick-scale-row')).toHaveCount(6);
  await expect(page.locator('#navNext')).toHaveText('送出今日回報');

  await page.locator('[data-quick="sleep"] button[data-score="5"]').click();
  await page.locator('[data-quick="pain"] button[data-score="2"]').click();
  await page.locator('[data-quick="performance"] button[data-score="4"]').click();

  // 細節區塊預設收合，不擋住送出
  await expect(page.locator('details.optional-daily').first()).not.toHaveAttribute('open', /.*/);

  await page.locator('#trainingNotes').fill('最後一組有撐住');
  await page.locator('#improveToday').fill('切入時機太慢');
  await page.locator('#consentPrivacy').check();
  await page.locator('#guardianConsent').check();
  await page.locator('#navNext').click();

  await expect(page.locator('#step-result')).toBeVisible();
  expect(submitted).toHaveLength(1);

  const payload = submitted[0];
  expect(payload.athleteId).toBe('a1');
  // 睡眠 5 分要對應到「良好」，疼痛 2 分要把疼痛狀態帶起來給教練看見
  expect(payload.sleepQuality).toBe('good');
  expect(payload.painStatus).not.toBe('none');
  expect(payload.painScore).toBeGreaterThan(0);
  expect(payload.trainingNotes).toContain('最後一組有撐住');
  expect(payload.trainingNotes).toContain('切入時機太慢');
  expect(payload.trainingNotes).toContain('訓練表現：4/5');

  // 建議與分享文字改成可展開，不是被砍掉
  const extras = page.locator('#step-result details.optional-daily');
  await expect(extras).toBeVisible();
  await extras.locator('summary').click();
  await expect(page.locator('#btnCopyParent')).toBeVisible();

  // KPI 量表這次沒到期，就不該冒出來卡住流程
  await expect(page.locator('#btnWeeklyKpi')).toBeHidden();
});

test('athlete sees the KPI form entry only when it is due', async ({ page }) => {
  await page.route('https://script.google.com/macros/s/**/exec', async (route) => {
    let data = {};
    try { data = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
    const action = data.action || '';
    let body = { ok: false, error: 'unexpected action: ' + action };

    if (action === 'joinInfo') {
      body = { ok: true, team: { teamId: 't1', teamName: '示範隊' }, athletes: [{ athleteId: 'a1', name: '選手甲' }], free: true };
    } else if (action === 'kpi2State') {
      body = { ok: false };
    } else if (action === 'kpiFormState') {
      body = { ok: true, kpiDue: true, cadence: 'weekly' };
    } else if (action === 'teamCompetitions') {
      body = { ok: true, competitions: [] };
    } else if (action === 'submitRecord') {
      body = { ok: true, status: 'green' };
    }

    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  await page.goto(`${BASE_URL}/join.html?t=demo-token`);
  await page.locator('#whoSelect').selectOption('a1');
  await page.locator('#consent').check();
  await page.locator('#whoNext').click();

  await page.locator('#consentPrivacy').check();
  await page.locator('#guardianConsent').check();
  await page.locator('#navNext').click();

  await expect(page.locator('#step-result')).toBeVisible();
  await expect(page.locator('#btnWeeklyKpi')).toBeVisible();
});
