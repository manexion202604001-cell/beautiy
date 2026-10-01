import { expect, test, type Page } from '@playwright/test';
import { SHOP_SLUG, loginAsStaff, nav } from './helpers';

/**
 * Screenshots of the POS / karte / reviews / EC screens (desktop, iPad, phone).
 * Runs only with SCREENSHOTS=1; output in e2e/screenshots (git-ignored).
 */
test.skip(!process.env.SCREENSHOTS, 'SCREENSHOTS=1 のときのみ実行');

const DIR = 'e2e/screenshots';
const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  ipad: { width: 1024, height: 768 },
  phone: { width: 390, height: 844 },
} as const;

async function shoot(page: Page, name: string) {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${DIR}/${name}.png` });
}

for (const [vp, size] of Object.entries(VIEWPORTS)) {
  test(`staff screens (${vp})`, async ({ page }) => {
    await page.setViewportSize(size);
    await loginAsStaff(page);
    const screens: [string, string, string][] = [
      ['/app/pos', 'pos-home', '会計'],
      ['/app/pos/transactions', 'pos-transactions', '会計履歴'],
      ['/app/pos/daily', 'pos-daily', '日報'],
      ['/app/kartes', 'kartes-list', 'カルテ'],
      ['/app/kartes/forms', 'form-templates', '問診・同意書フォーム'],
      ['/app/reviews', 'reviews', '口コミ'],
      ['/app/commerce?tab=products', 'commerce-products', '商品・EC'],
      ['/app/commerce?tab=low', 'commerce-low-stock', '商品・EC'],
      ['/app/commerce?tab=orders', 'commerce-orders', '商品・EC'],
      ['/app/commerce?tab=sales', 'commerce-sales', '商品・EC'],
    ];
    for (const [path, name, heading] of screens) {
      await nav(page, path);
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
      await shoot(page, `${name}-${vp}`);
    }
    // register close dialog (denomination counting)
    await nav(page, '/app/pos');
    await expect(page.getByText(/開局中|未開局/).first()).toBeVisible();
    const close = page.getByRole('button', { name: 'レジ締め' });
    if (await close.isVisible().catch(() => false)) {
      await close.click();
      const dlg = page.getByRole('dialog', { name: 'レジ締め' });
      await dlg.getByLabel('10,000円札の枚数').fill('3');
      await dlg.getByLabel('1,000円札の枚数').fill('12');
      await shoot(page, `pos-register-close-${vp}`);
      await dlg.getByRole('button', { name: 'キャンセル' }).click();
    }
    // form template editor
    await nav(page, '/app/kartes/forms');
    await page.getByRole('button', { name: '編集' }).first().click();
    await shoot(page, `form-template-editor-${vp}`);
    await page.keyboard.press('Escape');
    // a karte from the list
    await nav(page, '/app/kartes');
    const first = page.getByRole('link', { name: /のカルテを開く/ }).first();
    if (await first.isVisible().catch(() => false)) {
      await first.click();
      await expect(page.getByRole('heading', { level: 1, name: /カルテ/ })).toBeVisible();
      await shoot(page, `karte-editor-${vp}`);
    }
  });

  test(`public screens (${vp})`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto(`/book/${SHOP_SLUG}`);
    await expect(page.getByRole('heading', { name: 'メニューを選択' })).toBeVisible();
    await shoot(page, `book-with-reviews-${vp}`);
    await page.goto(`/book/${SHOP_SLUG}/reviews`);
    await shoot(page, `shop-reviews-${vp}`);
    const info = await page.request.get(`/v1/public/shops/${SHOP_SLUG}`);
    const staff = ((await info.json()) as { staff: { id: string }[] }).staff[0];
    if (staff) {
      await page.goto(`/book/${SHOP_SLUG}/staff/${staff.id}`);
      await shoot(page, `staff-profile-${vp}`);
    }
    await page.goto(`/store/${SHOP_SLUG}`);
    await shoot(page, `storefront-${vp}`);
  });
}
