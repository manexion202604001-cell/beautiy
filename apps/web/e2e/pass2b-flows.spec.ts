import { expect, test, type Page } from '@playwright/test';
import { loginAsStaff, nav } from './helpers';

/**
 * Interaction walkthrough + screenshots for the pass2-b screens (dialogs, drawers, public pages).
 * Run with SCREENSHOTS=1. Creates demo data (campaign draft, automation, referral link, SNS asset, export).
 */
test.skip(!process.env.SCREENSHOTS, 'SCREENSHOTS=1 only');

const OUT = 'e2e/screenshots';
const shot = (page: Page, name: string, fullPage = false) =>
  page.screenshot({ path: `${OUT}/p2b-flow-${name}.png`, fullPage });
const settle = async (page: Page, ms = 700) => {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(ms);
};

test('staff flows', async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAsStaff(page);

  // --- messages: thread + AI draft (accept copies into the composer, never sends)
  await nav(page, '/app/messages');
  await settle(page);
  await page.getByRole('complementary', { name: '受信箱' }).getByRole('button').first().click();
  await settle(page);
  await shot(page, 'message-thread');
  await page.getByRole('button', { name: 'AI下書き' }).click();
  const ai = page.getByRole('dialog', { name: 'AIでメッセージ下書きを作成' });
  await ai.getByRole('button', { name: '下書きを生成' }).click();
  await expect(ai.getByLabel('提案された本文（編集できます）')).not.toHaveValue('');
  await shot(page, 'ai-draft');
  await ai.getByRole('button', { name: '採用して作成欄にコピー' }).click();
  await expect(page.getByRole('textbox', { name: 'メッセージ本文' })).not.toHaveValue('');
  await shot(page, 'ai-draft-accepted');

  // --- customer page: messages tab with preferences + LINE QR
  await nav(page, '/app/customers');
  await page.locator('tbody tr').first().click();
  await page.getByRole('tab', { name: 'メッセージ' }).click();
  await settle(page);
  await shot(page, 'customer-messages', true);
  await page.getByRole('button', { name: '連携用QRコードを発行' }).click();
  await expect(page.getByRole('dialog', { name: 'LINE連携用QRコード' }).getByRole('img')).toBeVisible();
  const linkUrl = await page.getByLabel('連携URL').inputValue();
  await shot(page, 'line-qr');
  await page.keyboard.press('Escape');

  // --- templates: editor with variable chips + live preview
  await nav(page, '/app/campaigns?tab=templates');
  await page.getByRole('button', { name: 'テンプレートを作成' }).click();
  const td = page.getByRole('dialog', { name: 'テンプレートを作成' });
  await td.getByLabel('名前').fill('E2E 秋のご案内');
  await td.getByRole('button', { name: '予約URL' }).click();
  await settle(page, 600);
  await expect(td.getByTestId('template-preview')).toContainText('様');
  await shot(page, 'template-editor');
  await td.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('テンプレートを作成しました')).toBeVisible();

  // --- campaign: draft → drawer → schedule dialog (cancelled before sending)
  await nav(page, '/app/campaigns?tab=campaigns');
  await page.getByRole('button', { name: 'キャンペーンを作成' }).click();
  const cd = page.getByRole('dialog', { name: 'キャンペーンを作成（下書き）' });
  await cd.getByLabel('キャンペーン名').fill('E2E 休眠フォロー');
  await cd.getByRole('radio', { name: '条件を指定' }).click();
  await cd.getByRole('radio', { name: '本文を入力' }).click();
  await cd.getByLabel('本文').fill('{{customer.name}}様 お久しぶりです。{{shop.bookingUrl}}');
  await settle(page);
  await shot(page, 'campaign-create');
  await cd.getByRole('button', { name: '下書きを保存' }).click();
  await expect(page.getByText('キャンペーンを下書き保存しました')).toBeVisible();
  await settle(page);
  await shot(page, 'campaign-drawer');
  await page.getByRole('button', { name: '配信予約…' }).click();
  await settle(page);
  await shot(page, 'campaign-schedule');
  await page.getByRole('button', { name: 'やめる' }).click();
  await page.keyboard.press('Escape');

  // --- automation: create (inactive) + dry run
  await nav(page, '/app/campaigns?tab=automations');
  await page.getByRole('button', { name: '自動配信を作成' }).click();
  const ad = page.getByRole('dialog', { name: '自動配信を作成' });
  await ad.getByLabel('名前').fill('E2E 休眠45日');
  await ad.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('自動配信を作成しました（停止中）')).toBeVisible();
  await page.getByRole('button', { name: '試算（送信しない）' }).first().click();
  await expect(page.getByTestId('dry-run-count')).toBeVisible();
  await shot(page, 'automation-dry-run');
  await page.keyboard.press('Escape');

  // --- referral link + stats drawer with QR
  await nav(page, '/app/campaigns?tab=referrals');
  await page.getByRole('button', { name: 'リンクを作成' }).click();
  const rd = page.getByRole('dialog', { name: '紹介リンクを作成' });
  await rd.getByLabel('名前').fill('Instagram プロフィール');
  await rd.getByLabel('source').fill('instagram');
  await rd.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('リンクを作成しました')).toBeVisible();
  await page.getByRole('button', { name: '統計とQRコード' }).first().click();
  await expect(page.getByTestId('referral-stats')).toBeVisible();
  await shot(page, 'referral-drawer');
  await page.keyboard.press('Escape');

  // --- SNS asset (no photo) → preview
  await nav(page, '/app/campaigns?tab=sns');
  await page.getByRole('button', { name: '素材を作成' }).click();
  const sd = page.getByRole('dialog', { name: 'SNS素材を作成' });
  await sd.getByLabel('キャプション').fill('秋の透明感カラー、ご予約受付中です');
  await sd.getByLabel('ハッシュタグ').fill('秋カラー 渋谷美容室');
  await shot(page, 'sns-create');
  await sd.getByRole('button', { name: '作成' }).click();
  await expect(page.getByTestId('sns-preview')).toBeVisible();
  await settle(page, 1000);
  await shot(page, 'sns-preview');
  await page.keyboard.press('Escape');

  // --- integrations: edit dialog with mapping editors, conflict resolution dialog
  await nav(page, '/app/integrations?tab=accounts');
  await page.getByRole('button', { name: '設定を編集' }).first().click();
  const idlg = page.getByRole('dialog', { name: '連携設定を編集' });
  await idlg.getByRole('button', { name: '行を追加' }).first().click();
  await idlg.getByLabel('スタッフ対応表 外部コード 1').fill('ST-UNKNOWN');
  await idlg.getByLabel('スタッフ対応表 対応先 1').selectOption({ index: 1 });
  await shot(page, 'integration-edit');
  await idlg.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('連携設定を更新しました')).toBeVisible();
  await page.getByRole('button', { name: '同期履歴' }).first().click();
  await settle(page);
  await shot(page, 'sync-jobs');
  await page.keyboard.press('Escape');
  await nav(page, '/app/integrations?tab=conflicts');
  await settle(page);
  await page.getByTestId('conflict-item').first().getByRole('button', { name: /手動で対応済み/ }).click();
  await shot(page, 'conflict-resolve');
  await page.getByRole('button', { name: 'やめる' }).click();
  await nav(page, '/app/integrations?tab=status');
  await settle(page);
  await shot(page, 'sync-status', true);

  // --- ops: audit search, export with polling + download, flags
  await nav(page, '/app/ops?tab=audit');
  await page.getByLabel('操作', { exact: true }).fill('message.*');
  await page.getByRole('button', { name: '検索' }).click();
  await settle(page);
  await page.getByRole('button', { name: '詳細を表示' }).first().click();
  await shot(page, 'audit', true);
  await nav(page, '/app/ops?tab=exports');
  await page.getByRole('button', { name: '作成' }).click();
  await expect(page.getByTestId('export-row').first().getByText('完了')).toBeVisible({ timeout: 30_000 });
  await shot(page, 'exports');
  const download = page.waitForEvent('download');
  await page.getByTestId('export-row').first().getByRole('button', { name: 'ダウンロード' }).click();
  expect((await download).suggestedFilename()).toMatch(/\.csv$/);
  await nav(page, '/app/ops?tab=flags');
  await settle(page);
  await shot(page, 'flags');

  // --- public pages
  await page.goto(linkUrl.replace(/^https?:\/\/[^/]+/, ''));
  await settle(page);
  await shot(page, 'public-line-link');
});

