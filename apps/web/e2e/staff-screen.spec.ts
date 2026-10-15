import { expect, test } from '@playwright/test';
import { jstDate, loginAsStaff, nav } from './helpers';

/**
 * スタッフ (main menu): invite by e-mail → ログイン情報を設定 → スタッフ編集 → 営業時間・予約設定 →
 * お客様に表示 / 非表示 → 退職. Every step is checked on the row of the staff member just invited.
 */
test('スタッフ管理: 招待・ログイン情報・編集・個別設定・表示切替・退職', async ({ page }) => {
  const stamp = String(Date.now()).slice(-7);
  const name = `招待${stamp}`;
  const email = `e2e-staff-${stamp}@example.com`;

  await loginAsStaff(page);
  await nav(page, '/app/staff');
  await expect(page.getByRole('heading', { level: 1, name: 'スタッフ管理' })).toBeVisible();
  await expect(page.getByText('スタッフ一覧')).toBeVisible();

  // ---- スタッフ招待
  await page.getByLabel('招待するメールアドレス').fill(email);
  await page.getByLabel('招待するスタッフの氏名').fill(name);
  await page.getByRole('button', { name: '招待を送信' }).click();
  await expect(page.getByTestId('invite-result')).toBeVisible();
  await expect(page.getByText('招待履歴')).toBeVisible();
  const row = page.locator(`[data-staff-name="${name}"]`);
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('data-login-ready', 'false');
  await expect(row).toHaveAttribute('data-status', 'invited');

  // ---- ログイン情報を設定 (address + temporary password → the staff member can log in)
  await row.getByRole('button', { name: 'ログイン情報を設定' }).click();
  const cred = page.getByRole('dialog');
  await expect(cred.getByRole('heading', { name: `ログイン情報を設定: ${name}` })).toBeVisible();
  await expect(cred.getByLabel('メールアドレス')).toHaveValue(email);
  await cred.getByRole('button', { name: '設定する' }).click();
  await expect(cred.getByText('設定が完了しました')).toBeVisible();
  await expect(cred.getByText(`メールアドレス: ${email}`)).toBeVisible();
  await cred.getByRole('button', { name: '閉じる' }).click();
  await expect(row).toHaveAttribute('data-login-ready', 'true');
  await expect(row).toHaveAttribute('data-status', 'active');

  // ---- スタッフ編集 (nickname + LINE通知 needs a LINE User ID)
  await row.getByRole('button', { name: 'スタッフ編集' }).click();
  const edit = page.getByRole('dialog');
  await expect(edit.getByRole('heading', { name: 'スタッフ編集' })).toBeVisible();
  await edit.getByLabel('ニックネーム').fill('イーツー');
  await edit.getByRole('button', { name: '更新' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(row).toHaveAttribute('data-nickname', 'イーツー');

  // ---- 営業時間・予約設定
  await row.getByRole('button', { name: '営業時間・予約設定' }).click();
  const settings = page.getByRole('dialog');
  await expect(settings.getByRole('heading', { name: `${name} - 設定` })).toBeVisible();
  await expect(settings.getByText('未設定（サロンの営業時間を使用）')).toBeVisible();
  await settings.getByRole('button', { name: 'サロンの営業時間を反映' }).click();
  await expect(settings.getByText('個別設定済み')).toBeVisible();
  await settings.getByRole('tab', { name: '予約設定' }).click();
  await expect(settings.getByText('未設定（サロンの予約設定を使用）')).toBeVisible();
  await settings.getByLabel('何日先まで予約を受け付ける').fill('30');
  await settings.getByLabel('当日予約の締め切り').fill('3');
  await settings.getByRole('button', { name: '予約設定を保存' }).click();
  await expect(settings.getByText('個別設定済み')).toBeVisible();
  await page.keyboard.press('Escape');

  // ---- お客様に表示 / 非表示
  await row.getByRole('button', { name: 'お客様に表示中' }).click();
  await expect(row.getByRole('button', { name: 'お客様に非表示' })).toBeVisible();
  await expect(row).toHaveAttribute('data-visible-to-customer', 'false');

  // ---- 退職にする (confirmation → moves under 「退職スタッフ」)
  page.once('dialog', (d) => void d.accept());
  await row.getByRole('button', { name: '退職にする' }).click();
  await expect(page.getByText('退職スタッフ')).toBeVisible();
  await expect(row.getByRole('button', { name: '退職取り消し' })).toBeVisible();
  await expect(row).toHaveAttribute('data-status', 'retired');

  // 予約受付設定 › スタッフ別設定 lists who has their own settings (retired staff are not listed)
  await nav(page, '/app/reservation-settings');
  await page.getByRole('tab', { name: 'スタッフ別設定', exact: true }).click();
  await expect(page.getByTestId('staff-settings-list')).toBeVisible();
});

/** 予約受付設定: a temporary closure is added and removed; the booking rules are saved and read back */
test('予約受付設定: 臨時休業日の追加・削除と予約設定の保存', async ({ page }) => {
  await loginAsStaff(page);
  await nav(page, '/app/reservation-settings');
  await expect(page.getByRole('heading', { level: 1, name: '予約受付設定' })).toBeVisible();
  await expect(page.getByText('曜日ごとの営業時間と定休日を設定します。')).toBeVisible();

  // ---- 臨時休業日 (far ahead so no other test books that day)
  const date = jstDate(400 + Math.floor(Math.random() * 200));
  const reason = `E2E休業${String(Date.now()).slice(-5)}`;
  await page.getByLabel('臨時休業日').fill(date);
  await page.getByLabel('理由').fill(reason);
  await page.getByRole('button', { name: '追加', exact: true }).click();
  const closure = page.getByTestId('closures').locator('div.rounded-lg', { hasText: reason });
  await expect(closure).toBeVisible();
  await closure.getByRole('button', { name: `${date} を削除` }).click();
  await expect(page.getByText(reason)).toHaveCount(0);

  // ---- 受付可能数: one row per weekday
  await page.getByRole('tab', { name: '受付可能数', exact: true }).click();
  await expect(page.getByText('曜日ごとの同時受付可能人数を設定します。')).toBeVisible();

  // ---- 予約設定: 受付開始 3ヶ月先まで → saved → still there after leaving the screen
  await page.getByRole('tab', { name: '予約設定', exact: true }).click();
  await page.getByRole('combobox', { name: '受付開始' }).click();
  await page.getByRole('option', { name: '3ヶ月先まで', exact: true }).click();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('予約設定を保存しました')).toBeVisible();
  await nav(page, '/app');
  await nav(page, '/app/reservation-settings');
  await page.getByRole('tab', { name: '予約設定', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '受付開始' })).toHaveText('3ヶ月先まで');
});
