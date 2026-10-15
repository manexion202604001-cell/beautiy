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

    // 予約管理: week (the view it opens in), day, then a reservation and the new-reservation page
    await nav(page, '/app/calendar');
    await expect(page.getByTestId('calendar-grid')).toBeVisible();
    await page.waitForTimeout(800);
    await shot(page, `${vp.name}-calendar-week`);
    await page.getByRole('tab', { name: '日', exact: true }).click();
    await page.waitForTimeout(600);
    await shot(page, `${vp.name}-calendar-day`);

    const block = page.locator('[data-appt]').first();
    if (await block.count()) {
      await block.click();
      await expect(page).toHaveURL(/\/app\/calendar\/[0-9a-f-]{36}$/);
      await expect(page.getByText('予約詳細').first()).toBeVisible();
      await page.waitForTimeout(500);
      await shot(page, `${vp.name}-reservation-detail`);
    }

    await nav(page, '/app/calendar/new');
    await expect(page.getByRole('heading', { level: 1, name: '新規予約作成' })).toBeVisible();
    await page.waitForTimeout(600);
    await shot(page, `${vp.name}-create-appointment`);

    await nav(page, '/app/customers');
    await page.waitForTimeout(800);
    await shot(page, `${vp.name}-customers`);

    await page.locator('[data-customer]').first().click();
    const customerTabs = page.getByRole('tablist', { name: '顧客情報' });
    await expect(customerTabs).toBeVisible();
    await page.waitForTimeout(600);
    await shot(page, `${vp.name}-customer-detail`);
    for (const tab of ['予約履歴', 'カウンセリング', 'メッセージ']) {
      await customerTabs.getByRole('tab', { name: new RegExp(tab) }).click();
      await page.waitForTimeout(600);
      await shot(page, `${vp.name}-customer-${tab}`);
    }
    // the previous customer screen (tags, staff memos, merge history) stays one link away
    await page.getByTestId('customer-classic-link').click();
    await expect(page).toHaveURL(/\/app\/customers-classic\//);
    for (const tab of ['来店履歴', 'メモ', '重複候補・統合']) {
      await page.getByRole('tab', { name: new RegExp(tab) }).click();
      await page.waitForTimeout(600);
      await shot(page, `${vp.name}-customer-classic-${tab}`);
    }

    for (const [path, name] of [
      ['/app/customers/duplicates', 'duplicates'],
      ['/app/customers/new', 'customer-new'],
      ['/app/menus', 'menus'],
      ['/app/menus/categories', 'menu-categories'],
      ['/app/menus/new?type=coupon', 'coupon-new'],
      ['/app/menus-classic?tab=coupons', 'coupons'],
      ['/app/menus-classic?tab=resources', 'resources'],
      ['/app/staff', 'staff'],
      ['/app/staff-classic', 'staff-classic'],
      ['/app/staff/roles', 'roles'],
      ['/app/reservation-settings', 'reservation-settings'],
      ['/app/shifts', 'shifts'],
      ['/app/settings', 'store-settings'],
      ['/app/system', 'system-stores'],
      ['/app/system?tab=owner', 'system-owner'],
      ['/app/system?tab=staff', 'system-staff'],
      ['/app/system?tab=more', 'system-more'],
      ['/app/settings-classic', 'settings-shop'],
      ['/app/settings-classic?tab=booking', 'settings-booking'],
      ['/app/settings-classic?tab=hours', 'settings-hours'],
      ['/app/settings-classic?tab=holidays', 'settings-holidays'],
      ['/app/settings-classic?tab=org', 'settings-org'],
      ['/app/soon/pos', 'coming-soon'],
    ] as const) {
      await nav(page, path);
      await page.waitForTimeout(700);
      await shot(page, `${vp.name}-${name}`);
    }

    // スタッフ: 営業時間・予約設定 / スタッフ編集 dialogs of the first staff member
    await nav(page, '/app/staff');
    const staffRow = page.getByTestId('staff-list').locator('[data-staff]').first();
    await expect(staffRow).toBeVisible();
    await staffRow.getByRole('button', { name: '営業時間・予約設定' }).click();
    await page.waitForTimeout(600);
    await shot(page, `${vp.name}-staff-settings-hours`);
    await page.getByRole('tab', { name: '予約設定' }).click();
    await page.waitForTimeout(300);
    await shot(page, `${vp.name}-staff-settings-reservation`);
    await page.keyboard.press('Escape');
    await staffRow.getByRole('button', { name: 'スタッフ編集' }).click();
    await page.waitForTimeout(400);
    await shot(page, `${vp.name}-staff-edit`);
    await page.keyboard.press('Escape');

    // 予約受付設定: the four tabs
    await nav(page, '/app/reservation-settings');
    for (const tab of ['受付可能数', '予約設定', 'スタッフ別設定']) {
      await page.getByRole('tab', { name: tab, exact: true }).click();
      await page.waitForTimeout(500);
      await shot(page, `${vp.name}-reservation-settings-${tab}`);
    }

    // the previous staff screens (detail tabs) stay one link away
    await nav(page, '/app/staff-classic');
    await page.locator('tbody tr').nth(1).click();
    await page.waitForTimeout(600);
    await shot(page, `${vp.name}-staff-detail`);
    await page.getByRole('tab', { name: '勤務パターン' }).click();
    await page.waitForTimeout(600);
    await shot(page, `${vp.name}-staff-schedule`);

    await nav(page, '/app/menus');
    await page.getByRole('tab', { name: /クーポン/ }).click();
    await page.waitForTimeout(500);
    await shot(page, `${vp.name}-menu-coupons`);
    await page.getByRole('button', { name: '対応スタッフ' }).click();
    await page.waitForTimeout(500);
    await shot(page, `${vp.name}-menu-staff-matrix`);
    await page.getByRole('button', { name: 'リスト表示' }).click();
    await page.getByRole('tab', { name: /通常メニュー/ }).click();
    await page.getByRole('button', { name: '新規メニュー' }).click();
    await expect(page).toHaveURL(/\/app\/menus\/new\?type=regular/);
    await page.waitForTimeout(500);
    await shot(page, `${vp.name}-menu-new`);
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
  // the phone shell has a bottom bar: the screens outside its four tabs are under 「その他」
  await page.getByRole('button', { name: 'その他のメニュー' }).click();
  await page.waitForTimeout(300);
  await shot(page, 'phone-nav');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'アカウントメニュー' }).click();
  await page.waitForTimeout(300);
  await shot(page, 'phone-account-menu');
  await page.keyboard.press('Escape');
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
