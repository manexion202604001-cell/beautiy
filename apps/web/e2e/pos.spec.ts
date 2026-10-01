import { expect, test } from '@playwright/test';
import { loginAsStaff, nav } from './helpers';

const SHOTS = 'e2e/screenshots';

test('POS: checkout an appointment (cash, change, complete, receipt)', async ({
  page,
  context,
}) => {
  await loginAsStaff(page);
  await nav(page, '/app/pos');
  await expect(page.getByRole('heading', { level: 1, name: '会計' })).toBeVisible();

  // the shop requires an open register to complete transactions
  const openBtn = page.getByRole('button', { name: 'レジを開局する' });
  await expect(page.getByText(/開局中|未開局/).first()).toBeVisible();
  if (await openBtn.isVisible()) {
    await openBtn.click();
    const dlg = page.getByRole('dialog', { name: 'レジ開局' });
    await dlg.getByLabel('釣銭準備金').fill('30000');
    await dlg.getByRole('button', { name: '開局する' }).click();
    await expect(page.getByText('レジを開局しました')).toBeVisible();
  }
  await expect(page.getByTestId('expected-cash')).toBeVisible();

  // start checkout from a waiting appointment
  const start = page.getByTestId('start-checkout').first();
  await expect(start).toBeVisible();
  await start.click();
  await expect(page).toHaveURL(/\/app\/pos\/checkout\//);
  await expect(page.getByTestId('tx-line').first()).toBeVisible();
  await expect(page.getByTestId('tax-breakdown')).toBeVisible();

  const totalText = (await page.getByTestId('tx-total').textContent()) ?? '';
  const total = Number(totalText.replace(/[^\d]/g, ''));
  expect(total).toBeGreaterThan(0);
  await page.screenshot({ path: `${SHOTS}/pos-checkout-draft.png`, fullPage: true });

  // cash: tender a round amount above the total and check the change
  await page.getByRole('group', { name: '支払方法' }).getByRole('button', { name: '現金' }).click();
  const pay = page.getByRole('dialog', { name: '現金でお支払い' });
  const tendered = Math.ceil((total + 1) / 1000) * 1000;
  for (const ch of String(tendered))
    await pay.getByRole('button', { name: ch, exact: true }).click();
  await expect(pay.getByTestId('change')).toHaveText(
    `¥${(tendered - total).toLocaleString('ja-JP')}`,
  );
  await page.screenshot({ path: `${SHOTS}/pos-cash-keypad.png` });
  await pay.getByTestId('confirm-payment').click();
  await expect(page.getByTestId('outstanding')).toHaveText('¥0');

  // complete (Idempotency-Key)
  await page.getByTestId('complete-transaction').click();
  await expect(page.getByText('会計が完了しました').first()).toBeVisible();
  await expect(
    page.getByText(`お釣り ¥${(tendered - total).toLocaleString('ja-JP')}`).first(),
  ).toBeVisible();

  // receipt → printable HTML in a new tab (authenticated fetch → blob URL)
  await page.getByRole('button', { name: '発行する' }).click();
  const popupPromise = context.waitForEvent('page');
  await page.getByTestId('issue-receipt').click();
  const popup = await popupPromise;
  await expect(popup.locator('body')).toContainText('レシート', { timeout: 15_000 });
  await expect(page.getByTestId('receipts')).toContainText('R');
  await page.screenshot({ path: `${SHOTS}/pos-checkout-completed.png`, fullPage: true });
  await popup.close();

  // daily report shows the sale
  await nav(page, '/app/pos/daily');
  await expect(page.getByTestId('report-by-method')).toContainText('現金');
});
