import { test, type Page } from '@playwright/test';
import { loginAsStaff, nav } from './helpers';

/**
 * Crawls every screen to record API responses for the static web demo
 * (run with DEMO_CRAWL=1 against an API started with RECORD_FIXTURES=<file>).
 */
test.skip(!process.env.DEMO_CRAWL, 'demo fixture recording only');
test.setTimeout(30 * 60_000);

async function settle(page: Page) {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(250);
}

async function clickAllTabs(page: Page, depth = 0) {
  const tabs = page.getByRole('tab');
  const n = await tabs.count();
  for (let i = 0; i < n; i++) {
    const t = tabs.nth(i);
    if (!(await t.isVisible().catch(() => false))) continue;
    await t.click({ timeout: 3000 }).catch(() => undefined);
    await settle(page);
    if (depth === 0) {
      // segmented controls inside a tab (e.g. analytics group-by)
      const seg = page.locator('[role=radiogroup] [role=radio], [data-segmented] button');
      const m = Math.min(await seg.count(), 8);
      for (let j = 0; j < m; j++) {
        await seg.nth(j).click({ timeout: 2000 }).catch(() => undefined);
        await settle(page);
      }
    }
  }
}

async function visit(page: Page, path: string, tabs = true) {
  await nav(page, path);
  await settle(page);
  if (tabs) await clickAllTabs(page);
}

async function linksMatching(page: Page, re: RegExp, max: number): Promise<string[]> {
  const hrefs = await page.locator('a[href]').evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute('href') ?? ''));
  return [...new Set(hrefs.filter((h) => re.test(h)))].slice(0, max);
}

test('crawl staff app', async ({ page }) => {
  await loginAsStaff(page);
  await settle(page);
  await visit(page, '/app');
  // 予約管理: each view (週 / 日 / 月) with one step back and a few steps ahead, then the pages behind it
  await visit(page, '/app/calendar', false);
  const apptIds = new Set<string>();
  const collectAppts = async () => {
    const ids = await page
      .locator('[data-appt]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-appt') ?? '').filter(Boolean));
    for (const id of ids) apptIds.add(id);
  };
  for (const [view, ahead] of [
    ['週', 3],
    ['日', 14],
    ['月', 2],
  ] as const) {
    await page.getByRole('tab', { name: view, exact: true }).click({ timeout: 3000 }).catch(() => undefined);
    await settle(page);
    await page.getByRole('button', { name: '前へ' }).click({ timeout: 3000 }).catch(() => undefined);
    await settle(page);
    await collectAppts();
    for (let i = 0; i <= ahead; i++) {
      await page.getByRole('button', { name: '次へ' }).click({ timeout: 3000 }).catch(() => undefined);
      await settle(page);
      await collectAppts();
    }
    await page.getByRole('button', { name: '今日', exact: true }).click({ timeout: 3000 }).catch(() => undefined);
    await settle(page);
  }
  for (const id of [...apptIds].slice(0, 25)) await visit(page, `/app/calendar/${id}`, false);
  await visit(page, '/app/calendar/new', false);
  await visit(page, '/app/menus/select', false);
  await visit(page, '/app/customers?mode=select', false);
  await visit(page, '/app/calendar-classic', false);

  await visit(page, '/app/customers');
  // back to the list after the 担当未設定 / 統合候補 / 名前重複 tabs
  await page.getByRole('tab', { name: /全顧客/ }).click({ timeout: 3000 }).catch(() => undefined);
  await settle(page);
  const more = page.getByRole('button', { name: /もっと見る/ });
  for (let i = 0; i < 3 && (await more.isVisible().catch(() => false)); i++) {
    await more.click().catch(() => undefined);
    await settle(page);
  }
  // customer rows are not links: take the ids from the rows; record the customer screen and the previous one
  const customerIds = await page
    .locator('[data-customer]')
    .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-customer') ?? '').filter(Boolean));
  for (const id of [...new Set(customerIds)].slice(0, 40)) {
    await visit(page, `/app/customers/${id}`, false);
    // the karte tab is the one open first
    const karteIds = await page
      .locator('[data-karte]')
      .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-karte') ?? '').filter(Boolean));
    await clickAllTabs(page);
    for (const karteId of karteIds.slice(0, 3)) await visit(page, `/app/customers/kartes/${karteId}`);
    await visit(page, `/app/customers-classic/${id}`);
  }
  await visit(page, '/app/customers/new', false);
  await visit(page, '/app/customers/duplicates');

  await visit(page, '/app/menus');
  const menuIds = await page
    .locator('[data-menu]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-menu') ?? '').filter(Boolean));
  for (const id of [...new Set(menuIds)].slice(0, 20)) await visit(page, `/app/menus/${id}`, false);
  await visit(page, '/app/menus/new?type=regular', false);
  await visit(page, '/app/menus/new?type=coupon', false);
  await visit(page, '/app/menus/categories', false);
  await visit(page, '/app/menus-classic');
  await visit(page, '/app/consents', false);
  await visit(page, '/app/customers-classic', false);
  await visit(page, '/app/staff');
  await visit(page, '/app/staff-classic');
  for (const href of await linksMatching(page, /^\/app\/staff-classic\/[0-9a-f-]{36}$/, 10)) await visit(page, href);
  await visit(page, '/app/staff/roles');
  await visit(page, '/app/shifts');
  await visit(page, '/app/reservation-settings');
  await visit(page, '/app/settings');
  await visit(page, '/app/settings-classic');
  await visit(page, '/app/system');

  await visit(page, '/app/pos');
  await visit(page, '/app/pos/transactions');
  for (const href of await linksMatching(page, /^\/app\/pos\/checkout\//, 10)) await visit(page, href, false);
  await visit(page, '/app/pos/daily');
  await visit(page, '/app/kartes');
  for (const href of await linksMatching(page, /^\/app\/kartes\/[0-9a-f-]{36}$/, 10)) await visit(page, href, false);
  await visit(page, '/app/kartes/forms');
  await visit(page, '/app/reviews');
  await visit(page, '/app/commerce');

  await visit(page, '/app/messages');
  const threads = page.locator('[data-thread], [role=listitem] button, li button').filter({ hasText: /./ });
  for (let i = 0; i < Math.min(await threads.count(), 8); i++) {
    await threads.nth(i).click({ timeout: 2000 }).catch(() => undefined);
    await settle(page);
  }
  await visit(page, '/app/messages-classic');
  await visit(page, '/app/migration', false);
  await visit(page, '/app/campaigns');
  for (const range of ['', '?period=last7', '?period=thisMonth', '?period=last90']) await visit(page, `/app/analytics${range}`);
  await visit(page, '/app/integrations');
  await visit(page, '/app/ops');
});

