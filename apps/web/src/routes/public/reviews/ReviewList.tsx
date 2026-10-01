import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { reviewsApi, type PublicReview } from '../../../api/reviews';
import { Stars } from '../../../components/forms/Stars';
import { formatDate } from '../../../lib/format';

export function PublicReviewItem({ r }: { r: PublicReview }) {
  return (
    <li className="rounded-2xl border border-border bg-surface p-4">
      <div className="flex items-center justify-between gap-2">
        <Stars value={r.rating} size={14} />
        <span className="text-xs text-subtle">
          {formatDate(r.posted_at, 'Asia/Tokyo', { weekday: false })}
        </span>
      </div>
      {r.title ? <p className="mt-1.5 text-sm font-semibold">{r.title}</p> : null}
      {r.body ? (
        <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed">{r.body}</p>
      ) : null}
      <p className="mt-1.5 text-xs text-muted">
        {r.nickname} 様{r.staff_name ? ` ・ 担当 ${r.staff_name}` : ''}
        {r.source === 'google' ? ' ・ Google' : ''}
      </p>
      {r.reply_body ? (
        <div className="mt-2 rounded-xl bg-surface-2 p-3 text-[13px]">
          <p className="mb-0.5 text-xs font-medium text-muted">サロンより</p>
          <p className="whitespace-pre-wrap">{r.reply_body}</p>
        </div>
      ) : null}
    </li>
  );
}

/** Compact rating summary for the booking page header (links to the full list) */
export function ShopReviewsSummary({ slug }: { slug: string }) {
  const q = useQuery({
    queryKey: ['public', 'shop-reviews', slug, 'summary'],
    queryFn: () => reviewsApi.shopReviews(slug, { limit: 2 }),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const s = q.data?.summary;
  if (!s || !s.count) return null;
  return (
    <Link
      to={`/book/${slug}/reviews`}
      className="mb-4 flex items-center gap-3 rounded-2xl border border-border bg-surface px-4 py-3 hover:border-border-strong"
      data-testid="shop-review-summary"
    >
      <span className="text-2xl font-semibold tabular">{s.average?.toFixed(1)}</span>
      <span className="min-w-0 flex-1">
        <Stars value={s.average} size={14} />
        <span className="block text-xs text-muted">口コミ {s.count}件</span>
      </span>
      <span className="text-[13px] font-medium text-primary">口コミを見る ›</span>
    </Link>
  );
}
