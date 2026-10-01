import { expect, test, type Page } from '@playwright/test';
import { loginAsStaff, nav } from './helpers';

/**
 * Screenshots of the messaging / campaigns / analytics / integrations / ops screens.
 * Run with SCREENSHOTS=1 (output: e2e/screenshots/, gitignored).
 */
test.skip(!process.env.SCREENSHOTS, 'SCREENSHOTS=1 only');

const OUT = 'e2e/screenshots';
const shot = (page: Page, name: string, fullPage = true) =>
  page.screenshot({ path: `${OUT}/p2b-${name}.png`, fullPage });

async function settle(page: Page, ms = 900) {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(ms);
}

const viewports = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
];

for (const vp of viewports) {
  test(`pass2-b screens (${vp.name})`, async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await loginAsStaff(page);
    await settle(page);
    await shot(page, `${vp.name}-dashboard`);

    const tabs: [string, string[]][] = [
      ['/app/messages', []],
      ['/app/campaigns', ['campaigns', 'segments', 'templates', 'automations', 'referrals', 'sns']],
      ['/app/analytics', ['sales', 'customers', 'repeat', 'ltv', 'menus', 'staff', 'channels', 'ai']],
      ['/app/integrations', ['accounts', 'status', 'conflicts', 'line']],
      ['/app/ops', ['dashboard', 'jobs', 'webhooks', 'health', 'audit', 'exports', 'flags']],
    ];
    for (const [path, list] of tabs) {
      if (!list.length) {
        await nav(page, path);
        await settle(page);
        await shot(page, `${vp.name}-${path.split('/').pop()}`);
        const first = page.getByRole('complementary', { name: '受信箱' }).getByRole('button').first();
        if (await first.count()) {
          await first.click();
          await settle(page);
          await shot(page, `${vp.name}-${path.split('/').pop()}-thread`, false);
        }
        continue;
      }
      for (const t of list) {
        await nav(page, `${path}?tab=${t}`);
        await settle(page, 1200);
        await expect(page.locator('main')).toBeVisible();
        await shot(page, `${vp.name}-${path.split('/').pop()}-${t}`);
      }
    }

    // dark mode (charts use their own dark steps)
    await page.emulateMedia({ colorScheme: 'dark' });
    for (const t of ['sales', 'menus', 'ai']) {
      await nav(page, `/app/analytics?tab=${t}`);
      await settle(page, 1200);
      await shot(page, `${vp.name}-dark-analytics-${t}`);
    }
    await page.emulateMedia({ colorScheme: 'light' });
  });
}
