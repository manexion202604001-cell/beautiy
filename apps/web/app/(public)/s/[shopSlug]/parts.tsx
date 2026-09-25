// Presentational pieces shared by the public shop & stylist profile pages.
import type { BusinessHour, Review } from '@salonos/db';
import { jaWeekday, minutesToHHMM, toLocalParts } from '@salonos/core';
import { Stars } from '@/components/ui';
import { fmtDate } from '@/lib/format';

export function ReviewList({ reviews, staffName, tz }: { reviews: Review[]; staffName?: Map<string, string>; tz: string }) {
  if (!reviews.length) return <p className="sub">まだ口コミはありません。</p>;
  return (
    <div>
      {reviews.map((r) => (
        <article key={r.id} className="review-item" style={{ padding: '12px 0' }}>
          <div className="row-wrap" style={{ gap: 8 }}>
            <Stars value={r.rating} />
            {r.title && <strong>{r.title}</strong>}
          </div>
          <div className="sub">{r.authorName}様 · {fmtDate(r.createdAt, tz)}{r.staffId && staffName?.get(r.staffId) ? ` · 担当 ${staffName.get(r.staffId)}` : ''}{r.source === 'GOOGLE' ? ' · Googleの口コミ' : ''}</div>
          {r.body && <p className="review-body">{r.body}</p>}
          {r.reply && <div className="review-reply"><div className="sub" style={{ marginBottom: 2 }}>サロンより</div>{r.reply}</div>}
        </article>
      ))}
    </div>
  );
}

export function HoursTable({ hours, tz }: { hours: BusinessHour[]; tz: string }) {
  const today = toLocalParts(new Date(), tz).weekday;
  const order = [1, 2, 3, 4, 5, 6, 0];
  const byDay = new Map(hours.map((h) => [h.weekday, h]));
  if (!hours.length) return <p className="sub">営業時間は店舗へお問い合わせください。</p>;
  return (
    <table className="pp-hours">
      <tbody>
        {order.map((d) => {
          const h = byDay.get(d);
          return (
            <tr key={d} className={d === today ? 'today' : ''}>
              <td style={{ width: 70 }}>{jaWeekday(d)}曜日{d === today ? '（本日）' : ''}</td>
              <td className="right">{!h || h.closed ? <span className="sub">定休日</span> : `${minutesToHHMM(h.openMin)} – ${minutesToHHMM(h.closeMin)}`}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function RatingInline({ average, total }: { average: number; total: number }) {
  if (!total) return null;
  return <span className="pp-rating"><Stars value={average} /> {average.toFixed(1)} <span style={{ opacity: .8, fontWeight: 500 }}>（{total}件）</span></span>;
}
