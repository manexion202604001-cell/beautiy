// Public, no-account booking on a phone against the seeded demo shop, then the customer
// reschedules and cancels through the manage page from the confirmation screen.
import { test, expect } from '@playwright/test';
import { pickFirstSlot, visit } from './helpers';

const SHOP = 'aoyama';
// fixed identity: repeated runs resolve to the same demo customer instead of piling up new ones
const guest = { name: 'E2E モバイル', kana: 'イーツーイー モバイル', phone: '080-0000-0101' };

test('customer books on mobile, changes the time and cancels', async ({ page }) => {
  await visit(page, `/book/${SHOP}`);
  const openedAt = Date.now();
  await expect(page.getByRole('heading', { name: 'メニューを選ぶ' })).toBeVisible();

  // STEP 1: first regular menu (coupons and consultations excluded)
  const menuBtn = page.locator('button.choice:not(.bk-coupon)').first();
  const menuName = (await menuBtn.locator('b').first().innerText()).trim();
  await menuBtn.click();
  await expect(menuBtn).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'スタッフを選ぶ' }).click();

  // STEP 2: no nomination
  await expect(page.getByRole('heading', { name: 'スタッフを選ぶ' })).toBeVisible();
  await page.getByRole('button', { name: /指名なし/ }).click();
  await page.getByRole('button', { name: '日時を選ぶ' }).click();

  // STEP 3: from the day after tomorrow, so the booking stays outside the cancel/change deadline
  await expect(page.getByRole('heading', { name: '日時を選ぶ' })).toBeVisible();
  const first = await pickFirstSlot(page, 2);

  // STEP 4
  await expect(page.getByRole('heading', { name: 'お客様情報の入力' })).toBeVisible();
  await page.getByLabel('お名前').fill(guest.name);
  await page.getByLabel('フリガナ').fill(guest.kana);
  await page.getByLabel('電話番号').fill(guest.phone);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '確認へ進む' }).click();

  // STEP 5
  await expect(page.getByRole('heading', { name: '予約内容の確認' })).toBeVisible();
  const summary = page.locator('.bk-summary');
  await expect(summary).toContainText(menuName);
  await expect(summary).toContainText(`${first.time}〜`);
  const wait = 3500 - (Date.now() - openedAt);
  if (wait > 0) await page.waitForTimeout(wait);
  await page.getByRole('button', { name: '予約を確定する' }).click();

  await expect(page).toHaveURL(new RegExp(`/book/${SHOP}/complete`));
  await expect(page.getByRole('heading', { name: 'ご予約が確定しました' })).toBeVisible();
  await expect(page.locator('.bk-url')).toHaveText(/\/booking\/[\w-]+$/);
  await page.getByRole('link', { name: '予約内容を確認する' }).click();

  // manage page
  await expect(page).toHaveURL(/\/booking\/[\w-]+$/);
  await expect(page.getByText('予約確定')).toBeVisible();
  const when = page.locator('.bk-summary dd').nth(1);
  const before = (await when.innerText()).trim();
  expect(before).toContain(first.time);

  // change the date/time: a slot on a later day than the current booking
  await page.getByRole('button', { name: '日時を変更' }).click();
  await expect(page.getByRole('heading', { name: '新しい日時を選択' })).toBeVisible();
  const second = await pickFirstSlot(page, first.index + 1);
  await page.getByRole('button', { name: 'この日時に変更' }).click();
  // (the transient success message may be replaced by the refreshed page; assert the durable state)
  await expect(when).not.toHaveText(before);
  await expect(when).toContainText(`${second.time}〜`);

  // cancel
  await page.getByRole('button', { name: 'キャンセル', exact: true }).click();
  await page.getByLabel('キャンセル理由（任意）').fill('E2Eテストのためキャンセル');
  await page.getByRole('button', { name: 'キャンセルする' }).click();
  await expect(page.getByText('キャンセル済み')).toBeVisible();
  await expect(page.getByText('このご予約はキャンセルされています。')).toBeVisible();
  await expect(page.getByRole('button', { name: '日時を変更' })).toHaveCount(0);
});
