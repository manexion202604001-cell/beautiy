// PII masking and permission gates, checked against the seeded demo organization.
import { test, expect, type Page } from '@playwright/test';
import { prisma } from '@salonos/db';
import { login, visit } from './helpers';

const STYLIST = 'stylist1@demo.salon';
const OWNER = 'owner@demo.salon';

let customerId = '';

test.beforeAll(async () => {
  const c = await prisma.customer.findFirstOrThrow({
    where: { organization: { slug: 'demo' }, phoneEnc: { not: null }, deletedAt: null, mergedIntoId: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  customerId = c.id;
});

test.afterAll(async () => {
  await prisma.$disconnect();
});

function phoneOf(page: Page) {
  return page.locator('dt', { hasText: '電話' }).locator('xpath=following-sibling::dd[1]');
}

test('stylist sees masked contact details and is kept out of admin pages and exports', async ({ page }) => {
  await login(page, STYLIST);

  await visit(page, `/customers/${customerId}`);
  await expect(phoneOf(page)).toHaveText(/^\*+\d{4}$/);
  await expect(phoneOf(page).getByRole('link')).toHaveCount(0);
  await expect(page.getByText('個人情報は権限のあるスタッフのみ表示されます')).toBeVisible();

  // Pages render app/forbidden.tsx. The status stays 200 because the (staff) loading.tsx boundary has
  // already streamed the response head when forbidden() is thrown; the CSV route answers 403 itself.
  await visit(page, '/settings/permissions');
  await expect(page.getByRole('heading', { name: 'アクセスできません' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '権限・個人情報の保護' })).toHaveCount(0);

  const csv = await page.request.get('/reports/export/ltv');
  expect(csv.status()).toBe(403);
  expect(await csv.text()).not.toContain(',');
});

test('owner sees full contact details and can open permissions and the LTV export', async ({ page }) => {
  await login(page, OWNER);

  await visit(page, `/customers/${customerId}`);
  await expect(phoneOf(page)).toHaveText(/^[\d-]{10,13}$/);
  await expect(phoneOf(page).getByRole('link')).toHaveAttribute('href', /^tel:/);

  const res = await visit(page, '/settings/permissions');
  expect(res?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: '権限・個人情報の保護' })).toBeVisible();

  const csv = await page.request.get('/reports/export/ltv');
  expect(csv.status()).toBe(200);
  expect(csv.headers()['content-type']).toContain('text/csv');
  expect((await csv.text()).split('\n').length).toBeGreaterThan(1);
});
