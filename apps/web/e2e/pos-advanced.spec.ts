import { expect, test } from '@playwright/test';
import { OWNER, loginAsStaff, nav } from './helpers';

const SHOTS = 'e2e/screenshots';

test('POS: walk-in with barcode product, discount, staff split, split payment, refund, void, register close', async ({
  page,
  request,
}) => {
  // a product with a barcode (created through the API)
  const login = await request.post('/v1/auth/login', {
    data: { email: OWNER.email, password: OWNER.password },
  });
  const { accessToken } = (await login.json()) as { accessToken: string };
  const barcode = `49${Date.now().toString().slice(-11)}`;
  const created = await request.post('/v1/products', {
    headers: { authorization: `Bearer ${accessToken}` },
    data: {
      name: `バーコード商品 ${barcode.slice(-4)}`,
      price: 2200,
      barcode,
      stockManaged: false,
    },
  });
  expect(created.ok()).toBeTruthy();

  await loginAsStaff(page);
  await nav(page, '/app/pos');
  await expect(page.getByText(/開局中|未開局/).first()).toBeVisible();
  if (await page.getByRole('button', { name: 'レジを開局する' }).isVisible()) {
    await page.getByRole('button', { name: 'レジを開局する' }).click();
    await page
      .getByRole('dialog', { name: 'レジ開局' })
      .getByRole('button', { name: '開局する' })
      .click();
    await expect(page.getByTestId('expected-cash')).toBeVisible();
  }

  const walkIn = async () => {
    await nav(page, '/app/pos');
    await page.getByRole('button', { name: '新規会計（予約なし）' }).click();
    await expect(page).toHaveURL(/\/app\/pos\/checkout\//);
  };

  // ---- walk-in #1
  await walkIn();
  await page
    .getByRole('toolbar', { name: '明細の追加' })
    .getByRole('button', { name: 'メニュー' })
    .click();
  await page
    .getByRole('dialog', { name: 'メニューを追加' })
    .getByRole('button', { name: /^カット\s/ })
    .first()
    .click();
  await expect(page.getByTestId('tx-line')).toHaveCount(1);
  await page
    .getByRole('toolbar', { name: '明細の追加' })
    .getByRole('button', { name: '商品' })
    .click();
  const picker = page.getByRole('dialog', { name: '商品を追加' });
  await picker.getByLabel('商品を検索（バーコード可）').fill(barcode);
  await expect(picker.getByRole('button', { name: new RegExp(barcode) })).toBeVisible();
  await picker.getByLabel('商品を検索（バーコード可）').press('Enter');
  await expect(page.getByTestId('tx-line')).toHaveCount(2);

  await page
    .getByRole('toolbar', { name: '明細の追加' })
    .getByRole('button', { name: '値引' })
    .click();
  const disc = page.getByRole('dialog', { name: '値引を追加' });
  await disc.getByRole('radio', { name: '割合' }).click();
  await disc.getByLabel('値引率').fill('10');
  await disc.getByRole('button', { name: '追加する' }).click();
  await expect(page.getByTestId('tx-line')).toHaveCount(3);

  // staff split 50/50 on the first line
  await page
    .getByRole('button', { name: /担当者を設定|の担当者配分を編集/ })
    .first()
    .click();
  const share = page.getByRole('dialog', { name: '担当者配分' });
  await share.getByLabel('担当者1', { exact: true }).selectOption({ index: 1 });
  await share.getByRole('button', { name: '担当者を追加' }).click();
  await share.getByLabel('担当者2', { exact: true }).selectOption({ index: 2 });
  await share.getByRole('button', { name: '均等に配分' }).click();
  await expect(share.getByText('合計 100%')).toBeVisible();
  await share.getByRole('button', { name: '適用する' }).click();
  await expect(page.getByText(/50%/).first()).toBeVisible();

  const total = Number(
    ((await page.getByTestId('tx-total').textContent()) ?? '').replace(/[^\d]/g, ''),
  );
  // split: card 3,000 + cash for the rest
  await page
    .getByRole('group', { name: '支払方法' })
    .getByRole('button', { name: 'カード' })
    .click();
  const card = page.getByRole('dialog', { name: /でお支払い/ });
  await card.getByLabel(/金額/).fill('3000');
  await card.getByTestId('confirm-payment').click();
  await expect(page.getByTestId('outstanding')).toHaveText(
    `¥${(total - 3000).toLocaleString('ja-JP')}`,
  );
  await page.getByRole('group', { name: '支払方法' }).getByRole('button', { name: '現金' }).click();
  await page
    .getByRole('dialog', { name: '現金でお支払い' })
    .getByRole('button', { name: 'ちょうど' })
    .click();
  await page.getByRole('dialog', { name: '現金でお支払い' }).getByTestId('confirm-payment').click();
  await expect(page.getByTestId('outstanding')).toHaveText('¥0');
  await page.screenshot({ path: `${SHOTS}/pos-split-payment.png`, fullPage: true });
  await page.getByTestId('complete-transaction').click();
  await expect(page.getByText('会計が完了しました').first()).toBeVisible();

  // partial refund
  await page.getByRole('button', { name: '返金・返品' }).click();
  const refund = page.getByRole('dialog', { name: '返金・返品' });
  await refund.getByLabel('返金額').fill('500');
  await refund.getByLabel('返金理由').fill('仕上がり調整のため一部返金');
  await refund.getByRole('button', { name: '返金する' }).click();
  await expect(page.getByText('返金しました')).toBeVisible();
  await expect(page.getByText('一部返金').first()).toBeVisible();

  // ---- walk-in #2 → complete → void
  await walkIn();
  await page
    .getByRole('toolbar', { name: '明細の追加' })
    .getByRole('button', { name: 'メニュー' })
    .click();
  await page
    .getByRole('dialog', { name: 'メニューを追加' })
    .getByRole('button', { name: /前髪カット/ })
    .click();
  await page
    .getByRole('group', { name: '支払方法' })
    .getByRole('button', { name: 'QR決済' })
    .click();
  await page
    .getByRole('dialog', { name: /でお支払い/ })
    .getByTestId('confirm-payment')
    .click();
  await page.getByTestId('complete-transaction').click();
  await expect(page.getByText('会計が完了しました').first()).toBeVisible();
  await page.getByRole('button', { name: '会計を取り消す' }).click();
  const voidDlg = page.getByRole('dialog', { name: '会計を取り消しますか？' });
  await voidDlg.getByLabel('取消理由').fill('打ち間違い');
  await voidDlg.getByRole('button', { name: '取り消す' }).click();
  await expect(page.getByText('会計を取り消しました')).toBeVisible();

  // ---- register close with denomination counting
  await nav(page, '/app/pos');
  await page.getByRole('button', { name: 'レジ締め' }).click();
  const close = page.getByRole('dialog', { name: 'レジ締め' });
  await close.getByLabel('10,000円札の枚数').fill('3');
  await expect(close.getByTestId('counted-cash')).toHaveText('¥30,000');
  await page.screenshot({ path: `${SHOTS}/pos-register-close.png` });
  await close.getByRole('button', { name: '締めを確定する' }).click();
  await expect(page.getByText('レジを締めました')).toBeVisible();
  await expect(page.getByRole('button', { name: 'レジを開局する' })).toBeVisible();
});
