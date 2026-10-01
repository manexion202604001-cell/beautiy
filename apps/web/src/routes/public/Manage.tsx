import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router';
import { publicApi } from '../../api/public';
import type { PublicAppointment } from '../../api/types';
import { StatusBadge } from '../../components/appointments/StatusBadge';
import {
  Alert,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  PageSpinner,
  useToast,
} from '../../components/ui';
import { isApiError } from '../../lib/api';
import {
  formatDateJa,
  formatDateTime,
  formatDuration,
  formatTime,
  formatYen,
} from '../../lib/format';
import { downloadIcs } from '../../lib/ics';
import { DEFAULT_TZ, zonedParts } from '../../lib/time';
import { PublicShell, ShopHeader } from './PublicShell';

/** Guest booking management via the signed link in the confirmation (/b/manage/:token) */
export default function Manage() {
  const { token = '' } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: ['public', 'booking', token],
    queryFn: () => publicApi.booking(token),
    retry: false,
  });
  const [confirm, setConfirm] = useState(false);
  const cancel = useMutation({
    mutationFn: (reason?: string) => publicApi.cancelBooking(token, reason),
    onSuccess: (a) => {
      qc.setQueryData(['public', 'booking', token], a);
      toast.success('ご予約をキャンセルしました');
      setConfirm(false);
    },
    onError: (e) => {
      toast.error(e);
      setConfirm(false);
      void q.refetch();
    },
  });

  if (q.isLoading) return <PageSpinner />;
  if (q.error) {
    return (
      <PublicShell>
        {isApiError(q.error) && (q.error.status === 401 || q.error.status === 404) ? (
          <EmptyState
            className="mt-10"
            icon="lock"
            title="リンクが無効か、有効期限が切れています"
            description="お手数ですが、店舗へ直接お問い合わせください。"
          />
        ) : (
          <ErrorState className="mt-10" error={q.error} onRetry={() => void q.refetch()} />
        )}
      </PublicShell>
    );
  }
  const a = q.data as PublicAppointment;
  const tz = DEFAULT_TZ; // public booking payload has no shop timezone (see README: API gaps)
  const active = a.status === 'tentative' || a.status === 'confirmed';

  return (
    <PublicShell header={<ShopHeader name={a.shopName} sub="ご予約の確認" />}>
      <div className="space-y-4">
        <div className="overflow-hidden rounded-2xl border border-border bg-surface">
          <div className="flex items-start justify-between gap-3 bg-primary-soft/60 px-4 py-3">
            <div>
              <p className="text-xs text-muted">予約番号 {a.bookingReference}</p>
              <p className="text-lg font-semibold">
                {formatDateJa(zonedParts(a.startAt, tz).date, { year: true })}{' '}
                {formatTime(a.startAt, tz)}〜
              </p>
            </div>
            <StatusBadge status={a.status} />
          </div>
          <dl className="divide-y divide-border text-[13px]">
            <div className="flex justify-between gap-4 px-4 py-3">
              <dt className="text-muted">担当</dt>
              <dd className="text-right">
                {a.staffName ? `${a.staffName}${a.isNominated ? '（指名）' : ''}` : '当日決定'}
              </dd>
            </div>
            <div className="px-4 py-3">
              <dt className="mb-1 text-muted">メニュー</dt>
              {a.services.map((s, i) => (
                <dd key={i} className="flex justify-between gap-4">
                  <span>
                    {s.name}{' '}
                    <span className="text-xs text-muted">({formatDuration(s.durationMin)})</span>
                  </span>
                  <span className="tabular">{formatYen(s.price)}</span>
                </dd>
              ))}
            </div>
            <div className="flex justify-between gap-4 px-4 py-3">
              <dt className="text-muted">お支払い目安</dt>
              <dd className="font-semibold tabular">{formatYen(a.estimatedTotal)}</dd>
            </div>
            {a.customerNote ? (
              <div className="px-4 py-3">
                <dt className="text-muted">ご要望</dt>
                <dd className="mt-0.5 whitespace-pre-wrap">{a.customerNote}</dd>
              </div>
            ) : null}
          </dl>
        </div>

        {a.status === 'cancelled' ? (
          <Alert tone="info" title="このご予約はキャンセル済みです">
            またのご利用をお待ちしております。
          </Alert>
        ) : null}
        {a.status === 'tentative' ? (
          <Alert tone="warning" title="店舗の確認待ちです">
            確定しましたらご連絡いたします。
          </Alert>
        ) : null}

        {active ? (
          <div className="space-y-2.5">
            <Button
              variant="secondary"
              size="lg"
              className="w-full"
              icon="calendar"
              onClick={() =>
                downloadIcs(
                  {
                    uid: `${a.id}@salon-os`,
                    start: a.startAt,
                    end: a.endAt,
                    summary: `${a.shopName} ご予約`,
                    description: `予約番号: ${a.bookingReference}`,
                    url: window.location.href,
                  },
                  `reservation-${a.bookingReference}.ics`,
                )
              }
            >
              カレンダーに追加
            </Button>
            {a.canModify ? (
              <>
                <Button
                  variant="outline"
                  size="lg"
                  className="w-full !text-danger"
                  onClick={() => setConfirm(true)}
                >
                  予約をキャンセルする
                </Button>
                <p className="text-center text-xs text-muted">
                  キャンセル・変更は {formatDateTime(a.cancelDeadline, tz)} まで可能です。
                </p>
              </>
            ) : (
              <Alert tone="warning" title="オンラインでのキャンセル期限を過ぎています">
                変更・キャンセルは店舗へ直接お電話ください（期限:{' '}
                {formatDateTime(a.cancelDeadline, tz)}）。
              </Alert>
            )}
          </div>
        ) : null}
      </div>
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="ご予約をキャンセルしますか？"
        description={`${formatDateJa(zonedParts(a.startAt, tz).date)} ${formatTime(a.startAt, tz)}〜 のご予約をキャンセルします。`}
        tone="danger"
        confirmLabel="キャンセルする"
        cancelLabel="戻る"
        reason
        reasonLabel="キャンセル理由（任意）"
        loading={cancel.isPending}
        onConfirm={(reason) => cancel.mutate(reason)}
      />
    </PublicShell>
  );
}
