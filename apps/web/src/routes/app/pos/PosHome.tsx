import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useAppointments } from '../../../api/appointments';
import { posApi, posKeys, useTransactions } from '../../../api/pos';
import { StatusBadge } from '../../../components/appointments/StatusBadge';
import {
  Button,
  ButtonLink,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  InlineLoading,
  LoadMore,
  PageHeader,
  Stat,
  useToast,
} from '../../../components/ui';
import { newIdempotencyKey } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { formatDateJa, formatTime, formatYen } from '../../../lib/format';
import { useStableKey } from '../../../lib/hooks';
import { todayIn } from '../../../lib/time';
import { RegisterCard } from './RegisterCard';
import { StartCheckoutButton } from './StartCheckoutButton';
import { TxStatusBadge } from './shared';

export default function PosHome() {
  const { currentShopId: shopId, timezone: tz, can } = useAuth();
  const today = todayIn(tz);
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const [key, regenerate] = useStableKey(newIdempotencyKey);
  const [creating, setCreating] = useState(false);
  const txs = useTransactions(
    { shopId: shopId ?? undefined, from: today, to: today, limit: 50 },
    !!shopId,
  );
  const appts = useAppointments(
    { shopId: shopId ?? undefined, date: today },
    !!shopId && can('appointment.read'),
  );
  const list = useMemo(() => txs.data?.pages.flatMap((p) => p.items) ?? [], [txs.data]);
  const billedAppointments = useMemo(
    () =>
      new Set(
        list.filter((t) => t.status !== 'voided' && t.appointment_id).map((t) => t.appointment_id!),
      ),
    [list],
  );
  const waiting = (appts.data ?? []).filter(
    (a) =>
      ['confirmed', 'checked_in', 'in_service', 'completed'].includes(a.status) &&
      !billedAppointments.has(a.id),
  );
  const sold = list.filter((t) =>
    ['completed', 'partially_refunded', 'refunded'].includes(t.status),
  );
  const sales = sold.reduce((s, t) => s + t.total - t.refunded_total, 0);

  const walkIn = async () => {
    if (!shopId) return;
    setCreating(true);
    try {
      const tx = await posApi.create({ shopId }, key);
      regenerate();
      void qc.invalidateQueries({ queryKey: posKeys.all });
      navigate(`/app/pos/checkout/${tx.id}`);
    } catch (e) {
      regenerate();
      toast.error(e);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="会計"
        description={formatDateJa(today, { year: true })}
        actions={
          <>
            <ButtonLink to="/app/pos/transactions" variant="secondary" size="sm" icon="list">
              会計履歴
            </ButtonLink>
            {can('sales.read') || can('sales.read_own') ? (
              <ButtonLink to="/app/pos/daily" variant="secondary" size="sm" icon="chart">
                日報
              </ButtonLink>
            ) : null}
            {can('pos.operate') ? (
              <Button
                variant="primary"
                size="sm"
                icon="plus"
                loading={creating}
                onClick={() => void walkIn()}
              >
                新規会計（予約なし）
              </Button>
            ) : null}
          </>
        }
      />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-5">
          <Card>
            <div className="grid grid-cols-3 gap-4">
              <Stat label="本日の売上" value={formatYen(sales)} sub="返金控除後" />
              <Stat label="会計件数" value={`${sold.length}件`} />
              <Stat label="会計中" value={`${list.filter((t) => t.status === 'draft').length}件`} />
            </div>
          </Card>

          {can('appointment.read') ? (
            <Card padded={false}>
              <div className="p-5 pb-3">
                <CardHeader
                  title="会計待ちの予約"
                  description="本日の来店・施術中の予約"
                  className="!mb-0"
                />
              </div>
              {appts.isLoading ? (
                <div className="px-5">
                  <InlineLoading />
                </div>
              ) : null}
              {appts.data && !waiting.length ? (
                <p className="px-5 pb-5 text-[13px] text-muted">会計待ちの予約はありません。</p>
              ) : null}
              {waiting.length ? (
                <ul className="divide-y divide-border border-t border-border">
                  {waiting.map((a) => (
                    <li key={a.id} className="flex items-center gap-3 px-5 py-3">
                      <span className="w-12 shrink-0 text-sm font-semibold tabular">
                        {formatTime(a.start_at, tz)}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          {a.customer_name || '顧客未登録'}
                        </p>
                        <p className="truncate text-xs text-muted">
                          {a.staff_name ?? '担当未定'} ・ {a.services.map((s) => s.name).join('・')}{' '}
                          ・ 目安 {formatYen(a.estimated_total)}
                        </p>
                      </div>
                      <StatusBadge status={a.status} size="sm" />
                      {shopId ? (
                        <StartCheckoutButton
                          appointmentId={a.id}
                          shopId={shopId}
                          status={a.status}
                        />
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </Card>
          ) : null}

          <Card padded={false}>
            <div className="p-5 pb-3">
              <CardHeader title="本日の会計" className="!mb-0" />
            </div>
            {txs.isLoading ? (
              <div className="px-5">
                <InlineLoading />
              </div>
            ) : null}
            {txs.error ? (
              <ErrorState error={txs.error} onRetry={() => void txs.refetch()} className="m-5" />
            ) : null}
            {txs.data && !list.length ? (
              <div className="p-5 pt-0">
                <EmptyState icon="receipt" title="本日の会計はまだありません" />
              </div>
            ) : null}
            {list.length ? (
              <ul className="divide-y divide-border border-t border-border">
                {list.map((t) => (
                  <li key={t.id}>
                    <Link
                      to={`/app/pos/checkout/${t.id}`}
                      className="flex items-center gap-3 px-5 py-3 hover:bg-surface-2/60"
                    >
                      <span className="w-12 shrink-0 text-sm tabular text-muted">
                        {formatTime(t.completed_at ?? t.created_at, tz)}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          {t.customer_name || 'お客様（未登録）'}
                        </p>
                        <p className="truncate text-xs text-muted">
                          {t.transaction_number ? `No.${t.transaction_number}` : '番号未発行'} ・{' '}
                          {t.staff_name ?? '担当なし'}
                        </p>
                      </div>
                      <span className="text-sm font-semibold tabular">{formatYen(t.total)}</span>
                      <TxStatusBadge status={t.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            ) : null}
            <LoadMore
              hasMore={!!txs.hasNextPage}
              loading={txs.isFetchingNextPage}
              onClick={() => void txs.fetchNextPage()}
            />
          </Card>
        </div>
        <div className="min-w-0">{shopId ? <RegisterCard shopId={shopId} /> : null}</div>
      </div>
    </div>
  );
}
