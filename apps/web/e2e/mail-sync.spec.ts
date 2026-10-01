import { expect, test } from '@playwright/test';
import { loginAsStaff, nextOpenDate } from './helpers';

/**
 * Hot Pepper / LiME e-mail connectors: create both connectors, check a pasted notification with the
 * parse test, deliver a Hot Pepper booking mail to the inbound webhook, then confirm the LiME side
 * gets a "stop this slot" task that staff can mark done.
 */
test('Hot Pepper booking mail is imported and becomes a slot-block task for LiME', async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  const stamp = Date.now().toString().slice(-7);
  // a different day per run so re-runs against the same DB never overlap the previous booking
  const date = nextOpenDate(9 + (Number(stamp) % 50));
  const [y, m, d] = date.split('-').map(Number);
  const subject = '【SALON BOARD】予約連絡';
  const body = [
    '下記の内容で予約が入りました。',
    `予約番号：BE${stamp}`,
    `来店日時：${y}年${m}月${d}日 11:00`,
    'お客様名：メール 連携子 様',
    'フリガナ：メール レンケイコ',
    '電話番号：090-0000-' + stamp.slice(-4),
    '指名スタッフ：佐藤 美咲',
    'メニュー：',
    'カット',
    '所要時間：60分',
  ].join('\n');

  await loginAsStaff(page);
  await page.goto('/app/integrations');

  // one connector per medium and shop: create it (setup guide opens) or reuse it on re-runs
  const ensureConnector = async (provider: string, label: string, name: string) => {
    const existing = page.getByRole('article').filter({ hasText: label });
    await expect(page.getByRole('button', { name: '連携を追加' })).toBeVisible();
    if (!(await existing.count())) {
      await page.getByRole('button', { name: '連携を追加' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('連携先').selectOption(provider);
      await dialog.getByLabel('表示名').fill(name);
      await expect(dialog.getByRole('switch', { name: /枠止めを依頼/ })).toBeChecked();
      await dialog.getByRole('button', { name: '保存' }).click();
    } else {
      await existing.first().getByRole('button', { name: '設定手順・受信URL' }).click();
    }
    const guide = page.getByRole('dialog', { name: 'メール連携の設定手順' });
    await expect(guide).toBeVisible();
    const url = (await guide.locator('code').first().textContent())!.trim();
    expect(url).toMatch(/\/v1\/webhooks\/inbound_email\/[\w-]{16,}$/);
    await guide.getByRole('button', { name: '閉じる' }).last().click();
    return url;
  };
  await page.waitForLoadState('networkidle');
  const inboundUrl = await ensureConnector(
    'hotpepper_mail',
    'ホットペッパービューティー（予約通知メール連携）',
    `ホットペッパー ${stamp}`,
  );
  await ensureConnector('lime_mail', 'LiME（予約通知メール連携）', `LiME ${stamp}`);

  // parse test on the Hot Pepper card
  const card = page
    .getByRole('article')
    .filter({ hasText: 'ホットペッパービューティー（予約通知メール連携）' })
    .first();
  await card.getByRole('button', { name: '解析テスト' }).click();
  const pt = page.getByRole('dialog', { name: '予約通知メールの解析テスト' });
  await pt.getByLabel('件名').fill(subject);
  await pt.getByLabel('本文').fill(body);
  await pt.getByRole('button', { name: '解析する' }).click();
  await expect(pt.getByText('このまま取り込めます')).toBeVisible();
  await expect(pt.getByText(`BE${stamp}`, { exact: true })).toBeVisible();
  await expect(pt.getByText(/佐藤 美咲 → 佐藤 美咲/)).toBeVisible();
  await pt.getByRole('button', { name: '閉じる' }).last().click();

  // the mail arrives through the inbound-mail service (Postmark-style JSON)
  const res = await request.post(inboundUrl, {
    data: {
      From: 'yoyaku@salonboard.com',
      To: 'hpb@in.example.jp',
      Subject: subject,
      TextBody: body,
      MessageID: `<e2e-${stamp}@example>`,
    },
  });
  expect(res.status()).toBe(200);

  // → LiME must stop that slot: task appears in 媒体の枠止め and can be marked done
  await expect(async () => {
    await page.reload();
    await page.getByRole('tab', { name: /媒体の枠止め/ }).click();
    await expect(
      page.getByRole('listitem').filter({ hasText: 'LiME' }).filter({ hasText: '11:00' }).first(),
    ).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 45_000, intervals: [2_000] });
  const task = page
    .getByRole('listitem')
    .filter({ hasText: 'LiME' })
    .filter({ hasText: '11:00' })
    .filter({ hasText: '連携子' })
    .first();
  await expect(task.getByText('枠を止める')).toBeVisible();
  await task.getByRole('button', { name: '対応済み' }).click();
  await expect(page.getByText('枠止めを対応済みにしました')).toBeVisible();
});
