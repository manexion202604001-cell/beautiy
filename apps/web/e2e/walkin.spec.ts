import { expect, test, type Locator, type Page } from '@playwright/test';
import { loginAsStaff, nav, SHOP_SLUG } from './helpers';

async function sign(page: Page, pad: Locator) {
  await pad.scrollIntoViewIfNeeded();
  const box = (await pad.boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++)
    await page.mouse.move(box.x + 30 + i * 18, box.y + box.height / 2 + (i % 2 ? -18 : 18));
  await page.mouse.up();
}

/**
 * 同意書一覧（受付保留）: a customer without a reservation fills the consent at /consent/<shop>,
 * staff find the submission in the list and register the customer from it.
 */
test('walk-in consent → 同意書一覧 → 新規顧客として登録', async ({ page, browser }) => {
  const stamp = String(Date.now()).slice(-6);
  const lastName = `受付${stamp}`;

  // ---- customer: reception page on their own phone (no login)
  const ctx = await browser.newContext({
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    viewport: { width: 390, height: 844 },
  });
  const c = await ctx.newPage();
  await c.goto(`/consent/${SHOP_SLUG}`);
  await expect(c.getByRole('heading', { name: '施術同意書の確認とご提出' })).toBeVisible();
  await c.getByLabel('お名前（姓）').fill(lastName);
  await c.getByLabel('お名前（名）').fill('花子');
  await c.getByLabel('フリガナ（セイ）').fill('ウケツケ');
  await c.getByLabel('フリガナ（メイ）').fill('ハナコ');
  await c.getByLabel('生年月日').fill('1990-04-12');
  await c.getByLabel('電話番号').fill(`090${stamp}11`.slice(0, 11));
  await c.getByLabel('ご職業').fill('会社員');
  await c.getByLabel('ご来店のきっかけ').fill('Instagram');
  // the consent form's own questions (selects / checkboxes), whatever the shop registered
  const questions = c.getByRole('region', { name: '確認事項' });
  if (await questions.count()) {
    for (const sel of await questions.locator('select').all()) {
      if (!(await sel.inputValue())) await sel.selectOption({ index: 1 });
    }
    for (const box of await questions.locator('input[type="checkbox"]').all()) await box.check();
  }
  const pad = c.getByTestId('signature-pad');
  if (await pad.count()) await sign(c, pad);
  await c.getByRole('checkbox', { name: '上記の内容に同意します' }).check();
  await c.getByTestId('submit-walkin-consent').click();

  // counselling sheets are optional: finish without filling one (or land on the thank-you page directly)
  const finish = c.getByTestId('finish-walkin');
  const thanks = c.getByRole('heading', { name: 'ご記入ありがとうございました' });
  await expect(finish.or(thanks)).toBeVisible();
  if (await finish.isVisible()) {
    await expect(c.getByText('同意書を提出しました。')).toBeVisible();
    await finish.click();
  }
  await expect(thanks).toBeVisible();
  await ctx.close();

  // ---- staff: the submission waits in 同意書一覧
  await loginAsStaff(page);
  await nav(page, '/app/consents');
  await expect(page.getByRole('heading', { name: '同意書一覧（受付保留）' })).toBeVisible();
  await page.getByPlaceholder('お客様の名前・電話で検索').fill(lastName);
  const row = page.locator('[data-intake]').filter({ hasText: `${lastName} 花子` });
  await expect(row).toHaveCount(1);
  await expect(row.getByText('同意書のみ')).toBeVisible();
  await row.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('ふりがな: ウケツケ ハナコ')).toBeVisible();
  await expect(dialog.getByText('生年月日: 1990-04-12')).toBeVisible();
  await expect(dialog.getByText(/^同意日時: /)).toBeVisible();

  page.once('dialog', (d) => {
    expect(d.message()).toBe(`「${lastName} 花子」を新規顧客として登録しますか？`);
    void d.accept();
  });
  await dialog.getByRole('button', { name: '新規顧客として登録' }).click();
  await expect(page.getByText('新規顧客として登録しました')).toBeVisible();
  await expect(page.locator('[data-intake]').filter({ hasText: lastName })).toHaveCount(0);

  // the customer now exists
  await nav(page, `/app/customers?q=${encodeURIComponent(lastName)}`);
  await expect(page.locator('[data-customer]').filter({ hasText: lastName }).first()).toBeVisible();
});
