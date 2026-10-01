import { expect, test } from '@playwright/test';
import { SHOP_SLUG, loginAsStaff, nav } from './helpers';

const SHOTS = 'e2e/screenshots';
// 1×1 PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

test('EC: product → storefront → cart → checkout → order visible to staff', async ({
  page,
  browser,
}) => {
  const productName = `E2Eトリートメント ${Date.now().toString().slice(-6)}`;

  // ---- staff: register an online product with an image and EC stock
  await loginAsStaff(page);
  await nav(page, '/app/commerce');
  await expect(page.getByRole('heading', { level: 1, name: '商品・EC' })).toBeVisible();
  await page.getByRole('button', { name: '商品を登録' }).click();
  const dlg = page.getByRole('dialog', { name: '商品を登録' });
  await dlg.getByLabel('商品名').fill(productName);
  await dlg.getByLabel('ブランド').fill('Salon OS');
  await dlg.getByLabel('販売価格').fill('3300');
  await dlg.getByRole('switch', { name: 'ECで販売する' }).click();
  await dlg
    .getByTestId('product-image-input')
    .setInputFiles({ name: 'p.png', mimeType: 'image/png', buffer: PNG });
  await expect(dlg.getByRole('img', { name: '商品画像1' })).toBeVisible();
  await dlg.getByTestId('save-product').click();
  await expect(page.getByText('商品を登録しました')).toBeVisible();

  const row = page.getByRole('row').filter({ hasText: productName });
  await row.getByRole('button', { name: '在庫' }).click();
  const drawer = page.getByRole('dialog', { name: `在庫: ${productName}` });
  await drawer.getByLabel('数量').fill('10');
  await drawer.getByTestId('stock-adjust-submit').click();
  await expect(page.getByText('在庫を更新しました')).toBeVisible();
  await expect(drawer.getByRole('cell', { name: 'EC倉庫' })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/commerce-stock.png` });
  await drawer.getByRole('button', { name: '閉じる' }).click();

  // ---- customer: storefront → cart → checkout (LINE mock login)
  const ctx = await browser.newContext({
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    viewport: { width: 390, height: 844 },
  });
  const c = await ctx.newPage();
  await c.goto(`/store/${SHOP_SLUG}`);
  const card = c
    .getByTestId('store-products')
    .getByRole('listitem')
    .filter({ hasText: productName });
  await expect(card).toBeVisible();
  await c.screenshot({ path: `${SHOTS}/store-front-phone.png`, fullPage: true });
  await card.getByRole('link').first().click();
  await expect(c.getByRole('heading', { name: productName })).toBeVisible();
  await c.getByRole('button', { name: '数量を増やす' }).click();
  await c.getByTestId('add-to-cart').click();
  await expect(c.getByTestId('cart-count')).toHaveText('2');
  await c.screenshot({ path: `${SHOTS}/store-product-phone.png` });
  await c.getByTestId('cart-link').click();
  await expect(c.getByTestId('cart-subtotal')).toHaveText('¥6,600');
  await c.getByTestId('go-checkout').click();
  await c.getByRole('button', { name: /LINEでログイン/ }).click();
  await c.getByLabel('お名前').fill('テスト 花子');
  await c.getByLabel('郵便番号').fill('150-0001');
  await c.getByLabel('市区町村').fill('渋谷区神宮前');
  await c.getByLabel('番地').fill('1-2-3');
  await c.getByLabel('電話番号').fill('090-1234-5678');
  await c.screenshot({ path: `${SHOTS}/store-checkout-phone.png`, fullPage: true });
  await c.getByTestId('place-order').click();
  await expect(c).toHaveURL(new RegExp(`/store/${SHOP_SLUG}/orders/`));
  await expect(c.getByText('決済待ち').first()).toBeVisible();
  const total = (await c.getByTestId('order-total').textContent()) ?? '';
  expect(Number(total.replace(/[^\d]/g, ''))).toBeGreaterThanOrEqual(6600);
  const heading = (await c.getByRole('heading', { name: /注文番号/ }).textContent()) ?? '';
  const orderNumber = heading.replace('注文番号', '').trim();
  expect(orderNumber).toMatch(/^EC\d{4}-\d{6}$/);
  await c.screenshot({ path: `${SHOTS}/store-order-pending-phone.png`, fullPage: true });

  // ---- staff: the order is listed; complete the mock payment and ship it
  await nav(page, '/app/commerce?tab=orders');
  const orderRow = page.getByRole('row').filter({ hasText: orderNumber });
  await expect(orderRow).toBeVisible();
  await orderRow.click();
  const od = page.getByRole('dialog', { name: `注文 ${orderNumber}` });
  await expect(od.getByText(productName)).toBeVisible();
  await od.getByTestId('mock-complete-payment').click();
  await expect(od.getByText('支払済').first()).toBeVisible();
  await od.getByTestId('ship-order').click();
  const ship = page.getByRole('dialog', { name: '発送情報' });
  await ship.getByLabel('伝票番号').fill('1234-5678-9012');
  await ship.getByTestId('ship-submit').click();
  await expect(od.getByText('発送済').first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/commerce-order-drawer.png` });

  // ---- customer: the polling order page reflects the payment; my page lists the order
  await expect(
    c.getByText('ご注文ありがとうございます').or(c.getByText('発送済').first()),
  ).toBeVisible({ timeout: 15_000 });
  await c.goto(`/my/${SHOP_SLUG}?tab=orders`);
  await expect(c.getByTestId('my-orders')).toContainText('発送済');
  await ctx.close();
});
