import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { publicApi } from '../../../api/public';
import { reviewsApi } from '../../../api/reviews';
import { RatingBars, Stars } from '../../../components/forms/Stars';
import {
  ButtonLink,
  EmptyState,
  ErrorState,
  Icon,
  LoadMore,
  PageSpinner,
} from '../../../components/ui';
import { PublicShell, ShopHeader } from '../PublicShell';
import { PublicReviewItem } from './ReviewList';

/** /book/:shopSlug/reviews — public shop reviews */
export default function ShopReviews() {
  const { shopSlug = '' } = useParams();
  const shop = useQuery({
    queryKey: ['public', 'shop', shopSlug],
    queryFn: () => publicApi.shop(shopSlug),
    retry: false,
  });
  const q = useInfiniteQuery({
    queryKey: ['public', 'shop-reviews', shopSlug, 'list'],
    queryFn: ({ pageParam }) => reviewsApi.shopReviews(shopSlug, { cursor: pageParam, limit: 20 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    retry: false,
  });
  if (shop.isLoading || q.isLoading) return <PageSpinner />;
  if (shop.error || q.error) {
    return (
      <PublicShell>
        <ErrorState className="mt-10" error={shop.error ?? q.error} />
      </PublicShell>
    );
  }
  const summary = q.data?.pages[0]?.summary;
  const rows = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <PublicShell
      header={
        <ShopHeader
          name={shop.data!.shop.name}
          sub="口コミ"
          right={
            <Link
              to={`/book/${shopSlug}`}
              className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-[13px] font-medium text-primary hover:bg-primary-soft"
            >
              <Icon name="calendar" size={16} /> 予約する
            </Link>
          }
        />
      }
    >
      {summary && summary.count ? (
        <div className="mb-5 flex items-center gap-5 rounded-2xl border border-border bg-surface p-4">
          <div className="text-center">
            <p className="text-4xl font-semibold tabular">{summary.average?.toFixed(1)}</p>
            <Stars value={summary.average} />
            <p className="text-xs text-muted">{summary.count}件</p>
          </div>
          <div className="min-w-0 flex-1">
            <RatingBars distribution={summary.distribution} count={summary.count} />
          </div>
        </div>
      ) : null}
      {!rows.length ? <EmptyState icon="star" title="口コミはまだありません" /> : null}
      <ul className="space-y-3">
        {rows.map((r) => (
          <PublicReviewItem key={r.id} r={r} />
        ))}
      </ul>
      <LoadMore
        hasMore={!!q.hasNextPage}
        loading={q.isFetchingNextPage}
        onClick={() => void q.fetchNextPage()}
      />
      <ButtonLink to={`/book/${shopSlug}`} variant="primary" size="lg" className="mt-6 w-full">
        このお店を予約する
      </ButtonLink>
    </PublicShell>
  );
}
