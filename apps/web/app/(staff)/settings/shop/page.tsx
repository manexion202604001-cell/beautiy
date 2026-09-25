import { requirePage } from '@/lib/server/session';
import { prisma } from '@/lib/server/db';
import { env } from '@/lib/server/env';
import { PageHeader, Card, Field } from '@/components/ui';
import { ActionForm, CopyButton, SubmitButton } from '@/components/client';
import { encodeQr, qrSvgPath } from '../_components/qr';
import { updateShopAction } from './actions';

export const metadata = { title: '店舗情報・予約ルール' };

export default async function ShopSettingsPage() {
  const ctx = await requirePage('settings.shop');
  const shop = await prisma.shop.findFirstOrThrow({ where: { id: ctx.shop.id, organizationId: ctx.org.id } });
  const bookingUrl = `${env.appUrl}/book/${shop.slug}`;
  const profileUrl = `${env.appUrl}/s/${shop.slug}`;
  const qr = qrSvgPath(encodeQr(bookingUrl));

  return (
    <>
      <PageHeader title="店舗情報・予約ルール" back={{ href: '/settings', label: '設定' }} sub={`${shop.name} の設定（ヘッダーの店舗切替で対象店舗を変更できます）`} />
      <div className="split">
        <Card title="基本情報と予約ルール">
          <ActionForm action={updateShopAction} successMessage="保存しました">
            <div className="form-grid">
              <Field label="店舗名" htmlFor="name" required><input id="name" name="name" className="input" defaultValue={shop.name} required maxLength={80} /></Field>
              <Field label="電話番号" htmlFor="phone"><input id="phone" name="phone" className="input" defaultValue={shop.phone ?? ''} inputMode="tel" maxLength={30} /></Field>
              <Field label="住所" htmlFor="address" full><input id="address" name="address" className="input" defaultValue={shop.address ?? ''} maxLength={200} /></Field>
              <Field label="公開URL（スラッグ）" htmlFor="slug" required full hint={`${env.appUrl}/book/<スラッグ> — 変更すると以前のURL・QRコードは使えなくなります`}>
                <input id="slug" name="slug" className="input mono" defaultValue={shop.slug} required pattern="[a-z0-9](?:[a-z0-9\-]{0,38}[a-z0-9])?" maxLength={40} />
              </Field>
            </div>
            <hr />
            <h3 style={{ marginBottom: 10 }}>予約ルール</h3>
            <div className="form-grid">
              <Field label="席数（同時に施術できる数）" htmlFor="seatCount" required hint="席数を超える予約はスタッフ操作で警告付きの場合のみ登録できます">
                <input id="seatCount" name="seatCount" type="number" min={1} max={100} className="input" defaultValue={shop.seatCount} required />
              </Field>
              <Field label="ネット予約の受付方法" htmlFor="bookingMode" required>
                <select id="bookingMode" name="bookingMode" className="select" defaultValue={shop.bookingMode}>
                  <option value="INSTANT">即時確定</option>
                  <option value="REQUEST">リクエスト（サロンが承認して確定）</option>
                </select>
              </Field>
              <Field label="予約枠の間隔" htmlFor="slotIntervalMin" required>
                <select id="slotIntervalMin" name="slotIntervalMin" className="select" defaultValue={String(shop.slotIntervalMin)}>
                  {[10, 15, 20, 30, 60].map((v) => <option key={v} value={v}>{v}分</option>)}
                </select>
              </Field>
              <Field label="何日先まで予約を受け付けるか" htmlFor="bookingHorizonDays" required>
                <input id="bookingHorizonDays" name="bookingHorizonDays" type="number" min={1} max={365} className="input" defaultValue={shop.bookingHorizonDays} required />
              </Field>
              <Field label="予約受付の締切（開始の何分前まで）" htmlFor="minNoticeMin" required hint="例：60 = 1時間前まで">
                <input id="minNoticeMin" name="minNoticeMin" type="number" min={0} max={10080} className="input" defaultValue={shop.minNoticeMin} required />
              </Field>
              <Field label="お客様によるキャンセル・変更期限（時間前）" htmlFor="cancelDeadlineHours" required>
                <input id="cancelDeadlineHours" name="cancelDeadlineHours" type="number" min={0} max={720} className="input" defaultValue={shop.cancelDeadlineHours} required />
              </Field>
              <Field label="消費税率（%・内税）" htmlFor="taxRatePct" required>
                <input id="taxRatePct" name="taxRatePct" type="number" min={0} max={30} className="input" defaultValue={shop.taxRatePct} required />
              </Field>
              <Field label="ポイント付与率（%）" htmlFor="pointRatePct" required>
                <input id="pointRatePct" name="pointRatePct" type="number" min={0} max={100} className="input" defaultValue={shop.pointRatePct} required />
              </Field>
            </div>
            <div className="form-actions"><SubmitButton>保存</SubmitButton></div>
          </ActionForm>
        </Card>

        <div className="stack">
          <Card title="ネット予約ページ">
            <div className="stack">
              <div className="url-box"><input className="input" readOnly value={bookingUrl} aria-label="ネット予約URL" /><CopyButton text={bookingUrl} /></div>
              <div className="qr-box">
                <svg viewBox={`0 0 ${qr.dim} ${qr.dim}`} role="img" aria-label="ネット予約ページのQRコード" shapeRendering="crispEdges">
                  <rect width={qr.dim} height={qr.dim} fill="#fff" /><path d={qr.d} fill="#0d1830" />
                </svg>
              </div>
              <p className="sub">店頭POPや名刺に印刷してご利用ください（画面を右クリックで画像として保存できます）。</p>
              <div className="row-wrap">
                <a className="btn secondary sm" href={bookingUrl} target="_blank" rel="noreferrer">予約ページを開く</a>
                <a className="btn ghost sm" href={profileUrl} target="_blank" rel="noreferrer">店舗プロフィール</a>
              </div>
            </div>
          </Card>
          <Card title="関連する設定">
            <div className="stack-sm">
              <a className="link" href="/settings/hours">営業時間・休業日 →</a>
              <a className="link" href="/settings/menus">メニュー・クーポン →</a>
              <a className="link" href="/settings/staff">スタッフとネット予約の受付 →</a>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
