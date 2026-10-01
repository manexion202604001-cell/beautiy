import { expect, test } from '@playwright/test';
import { loginAsStaff, nextOpenDate } from './helpers';

test('staff: login → calendar shows seeded appointments → create an appointment', async ({
  page,
}) => {
  await loginAsStaff(page);

  // dashboard
  await expect(page.getByRole('heading', { level: 1 })).toContainText('さん');

  // calendar (day view) with seeded appointments
  await page.getByRole('link', { name: '予約カレンダー', exact: true }).click();
  await expect(page).toHaveURL(/\/app\/calendar/);
  const grid = page.getByTestId('calendar-grid');
  await expect(grid).toBeVisible();
  // the seed books appointments for today and the next 2 weeks (skip closed days)
  const blocks = grid.locator('[data-appt]');
  for (let i = 0; i < 7 && (await blocks.count()) === 0; i++) {
    await page.getByRole('button', { name: '次の日' }).click();
    await page.waitForTimeout(800);
  }
  await expect(blocks.first()).toBeVisible();

  // open the create drawer
  await page.getByRole('button', { name: '予約を追加', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '予約を作成' });
  await expect(drawer).toBeVisible();

  // customer typeahead
  await drawer.getByRole('combobox', { name: '顧客を検索' }).fill('ササキ');
  const option = drawer.getByRole('listbox').getByRole('option').first();
  await expect(option).toBeVisible();
  await option.click();

  // menu: first menu in the list (カット)
  await drawer.locator('input[type="checkbox"]').first().check();

  // future date with availability
  const date = nextOpenDate(3);
  await drawer.getByLabel('日付').fill(date);
  const slot = drawer.getByRole('radiogroup', { name: '開始時刻' }).getByRole('radio').first();
  await expect(slot).toBeVisible();
  await slot.click();

  await drawer.getByTestId('create-appointment-submit').click();
  await expect(page.getByText('予約を登録しました')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`date=${date}`));
});
