import { expect, test } from '@playwright/test';
import { loginAsStaff, nav } from './helpers';

const SHOTS = 'e2e/screenshots';

test('reviews: staff issues a request (URL + QR) → customer submits → staff publishes and replies', async ({
  page,
  browser,
}) => {
  await loginAsStaff(page);
  await nav(page, '/app/reviews');
  await expect(page.getByRole('heading', { level: 1, name: '口コミ' })).toBeVisible();

  // issue a review request for a seeded customer without sending (counter QR)
  await page.getByRole('button', { name: '口コミ依頼を作成' }).click();
  const dlg = page.getByRole('dialog', { name: '口コミ依頼を作成' });
  await dlg.getByRole('combobox', { name: '顧客を検索' }).fill('ササキ');
  await dlg.getByRole('listbox').getByRole('option').first().click();
  await dlg.getByRole('button', { name: 'リンクを発行' }).click();
  await expect(dlg.getByRole('img', { name: '口コミ投稿リンクのQRコード' })).toBeVisible();
  const url = await dlg.getByTestId('copy-link-url').inputValue();
  expect(url).toMatch(/\/review\/[A-Za-z0-9_-]+$/);
  await page.screenshot({ path: `${SHOTS}/reviews-request-qr.png` });
  await dlg.getByRole('button', { name: '閉じる' }).last().click();

  // customer submits on a phone
  const ctx = await browser.newContext({
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    viewport: { width: 390, height: 844 },
  });
  const c = await ctx.newPage();
  await c.goto(new URL(url).pathname);
  await expect(c.getByRole('heading', { name: 'ご来店ありがとうございました' })).toBeVisible();
  await c.getByRole('radio', { name: /5点/ }).first().click();
  const comment = `仕上がりがとても素敵でした ${Date.now()}`;
  await c.getByLabel(/ご感想/).fill(comment);
  await c.getByLabel(/ニックネーム/).fill('はなこ');
  await c.screenshot({ path: `${SHOTS}/review-submit-phone.png`, fullPage: true });
  await c.getByTestId('submit-review').click();
  await expect(c.getByRole('heading', { name: 'ご協力ありがとうございました' })).toBeVisible();
  // the single-use link cannot be reused
  await c.reload();
  await expect(c.getByText('このリンクは投稿済みか、有効期限が切れています')).toBeVisible();
  await ctx.close();

  // staff: moderate + reply
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: '口コミ' })).toBeVisible();
  const item = page.getByTestId('review-list').getByRole('listitem').filter({ hasText: comment });
  await expect(item).toBeVisible();
  await item.getByRole('button', { name: '公開する' }).click();
  await expect(page.getByText('公開しました')).toBeVisible();
  await item.getByRole('button', { name: '返信する' }).click();
  await item
    .getByLabel('返信')
    .fill('ご来店ありがとうございました。またのお越しをお待ちしております。');
  await item.getByRole('button', { name: '返信を保存' }).click();
  await expect(item.getByText('お店からの返信')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/reviews-list.png`, fullPage: true });
});
