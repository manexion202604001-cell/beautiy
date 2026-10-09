import { test, expect } from '@playwright/test';
import { loginAsStaff } from './helpers';
test('shots', async ({ page }) => {
  page.on('console', async (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 200)); });
  await page.setViewportSize({ width: 1280, height: 900 });
  await loginAsStaff(page);
  await page.goto('/app/migration');
  const csv = ['会員番号,お客様名,フリガナ,携帯電話,生年月日,性別,DM可否,来店回数,累計売上,最終来店日,担当者,保有ポイント,謎の列', 'Z1,見本 花子,ミホン ハナコ,090-1234-0001,S60.4.1,女,可,8,64000,2026/09/01,佐藤,300,x', 'Z2,見本 太郎,,090-1234-0002,不明,男,,3,,2026/08/01,退職 者,,', 'Z3,,,,,,,,,,,,'].join('\n');
  await page.getByLabel('CSVファイルを選択').setInputFiles({ name: 'sample.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await expect(page.getByText('確認結果')).toBeVisible();
  await page.getByRole('button', { name: '確認・変更する' }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/tmp/claude-0/-home-user-beautiy/58148265-8625-58d1-8189-498527447750/scratchpad/m1.png', fullPage: true });
});
