import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import {
  SOURCE_LABEL,
  appointmentKeys,
  appointmentsApi,
  useAppointments,
} from '../../api/appointments';
import { useStaffList } from '../../api/org';
import type { AppointmentListItem, AttentionItem } from '../../api/types';
import { AppointmentDrawer } from '../../components/appointments/AppointmentDrawer';
import { CreateAppointmentDrawer } from '../../components/appointments/CreateAppointmentDrawer';
import { StatusBadge } from '../../components/appointments/StatusBadge';
import {
  Badge,
  Button,
  ButtonLink,
  Card,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Icon,
  InlineLoading,
  useToast,
} from '../../components/ui';
import { newIdempotencyKey } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { cn } from '../../lib/cn';
import {
  formatDateJa,
  formatDateTime,
  formatRelativeDay,
  formatTime,
  formatYen,
} from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { todayIn, zonedParts } from '../../lib/time';
import { StartCheckoutButton } from './pos/StartCheckoutButton';
import { DashboardInsights } from './analytics/DashboardInsights';
import { ManualBlocksCard } from './integrations/MailTools';

export default function Dashboard() {
  const { me, currentShop, currentShopId: shopId, timezone: tz, can } = useAuth();
  const now = useNow(60_000);
  const today = todayIn(tz, now);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const createInitial = useMemo(() => ({ date: today }), [today]);
  const appts = useAppointments(
    { shopId: shopId ?? undefined, date: today },
    !!shopId && can('appointment.read'),
  );

  const hour = zonedParts(now, tz).hour;
  const greeting = hour < 11 ? 'おはようございます' : hour < 18 ? 'こんにちは' : 'お疲れさまです';

  const list = appts.data ?? [];
  const active = list.filter((a) => a.status !== 'cancelled' && a.status !== 'no_show');
  const stats = {
    total: active.length,
    done: active.filter((a) => a.status === 'completed').length,
    inStore: active.filter((a) => a.status === 'checked_in' || a.status === 'in_service').length,
    upcoming: active.filter(
      (a) => (a.status === 'confirmed' || a.status === 'tentative') && new Date(a.start_at) > now,
    ).length,
    newCustomers: active.filter((a) => a.is_new_customer).length,
    sales: active.reduce((s, a) => s + a.estimated_total, 0),
  };
  const next = active
    .filter((a) => new Date(a.start_at) > now && a.status !== 'completed')
    .sort((a, b) => a.start_at.localeCompare(b.start_at))[0];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[13px] text-muted">{formatDateJa(today, { year: true })}</p>
          <h1 className="mt-0.5 text-xl font-semibold tracking-tight sm:text-2xl">
            {greeting}、{me?.staff.display_name ?? ''}さん
          </h1>
          <p className="mt-1 text-[13px] text-muted">{currentShop?.name} の本日の状況です。</p>
        </div>
        <div className="flex gap-2">
          <ButtonLink to="/app/calendar" icon="calendar">
            カレンダー
          </ButtonLink>
          {can('appointment.write') && shopId ? (
            <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
              予約を追加
            </Button>
          ) : null}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="本日の予約"
          value={`${stats.total}件`}
          sub={`新規 ${stats.newCustomers}名`}
          icon="calendar"
        />
        <StatCard
          label="来店中"
          value={`${stats.inStore}名`}
          sub={`完了 ${stats.done}件`}
          icon="users"
          tone="info"
        />
        <StatCard
          label="これから"
          value={`${stats.upcoming}件`}
          sub={
            next
              ? `次: ${formatTime(next.start_at, tz)} ${next.customer_name || ''}`
              : '本日の予約はすべて対応済み'
          }
          icon="clock"
          tone="warning"
        />
        <StatCard
          label="見込み売上"
          value={formatYen(stats.sales)}
          sub="予約メニューの合計（税込）"
          icon="chart"
          tone="success"
        />
      </div>

      {shopId ? <ManualBlocksCard shopId={shopId} /> : null}

      <DashboardInsights />

      <div className="grid gap-6 xl:grid-cols-[1.6fr_1fr]">
        <Card padded={false} className="min-w-0">
          <div className="p-5 pb-3">
            <CardHeader
              className="mb-0"
              title="本日の予約"
              description={`${list.length}件（キャンセル含む）`}
              actions={
                <ButtonLink to={`/app/calendar?date=${today}`} size="sm" variant="ghost">
                  カレンダーで見る
                </ButtonLink>
              }
            />
          </div>
          {appts.isLoading ? (
            <div className="px-5">
              <InlineLoading />
            </div>
          ) : null}
          {appts.error ? (
            <div className="p-5">
              <ErrorState error={appts.error} onRetry={() => void appts.refetch()} />
            </div>
          ) : null}
          {appts.data && !list.length ? (
            <div className="p-5 pt-0">
              <EmptyState
                icon="calendar"
                title="本日の予約はありません"
                description="予約が入るとここに表示されます。"
              />
            </div>
          ) : null}
          {list.length ? (
            <ul className="divide-y divide-border border-t border-border">
              {list.map((a) => (
                <TodayRow key={a.id} a={a} tz={tz} now={now} onOpen={() => setOpenId(a.id)} />
              ))}
            </ul>
          ) : null}
        </Card>

        {shopId && can('appointment.read') ? (
          <AttentionCard shopId={shopId} tz={tz} onOpen={setOpenId} />
        ) : null}
      </div>

      <AppointmentDrawer id={openId} onClose={() => setOpenId(null)} tz={tz} />
      {shopId ? (
        <CreateAppointmentDrawer
          open={creating}
          onClose={() => setCreating(false)}
          shopId={shopId}
          tz={tz}
          initial={createInitial}
        />
      ) : null}
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  icon,
  tone = 'primary',
}: {
  label: string;
  value: string;
  sub?: string;
  icon: 'calendar' | 'users' | 'clock' | 'chart';
  tone?: 'primary' | 'info' | 'warning' | 'success';
}) {
  const toneCls = {
    primary: 'bg-primary-soft text-primary',
    info: 'bg-info-soft text-info',
    warning: 'bg-warning-soft text-warning',
    success: 'bg-success-soft text-success',
  }[tone];
  return (
    <Card className="!p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium text-muted">{label}</p>
        <span className={cn('flex h-8 w-8 items-center justify-center rounded-lg', toneCls)}>
          <Icon name={icon} size={16} />
        </span>
      </div>
      <p className="mt-1 text-2xl font-semibold tracking-tight tabular">{value}</p>
      {sub ? <p className="mt-0.5 truncate text-xs text-muted">{sub}</p> : null}
    </Card>
  );
}

