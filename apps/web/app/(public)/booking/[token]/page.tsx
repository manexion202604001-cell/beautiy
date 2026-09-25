import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { jaWeekday, minutesToHHMM, toLocalParts } from '@salonos/core';
import { bookingDays, cancelDeadline, customerCanModify, loadManagedAppointment } from '@/lib/server/reservations';
import { PublicFooter, PublicHeader } from '../../book/[shopSlug]/PublicHeader';
import { ManageActions } from './ManageActions';

export const metadata: Metadata = { title: 'ご予約の確認・変更', robots: { index: false, follow: false } };

const STATUS_TEXT: Record<string, { label: string; tone: string }> = {
  REQUESTED: { label: 'リクエスト受付中（未確定）', tone: 'amber' },
  CONFIRMED: { label: '予約確定', tone: 'blue' },
  ARRIVED: { label: 'ご来店済み', tone: 'green' },
  IN_SERVICE: { label: '施術中', tone: 'green' },
  COMPLETED: { label: 'ご来店済み', tone: 'green' },
  CANCELLED: { label: 'キャンセル済み', tone: 'red' },
  NO_SHOW: { label: 'キャンセル済み', tone: 'red' },
};

export default async function ManageBookingPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const a = await loadManagedAppointment(token);
  if (!a || a.kind === 'PRIVATE') notFound();
  const tz = a.shop.timezone;
  const p = toLocalParts(a.startAt, tz), e = toLocalParts(a.endAt, tz);
  const now = new Date();
  const check = customerCanModify(a, a.shop, now);
  const dl = toLocalParts(cancelDeadline(a, a.shop), tz);
  const st = STATUS_TEXT[a.status];
  const days = check.ok ? await bookingDays(a.shop, now) : [];
  const past = a.endAt < now;

  return (
    <>
      <PublicHeader name={a.shop.name} slug={a.shop.slug} phone={a.shop.phone} imageUrl={a.shop.imageUrl} sub="ご予約の確認・変更" />
      <main className="public-body stack">
        <div className="card">
          <div className="between" style={{ marginBottom: 12 }}>
            <h2>ご予約内容</h2>
            <span className={`badge ${st.tone}`}>{st.label}</span>
          </div>
          <dl className="bk-summary">
            {/* Only the name the booker typed — never the matched customer record (see resolveCustomer). */}
            {a.guestName && <><dt>お名前</dt><dd>{a.guestName} 様</dd></>}
            <dt>日時</dt><dd><b style={a.status === 'CANCELLED' ? { textDecoration: 'line-through' } : undefined}>{p.year}年{p.month}月{p.day}日({jaWeekday(p.weekday)}) {minutesToHHMM(p.minutes)}〜{minutesToHHMM(e.minutes)}</b></dd>
            <dt>メニュー</dt><dd>{a.menus.length ? a.menus.map((m) => <div key={m.id}>{m.name}</div>) : a.kind === 'CONSULTATION' ? 'ご相談' : '—'}</dd>
            <dt>スタッフ</dt><dd>{a.nominated && a.staffName ? a.staffName : '指名なし'}</dd>
            <dt>お支払い目安</dt><dd>¥{a.totalPrice.toLocaleString('ja-JP')}</dd>
            {a.customerNote && <><dt>ご要望</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{a.customerNote}</dd></>}
            <dt>店舗</dt><dd>{a.shop.name}{a.shop.address && <div className="sub">{a.shop.address}</div>}{a.shop.accessInfo && <div className="sub">{a.shop.accessInfo}</div>}</dd>
          </dl>
        </div>

        {a.status === 'CANCELLED' && (
          <div className="card center stack-sm">
            <p style={{ margin: 0 }}>このご予約はキャンセルされています。</p>
            <div><Link className="btn" href={`/book/${a.shop.slug}`}>新しく予約する</Link></div>
          </div>
        )}

        {check.ok && (
          <>
            <p className="sub" style={{ margin: 0 }}>変更・キャンセルは {dl.month}/{dl.day} {minutesToHHMM(dl.minutes)}（ご予約の{a.shop.cancelDeadlineHours}時間前）まで承ります。</p>
            <ManageActions token={a.manageToken} shopSlug={a.shop.slug} days={days} currentDate={p.date} />
          </>
        )}

        {!check.ok && check.reason === 'PAST_DEADLINE' && !past && (
          <div className="alert warn">
            オンラインでの変更・キャンセル期限（ご予約の{a.shop.cancelDeadlineHours}時間前）を過ぎています。
            {a.shop.phone ? <>お手数ですがお電話（<a className="link" href={`tel:${a.shop.phone.replace(/[^\d+]/g, '')}`}>{a.shop.phone}</a>）でご連絡ください。</> : 'お手数ですが店舗へ直接ご連絡ください。'}
          </div>
        )}
        {(past || a.status === 'COMPLETED') && a.status !== 'CANCELLED' && (
          <div className="card center stack-sm">
            <p style={{ margin: 0 }}>ご来店ありがとうございました。</p>
            <div><Link className="btn" href={`/book/${a.shop.slug}`}>次回のご予約をする</Link></div>
          </div>
        )}
        <PublicFooter />
      </main>
    </>
  );
}
