// First acceptance journey (CLAUDE.md): owner creates org/shop → invites stylist → menus/hours/seats →
// customer books from the public page with a LINE link → reservation in the staff ledger →
// stylist writes a karte with a photo → POS checkout → visit/LTV/report updated → follow-up message.
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { prisma } from '@salonos/db';
import { signLineLink } from '../../lib/server/line-link';
import { pathOf, pickFirstSlot, stat, TINY_PNG } from './helpers';

test.describe.configure({ mode: 'serial' });

const run = Date.now();
const tag = String(run).slice(-7);
const owner = { name: `E2Eオーナー${tag}`, email: `e2e-owner-${run}@example.test`, password: 'e2e-owner-pass' };
const stylist = { name: `E2Eスタイリスト${tag}`, email: `e2e-stylist-${run}@example.test`, password: 'e2e-stylist-pass' };
const orgName = `E2E Salon ${tag}`;
const shopName = `E2E青山 ${tag}`;
const menu = { category: 'E2E', name: `E2Eカット${tag}`, price: 6600, priceLabel: '¥6,600' };
const customer = { last: '検証', first: `花子${tag}`, kana: 'ケンショウ ハナコ', phone: `090${String(run).slice(-8)}` };
const customerName = `${customer.last} ${customer.first}`;
const lineUserId = `Ue2e${run.toString(16)}`;

let ownerCtx: BrowserContext;
let stylistCtx: BrowserContext;
let customerCtx: BrowserContext;
let ownerPage: Page;
let stylistPage: Page;

// shared journey state
let shopSlug = '';
let apptDate = '';
let manageUrl = '';
let customerId = '';
let appointmentId = '';
let paidTotal = '';

// one browser context per actor (contexts created here inherit the project's `use` options)
test.beforeAll(async ({ browser }) => {
  ownerCtx = await browser.newContext();
  stylistCtx = await browser.newContext();
  customerCtx = await browser.newContext();
  ownerPage = await ownerCtx.newPage();
  stylistPage = await stylistCtx.newPage();
});

test.afterAll(async () => {
  await Promise.all([ownerCtx?.close(), stylistCtx?.close(), customerCtx?.close()]);
  await prisma.$disconnect();
});

test('a. owner signs up and lands on the dashboard', async () => {
  const page = ownerPage;
  await page.goto('/signup');
  await page.getByLabel('サロン名（組織名）').fill(orgName);
  await page.getByLabel('最初の店舗名').fill(shopName);
  await page.getByLabel('オーナーのお名前').fill(owner.name);
  await page.getByLabel('メールアドレス').fill(owner.email);
  await page.getByLabel('パスワード（8文字以上）').fill(owner.password);
  await page.getByRole('button', { name: 'サロンを作成して始める' }).click();
  await expect(page).toHaveURL(/\/dashboard/);
});

