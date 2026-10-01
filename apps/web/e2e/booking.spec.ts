import { expect, test } from '@playwright/test';
import { SHOP_SLUG } from './helpers';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test('customer: guest booking via /book/<slug> end-to-end', async ({ page }) => {
  await page.goto(`/book/${SHOP_SLUG}?utm_source=e2e&utm_campaign=smoke`);
  await expect(page.getByRole('heading', { name: 'メニューを選択' })).toBeVisible();

  // step 1: first menu
  await page.locator('main input[type="checkbox"]').first().check();
  await page.getByTestId('book-next').click();

  // step 2: staff (指名なし is preselected)
  const staffHeading = page.getByRole('heading', { name: 'スタッフを選択' });
  if (await staffHeading.isVisible().catch(() => false)) {
    await page.getByRole('radio', { name: /指名なし/ }).click();
    await page.getByTestId('book-next').click();
  }

  // step 3: first date that has slots
  await expect(page.getByRole('heading', { name: 'ご希望の日時' })).toBeVisible();
  const dates = page.getByRole('radiogroup', { name: '日付' }).getByRole('radio');
  const slots = page.getByRole('radiogroup', { name: '開始時刻' }).getByRole('radio');
  let picked = false;
  const n = await dates.count();
  for (let i = 0; i < n && !picked; i++) {
    const d = dates.nth(i);
    if (await d.isDisabled()) continue;
    await d.click();
    try {
      await expect(slots.first()).toBeVisible({ timeout: 4000 });
      picked = true;
    } catch {
      /* no slots that day */
    }
  }
  expect(picked).toBe(true);
  await slots.first().click();
  await page.getByTestId('book-next').click();

  // step 4: guest info
  await expect(page.getByRole('heading', { name: 'お客様情報' })).toBeVisible();
  const phone = `090${String(Date.now()).slice(-8)}`;
  await page.getByRole('textbox', { name: '姓', exact: true }).fill('テスト');
  await page.getByRole('textbox', { name: '名', exact: true }).fill('花子');
  await page.getByRole('textbox', { name: 'セイ', exact: true }).fill('テスト');
  await page.getByRole('textbox', { name: 'メイ', exact: true }).fill('ハナコ');
  await page.getByRole('textbox', { name: '電話番号', exact: true }).fill(phone);
  await page.getByTestId('book-next').click();

  // step 5: confirm
  await expect(page.getByRole('heading', { name: 'ご予約内容の確認' })).toBeVisible();
  await page.getByTestId('book-next').click();

  // done
  await expect(
    page.getByRole('heading', { name: /ご予約が完了しました|予約リクエストを受け付けました/ }),
  ).toBeVisible();
  await expect(page.getByTestId('booking-reference')).toHaveText(/^[A-Z0-9]{6,}$/);

  // manage link works
  await page.getByRole('link', { name: '予約の確認・キャンセル' }).click();
  await expect(page).toHaveURL(/\/b\/manage\//);
  await expect(page.getByText('予約番号')).toBeVisible();
});
