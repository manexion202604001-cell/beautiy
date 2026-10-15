import { expect, test } from '@playwright/test';
import { loginAsStaff, nav } from './helpers';

test('menus: category → menu → 掲載 → edit → coupon → 対応スタッフ → delete', async ({ page }) => {
  await loginAsStaff(page);
  const stamp = Date.now().toString().slice(-7);
  const category = `E2Eカテゴリ${stamp}`;
  const child = `E2E子${stamp}`;
  const menuName = `E2Eメニュー${stamp}`;
  const couponName = `E2Eクーポン${stamp}`;
  // delete confirmations
  page.on('dialog', (d) => void d.accept());

  await page.getByRole('link', { name: 'メニュー', exact: true }).click();
  await expect(page).toHaveURL(/\/app\/menus$/);
  await expect(page.getByRole('heading', { level: 1, name: 'メニュー管理' })).toBeVisible();
  await expect(page.getByRole('tab', { name: /通常メニュー/ })).toHaveAttribute('aria-selected', 'true');

  // --- category with a colour
  await page.getByRole('link', { name: 'カテゴリ管理' }).click();
  await expect(page).toHaveURL(/\/app\/menus\/categories$/);
  await expect(page.getByRole('heading', { level: 1, name: 'カテゴリ管理' })).toBeVisible();
  // 全削除 is offered while categories exist (not pressed here: it would empty the seeded categories)
  await expect(page.getByRole('button', { name: '全削除' })).toBeVisible();
  await page.getByRole('button', { name: '親カテゴリを追加' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: '親カテゴリ追加' })).toBeVisible();
  await dialog.getByLabel('カテゴリ名', { exact: true }).fill(category);
  await dialog.getByRole('button', { name: 'ブルー' }).click();
  await dialog.getByRole('button', { name: '追加', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const categoryRow = page.locator('[data-category]', { hasText: category });
  await expect(categoryRow).toBeVisible();
  await expect(categoryRow).toContainText('0件');

  // a child category under it (the row buttons appear on hover)
  await categoryRow.hover();
  await categoryRow.getByRole('button', { name: `${category} に子カテゴリを追加` }).click();
  await expect(dialog.getByRole('heading', { name: '子カテゴリ追加' })).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: '親カテゴリ' })).toContainText(category);
  await dialog.getByLabel('子カテゴリ名', { exact: true }).fill(child);
  await dialog.getByRole('button', { name: '追加', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(categoryRow).toContainText('1件');
  const childRow = page.locator('[data-category]', { hasText: child });
  await expect(childRow).toBeVisible();

  // --- new menu in that category
  await page.getByRole('button', { name: 'メニュー一覧に戻る' }).click();
  await expect(page).toHaveURL(/\/app\/menus$/);
  await page.getByRole('button', { name: '新規メニュー' }).click();
  await expect(page).toHaveURL(/\/app\/menus\/new\?type=regular$/);
  await expect(page.getByRole('heading', { level: 1, name: '新規メニュー' })).toBeVisible();
  await page.getByRole('button', { name: 'カテゴリを選択' }).click();
  // the parent is a heading in the picker; its child is what gets ticked
  await page.getByRole('dialog', { name: 'カテゴリ' }).getByText(child, { exact: true }).click();
  await expect(page.getByRole('button', { name: '1件選択中' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByLabel(/^メニュー名/).fill(menuName);
  await page.getByLabel(/^価格（税込）/).fill('4400');
  await page.getByLabel(/^所要目安時間/).fill('45');
  await page.getByRole('button', { name: '登録', exact: true }).click();
  await expect(page).toHaveURL(/\/app\/menus$/);
  const row = page.locator('[data-menu]', { hasText: menuName });
  await expect(row).toBeVisible();
  // grouped under the parent category
  await expect(page.getByText(category, { exact: true })).toBeVisible();
  await expect(row).toContainText('45分');
  await expect(row).toContainText('4,400');

  // --- 非掲載 and back
  await row.getByRole('button', { name: '非掲載', exact: true }).click();
  await expect(row.getByRole('button', { name: '掲載', exact: true })).toBeVisible();
  await row.getByRole('button', { name: '掲載', exact: true }).click();
  await expect(row.getByRole('button', { name: '非掲載', exact: true })).toBeVisible();

  // --- edit
  await row.getByRole('button', { name: '編集' }).click();
  await expect(page).toHaveURL(/\/app\/menus\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1, name: 'メニュー編集' })).toBeVisible();
  await expect(page.getByLabel(/^メニュー名/)).toHaveValue(menuName);
  await expect(page.getByRole('button', { name: '1件選択中' })).toBeVisible();
  await page.getByLabel(/^価格（税込）/).fill('5500');
  await page.getByRole('button', { name: '更新', exact: true }).click();
  await expect(page).toHaveURL(/\/app\/menus$/);
  await expect(page.locator('[data-menu]', { hasText: menuName })).toContainText('5,500');

  // --- coupon
  await page.getByRole('tab', { name: /クーポン/ }).click();
  await page.getByRole('button', { name: '新規クーポン' }).click();
  await expect(page).toHaveURL(/\/app\/menus\/new\?type=coupon$/);
  await expect(page.getByRole('heading', { level: 1, name: '新規クーポン' })).toBeVisible();
  await page.getByRole('combobox', { name: '種別' }).click();
  await page.getByRole('option', { name: '新規' }).click();
  await page.getByLabel(/^クーポン名/).fill(couponName);
  await page.getByLabel(/^価格（税込）/).fill('8000');
  await page.getByLabel(/^所要目安時間/).fill('90');
  await page.getByRole('button', { name: '登録', exact: true }).click();
  await expect(page).toHaveURL(/\/app\/menus\?tab=coupon$/);
  const couponRow = page.locator('[data-menu]', { hasText: couponName });
  await expect(couponRow).toBeVisible();
  await expect(couponRow).toContainText('新規');
  await page.locator('button[aria-pressed]', { hasText: '再来' }).click();
  await expect(couponRow).toHaveCount(0);
  await page.locator('button[aria-pressed]', { hasText: 'すべて' }).click();
  await expect(couponRow).toBeVisible();

  // --- 対応スタッフ: tick, save, then untick and save again so other specs keep their staff unrestricted
  await page.getByRole('button', { name: '対応スタッフ' }).click();
  await expect(page.getByText('対応スタッフ設定')).toBeVisible();
  const cell = page.getByRole('checkbox', { name: new RegExp(`^${menuName} × `) }).first();
  await cell.click();
  await expect(cell).toHaveAttribute('aria-checked', 'true');
  const save = page.getByRole('button', { name: '保存', exact: true });
  await save.click();
  await expect(page.getByText('保存しました').first()).toBeVisible();
  await expect(save).toBeEnabled();
  await cell.click();
  await expect(cell).toHaveAttribute('aria-checked', 'false');
  await save.click();
  // the button reads 保存中... until the second save has finished
  await expect(save).toBeEnabled();

  // --- 対応設備 opens and goes back to the list
  await page.getByRole('button', { name: '対応設備' }).click();
  await expect(page.getByText('対応設備設定')).toBeVisible();
  await page.getByRole('button', { name: 'リスト表示' }).click();

  // --- delete the coupon and the menu (no reservations use them: one confirmation)
  await couponRow.getByRole('button', { name: '削除' }).click();
  await expect(couponRow).toHaveCount(0);
  await page.getByRole('tab', { name: /通常メニュー/ }).click();
  await row.getByRole('button', { name: '削除' }).click();
  await expect(row).toHaveCount(0);

  // --- delete the parent category: its child goes with it
  await nav(page, '/app/menus/categories');
  await expect(childRow).toBeVisible();
  await categoryRow.hover();
  await categoryRow.getByRole('button', { name: `${category} を削除` }).click();
  await expect(categoryRow).toHaveCount(0);
  await expect(childRow).toHaveCount(0);

  // --- the menu picker of the reservation form and the previous screen stay reachable
  await nav(page, '/app/menus/select');
  await expect(page.getByRole('heading', { level: 1, name: 'メニューを選択' })).toBeVisible();
  await nav(page, '/app/menus-classic');
  await expect(page.getByRole('tablist', { name: 'メニュー管理' })).toBeVisible();
});
