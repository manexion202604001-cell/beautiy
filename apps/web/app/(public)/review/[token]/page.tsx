import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { CheckCircle2, Clock } from 'lucide-react';
import { reviewableAppointment } from '@/lib/server/reviews';
import { splitName } from '@/lib/server/customers';
import { Empty, Stars } from '@/components/ui';
import { fmtDateW } from '@/lib/format';
import { ReviewForm } from './ReviewForm';

export const metadata: Metadata = { title: '口コミを投稿', robots: { index: false, follow: false } };

export default async function ReviewPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const r = await reviewableAppointment(token);
  if (!r) notFound();
  const a = r.appointment;
  const tz = a.shop.timezone;
  const menu = a.menus.map((m) => m.name).join('・');

  return (
    <main className="public-body" style={{ paddingTop: 20 }}>
      <header style={{ marginBottom: 14 }}>
        <div className="sub">{a.shop.name}</div>
        <h1>ご来店の感想をお聞かせください</h1>
        <p className="sub" style={{ marginTop: 4 }}>{fmtDateW(a.startAt, tz)}{menu ? ` · ${menu}` : ''}{r.staffName ? ` · 担当 ${r.staffName}` : ''}</p>
      </header>
      {r.existing ? (
        <div className="card">
          <div className="row" style={{ marginBottom: 8 }}><CheckCircle2 size={22} color="var(--green)" /><h2>口コミは投稿済みです</h2></div>
          <p className="sub">このご来店の口コミはすでにいただいております。ありがとうございました。</p>
          <div className="review-item" style={{ padding: '10px 0 0' }}>
            <Stars value={r.existing.rating} /> {r.existing.title && <strong>{r.existing.title}</strong>}
            {r.existing.body && <p className="review-body">{r.existing.body}</p>}
            {r.existing.reply && <div className="review-reply"><div className="sub">サロンより</div>{r.existing.reply}</div>}
          </div>
          <a href={`/book/${a.shop.slug}`} className="btn block" style={{ marginTop: 14 }}>次回のご予約</a>
        </div>
      ) : a.status !== 'COMPLETED' ? (
        <div className="card"><Empty title="ご来店後に投稿いただけます" icon={<Clock size={20} />}>施術の完了後に、こちらのページから口コミを投稿いただけます。</Empty></div>
      ) : r.expired ? (
        <div className="card"><Empty title="投稿期限を過ぎています" icon={<Clock size={20} />}>口コミはご来店から90日以内にご投稿ください。</Empty></div>
      ) : (
        <ReviewForm token={token} defaultName={a.guestName ? splitName(a.guestName).lastName : ''} shopSlug={a.shop.slug} />
      )}
    </main>
  );
}
