import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { CheckCircle2, Hourglass } from 'lucide-react';
import { jaWeekday, minutesToHHMM, toLocalParts } from '@salonos/core';
import { prisma } from '@/lib/server/db';
import { cancelDeadline, loadManagedAppointment, manageUrl } from '@/lib/server/reservations';
import { CopyButton } from '@/components/client';
import { PublicFooter, PublicHeader } from '../PublicHeader';

export const metadata: Metadata = { title: 'ご予約完了', robots: { index: false, follow: false } };

type Params = Promise<{ shopSlug: string }>;
type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function CompletePage({ params, searchParams }: { params: Params; searchParams: SP }) {
  const { shopSlug } = await params;
  const sp = await searchParams;
  const token = typeof sp.t === 'string' ? sp.t : '';
  const a = token ? await loadManagedAppointment(token) : null;
  if (!a || a.shop.slug !== shopSlug) notFound();
  if (a.status === 'CANCELLED' || a.status === 'NO_SHOW') redirect(`/booking/${a.manageToken}`);
  const tz = a.shop.timezone;
  const p = toLocalParts(a.startAt, tz), e = toLocalParts(a.endAt, tz);
  const url = manageUrl(a.manageToken);
  const requested = a.status === 'REQUESTED';
  const sent = await prisma.message.findFirst({ where: { appointmentId: a.id, status: { in: ['SENT', 'DELIVERED'] } }, select: { channel: true } });
  const deadline = toLocalParts(cancelDeadline(a, a.shop), tz);

  return (
    <>
      <PublicHeader name={a.shop.name} slug={a.shop.slug} phone={a.shop.phone} imageUrl={a.shop.imageUrl} />
      <main className="public-body stack">
        <div className="card center">
          <span className="bk-done-icon" style={requested ? { background: 'var(--amber-soft)', color: 'var(--amber)' } : undefined}>
            {requested ? <Hourglass size={28} /> : <CheckCircle2 size={28} />}
          </span>
          <h2 style={{ fontSize: 20, marginTop: 10 }}>{requested ? 'ご予約リクエストを受け付けました' : 'ご予約が確定しました'}</h2>
          <p className="sub" style={{ marginTop: 6 }}>
            {requested ? 'サロンで内容を確認のうえ、確定のご連絡をいたします。' : `${a.customer ? `${a.customer.lastName} ${a.customer.firstName}`.trim() : ''}様、ご来店をお待ちしております。`}
            {sent && <><br />{sent.channel === 'LINE' ? 'LINE' : 'メール'}に確認メッセージをお送りしました。</>}
          </p>
        </div>

        <div className="card">
          <dl className="bk-summary">
            <dt>日時</dt><dd><b>{p.year}年{p.month}月{p.day}日({jaWeekday(p.weekday)}) {minutesToHHMM(p.minutes)}〜{minutesToHHMM(e.minutes)}</b></dd>
            <dt>メニュー</dt><dd>{a.menus.length ? a.menus.map((m) => <div key={m.id}>{m.name}</div>) : a.kind === 'CONSULTATION' ? 'ご相談' : '—'}</dd>
            <dt>スタッフ</dt><dd>{a.nominated && a.staffName ? a.staffName : '指名なし'}</dd>
            <dt>お支払い目安</dt><dd>¥{a.totalPrice.toLocaleString('ja-JP')}<div className="sub">お支払いは当日店頭にて承ります</div></dd>
            <dt>店舗</dt><dd>{a.shop.name}{a.shop.address && <div className="sub">{a.shop.address}</div>}{a.shop.phone && <div className="sub">TEL {a.shop.phone}</div>}</dd>
          </dl>
        </div>

        <div className="card stack-sm">
          <h3>ご予約の変更・キャンセル</h3>
          <p className="sub" style={{ margin: 0 }}>下記のURLから、{deadline.month}/{deadline.day} {minutesToHHMM(deadline.minutes)}（ご予約の{a.shop.cancelDeadlineHours}時間前）まで変更・キャンセルができます。ブックマークしておくと便利です。</p>
          <div className="bk-url">{url}</div>
          <div className="row-wrap">
            <CopyButton text={url} label="URLをコピー" />
            <Link className="btn sm" href={`/booking/${a.manageToken}`}>予約内容を確認する</Link>
          </div>
        </div>
        <div className="center"><Link className="link" href={`/book/${a.shop.slug}`}>別のご予約をする</Link></div>
        <PublicFooter />
      </main>
    </>
  );
}
