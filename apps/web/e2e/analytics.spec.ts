import { expect, test } from '@playwright/test';
import { loginAsStaff, nav } from './helpers';

test('analytics sales page renders tiles, charts and the table view', async ({ page }) => {
  await loginAsStaff(page);
  await nav(page, '/app/analytics?tab=sales&period=d90');
  await expect(page.getByRole('heading', { name: '分析' })).toBeVisible();
  await expect(page.getByTestId('sales-tiles').getByText('純売上')).toBeVisible();

  const line = page.getByTestId('sales-line-chart');
  await expect(line.locator('svg path').first()).toBeVisible();
  // the trend line has a real path (not just the axis)
  const d = await line.locator('svg path[stroke-linejoin="round"]').first().getAttribute('d');
  expect(d?.split('L').length ?? 0).toBeGreaterThan(5);

  const bars = page.getByTestId('sales-bar-chart');
  await expect(bars.locator('svg')).toBeVisible();
  expect(await bars.locator('svg path.viz-mark').count()).toBeGreaterThan(0);

  // hover shows a tooltip with the value
  const box = await line.locator('svg').boundingBox();
  await page.mouse.move(box!.x + box!.width * 0.6, box!.y + box!.height / 2);
  await expect(line.getByRole('status')).toContainText('¥');

  // monthly grouping + table twin
  await page.getByRole('radio', { name: '月' }).click();
  const card = page.locator('section').filter({ hasText: '売上の推移' });
  await card.getByRole('radio', { name: '表' }).click();
  await expect(card.getByRole('table', { name: '売上の内訳' })).toBeVisible();
  await expect(card.locator('tbody tr').first()).toBeVisible();
});
