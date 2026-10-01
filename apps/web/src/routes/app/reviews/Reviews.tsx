import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useStaffList } from '../../../api/org';
import {
  REQUEST_STATUS_LABEL,
  REVIEW_SOURCE_LABEL,
  REVIEW_STATUS_LABEL,
  reviewKeys,
  reviewsApi,
  useReviewSummary,
  useReviews,
  type Review,
  type ReviewQuery,
  type ReviewSource,
  type ReviewStatus,
} from '../../../api/reviews';
import { RatingBars, Stars } from '../../../components/forms/Stars';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  InlineLoading,
  LoadMore,
  PageHeader,
  Select,
  Stat,
  TabPanel,
  Tabs,
  Textarea,
  useToast,
} from '../../../components/ui';
import { errorMessage } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { formatDateTime } from '../../../lib/format';
import { ReviewRequestDialog } from './ReviewRequestDialog';

type Tab = 'reviews' | 'requests';

export default function Reviews() {
  const { can, shops, currentShopId } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('reviews');
  const [shopId, setShopId] = useState(currentShopId ?? '');
  const [staffId, setStaffId] = useState('');
  const [rating, setRating] = useState('');
  const [status, setStatus] = useState<ReviewStatus | ''>('');
  const [source, setSource] = useState<ReviewSource | ''>('');
  const [replied, setReplied] = useState<'' | 'true' | 'false'>('');
  const [requesting, setRequesting] = useState(false);
  const [importing, setImporting] = useState(false);
  const staff = useStaffList({ shopId: shopId || undefined });
  const manage = can('review.manage');
  const query: ReviewQuery = useMemo(
    () => ({
      shopId: shopId || undefined,
      staffId: staffId || undefined,
      rating: rating ? Number(rating) : undefined,
      status: status || undefined,
      source: source || undefined,
      replied: replied || undefined,
      limit: 30,
    }),
    [shopId, staffId, rating, status, source, replied],
  );
  const summary = useReviewSummary({ shopId: shopId || undefined, staffId: staffId || undefined });
  const q = useReviews(query);
  const rows = q.data?.pages.flatMap((p) => p.items) ?? [];

  const importGoogle = async () => {
    setImporting(true);
    try {
      const r = await reviewsApi.googleImport();
      if (!r.accounts)
        toast.info(
          'Google Business Profile の連携がありません',
          '外部連携の設定から接続してください',
        );
      else toast.success('Google口コミの取り込みを開始しました', `${r.queued}件の連携を処理します`);
      void qc.invalidateQueries({ queryKey: reviewKeys.all });
    } catch (e) {
      toast.error(e);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="口コミ"
        description="自社口コミ・Google口コミの管理と返信"
        actions={
          <>
            {manage || can('integration.manage') ? (
              <Button
                size="sm"
                icon="refresh"
                loading={importing}
                onClick={() => void importGoogle()}
              >
                Google口コミを取り込む
              </Button>
            ) : null}
            {manage || can('message.send') ? (
              <Button size="sm" variant="primary" icon="send" onClick={() => setRequesting(true)}>
                口コミ依頼を作成
              </Button>
            ) : null}
          </>
        }
      />

      <div className="mb-5 grid gap-4 md:grid-cols-[1fr_1.4fr]">
        <Card>
          {summary.isLoading ? <InlineLoading /> : null}
          {summary.data ? (
            <div className="flex items-center gap-5">
              <div className="text-center">
                <p className="text-4xl font-semibold tabular" data-testid="review-average">
                  {summary.data.average?.toFixed(2) ?? '—'}
                </p>
                <Stars value={summary.data.average} size={18} />
                <p className="mt-1 text-xs text-muted">公開 {summary.data.count}件</p>
              </div>
              <div className="min-w-0 flex-1">
                <RatingBars distribution={summary.data.distribution} count={summary.data.count} />
              </div>
            </div>
          ) : null}
        </Card>
        <Card>
          {summary.data ? (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat label="承認待ち" value={`${summary.data.pendingCount}件`} />
              <Stat label="未返信" value={`${summary.data.unrepliedCount}件`} />
              <Stat label="非表示" value={`${summary.data.hiddenCount}件`} />
              <Stat
                label="スタッフ評価"
                value={summary.data.staffRatingAverage?.toFixed(2) ?? '—'}
              />
            </div>
          ) : null}
        </Card>
      </div>

      <Tabs
        idBase="reviews"
        label="口コミ"
        value={tab}
        onChange={setTab}
        items={[
          { value: 'reviews', label: '口コミ一覧' },
          { value: 'requests', label: '依頼履歴', disabled: !(manage || can('message.send')) },
        ]}
      />
      <div className="pt-4">
        {tab === 'reviews' ? (
          <TabPanel idBase="reviews" value="reviews">
            <div
              className="mb-4 grid grid-cols-2 gap-3 rounded-2xl border border-border bg-surface p-4 md:grid-cols-6"
              role="search"
              aria-label="口コミの絞り込み"
            >
              <Field label="店舗">
                <Select value={shopId} onChange={(e) => setShopId(e.target.value)} selectSize="sm">
                  <option value="">すべて</option>
                  {shops.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="スタッフ">
                <Select
                  value={staffId}
                  onChange={(e) => setStaffId(e.target.value)}
                  selectSize="sm"
                >
                  <option value="">すべて</option>
                  {(staff.data ?? []).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.display_name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="評価">
                <Select value={rating} onChange={(e) => setRating(e.target.value)} selectSize="sm">
                  <option value="">すべて</option>
                  {[5, 4, 3, 2, 1].map((n) => (
                    <option key={n} value={n}>
                      ★{n}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="状態">
                <Select
                  value={status}
                  onChange={(e) => setStatus(e.target.value as ReviewStatus | '')}
                  selectSize="sm"
                >
                  <option value="">すべて</option>
                  {(Object.keys(REVIEW_STATUS_LABEL) as ReviewStatus[]).map((s) => (
                    <option key={s} value={s}>
                      {REVIEW_STATUS_LABEL[s]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="媒体">
                <Select
                  value={source}
                  onChange={(e) => setSource(e.target.value as ReviewSource | '')}
                  selectSize="sm"
                >
                  <option value="">すべて</option>
                  {(Object.keys(REVIEW_SOURCE_LABEL) as ReviewSource[]).map((s) => (
                    <option key={s} value={s}>
                      {REVIEW_SOURCE_LABEL[s]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="返信">
                <Select
                  value={replied}
                  onChange={(e) => setReplied(e.target.value as '' | 'true' | 'false')}
                  selectSize="sm"
                >
                  <option value="">すべて</option>
                  <option value="false">未返信</option>
                  <option value="true">返信済</option>
                </Select>
              </Field>
            </div>
            {q.isLoading ? <InlineLoading /> : null}
            {q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : null}
            {q.data && !rows.length ? (
              <EmptyState icon="star" title="該当する口コミはありません" />
            ) : null}
            <ul className="space-y-3" data-testid="review-list">
              {rows.map((r) => (
                <ReviewItem key={r.id} r={r} manage={manage} />
              ))}
            </ul>
            <LoadMore
              hasMore={!!q.hasNextPage}
              loading={q.isFetchingNextPage}
              onClick={() => void q.fetchNextPage()}
            />
          </TabPanel>
        ) : (
          <TabPanel idBase="reviews" value="requests">
            <RequestsList shopId={shopId || undefined} />
          </TabPanel>
        )}
      </div>
      {requesting ? <ReviewRequestDialog onClose={() => setRequesting(false)} /> : null}
    </div>
  );
}

function ReviewItem({ r, manage }: { r: Review; manage: boolean }) {
  const { timezone: tz } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [replying, setReplying] = useState(false);
  const [text, setText] = useState(r.reply_body ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: reviewKeys.all });

  const moderate = async (status: ReviewStatus) => {
    setBusy(status);
    try {
      await reviewsApi.moderate(r.id, status);
      toast.success(
        status === 'published'
          ? '公開しました'
          : status === 'hidden'
            ? '非表示にしました'
            : '承認待ちに戻しました',
      );
      void refresh();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  const reply = async () => {
    if (!text.trim()) return setError('返信を入力してください');
    setBusy('reply');
    setError(null);
    try {
      await reviewsApi.reply(r.id, text.trim());
      toast.success(
        r.source === 'google' ? '返信を保存しました（Googleへ反映します）' : '返信を保存しました',
      );
      setReplying(false);
      void refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <li className="rounded-2xl border border-border bg-surface p-4 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Stars value={r.rating} />
            <Badge size="sm" tone={r.source === 'google' ? 'info' : 'neutral'}>
              {REVIEW_SOURCE_LABEL[r.source]}
            </Badge>
            <Badge
              size="sm"
              tone={
                r.status === 'published'
                  ? 'success'
                  : r.status === 'pending'
                    ? 'warning'
                    : 'neutral'
              }
            >
              {REVIEW_STATUS_LABEL[r.status]}
            </Badge>
          </div>
          {r.title ? <p className="mt-1 text-sm font-semibold">{r.title}</p> : null}
        </div>
        <p className="text-xs text-muted">{formatDateTime(r.posted_at, tz)}</p>
      </div>
      {r.body ? (
        <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed">{r.body}</p>
      ) : null}
      <p className="mt-2 text-xs text-muted">
        {r.reviewer_name ?? '匿名'}
        {r.customer_name ? `（顧客: ${r.customer_name}）` : ''}
        {r.staff_name ? ` ・ 担当 ${r.staff_name}` : ''}
        {r.staff_rating ? ` ・ スタッフ評価 ★${r.staff_rating}` : ''}
      </p>
      {r.reply_body && !replying ? (
        <div className="mt-3 rounded-xl bg-surface-2 p-3 text-[13px]">
          <p className="mb-1 text-xs font-medium text-muted">
            お店からの返信 {r.replied_at ? `・ ${formatDateTime(r.replied_at, tz)}` : ''}
            {r.source === 'google'
              ? r.reply_synced_at
                ? ' ・ Google反映済'
                : r.reply_sync_error
                  ? ' ・ Google反映エラー'
                  : ' ・ Google反映待ち'
              : ''}
          </p>
          <p className="whitespace-pre-wrap">{r.reply_body}</p>
        </div>
      ) : null}
      {replying ? (
        <div className="mt-3 space-y-2">
          <Field label="返信" error={error}>
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={3}
              maxLength={4000}
              placeholder="ご来店ありがとうございました。…"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setReplying(false)}>
              キャンセル
            </Button>
            <Button
              size="sm"
              variant="primary"
              loading={busy === 'reply'}
              onClick={() => void reply()}
            >
              返信を保存
            </Button>
          </div>
        </div>
      ) : null}
      {manage && !replying ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="xs" icon="message" onClick={() => setReplying(true)}>
            {r.reply_body ? '返信を編集' : '返信する'}
          </Button>
          {r.status !== 'published' ? (
            <Button
              size="xs"
              variant="soft"
              loading={busy === 'published'}
              onClick={() => void moderate('published')}
            >
              公開する
            </Button>
          ) : null}
          {r.status !== 'hidden' ? (
            <Button
              size="xs"
              variant="ghost"
              loading={busy === 'hidden'}
              onClick={() => void moderate('hidden')}
            >
              非表示にする
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function RequestsList({ shopId }: { shopId?: string }) {
  const { timezone: tz } = useAuth();
  const q = useInfiniteQuery({
    queryKey: reviewKeys.requests({ shopId }),
    queryFn: ({ pageParam }) => reviewsApi.requests({ shopId, cursor: pageParam, limit: 50 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = q.data?.pages.flatMap((p) => p.items) ?? [];
  if (q.isLoading) return <InlineLoading />;
  if (q.error) return <ErrorState error={q.error} />;
  if (!rows.length) return <EmptyState icon="send" title="口コミ依頼はまだありません" />;
  return (
    <>
      <ul className="divide-y divide-border rounded-2xl border border-border bg-surface">
        {rows.map((r) => (
          <li key={r.id} className="flex items-center gap-3 px-4 py-3 text-[13px]">
            <span className="min-w-0 flex-1">
              <span className="font-medium">{r.customer_name || '—'}</span>
              {r.staff_name ? <span className="text-muted"> ・ 担当 {r.staff_name}</span> : null}
              <span className="block text-xs text-muted">
                発行 {formatDateTime(r.created_at, tz)}
                {r.expires_at ? ` ・ 期限 ${formatDateTime(r.expires_at, tz)}` : ''}
              </span>
            </span>
            <Badge
              size="sm"
              tone={
                r.status === 'submitted' ? 'success' : r.status === 'expired' ? 'neutral' : 'info'
              }
            >
              {REQUEST_STATUS_LABEL[r.status]}
            </Badge>
          </li>
        ))}
      </ul>
      <LoadMore
        hasMore={!!q.hasNextPage}
        loading={q.isFetchingNextPage}
        onClick={() => void q.fetchNextPage()}
      />
    </>
  );
}
