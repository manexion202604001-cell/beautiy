import { expect, test, type Locator, type Page } from '@playwright/test';
import { loginAsStaff, nav } from './helpers';

const SHOTS = 'e2e/screenshots';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

async function sign(page: Page, pad: Locator) {
  const box = (await pad.boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++)
    await page.mouse.move(box.x + 30 + i * 18, box.y + box.height / 2 + (i % 2 ? -18 : 18));
  await page.mouse.up();
}

test('kartes & forms: karte with photo → share page; staff consent with signature → verify; customer pre-visit form', async ({
  page,
  browser,
}) => {
  await loginAsStaff(page);

  // ---- karte: template fields, chemical, photo, share
  await nav(page, '/app/kartes/new');
  await expect(page.getByRole('heading', { name: '新しいカルテ' })).toBeVisible();
  await page.getByRole('combobox', { name: '顧客を検索' }).fill('ササキ');
  await page.getByRole('listbox').getByRole('option').first().click();
  await page.getByLabel('ご要望').fill('前髪は眉下で軽めに');
  await page.getByLabel('スタイル（共有）').fill('くびれミディ');
  await page.getByRole('button', { name: '薬剤を追加' }).click();
  await page.getByLabel('薬剤名').fill('ストレートA');
  await page.getByTestId('save-karte').click();
  await expect(page).toHaveURL(/\/app\/kartes\/[0-9a-f-]{36}$/);
  await expect(page.getByText('カルテを作成しました')).toBeVisible();

  await page
    .getByTestId('karte-photo-input')
    .setInputFiles({ name: 'before.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByText('1枚の画像を追加しました')).toBeVisible();
  await expect(page.getByRole('img', { name: 'ビフォー' }).first()).toBeVisible();

  await page.getByRole('button', { name: '共有する' }).click();
  const share = page.getByRole('dialog', { name: 'カルテを共有' });
  await share.getByRole('checkbox', { name: 'お客様に通知する' }).uncheck();
  await share.getByTestId('share-karte-submit').click();
  const shareUrl = await page.getByTestId('copy-link-url').inputValue();
  expect(shareUrl).toMatch(/\/k\/[A-Za-z0-9_-]+$/);
  await page.screenshot({ path: `${SHOTS}/karte-editor.png`, fullPage: true });

  const ctx = await browser.newContext({
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    viewport: { width: 390, height: 844 },
  });
  const c = await ctx.newPage();
  await c.goto(new URL(shareUrl).pathname);
  await expect(c.getByText('くびれミディ')).toBeVisible();
  await expect(c.getByText('ストレートA')).toHaveCount(0); // chemicals are never shared
  await expect(c.getByRole('img', { name: 'Beforeの写真' })).toBeVisible();
  await c.screenshot({ path: `${SHOTS}/karte-share-phone.png`, fullPage: true });

  // ---- customer detail: カルテ / 書類 tabs; consent form with signature at the counter
  const customerLink = page.getByRole('link', { name: /様$/ }).first();
  await customerLink.click();
  await expect(page).toHaveURL(/\/app\/customers\/.*tab=kartes/);
  await expect(page.getByRole('tab', { name: 'カルテ', selected: true })).toBeVisible();
  await page.getByRole('tab', { name: '書類' }).click();
  await page.getByRole('button', { name: '店頭で記入・署名' }).click();
  const fill = page.getByRole('dialog', { name: 'フォームに記入' });
  await fill.getByLabel('フォーム').selectOption({ label: '【同意書】カラー施術同意書（v1）' });
  await fill.getByLabel('パッチテスト').selectOption({ index: 1 });
  for (const sel of await fill.locator('select').all()) {
    if (!(await sel.inputValue())) await sel.selectOption({ index: 1 });
  }
  await fill.getByRole('checkbox').check();
  await sign(page, fill.getByTestId('signature-pad'));
  await page.screenshot({ path: `${SHOTS}/form-fill-signature.png` });
  await fill.getByTestId('submit-form-response').click();
  await expect(page.getByText('書類を提出しました')).toBeVisible();
  await page
    .getByRole('button', { name: /カラー施術同意書/ })
    .first()
    .click();
  const drawer = page.getByRole('dialog', { name: 'カラー施術同意書' });
  await expect(drawer.getByRole('img', { name: /の署名/ })).toBeVisible();
  await drawer.getByRole('button', { name: '改ざん検証' }).click();
  await expect(drawer.getByText('改ざんは検出されませんでした')).toBeVisible();
  await drawer.getByRole('button', { name: '閉じる' }).first().click();

  // ---- customer link (pre-visit questionnaire) → public form
  await page.getByRole('button', { name: 'リンクを送る' }).click();
  const send = page.getByRole('dialog', { name: 'フォームを送る' });
  await send.getByLabel('フォーム').selectOption({ label: '【事前問診】事前アンケート（v1）' });
  await send.getByRole('button', { name: 'リンクを発行' }).click();
  const formUrl = await send.getByTestId('copy-link-url').inputValue();
  expect(formUrl).toMatch(/\/f\/[A-Za-z0-9_-]+$/);
  await send.getByRole('button', { name: '閉じる' }).last().click();

  await c.goto(new URL(formUrl).pathname);
  await expect(c.getByRole('heading', { name: '事前アンケート' })).toBeVisible();
  await c.getByRole('checkbox', { name: /パサつき/ }).click();
  await c.getByLabel('ご要望').fill('短めにしたいです');
  await c.screenshot({ path: `${SHOTS}/public-form-phone.png`, fullPage: true });
  await c.getByTestId('submit-public-form').click();
  await expect(c.getByRole('heading', { name: 'ご回答ありがとうございました' })).toBeVisible();
  await ctx.close();

  await page.reload();
  await expect(page.getByRole('button', { name: /事前アンケート/ }).first()).toContainText(
    '提出済',
  );
});
