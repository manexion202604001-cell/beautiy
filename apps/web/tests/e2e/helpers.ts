import { expect, type Page } from '@playwright/test';

export const DEMO_PASSWORD = 'demo1234';

/** 1×1 transparent PNG — a real image so the upload path validates it like any photo. */
export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * Wait until React has hydrated every interactive element. Clicking server-rendered markup before
 * hydration does nothing (buttons) or submits natively (ActionForm forms) — common on a cold dev server.
 */
export async function ready(page: Page) {
  await page.waitForFunction(() => {
    const els = document.querySelectorAll('button, input:not([type=hidden]), select, textarea, form');
    return document.readyState === 'complete'
      && Array.from(els).every((el) => Object.keys(el).some((k) => k.startsWith('__reactProps$')));
  }, undefined, { timeout: 120_000 });
}

/** page.goto + wait for hydration. */
export async function visit(page: Page, url: string) {
  const res = await page.goto(url);
  await ready(page);
  return res;
}

export async function login(page: Page, email: string, password = DEMO_PASSWORD) {
  await visit(page, '/login');
  await page.getByLabel('メールアドレス').fill(email);
  await page.getByLabel('パスワード').fill(password);
  await page.getByRole('button', { name: 'ログイン' }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

/** Path + query of an absolute URL, so links built from APP_URL work against any E2E_BASE_URL. */
export function pathOf(url: string) {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
}

/** Card with a label (Stat component) → its value element. */
export function stat(page: Page, label: string) {
  return page.locator('.stat').filter({ has: page.locator('.label', { hasText: label }) }).locator('.value');
}

/**
 * Public SlotPicker: walk the date strip from `fromIndex` and pick the first time slot found.
 * Returns the chosen date chip index and the slot's label (HH:MM).
 */
export async function pickFirstSlot(page: Page, fromIndex = 0): Promise<{ index: number; time: string }> {
  const chips = page.getByRole('listbox', { name: '日付を選択' }).getByRole('option');
  await expect(chips.first()).toBeVisible();
  const count = await chips.count();
  for (let i = fromIndex; i < count; i++) {
    const chip = chips.nth(i);
    if (await chip.isDisabled()) continue;
    if ((await chip.getAttribute('aria-selected')) !== 'true') {
      const loaded = page.waitForResponse((r) => r.url().includes('/api/availability'));
      await chip.click();
      await loaded;
    }
    await expect(chip).toHaveAttribute('aria-selected', 'true');
    const slots = page.getByRole('listbox', { name: '開始時刻' }).getByRole('option');
    const none = page.getByText('この日は空きがありません');
    await expect(page.locator('.slot-grid .skeleton')).toHaveCount(0);
    await expect(slots.first().or(none)).toBeVisible();
    if (await none.isVisible()) continue;
    const slot = slots.first();
    const time = (await slot.innerText()).trim();
    await slot.click();
    return { index: i, time };
  }
  throw new Error('no bookable slot found in the date strip');
}