test('b. owner invites a stylist who accepts and becomes bookable', async () => {
  const page = ownerPage;
  await page.goto('/settings/staff');
  await page.getByRole('button', { name: 'スタッフを招待' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('氏名').fill(stylist.name);
  await dialog.getByLabel('メールアドレス').fill(stylist.email);
  await expect(dialog.getByLabel('役割')).toHaveValue('STYLIST');
  await expect(dialog.getByRole('checkbox', { name: shopName })).toBeChecked();
  await dialog.getByRole('button', { name: '招待リンクを発行' }).click();
  const link = dialog.getByRole('textbox', { name: /招待リンクを発行しました/ });
  await expect(link).toHaveValue(/\/invite\//);
  const inviteUrl = await link.inputValue();
  await dialog.getByRole('button', { name: '閉じる' }).first().click();

  // stylist accepts in a separate browser
  const s = stylistPage;
  await s.goto(pathOf(inviteUrl));
  await expect(s.getByRole('heading', { name: `${orgName} に参加` })).toBeVisible();
  await expect(s.getByLabel('お名前')).toHaveValue(stylist.name);
  await s.getByLabel('パスワード（8文字以上）').fill(stylist.password);
  await s.getByRole('button', { name: '参加する' }).click();
  await expect(s).toHaveURL(/\/dashboard/);

  // back as owner: the stylist is a member assigned to the shop and takes online bookings
  await page.goto('/settings/staff');
  const row = page.getByRole('row').filter({ hasText: stylist.email });
  await expect(row).toContainText(stylist.name);
  await expect(row).toContainText('スタイリスト');
  await expect(row).toContainText(shopName);
  if (!(await row.getByText('受付', { exact: true }).isVisible())) {
    await row.getByRole('button', { name: '編集' }).click();
    const d = page.getByRole('dialog');
    await d.getByRole('checkbox', { name: 'ネット予約で指名・自動割当の対象にする' }).check();
    await d.getByRole('button', { name: '保存' }).click();
    await expect(d).toBeHidden();
  }
  await expect(row.getByText('受付', { exact: true })).toBeVisible();
});

test('c. owner configures menu, seats and business hours', async () => {
  const page = ownerPage;

  // menu
  await page.goto('/settings/menus');
  await page.getByRole('button', { name: 'メニューを追加' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('カテゴリ').fill(menu.category);
  await dialog.getByLabel('メニュー名').fill(menu.name);
  await dialog.getByLabel('所要時間（分）').fill('60');
  await dialog.getByLabel('料金（税込・円）').fill(String(menu.price));
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(dialog).toBeHidden();
  const menuRow = page.getByRole('row').filter({ hasText: menu.name });
  await expect(menuRow).toContainText(menu.priceLabel);
  await expect(menuRow).toContainText('掲載');

  // seats (+ read the public slug)
  await page.goto('/settings/shop');
  await page.getByLabel('席数（同時に施術できる数）').fill('2');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('保存しました');
  await page.reload();
  await expect(page.getByLabel('席数（同時に施術できる数）')).toHaveValue('2');
  shopSlug = await page.getByLabel('公開URL（スラッグ）').inputValue();
  expect(shopSlug).toMatch(/^[a-z0-9-]+$/);

  // business hours: open every day so the journey does not depend on today's weekday
  await page.goto('/settings/hours');
  const closed = page.getByRole('checkbox', { name: '定休日' });
  await expect(closed).toHaveCount(7);
  for (let i = 0; i < 7; i++) await closed.nth(i).uncheck();
  await page.getByRole('button', { name: '営業時間を保存' }).click();
  await expect(page.getByRole('status')).toContainText('営業時間を保存しました');
  await page.reload();
  for (let i = 0; i < 7; i++) await expect(closed.nth(i)).not.toBeChecked();
});

test('d. customer books on the public page through a LINE link', async () => {
  const shop = await prisma.shop.findUniqueOrThrow({ where: { slug: shopSlug }, select: { organizationId: true } });
  const lk = signLineLink(shop.organizationId, lineUserId);

  const page = await customerCtx.newPage();
  await page.goto(`/book/${shopSlug}?lk=${encodeURIComponent(lk)}`);
  const openedAt = Date.now();
  await expect(page.getByText('LINEと連携してご予約いただけます')).toBeVisible();

  // STEP 1 menu
  await page.getByRole('button', { name: new RegExp(menu.name) }).click();
  await page.getByRole('button', { name: 'スタッフを選ぶ' }).click();
  // STEP 2 staff: nominate the invited stylist
  await page.getByRole('button', { name: new RegExp(stylist.name) }).click();
  await page.getByRole('button', { name: '日時を選ぶ' }).click();
  // STEP 3 first available slot
  await pickFirstSlot(page);
  // STEP 4 details
  await expect(page.getByRole('heading', { name: 'お客様情報の入力' })).toBeVisible();
  await page.getByLabel('お名前').fill(customerName);
  await page.getByLabel('フリガナ').fill(customer.kana);
  await page.getByLabel('電話番号').fill(customer.phone);
  await expect(page.getByText('予約確認はLINEでお届けします')).toBeVisible();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '確認へ進む' }).click();
  // STEP 5 confirm
  await expect(page.getByRole('heading', { name: '予約内容の確認' })).toBeVisible();
  await expect(page.locator('.bk-summary')).toContainText(stylist.name);
  // the page embeds a bot-guard timestamp: submissions within 3s of rendering are rejected
  const wait = 3500 - (Date.now() - openedAt);
  if (wait > 0) await page.waitForTimeout(wait);
  await page.getByRole('button', { name: '予約を確定する' }).click();

  await expect(page).toHaveURL(new RegExp(`/book/${shopSlug}/complete`));
  await expect(page.getByRole('heading', { name: 'ご予約が確定しました' })).toBeVisible();
  await expect(page.getByText('LINEに確認メッセージをお送りしました')).toBeVisible();
  manageUrl = (await page.locator('.bk-url').innerText()).trim();
  expect(manageUrl).toMatch(/\/booking\/[\w-]+$/);
  const when = (await page.locator('.bk-summary dd').first().innerText()).match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  expect(when).not.toBeNull();
  apptDate = `${when![1]}-${when![2].padStart(2, '0')}-${when![3].padStart(2, '0')}`;

  // the manage URL works for the customer
  await page.goto(pathOf(manageUrl));
  await expect(page.getByText('予約確定')).toBeVisible();
  await expect(page.getByText(`${customerName} 様`)).toBeVisible();
  await page.close();
});

test('e. reservation is in the staff ledger and the customer has a LINE identity', async () => {
  const page = ownerPage;
  await page.goto(`/reservations?view=day&date=${apptDate}`);
  const block = page.getByRole('button', { name: new RegExp(customerName) });
  await expect(block).toBeVisible();
  await expect(block).toHaveAccessibleName(/確定/);
  await block.click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toContainText(customerName);
  const karteLink = drawer.getByRole('link', { name: 'カルテ作成' });
  appointmentId = new URL((await karteLink.getAttribute('href'))!, 'http://x').searchParams.get('appointmentId')!;
  expect(appointmentId).toBeTruthy();
  await drawer.getByRole('link', { name: '顧客詳細' }).click();
  await expect(page).toHaveURL(/\/customers\/[\w-]+$/);
  customerId = new URL(page.url()).pathname.split('/').pop()!;

  await expect(page.getByRole('heading', { name: new RegExp(customerName) })).toBeVisible();
  await expect(page.getByText('LINE連携')).toBeVisible();
  const ids = page.locator('.card').filter({ has: page.getByRole('heading', { name: '外部ID連携' }) });
  await expect(ids.locator('.list-item')).toHaveCount(1);
  await expect(ids.locator('.list-item')).toContainText('LINE');
});

test('f. stylist opens the customer and writes a karte with a photo', async () => {
  const page = stylistPage;
  await page.goto(`/customers/${customerId}`);
  await expect(page.getByRole('heading', { name: new RegExp(customerName) })).toBeVisible();
  // stylists do not see raw contact details
  const phone = page.locator('dt', { hasText: '電話' }).locator('xpath=following-sibling::dd[1]');
  await expect(phone).toHaveText(new RegExp(`^\\*+${customer.phone.slice(-4)}$`));

  await page.goto(`/karte/new?appointmentId=${appointmentId}`);
  await expect(page.getByRole('heading', { name: `${customerName} 様の新規カルテ` })).toBeVisible();
  await page.getByLabel('施術内容').fill(`E2E施術メモ ${tag}: 全体2cmカット`);
  await page.getByLabel('お客様へのケアメモ').fill('2日間はシャンプー控えめに');
  await page.getByRole('button', { name: 'カルテを作成' }).click();
  await expect(page).toHaveURL(/\/karte\/[\w-]+\?created=1/);
  await expect(page.getByText('カルテを作成しました')).toBeVisible();
  await expect(page.getByLabel('施術内容')).toHaveValue(new RegExp(`E2E施術メモ ${tag}`));

  await page.locator('input[type=file]').setInputFiles({ name: 'after.png', mimeType: 'image/png', buffer: TINY_PNG });
  await expect(page.getByRole('status').filter({ hasText: '1枚の写真を追加しました' })).toBeVisible();
  await expect(page.locator('.kt-photo img')).toHaveCount(1);
  await expect(page.locator('.card-head', { hasText: '写真' })).toContainText('1枚');
});

test('g. POS checkout of the appointment paid in cash', async () => {
  const page = ownerPage;
  await page.goto('/pos/register');
  const open = page.getByRole('button', { name: 'レジを開ける' });
  if (await open.isVisible()) {
    await open.click();
    await expect(page.getByText('レジを開けました')).toBeVisible();
  }
  await expect(page.getByRole('button', { name: 'レジを締める' })).toBeVisible();

  await page.goto(`/pos/checkout?appointmentId=${appointmentId}`);
  await expect(page.getByRole('textbox', { name: '品目名' }).first()).toHaveValue(menu.name);
  await page.getByRole('button', { name: '現金', exact: true }).click();
  const confirm = page.getByRole('button', { name: /^会計確定/ });
  await expect(confirm).toBeEnabled();
  await expect(confirm).toHaveText(`会計確定 ${menu.priceLabel}`);
  await confirm.click();
  await expect(page).toHaveURL(/\/pos\/receipt\/[\w-]+\?done=1/);
  await expect(page.getByText('会計が完了しました。')).toBeVisible();
  const receipt = page.getByLabel('レシート');
  await expect(receipt).toContainText(customerName);
  paidTotal = (await receipt.locator('.r-total span').last().innerText()).trim();
  expect(paidTotal).toBe(menu.priceLabel);
});

test('h. visit count, LTV, sales report and appointment status are updated', async () => {
  const page = ownerPage;
  await page.goto(`/customers/${customerId}`);
  await expect(stat(page, '来店回数')).toHaveText('1回');
  await expect(stat(page, '累計売上（LTV）')).toHaveText(paidTotal);

  await page.goto('/reports?range=today');
  await expect(stat(page, '純売上（返金控除後）')).toHaveText(paidTotal);
  await expect(stat(page, '会計件数')).toHaveText('1件');

  await page.goto(`/reservations?view=day&date=${apptDate}`);
  await expect(page.getByRole('button', { name: new RegExp(customerName) })).toHaveAccessibleName(/完了/);
});

test('i. an outbound message to the customer is logged', async () => {
  const page = ownerPage;
  await page.goto('/messages/logs');
  const row = page.getByRole('row').filter({ hasText: customerName });
  await expect(row.first()).toBeVisible();
  await expect(row.first()).toContainText('LINE');
  await expect(row.first()).toContainText('予約通知');
});
