import { expect, test } from '@playwright/test';
import { loginAsStaff, nav, nextOpenDate } from './helpers';

test('staff: login → calendar shows seeded appointments → create an appointment', async ({
  page,
}) => {
  await loginAsStaff(page);

  // dashboard
  await expect(page.getByRole('heading', { level: 1, name: 'ダッシュボード' })).toBeVisible();

  // calendar (week view) with seeded appointments
  await page.getByRole('link', { name: '予約管理', exact: true }).click();
  await expect(page).toHaveURL(/\/app\/calendar/);
  const grid = page.getByTestId('calendar-grid');
  await expect(grid).toBeVisible();
  // the seed books appointments for today and the next 2 weeks (skip closed days)
  const blocks = grid.locator('[data-appt]');
  for (let i = 0; i < 7 && (await blocks.count()) === 0; i++) {
    await page.getByRole('button', { name: '次へ' }).click();
    await page.waitForTimeout(800);
  }
  await expect(blocks.first()).toBeVisible();

  // new reservation: a page of its own, with the customer and the menus picked on their own screens
  await page.getByRole('button', { name: '新規予約' }).click();
  await expect(page).toHaveURL(/\/app\/calendar\/new\?date=/);
  await expect(page.getByRole('heading', { level: 1, name: '新規予約作成' })).toBeVisible();
  const submit = page.getByRole('button', { name: '新規予約を作成する' });
  await expect(submit).toBeDisabled();

  // start from a future open day at 18:00 (what a long press on the calendar hands over)
  // a different day on every run so reruns against the same database do not collide
  const date = nextOpenDate(3 + Math.floor(Math.random() * 40));
  await nav(page, '/app/calendar');
  await nav(page, `/app/calendar/new?date=${date}&time=18:00`);
  const [, mm, dd] = date.split('-').map(Number);
  await expect(page.getByRole('button', { name: new RegExp(`^${mm}/${dd}\\(.\\) 18:00$`) })).toBeVisible();

  await page.getByRole('button', { name: '顧客を選択' }).click();
  await expect(page).toHaveURL(/\/app\/customers\?mode=select/);
  await expect(page.getByRole('heading', { level: 1, name: '顧客を選択' })).toBeVisible();
  await page.getByPlaceholder('名前、電話番号で検索...').fill('ササキ');
  // the seed also has a kana-only duplicate of this customer; either may be listed first
  const row = page.locator('[data-customer]').filter({ hasText: '佐々木' }).first();
  await expect(row).toBeVisible();
  await row.click();
  await expect(page).toHaveURL(/\/app\/calendar\/new\?customer_id=/);
  await expect(page.getByText('佐々木').first()).toBeVisible();
  // the date and time survive the round trip
  await expect(page.getByRole('button', { name: new RegExp(`^${mm}/${dd}\\(.\\) 18:00$`) })).toBeVisible();

  await page.getByRole('button', { name: 'メニューを選択' }).click();
  await expect(page).toHaveURL(/\/app\/menus\/select/);
  const confirm = page.getByRole('button', { name: 'メニューを選択してください' });
  await expect(confirm).toBeDisabled();
  await page.getByRole('checkbox').first().click();
  await page.getByRole('button', { name: /^決定 \(1件 \/ 1時間 \/ / }).click();
  await expect(page).toHaveURL(/\/app\/calendar\/new\?menu_data=/);
  await expect(page.getByText(/^合計: 1時間 \/ /)).toBeVisible();
  // the end time follows the menu: 18:00 + 1 hour
  const endButton = page.getByRole('button', { name: '19:00', exact: true });
  await expect(endButton).toBeVisible();

  // end time edited by hand: one notch down on the minute drum = 19:05
  await endButton.click();
  const sheet = page.getByRole('dialog', { name: '終了時間' });
  await expect(sheet).toBeVisible();
  await sheet.getByText('00分', { exact: true }).hover();
  await page.mouse.wheel(0, 100);
  await sheet.getByRole('button', { name: '決定' }).click();
  await expect(page.getByRole('button', { name: '19:05', exact: true })).toBeVisible();
  await expect(page.getByText('メニュー所要時間: 1時間 → 変更済み: 1時間5分')).toBeVisible();

  await page.getByRole('combobox', { name: '予約経路' }).click();
  await page.getByRole('option', { name: '電話（HPB）' }).click();
  await page.getByPlaceholder('予約に関するメモ...').fill('E2E: 新規予約ページから作成');
  await submit.click();
  await expect(page).toHaveURL(/\/app\/calendar$/);

  // the reservation is found by name, with the hand-edited end time
  await page.getByPlaceholder('名前・電話番号で検索...').fill('ササキ');
  await expect(page.getByText(/検索結果: 「ササキ」 \d+件/)).toBeVisible();
  await expect(page.getByText('18:00~19:05').first()).toBeVisible();
});