test('crawl public pages', async ({ page }) => {
  for (const slug of ['shibuya', 'omotesando']) {
    await page.goto(`/book/${slug}`);
    await settle(page);
    const menus = page.getByRole('checkbox');
    if (await menus.count()) {
      await menus.first().check({ timeout: 3000 }).catch(() => undefined);
      await page.getByRole('button', { name: '次へ' }).click({ timeout: 3000 }).catch(() => undefined);
      await settle(page);
      const staffCards = page.getByRole('radio');
      for (let i = 0; i < Math.min(await staffCards.count(), 4); i++) {
        await staffCards.nth(i).click({ timeout: 2000 }).catch(() => undefined);
        await settle(page);
      }
      await page.getByRole('button', { name: '次へ' }).click({ timeout: 3000 }).catch(() => undefined);
      await settle(page);
      const days = page.locator('[data-date], button[aria-pressed]');
      for (let i = 0; i < Math.min(await days.count(), 10); i++) {
        await days.nth(i).click({ timeout: 2000 }).catch(() => undefined);
        await settle(page);
      }
    }
    await page.goto(`/book/${slug}/reviews`);
    await settle(page);
    await page.goto(`/store/${slug}`);
    await settle(page);
    const products = await linksMatching(page, /\/products\//, 6);
    for (const href of products) {
      await page.goto(href);
      await settle(page);
    }
  }
  await page.goto('/my/shibuya');
  await settle(page);
  const line = page.getByRole('button', { name: /LINE/ });
  if (await line.isVisible().catch(() => false)) {
    await line.click().catch(() => undefined);
    await settle(page);
  }
  await clickAllTabs(page);
});
