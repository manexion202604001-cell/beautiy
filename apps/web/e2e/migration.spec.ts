import { expect, test } from '@playwright/test';
import { loginAsStaff } from './helpers';

/**
 * Data migration: a customer export and a visit-history export from the previous system
 * are checked, imported and visible on the customer screen (carried-over items + visit history).
 */
test('migrates customers and visit history from the previous system', async ({ page }) => {
  test.setTimeout(120_000);
  const stamp = Date.now().toString().slice(-6);
  const no = `E${stamp}`;
  const customers = [
    '会員番号,お客様名,フリガナ,携帯電話,生年月日,DM可否,来店回数,累計売上,最終来店日,担当者,ポイント',
    `${no},移行 花子${stamp},イコウ ハナコ,090-${stamp.slice(0, 4)}-${stamp.slice(2, 6)},S60.4.1,可,8,"¥64,000",2026/09/01,佐藤,300`,
    `${no}X,,,,,,,,,,`,
  ].join('\r\n');
  const visits = ['伝票番号,会員番号,来店日,担当,メニュー,合計金額,カルテ', `V${stamp},${no},2026/09/01,佐藤,カット＋カラー,"12,100",8Lv アッシュ`].join('\r\n');

  await loginAsStaff(page);
  await page.goto('/app/migration');
  await expect(page.getByRole('heading', { name: 'データ移行' })).toBeVisible();

  // ① customers (Shift_JIS file)
  const sjis = await page.evaluate(async (text) => {
    // encode in the browser is not possible for Shift_JIS; the API side handles UTF-8, the screen decodes
    // Shift_JIS — this file is UTF-8 with BOM, the Shift_JIS path is unit tested (lib/decode.test.ts)
    return text;
  }, customers);
  await page.getByLabel('CSVファイルを選択').setInputFiles({ name: 'customers.csv', mimeType: 'text/csv', buffer: Buffer.from('﻿' + sjis, 'utf-8') });
  await expect(page.getByText('確認結果')).toBeVisible();
  const tiles = page.locator('div.rounded-xl', { hasText: '取り込める' }).first();
  await expect(tiles).toContainText('1');
  await expect(page.getByText('氏名・フリガナがありません')).toBeVisible();
  await page.getByRole('button', { name: '確認・変更する' }).click();
  await expect(page.getByRole('combobox', { name: '顧客番号（旧システム） の列' })).toHaveValue('0');
  await page.getByRole('button', { name: '取り込む', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '取り込む' }).click();
  await expect(page.getByText('照合結果')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('¥64,000').first()).toBeVisible();
  await page.getByRole('button', { name: '新しく取り込む' }).click();

  // ② visit history
  await page.getByRole('radio', { name: /来店履歴/ }).click();
  await page.getByLabel('CSVファイルを選択').setInputFiles({ name: 'visits.csv', mimeType: 'text/csv', buffer: Buffer.from(visits, 'utf-8') });
  await expect(page.getByText('問題のある行はありません')).toBeVisible();
  await page.getByRole('button', { name: '取り込む', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '取り込む' }).click();
  await expect(page.getByText('照合結果')).toBeVisible({ timeout: 30_000 });

  // the customer screen shows the carried-over data
  await page.goto(`/app/customers?q=${no}`);
  await page.getByRole('link', { name: new RegExp(`移行 花子${stamp}`) }).first().click();
  await expect(page.getByText('旧システムから引き継いだ項目')).toBeVisible();
  await page.getByText('旧システムから引き継いだ項目').click();
  await expect(page.getByText('旧顧客番号')).toBeVisible();
  await expect(page.getByText(no, { exact: true }).first()).toBeVisible();
  await page.getByRole('tab', { name: '来店履歴' }).click();
  await expect(page.getByText('旧システムの来店履歴')).toBeVisible();
  await expect(page.getByText('8Lv アッシュ')).toBeVisible();
  await expect(page.getByText('¥12,100')).toBeVisible();
});