test('stylist sees only own analytics (analytics.read_own)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAsStaff(page, 'stylist1@example.com', 'password-1234');
  const nav0 = page.getByRole('navigation', { name: 'メインメニュー' });
  await expect(nav0.getByRole('link', { name: '分析' })).toBeVisible();
  await expect(nav0.getByRole('link', { name: 'メッセージ' })).toBeVisible();
  await expect(nav0.getByRole('link', { name: '配信' })).toHaveCount(0);
  await expect(nav0.getByRole('link', { name: '外部連携' })).toHaveCount(0);
  await expect(nav0.getByRole('link', { name: '運用・監査' })).toHaveCount(0);
  await nav(page, '/app/analytics');
  const tabs = page.getByRole('tablist', { name: '分析メニュー' });
  await expect(tabs.getByRole('tab', { name: '売上' })).toBeVisible();
  await expect(tabs.getByRole('tab', { name: 'スタッフ生産性' })).toBeVisible();
  await expect(tabs.getByRole('tab', { name: '顧客' })).toHaveCount(0);
  await expect(page.getByRole('radio', { name: '店舗' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'CSV出力' })).toHaveCount(0);
  await settle(page);
  await shot(page, 'stylist-analytics', true);
  await nav(page, '/app/ops');
  await expect(page.getByText('この画面を表示する権限がありません')).toBeVisible();
});

test('public pages (phone)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/unsubscribe?token=invalid-token-123');
  await settle(page);
  await shot(page, 'public-unsubscribe-invalid');
  await page.goto('/s/shibuya?utm_source=line');
  await expect(page).toHaveURL(/\/book\/shibuya\?utm_source=line/);

  if (process.env.E2E_UNSUB_URL) {
    await page.goto(process.env.E2E_UNSUB_URL.replace(/^https?:\/\/[^/]+/, ''));
    await expect(page.getByRole('button', { name: '配信を停止する' })).toBeVisible();
    await shot(page, 'public-unsubscribe');
    await page.getByRole('button', { name: '配信を停止する' }).click();
    await expect(page.getByText('配信を停止しました', { exact: true })).toBeVisible();
    await shot(page, 'public-unsubscribe-done');
  }

  // マイページ: LINE mock login as the linked demo user → 通知設定
  await page.goto('/book/shibuya');
  await page.evaluate(() => localStorage.setItem('salon.mockLineUserId', 'Udemo0001'));
  await page.goto('/my/shibuya');
  await page.getByRole('button', { name: /LINEでログイン/ }).click();
  await page.getByRole('radio', { name: '通知設定' }).click();
  await expect(page.getByTestId('notification-channels')).toBeVisible();
  await settle(page);
  await shot(page, 'public-my-notifications', true);
});