function TodayRow({
  a,
  tz,
  now,
  onOpen,
}: {
  a: AppointmentListItem;
  tz: string;
  now: Date;
  onOpen: () => void;
}) {
  const past = new Date(a.end_at) < now;
  return (
    <li className="flex items-center hover:bg-surface-2/60">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-4 px-5 py-3 text-left"
      >
        <div className="w-14 shrink-0 text-right">
          <p className={cn('text-sm font-semibold tabular', past ? 'text-muted' : 'text-fg')}>
            {formatTime(a.start_at, tz)}
          </p>
          <p className="text-[11px] text-subtle tabular">{formatTime(a.end_at, tz)}</p>
        </div>
        <span
          className="h-9 w-1 shrink-0 rounded-full"
          style={{ background: a.staff_color ?? 'var(--subtle)' }}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <p
            className={cn(
              'truncate text-sm font-medium',
              (a.status === 'cancelled' || a.status === 'no_show') && 'text-muted line-through',
            )}
          >
            {a.customer_name || '顧客未登録'}
            {a.is_new_customer ? (
              <Badge size="sm" tone="info" className="ml-2">
                新規
              </Badge>
            ) : null}
          </p>
          <p className="truncate text-xs text-muted">
            {a.staff_name ?? '担当未定'}
            {a.is_nominated ? '（指名）' : ''} ・ {a.services.map((s) => s.name).join('・')}
          </p>
        </div>
        <div className="hidden text-right sm:block">
          <p className="text-[13px] tabular">{formatYen(a.estimated_total)}</p>
          <p className="text-[11px] text-subtle">{SOURCE_LABEL[a.source]}</p>
        </div>
        <StatusBadge status={a.status} size="sm" />
      </button>
      {['checked_in', 'in_service', 'completed'].includes(a.status) ? (
        <div className="shrink-0 pr-4">
          <StartCheckoutButton
            appointmentId={a.id}
            shopId={a.shop_id}
            status={a.status}
            size="xs"
            label="会計"
          />
        </div>
      ) : null}
    </li>
  );
}

