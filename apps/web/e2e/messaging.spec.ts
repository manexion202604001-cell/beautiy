import { expect, test } from '@playwright/test';
import { loginAsStaff, nav } from './helpers';

test('send a 1:1 message from the customer page and see it in the conversation', async ({ page }) => {
  await loginAsStaff(page);
  await nav(page, '/app/customers');
  await page.locator('tbody tr').first().click();
  await expect(page.getByRole('tablist', { name: '顧客情報' })).toBeVisible();
  await page.getByRole('tab', { name: 'メッセージ' }).click();

  const thread = page.getByRole('region', { name: 'メッセージスレッド' });
  await expect(thread).toBeVisible();
  const text = `E2Eテスト ${Date.now()} {{customer.name}}様`;
  await thread.getByRole('textbox', { name: 'メッセージ本文' }).fill(text);

  // live preview renders the variables for this customer
  await thread.getByRole('button', { name: 'プレビュー' }).click();
  await expect(thread.getByText('プレビュー（このお客様の情報で表示）')).toBeVisible();

  await thread.getByRole('button', { name: '送信', exact: true }).click();
  await expect(page.getByText('メッセージを送信キューに追加しました')).toBeVisible();

  // the queued message appears in the thread; the worker renders variables at delivery time
  const marker = text.split(' ')[1]!;
  const bubble = thread.getByTestId('message-bubble').filter({ hasText: marker });
  await expect(bubble).toBeVisible();
  await expect(bubble.getByText(/送信待ち|送信中|送信済み|スキップ|送信失敗/)).toBeVisible();

  // it is also listed in the inbox
  await nav(page, '/app/messages');
  await expect(page.getByRole('complementary', { name: '受信箱' }).getByText(marker)).toBeVisible();
});
