import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { publicApi } from '../../../api/public';
import { reviewsApi } from '../../../api/reviews';
import { sameOriginBlobUrl } from '../../../api/files';
import { RatingBars, Stars } from '../../../components/forms/Stars';
import {
  Badge,
  ButtonLink,
  EmptyState,
  ErrorState,
  Icon,
  PageSpinner,
} from '../../../components/ui';
import { formatYen } from '../../../lib/format';
import { PublicShell, ShopHeader } from '../PublicShell';
import { PublicReviewItem } from './ReviewList';

const SNS: { key: string; label: string; url: (v: string) => string }[] = [
  {
    key: 'instagram',
    label: 'Instagram',
    url: (v) => (v.startsWith('http') ? v : `https://www.instagram.com/${v.replace(/^@/, '')}`),
  },
  {
    key: 'tiktok',
    label: 'TikTok',
    url: (v) => (v.startsWith('http') ? v : `https://www.tiktok.com/@${v.replace(/^@/, '')}`),
  },
  { key: 'youtube', label: 'YouTube', url: (v) => v },
  {
    key: 'x',
    label: 'X',
    url: (v) => (v.startsWith('http') ? v : `https://x.com/${v.replace(/^@/, '')}`),
  },
];

/** /book/:shopSlug/staff/:staffId — public stylist profile + rating + reviews */
export default function StaffProfile() {
  const { shopSlug = '', staffId = '' } = useParams();
  const shop = useQuery({
    queryKey: ['public', 'shop', shopSlug],
    queryFn: () => publicApi.shop(shopSlug),
    retry: false,
  });
  const q = useQuery({
    queryKey: ['public', 'staff-profile', shopSlug, staffId],
    queryFn: () => reviewsApi.staffProfile(shopSlug, staffId),
    retry: false,
  });
  if (q.isLoading || shop.isLoading) return <PageSpinner />;
  if (q.error || !q.data) {
    return (
      <PublicShell>
        <ErrorState className="mt-10" error={q.error ?? new Error('スタッフが見つかりません')} />
      </PublicShell>
    );
  }
  const p = q.data;
  const prof = p.profile;
  const specialties = (Array.isArray(prof.specialties) ? prof.specialties : []) as string[];
  const styles = (Array.isArray(prof.styles) ? prof.styles : []) as string[];
  const qualifications = (
    Array.isArray(prof.qualifications) ? prof.qualifications : []
  ) as string[];
  return (
    <PublicShell
      header={
        <ShopHeader
          name={shop.data?.shop.name ?? ''}
          sub="スタイリスト紹介"
          right={
            <Link
              to={`/book/${shopSlug}`}
              className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-[13px] font-medium text-primary hover:bg-primary-soft"
            >
              <Icon name="chevron-left" size={16} /> 予約ページ
            </Link>
          }
        />
      }
    >
      <div className="flex items-center gap-4">
        {prof.photoUrl ? (
          <img
            src={sameOriginBlobUrl(prof.photoUrl)}
            alt={p.displayName}
            className="h-20 w-20 rounded-full object-cover"
          />
        ) : (
          <span
            className="flex h-20 w-20 items-center justify-center rounded-full bg-primary-soft text-2xl font-semibold text-primary"
            aria-hidden
          >
            {p.displayName.slice(0, 1)}
          </span>
        )}
        <div className="min-w-0">
          <h1 className="text-xl font-semibold">{p.displayName}</h1>
          {p.title ? <p className="text-[13px] text-muted">{p.title}</p> : null}
          <div className="mt-1 flex items-center gap-2">
            <Stars value={p.rating.average} size={14} />
            <span className="text-xs text-muted">
              {p.rating.average?.toFixed(1) ?? '—'}（{p.rating.count}件）
            </span>
          </div>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-1.5">
        {typeof prof.yearsOfExperience === 'number' ? (
          <Badge>経験 {prof.yearsOfExperience}年</Badge>
        ) : null}
        <Badge tone="primary">
          {p.nominationFee ? `指名料 ${formatYen(p.nominationFee)}` : '指名料なし'}
        </Badge>
      </div>
      {prof.bio || prof.message ? (
        <section className="mt-5 rounded-2xl border border-border bg-surface p-4">
          {prof.bio ? (
            <p className="whitespace-pre-wrap text-[13px] leading-relaxed">{String(prof.bio)}</p>
          ) : null}
          {prof.message ? (
            <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-muted">
              {String(prof.message)}
            </p>
          ) : null}
        </section>
      ) : null}
      {specialties.length || styles.length || qualifications.length ? (
        <section className="mt-4 space-y-2">
          {[
            ['得意な技術', specialties],
            ['得意なスタイル', styles],
            ['資格', qualifications],
          ].map(([label, list]) =>
            (list as string[]).length ? (
              <div key={label as string}>
                <p className="mb-1 text-xs font-semibold text-muted">{label as string}</p>
                <div className="flex flex-wrap gap-1.5">
                  {(list as string[]).map((s) => (
                    <Badge key={s}>{s}</Badge>
                  ))}
                </div>
              </div>
            ) : null,
          )}
        </section>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2">
        {SNS.filter((s) => typeof prof[s.key] === 'string' && prof[s.key]).map((s) => (
          <a
            key={s.key}
            href={s.url(String(prof[s.key]))}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-full border border-border px-3 py-1 text-xs hover:bg-surface-2"
          >
            {s.label} <Icon name="external" size={12} />
          </a>
        ))}
      </div>
      {p.bookable ? (
        <ButtonLink
          to={`/book/${shopSlug}?staff=${p.id}`}
          variant="primary"
          size="lg"
          className="mt-5 w-full"
        >
          {p.displayName}を指名して予約
        </ButtonLink>
      ) : null}
      <section className="mt-6">
        <h2 className="mb-2 text-sm font-semibold">口コミ</h2>
        {p.rating.count ? (
          <div className="mb-3 rounded-2xl border border-border bg-surface p-4">
            <RatingBars distribution={p.rating.distribution} count={p.rating.count} />
          </div>
        ) : null}
        {!p.recentReviews.length ? <EmptyState icon="star" title="口コミはまだありません" /> : null}
        <ul className="space-y-3">
          {p.recentReviews.map((r) => (
            <PublicReviewItem key={r.id} r={r} />
          ))}
        </ul>
      </section>
    </PublicShell>
  );
}
