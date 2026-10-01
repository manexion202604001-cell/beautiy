import { expect, test, type Page } from '@playwright/test';
import { SHOP_SLUG, loginAsStaff, nav } from './helpers';

/**
 * Visual check of the main screens (run: pnpm --filter @salon/web screenshots).
 * Output: e2e/screenshots/*.png (gitignored)
 */
const OUT = 'e2e/screenshots';
const shot = (page: Page, name: string, fullPage = false) =>
  page.screenshot({ path: `${OUT}/${name}.png`, fullPage });

const viewports = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'ipad', width: 1024, height: 768 },
];

for (const vp of viewports) {
  test(`staff screens (${vp.name})`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await loginAsStaff(page);
    await page.waitForTimeout(800);
    await shot(page, `${vp.name}-dashboard`);

    await nav(page, '/app/calendar');
    await expect(page.getByTestId('calendar-grid')).toBeVisible();
    await page.waitForTimeout(600);
    await shot(page, `${vp.name}-calendar-day`);

    const block = page.locator('[data-appt]').first();
    if (await block.count()) {
      await block.click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.waitForTimeout(500);
      await shot(page, `${vp.name}-appointment-drawer`);
      await page.keyboard.press('Escape');
    }

    await page.getByRole('button', { name: '予約を追加', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: '予約を作成' });
    await drawer.locator('input[type="checkbox"]').first().check();
    await page.waitForTimeout(800);
    await shot(page, `${vp.name}-create-appointment`);
    await page.keyboard.press('Escape');

    await nav(page, '/app/calendar?view=week');
    await page.waitForTimeout(800);
    await shot(page, `${vp.name}-calendar-week`);

    await nav(page, '/app/customers');
    await page.waitForTimeout(800);
    await shot(page, `${vp.name}-customers`);

    await page.locator('tbody tr').first().click();
    await expect(page.getByRole('tablist', { name: '顧客情報' })).toBeVisible();
    await page.waitForTimeout(600);
    await shot(page, `${vp.name}-customer-detail`);
    for (const tab of ['来店履歴', 'メモ', '重複候補・統合']) {
      await page.getByRole('tab', { name: new RegExp(tab) }).click();
      await page.waitForTimeout(600);
      await shot(page, `${vp.name}-customer-${tab}`);
    }

    for (const [path, name] of [
      ['/app/customers/duplicates', 'duplicates'],
      ['/app/customers/new', 'customer-new'],
      ['/app/menus', 'menus'],
      ['/app/menus?tab=coupons', 'coupons'],
      ['/app/menus?tab=resources', 'resources'],
      ['/app/staff', 'staff'],
      ['/app/staff/roles', 'roles'],
      ['/app/shifts', 'shifts'],
      ['/app/settings', 'settings-shop'],
      ['/app/settings?tab=booking', 'settings-booking'],
      ['/app/settings?tab=hours', 'settings-hours'],
      ['/app/settings?tab=holidays', 'settings-holidays'],
      ['/app/settings?tab=org', 'settings-org'],
      ['/app/soon/pos', 'coming-soon'],
    ] as const) {
      await nav(page, path);
      await page.waitForTimeout(700);
      await shot(page, `${vp.name}-${name}`);
    }

    await nav(page, '/app/staff');
    await page.locator('tbody tr').nth(1).click();
    await page.waitForTimeout(600);
    await shot(page, `${vp.name}-staff-detail`);
    await page.getByRole('tab', { name: '勤務パターン' }).click();
    await page.waitForTimeout(600);
    await shot(page, `${vp.name}-staff-schedule`);

    await nav(page, '/app/menus');
    await page.getByRole('button', { name: 'メニューを追加' }).click();
    await page.waitForTimeout(500);
    await shot(page, `${vp.name}-menu-dialog`);
  });
}

test('auth screens', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/login');
  await shot(page, 'desktop-login');
  await page.goto('/signup');
  await shot(page, 'desktop-signup', true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/login');
  await shot(page, 'phone-login');
});

test('staff on phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginAsStaff(page);
  await page.waitForTimeout(600);
  await shot(page, 'phone-dashboard');
  await page.getByRole('button', { name: 'メニューを開く' }).click();
  await page.waitForTimeout(300);
  await shot(page, 'phone-nav');
  await nav(page, '/app/calendar');
  await page.waitForTimeout(800);
  await shot(page, 'phone-calendar');
  await nav(page, '/app/customers');
  await page.waitForTimeout(800);
  await shot(page, 'phone-customers');
});

test('customer booking flow (phone)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/book/${SHOP_SLUG}`);
  await page.waitForTimeout(600);
  await shot(page, 'phone-book-1-menu');
  await page.locator('main input[type="checkbox"]').first().check();
  await page.getByTestId('book-next').click();
  await page.waitForTimeout(400);
  await shot(page, 'phone-book-2-staff');
  await page.getByTestId('book-next').click();
  await page.waitForTimeout(1200);
  const dates = page.getByRole('radiogroup', { name: '日付' }).getByRole('radio');
  const slots = page.getByRole('radiogroup', { name: '開始時刻' }).getByRole('radio');
  for (let i = 0; i < 7; i++) {
    if (await slots.count()) break;
    const d = dates.nth(i + 1);
    if (!(await d.isDisabled())) await d.click();
    await page.waitForTimeout(800);
  }
  await shot(page, 'phone-book-3-datetime');
  await slots.first().click();
  await page.getByTestId('book-next').click();
  await page.waitForTimeout(400);
  await shot(page, 'phone-book-4-info', true);
  await page.getByRole('textbox', { name: '姓', exact: true }).fill('見本');
  await page.getByRole('textbox', { name: '名', exact: true }).fill('太郎');
  await page
    .getByRole('textbox', { name: '電話番号', exact: true })
    .fill(`080${String(Date.now()).slice(-8)}`);
  await page.getByTestId('book-next').click();
  await page.waitForTimeout(400);
  await shot(page, 'phone-book-5-confirm', true);
  await page.getByTestId('book-next').click();
  await expect(page.getByTestId('booking-reference')).toBeVisible();
  await shot(page, 'phone-book-6-done', true);
  await page.getByRole('link', { name: '予約の確認・キャンセル' }).click();
  await page.waitForTimeout(800);
  await shot(page, 'phone-manage', true);
  await page.goto(`/my/${SHOP_SLUG}`);
  await page.getByRole('button', { name: /LINEでログイン/ }).click();
  await page.waitForTimeout(1200);
  await shot(page, 'phone-my', true);
});