function AttentionCard({
  shopId,
  tz,
  onOpen,
}: {
  shopId: string;
  tz: string;
  onOpen: (id: string) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const staff = useStaffList({ shopId });
  const q = useQuery({
    queryKey: appointmentKeys.attention(shopId),
    queryFn: () => appointmentsApi.attention(shopId),
    refetchInterval: 60_000,
  });
  const [noShow, setNoShow] = useState<AttentionItem | null>(null);
  // attention items carry only ids → resolve names from the detail endpoint lazily (cached)
  const ids = useMemo(
    () => [...(q.data?.tentative ?? []), ...(q.data?.noShowCandidates ?? [])].map((x) => x.id),
    [q.data],
  );
  const details = useQuery({
    queryKey: ['appointments', 'attention-details', ids],
    queryFn: async () =>
      Object.fromEntries(
        await Promise.all(ids.map(async (id) => [id, await appointmentsApi.get(id)] as const)),
      ),
    enabled: ids.length > 0 && ids.length <= 30,
  });

  const act = useMutation({
    mutationFn: ({
      id,
      action,
    }: {
      id: string;
      action: 'confirm' | 'no-show' | 'check-in' | 'cancel';
    }) => appointmentsApi.transition(id, action, {}, newIdempotencyKey()),
    onSuccess: (_d, v) => {
      void qc.invalidateQueries({ queryKey: appointmentKeys.all });
      toast.success(
        v.action === 'confirm'
          ? '予約を確定しました'
          : v.action === 'no-show'
            ? '無断キャンセルとして記録しました'
            : '更新しました',
      );
      setNoShow(null);
    },
    onError: (e) => toast.error(e),
  });

  const staffName = (id: string | null) =>
    staff.data?.find((s) => s.id === id)?.display_name ?? '担当未定';
  const name = (id: string) =>
    details.data?.[id]?.customer_name || (details.isLoading ? '…' : '顧客未登録');
  const writable = can('appointment.write');

  const Item = ({ item, kind }: { item: AttentionItem; kind: 'tentative' | 'noshow' }) => (
    <li className="flex items-center gap-3 px-5 py-3">
      <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onOpen(item.id)}>
        <p className="truncate text-sm font-medium hover:underline">{name(item.id)}</p>
        <p className="truncate text-xs text-muted">
          {formatDateTime(item.start_at, tz)}（{formatRelativeDay(item.start_at, tz)}）・{' '}
          {staffName(item.staff_id)} ・ {SOURCE_LABEL[item.source]}
        </p>
      </button>
      {writable ? (
        kind === 'tentative' ? (
          <Button
            size="sm"
            variant="primary"
            loading={act.isPending && act.variables?.id === item.id}
            onClick={() => act.mutate({ id: item.id, action: 'confirm' })}
          >
            承認
          </Button>
        ) : (
          <div className="flex gap-1.5">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => act.mutate({ id: item.id, action: 'check-in' })}
              disabled={act.isPending}
            >
              来店済み
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setNoShow(item)}
              disabled={act.isPending}
            >
              無断キャンセル
            </Button>
          </div>
        )
      ) : null}
    </li>
  );

  const tentative = q.data?.tentative ?? [];
  const overdue = q.data?.noShowCandidates ?? [];

  return (
    <Card padded={false} className="min-w-0">
      <div className="p-5 pb-3">
        <CardHeader
          className="mb-0"
          title="要対応"
          description="仮予約の承認と、開始時刻を過ぎても来店記録がない予約"
        />
      </div>
      {q.isLoading ? (
        <div className="px-5">
          <InlineLoading />
        </div>
      ) : null}
      {q.error ? (
        <div className="p-5">
          <ErrorState error={q.error} />
        </div>
      ) : null}
      {q.data ? (
        <div className="border-t border-border">
          <h3 className="flex items-center gap-2 bg-surface-2/60 px-5 py-2 text-xs font-semibold text-muted">
            仮予約の承認{' '}
            <Badge size="sm" tone={tentative.length ? 'warning' : 'neutral'}>
              {tentative.length}
            </Badge>
          </h3>
          {tentative.length ? (
            <ul className="divide-y divide-border">
              {tentative.map((t) => (
                <Item key={t.id} item={t} kind="tentative" />
              ))}
            </ul>
          ) : (
            <p className="px-5 py-3 text-[13px] text-muted">承認待ちの仮予約はありません</p>
          )}
          <h3 className="flex items-center gap-2 border-t border-border bg-surface-2/60 px-5 py-2 text-xs font-semibold text-muted">
            無断キャンセル候補{' '}
            <Badge size="sm" tone={overdue.length ? 'danger' : 'neutral'}>
              {overdue.length}
            </Badge>
          </h3>
          {overdue.length ? (
            <ul className="divide-y divide-border">
              {overdue.map((t) => (
                <Item key={t.id} item={t} kind="noshow" />
              ))}
            </ul>
          ) : (
            <p className="px-5 py-3 text-[13px] text-muted">該当する予約はありません</p>
          )}
        </div>
      ) : null}
      <div className="border-t border-border px-5 py-3 text-right">
        <Link to="/app/calendar" className="text-[13px] font-medium text-primary hover:underline">
          予約カレンダーを開く →
        </Link>
      </div>
      <ConfirmDialog
        open={!!noShow}
        onClose={() => setNoShow(null)}
        title="無断キャンセルとして記録しますか？"
        description={
          noShow ? `${name(noShow.id)} ・ ${formatDateTime(noShow.start_at, tz)}` : undefined
        }
        tone="danger"
        confirmLabel="無断キャンセルにする"
        loading={act.isPending}
        onConfirm={() => noShow && act.mutate({ id: noShow.id, action: 'no-show' })}
      />
    </Card>
  );
}
