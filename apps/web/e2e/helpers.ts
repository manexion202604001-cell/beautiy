import { expect, type Page } from '@playwright/test';

export const OWNER = {
  email: process.env.E2E_EMAIL ?? 'owner@example.com',
  password: process.env.E2E_PASSWORD ?? 'password-1234',
};
export const SHOP_SLUG = process.env.E2E_SHOP_SLUG ?? 'shibuya';

export async function loginAsStaff(page: Page, email = OWNER.email, password = OWNER.password) {
  await page.goto('/login');
  await page.getByLabel('メールアドレス').fill(email);
  await page.getByLabel('パスワード').fill(password);
  await page.getByRole('button', { name: 'ログイン' }).click();
  await expect(page).toHaveURL(/\/app/);
}

/** JST date string N days from now */
export function jstDate(offsetDays: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(
    new Date(Date.now() + offsetDays * 86_400_000),
  );
}

/** Next date (>= minDays ahead) that is not a Tuesday (seed shop holiday) */
export function nextOpenDate(minDays = 2): string {
  for (let i = minDays; i < minDays + 7; i++) {
    const d = jstDate(i);
    const wd = new Date(`${d}T12:00:00+09:00`).getUTCDay();
    if (wd !== 2) return d;
  }
  return jstDate(minDays);
}

/**
 * Client-side navigation (no full reload). Every full page load restores the session through
 * POST /v1/auth/refresh, which the API rate-limits per IP (20/min), so long test runs navigate
 * inside the SPA instead of calling page.goto().
 */
export async function nav(page: Page, path: string) {
  await page.evaluate((p) => {
    window.history.pushState({}, '', p);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}
