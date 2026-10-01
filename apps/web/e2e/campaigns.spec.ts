import { expect, test } from '@playwright/test';
import { loginAsStaff, nav } from './helpers';

test('build a segment visually and see the live preview count', async ({ page }) => {
  await loginAsStaff(page);
  await nav(page, '/app/campaigns?tab=segments');
  await page.getByRole('button', { name: '新規', exact: true }).click();

  const builder = page.getByTestId('segment-builder');
  await expect(builder).toBeVisible();
  // default: last visit > 60 days AND no future appointment
  await expect(builder.getByTestId('segment-condition')).toHaveCount(2);
  const count = page.getByTestId('segment-count');
  await expect(count).toHaveText(/^\d[\d,]*人$/);

  // add a visit-count condition (parameter editor + validation)
  await builder.getByRole('combobox', { name: '条件を追加' }).selectOption('visit_count');
  await expect(builder.getByTestId('segment-condition')).toHaveCount(3);
  await builder.getByRole('spinbutton', { name: '来店回数の下限' }).fill('1');
  await expect(count).toHaveText(/^\d[\d,]*人$/);

  // OR group
  await page.getByRole('combobox', { name: '条件の組み合わせ' }).selectOption('any');
  await expect(builder.getByText('または').first()).toBeVisible();
  await expect(count).toHaveText(/^\d[\d,]*人$/);
  const anyCount = Number((await count.textContent())!.replace(/[^\d]/g, ''));
  expect(anyCount).toBeGreaterThan(0);

  const name = `E2Eセグメント ${Date.now()}`;
  await page.getByLabel('セグメント名').fill(name);
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('セグメントを保存しました')).toBeVisible();
  await expect(page.getByRole('button', { name: new RegExp(name) })).toBeVisible();
});
