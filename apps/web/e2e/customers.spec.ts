import { expect, test } from '@playwright/test';
import { loginAsStaff, nav } from './helpers';

/**
 * 顧客管理: register a customer, edit the profile, write a karte (record + face drawing),
 * keep the counselling sheet, and settle a name duplicate by linking the two records.
 */
test('customer screens: register → edit → karte → counselling sheet → name duplicate link', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAsStaff(page);
  const stamp = Date.now().toString().slice(-6);
  const name = `画面 太郎${stamp}`;

  // ---- list → 新規顧客登録
  await nav(page, '/app/customers');
  await expect(page.getByRole('heading', { level: 1, name: 'カルテ' })).toBeVisible();
  await page.getByRole('button', { name: '新規顧客' }).click();
  await expect(page.getByRole('heading', { level: 1, name: '新規顧客登録' })).toBeVisible();
  await page.getByLabel('名前').fill(name);
  await page.getByLabel('よみがな').fill('ガメン タロウ');
  await page.getByLabel('メモ').fill('E2E 顧客メモ');
  await page.getByRole('button', { name: '登録する' }).click();

  // ---- detail
  await expect(page).toHaveURL(/\/app\/customers\/[0-9a-f-]{36}$/);
  const customerUrl = page.url();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  await expect(page.getByText('ガメン タロウ')).toBeVisible();
  await expect(page.getByText('E2E 顧客メモ')).toBeVisible();
  await expect(page.getByText('未定（来店済みの予約がありません）')).toBeVisible();

  await page.getByRole('button', { name: '編集', exact: true }).click();
  const edit = page.getByRole('dialog');
  await expect(edit.getByLabel('姓')).toHaveValue('画面');
  await edit.getByLabel('職業').fill('美容師');
  await edit.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('美容師')).toBeVisible();

  // ---- karte: 追加 opens the new karte for editing; record + face drawing
  await page.getByRole('button', { name: '追加', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'カルテ詳細' })).toBeVisible();
  const karte = page.getByRole('dialog');
  await karte.getByLabel('施術内容').fill('カット＋トリートメント');
  await karte.getByLabel('カラー配合').fill('8AB:6N = 1:1');
  await karte.getByLabel('内部メモ（非公開）').fill('E2E 内部メモ');
  const canvas = karte.getByTestId('face-drawing-canvas');
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5, { steps: 6 });
  await page.mouse.up();
  await expect(karte.getByRole('button', { name: '戻す' })).toBeEnabled();
  await karte.getByTestId('save-karte-record').click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('カット＋トリートメント')).toBeVisible();
  await expect(page.getByText('8AB:6N = 1:1')).toBeVisible();
  await expect(page.getByText('E2E 内部メモ')).toBeVisible();
  await expect(page.getByRole('img', { name: 'フェイス描画' })).toBeVisible();

  // ---- counselling sheet (kept per customer)
  await page.getByRole('tab', { name: 'カウンセリングシート' }).click();
  await page.getByRole('button', { name: 'あり', exact: true }).click();
  await page.getByRole('button', { name: '生え癖', exact: true }).click();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存しました' })).toBeVisible();

  // the karte and the sheet are on the customer screen
  await page.goto(customerUrl);
  const tabs = page.getByRole('tablist', { name: '顧客情報' });
  await expect(page.locator('[data-karte]').first()).toContainText('カット＋トリートメント');
  await tabs.getByRole('tab', { name: 'カウンセリング' }).click();
  await expect(page.getByRole('button', { name: '生え癖', exact: true })).toHaveAttribute('aria-pressed', 'true');

  // ---- a second record with the same name → 名前重複 → 同一人物としてリンク
  await nav(page, '/app/customers/new');
  await page.getByLabel('名前').fill(name);
  await page.getByRole('button', { name: '登録する' }).click();
  await expect(page).toHaveURL(/\/app\/customers\/[0-9a-f-]{36}$/);
  await nav(page, '/app/customers');
  await page.getByRole('tab', { name: /名前重複/ }).click();
  await page.getByPlaceholder('名前、電話番号で絞り込み...').fill(name);
  await page.getByRole('button', { name: '絞り込む' }).click();
  const group = page.locator('[data-name-duplicate]').filter({ hasText: name });
  await expect(group).toHaveCount(1);
  await expect(group.getByText('推奨')).toBeVisible();
  await group.getByRole('button', { name: '同一人物としてリンク' }).click();
  await expect(page.getByText(/会員番号 .+ に統合しました/)).toBeVisible();

  await page.goto(customerUrl);
  await expect(page.getByText(/^会員番号: /)).toBeVisible();
  await expect(page.getByText('同一会員番号のリンク済みレコード（他店舗含む）')).toBeVisible();
});
