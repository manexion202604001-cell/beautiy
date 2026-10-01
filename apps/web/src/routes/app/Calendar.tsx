import { useMemo, useState, type CSSProperties, type MouseEvent } from 'react';
import { useSearchParams } from 'react-router';
import { SOURCE_LABEL, useAppointments } from '../../api/appointments';
import { useStaffList } from '../../api/org';
import { useBlocks, useStaffSchedule } from '../../api/schedules';
import type { AppointmentListItem, Range, ScheduleBlock, Staff } from '../../api/types';
import { AppointmentDrawer } from '../../components/appointments/AppointmentDrawer';
import {
  CreateAppointmentDrawer,
  type CreateInitial,
} from '../../components/appointments/CreateAppointmentDrawer';
import { StatusBadge } from '../../components/appointments/StatusBadge';
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Checkbox,
  DateNav,
  EmptyState,
  ErrorState,
  InlineLoading,
  Segmented,
} from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { cn } from '../../lib/cn';
import { WEEKDAYS_JA, formatDateJa, formatTime, formatYen } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import {
  addDays,
  dateRange,
  minutesToHhmm,
  startOfWeek,
  todayIn,
  weekdayOf,
  zonedParts,
  zonedToIso,
} from '../../lib/time';

const PX_PER_MIN = 1.1; // 66px per hour
const SNAP = 15;
const HIDDEN_STATUSES = new Set(['cancelled', 'no_show']);

type View = 'day' | 'week';

export default function CalendarPage() {
  const { currentShopId: shopId, timezone: tz, can } = useAuth();
  const [params, setParams] = useSearchParams();
  const today = todayIn(tz);
  const date = params.get('date') ?? today;
  const view: View = params.get('view') === 'week' ? 'week' : 'day';
  const openId = params.get('appt');
  const [showCancelled, setShowCancelled] = useState(false);
  const [createInitial, setCreateInitial] = useState<CreateInitial | null>(null);

  const setParam = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: true });
  };

  if (!shopId) return <InlineLoading />;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="sr-only">予約カレンダー</h1>
          <DateNav
            value={view === 'week' ? startOfWeek(date) : date}
            today={view === 'week' ? startOfWeek(today) : today}
            step={view === 'week' ? 7 : 1}
            onChange={(d) => setParam({ date: d })}
            label={
              view === 'week'
                ? `${formatDateJa(startOfWeek(date))} 〜 ${formatDateJa(addDays(startOfWeek(date), 6))}`
                : undefined
            }
          />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Checkbox
            label="キャンセルを表示"
            checked={showCancelled}
            onChange={(e) => setShowCancelled(e.target.checked)}
          />
          <Segmented
            label="表示切替"
            value={view}
            onChange={(v) => setParam({ view: v === 'day' ? null : v })}
            options={[
              { value: 'day', label: '日' },
              { value: 'week', label: '週' },
            ]}
          />
          {can('appointment.write') ? (
            <Button variant="primary" icon="plus" onClick={() => setCreateInitial({ date })}>
              予約を追加
            </Button>
          ) : null}
        </div>
      </div>

      {view === 'day' ? (
        <DayView
          shopId={shopId}
          date={date}
          tz={tz}
          showCancelled={showCancelled}
          canCreate={can('appointment.write')}
          onOpen={(id) => setParam({ appt: id })}
          onCreate={(initial) => setCreateInitial(initial)}
        />
      ) : (
        <WeekView
          shopId={shopId}
          date={date}
          tz={tz}
          showCancelled={showCancelled}
          onOpen={(id) => setParam({ appt: id })}
          onPickDay={(d) => setParam({ date: d, view: null })}
        />
      )}

      <AppointmentDrawer id={openId} onClose={() => setParam({ appt: null })} tz={tz} />
      <CreateAppointmentDrawer
        open={!!createInitial}
        initial={createInitial ?? undefined}
        onClose={() => setCreateInitial(null)}
        shopId={shopId}
        tz={tz}
        onCreated={(a) => setParam({ date: zonedParts(a.start_at, tz).date })}
      />
    </div>
  );
}

// ------------------------------------------------------------------ day view

interface Lane {
  appt: AppointmentListItem;
  lane: number;
  lanes: number;
}

/** Assign overlapping appointments in one column to side-by-side lanes */
function layoutLanes(items: AppointmentListItem[]): Lane[] {
  const sorted = [...items].sort((a, b) => a.start_at.localeCompare(b.start_at));
  const out: Lane[] = [];
  let cluster: Lane[] = [];
  let clusterEnd = '';
  const flush = () => {
    const lanes = Math.max(1, ...cluster.map((c) => c.lane + 1));
    cluster.forEach((c) => (c.lanes = lanes));
    out.push(...cluster);
    cluster = [];
  };
  for (const appt of sorted) {
    if (cluster.length && appt.start_at >= clusterEnd) flush();
    const used = new Set(cluster.filter((c) => c.appt.end_at > appt.start_at).map((c) => c.lane));
    let lane = 0;
    while (used.has(lane)) lane++;
    cluster.push({ appt, lane, lanes: 1 });
    if (appt.end_at > clusterEnd) clusterEnd = appt.end_at;
  }
  if (cluster.length) flush();
  return out;
}

function minutesOf(iso: string, tz: string, date: string) {
  const p = zonedParts(iso, tz);
  // appointments crossing midnight: clamp to the visible day
  if (p.date < date) return 0;
  if (p.date > date) return 24 * 60;
  return p.minutes;
}

function DayView({
  shopId,
  date,
  tz,
  showCancelled,
  canCreate,
  onOpen,
  onCreate,
}: {
  shopId: string;
  date: string;
  tz: string;
  showCancelled: boolean;
  canCreate: boolean;
  onOpen: (id: string) => void;
  onCreate: (initial: CreateInitial) => void;
}) {
  const staffQ = useStaffList({ shopId, bookableOnly: true });
  const scheduleQ = useStaffSchedule(shopId, date);
  const apptsQ = useAppointments({ shopId, date });
  const dayStart = zonedToIso(date, '00:00', tz);
  const dayEnd = zonedToIso(addDays(date, 1), '00:00', tz);
  const blocksQ = useBlocks(shopId, dayStart, dayEnd);
  const now = useNow(60_000);
  const isToday = todayIn(tz, now) === date;

  const appts = useMemo(
    () => (apptsQ.data ?? []).filter((a) => showCancelled || !HIDDEN_STATUSES.has(a.status)),
    [apptsQ.data, showCancelled],
  );
  // invited staff cannot take bookings yet (API candidateStaff requires status=active)
  const staff = useMemo(
    () => (staffQ.data ?? []).filter((s) => s.status === 'active'),
    [staffQ.data],
  );

  // columns: bookable staff + anyone else who has an appointment that day
  const columns = useMemo(() => {
    const cols: { id: string; name: string; color: string; staff?: Staff }[] = staff.map((s) => ({
      id: s.id,
      name: s.display_name,
      color: s.color,
      staff: s,
    }));
    const extra = new Map<string, { id: string; name: string; color: string }>();
    for (const a of appts) {
      const sid = a.staff_id ?? 'unassigned';
      if (!cols.some((c) => c.id === sid) && !extra.has(sid))
        extra.set(sid, {
          id: sid,
          name: a.staff_name ?? '担当未定',
          color: a.staff_color ?? '#94a3b8',
        });
    }
    return [...cols, ...extra.values()];
  }, [staff, appts]);

  const openRanges = useMemo(() => scheduleQ.data?.shopOpen ?? [], [scheduleQ.data]);
  const closedDay = scheduleQ.data && openRanges.length === 0;

  // visible time window: business hours ∪ appointments, padded to whole hours
  const [startMin, endMin] = useMemo(() => {
    let s = 10 * 60;
    let e = 20 * 60;
    if (openRanges.length) {
      s = Math.min(...openRanges.map((r) => minutesOf(r.start, tz, date)));
      e = Math.max(...openRanges.map((r) => minutesOf(r.end, tz, date)));
    }
    for (const a of appts) {
      s = Math.min(s, minutesOf(a.start_at, tz, date));
      e = Math.max(e, minutesOf(a.end_at, tz, date));
    }
    s = Math.max(0, Math.floor(s / 60) * 60 - 60);
    e = Math.min(24 * 60, Math.ceil(e / 60) * 60 + 60);
    return [s, e];
  }, [openRanges, appts, tz, date]);

  const height = (endMin - startMin) * PX_PER_MIN;
  const hours: number[] = [];
  for (let m = startMin; m < endMin; m += 60) hours.push(m);

  const workingFor = (staffId: string): Range[] =>
    scheduleQ.data?.staff.find((s) => s.staffId === staffId)?.working ??
    (scheduleQ.data ? [] : openRanges);

  const top = (iso: string) => (minutesOf(iso, tz, date) - startMin) * PX_PER_MIN;

  /** hour buttons: precise 15-min snapping for pointer clicks, the hour itself for keyboard */
  const onHourClick = (e: MouseEvent<HTMLButtonElement>, staffId: string, hourStart: number) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.detail === 0 ? 0 : e.clientY - rect.top;
    const minute = hourStart + Math.floor(y / PX_PER_MIN / SNAP) * SNAP;
    onCreate({
      staffId: staffId === 'unassigned' ? null : staffId,
      date,
      time: minutesToHhmm(Math.max(0, Math.min(minute, 24 * 60 - SNAP))),
    });
  };

  if (staffQ.error)
    return <ErrorState error={staffQ.error} onRetry={() => void staffQ.refetch()} />;
  if (apptsQ.error)
    return <ErrorState error={apptsQ.error} onRetry={() => void apptsQ.refetch()} />;
  if (staffQ.isLoading || apptsQ.isLoading) return <InlineLoading />;

  if (!columns.length) {
    return (
      <EmptyState
        icon="user"
        title="予約を受け付けるスタッフがいません"
        description="スタッフ画面で「予約受付可」のスタッフをこの店舗に所属させてください。"
      />
    );
  }

  const activeCount = (apptsQ.data ?? []).filter((a) => !HIDDEN_STATUSES.has(a.status)).length;
  const salesForecast = (apptsQ.data ?? [])
    .filter((a) => !HIDDEN_STATUSES.has(a.status))
    .reduce((s, a) => s + a.estimated_total, 0);
  const nowTop = isToday ? (zonedParts(now, tz).minutes - startMin) * PX_PER_MIN : -1;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px] text-muted">
        <span>
          {formatDateJa(date, { year: true })}
          {isToday ? (
            <Badge tone="primary" size="sm" className="ml-2">
              今日
            </Badge>
          ) : null}
        </span>
        <span>
          予約 <span className="font-semibold text-fg tabular">{activeCount}</span> 件
        </span>
        <span>
          見込み売上{' '}
          <span className="font-semibold text-fg tabular">{formatYen(salesForecast)}</span>
        </span>
      </div>
      {closedDay ? (
        <Alert tone="warning" title="この日は休業日です">
          営業時間外の予約は「時間外予約を許可」をオンにすると登録できます。
        </Alert>
      ) : null}

      <div
        className="scrollbar-thin overflow-auto rounded-2xl border border-border bg-surface"
        style={{ maxHeight: 'calc(100vh - 230px)' }}
        data-testid="calendar-grid"
      >
        <div
          className="grid min-w-fit"
          style={{ gridTemplateColumns: `56px repeat(${columns.length}, minmax(150px, 1fr))` }}
        >
          {/* header row */}
          <div className="sticky left-0 top-0 z-30 border-b border-r border-border bg-surface" />
          {columns.map((c) => {
            const count = appts.filter(
              (a) => (a.staff_id ?? 'unassigned') === c.id && !HIDDEN_STATUSES.has(a.status),
            ).length;
            const working = workingFor(c.id);
            return (
              <div
                key={c.id}
                className="sticky top-0 z-20 flex items-center gap-2 border-b border-r border-border bg-surface px-3 py-2 last:border-r-0"
              >
                <Avatar name={c.name} color={c.color} size={28} />
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-semibold text-fg">{c.name}</p>
                  <p className="truncate text-[11px] text-muted">
                    {working.length
                      ? working
                          .map((r) => `${formatTime(r.start, tz)}-${formatTime(r.end, tz)}`)
                          .join(', ')
                      : '休み'}{' '}
                    ・ {count}件
                  </p>
                </div>
              </div>
            );
          })}

          {/* time axis */}
          <div className="sticky left-0 z-10 border-r border-border bg-surface" style={{ height }}>
            {hours.map((m) => (
              <div
                key={m}
                className="absolute right-2 -translate-y-1/2 text-[11px] text-muted tabular"
                style={{ top: (m - startMin) * PX_PER_MIN + (m === startMin ? 8 : 0) }}
              >
                {minutesToHhmm(m)}
              </div>
            ))}
          </div>

          {/* staff columns */}
          {columns.map((c) => {
            const working = workingFor(c.id);
            const lanes = layoutLanes(appts.filter((a) => (a.staff_id ?? 'unassigned') === c.id));
            const blocks = (blocksQ.data ?? []).filter((b) => b.staff_id === c.id);
            return (
              <div
                key={c.id}
                className="bg-closed relative border-r border-border last:border-r-0"
                style={{ height }}
                data-staff-column={c.id}
              >
                {/* working hours (white) */}
                {working.map((r, i) => (
                  <div
                    key={i}
                    className="absolute inset-x-0 bg-surface"
                    style={{ top: top(r.start), height: Math.max(0, top(r.end) - top(r.start)) }}
                    aria-hidden
                  />
                ))}
                {/* grid lines */}
                <div
                  className="pointer-events-none absolute inset-0"
                  aria-hidden
                  style={{
                    backgroundImage: `repeating-linear-gradient(to bottom, var(--border) 0 1px, transparent 1px ${60 * PX_PER_MIN}px), repeating-linear-gradient(to bottom, var(--grid-line) 0 1px, transparent 1px ${15 * PX_PER_MIN}px)`,
                  }}
                />
                {/* keyboard access: one button per hour */}
                {canCreate
                  ? hours.map((m) => (
                      <button
                        key={m}
                        type="button"
                        className="group absolute inset-x-0 flex cursor-cell items-start justify-end p-1 focus-visible:z-[4]"
                        style={{ top: (m - startMin) * PX_PER_MIN, height: 60 * PX_PER_MIN }}
                        aria-label={`${c.name} ${minutesToHhmm(m)} に予約を追加`}
                        onClick={(e) => onHourClick(e, c.id, m)}
                      >
                        <span className="pointer-events-none rounded bg-primary px-1.5 py-0.5 text-[11px] font-medium text-primary-fg opacity-0 group-hover:opacity-90 group-focus-visible:opacity-100">
                          ＋ 予約
                        </span>
                      </button>
                    ))
                  : null}
                {blocks.map((b) => (
                  <BlockView
                    key={b.id}
                    block={b}
                    top={top(b.start_at)}
                    height={top(b.end_at) - top(b.start_at)}
                  />
                ))}
                {lanes.map(({ appt, lane, lanes: n }) => (
                  <ApptBlock
                    key={appt.id}
                    a={appt}
                    tz={tz}
                    style={{
                      top: top(appt.start_at) + 1,
                      height: Math.max(22, top(appt.end_at) - top(appt.start_at) - 2),
                      left: `calc(${(lane / n) * 100}% + 3px)`,
                      width: `calc(${100 / n}% - 6px)`,
                    }}
                    onOpen={() => onOpen(appt.id)}
                  />
                ))}
                {nowTop >= 0 && nowTop <= height ? (
                  <div
                    className="pointer-events-none absolute inset-x-0 z-[5] border-t-2 border-danger"
                    style={{ top: nowTop }}
                    aria-hidden
                  >
                    <span className="absolute -left-1 -top-[5px] h-2 w-2 rounded-full bg-danger" />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
      <Legend />
    </div>
  );
}

function BlockView({ block, top, height }: { block: ScheduleBlock; top: number; height: number }) {
  return (
    <div
      className="absolute inset-x-1 z-[1] overflow-hidden rounded-md border border-dashed border-border-strong bg-surface-3/80 px-2 py-1 text-[11px] text-muted"
      style={{ top, height: Math.max(18, height) }}
      title={block.reason ?? 'ブロック'}
    >
      {block.reason ?? 'ブロック'}
    </div>
  );
}

function ApptBlock({
  a,
  tz,
  style,
  onOpen,
}: {
  a: AppointmentListItem;
  tz: string;
  style: CSSProperties;
  onOpen: () => void;
}) {
  const color = a.staff_color ?? '#64748b';
  const faded = a.status === 'cancelled' || a.status === 'no_show';
  const done = a.status === 'completed';
  const active = a.status === 'checked_in' || a.status === 'in_service';
  const tentative = a.status === 'tentative';
  const h = typeof style.height === 'number' ? style.height : 60;
  return (
    <button
      type="button"
      data-appt
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      className={cn(
        'absolute z-[2] flex flex-col items-stretch justify-start overflow-hidden rounded-lg border px-2 py-1 text-left text-[12px] leading-tight shadow-sm transition-shadow hover:z-[3] hover:shadow-md',
        tentative && 'border-dashed',
        faded && 'opacity-55',
        done && 'opacity-75',
      )}
      style={{
        ...style,
        borderColor: tentative ? color : `color-mix(in srgb, ${color} 45%, transparent)`,
        borderLeftWidth: 4,
        borderLeftColor: color,
        background: active
          ? `color-mix(in srgb, ${color} 26%, var(--surface))`
          : `color-mix(in srgb, ${color} 12%, var(--surface))`,
      }}
      aria-label={`${formatTime(a.start_at, tz)}〜${formatTime(a.end_at, tz)} ${a.customer_name || '顧客未登録'} ${a.services.map((s) => s.name).join('・')}`}
    >
      <div className="flex items-center gap-1">
        <span className="font-semibold tabular text-fg">{formatTime(a.start_at, tz)}</span>
        {a.status !== 'confirmed' ? <StatusBadge status={a.status} size="sm" /> : null}
        {a.is_new_customer ? (
          <Badge size="sm" tone="info">
            新規
          </Badge>
        ) : null}
      </div>
      <p className={cn('mt-0.5 truncate font-medium text-fg', faded && 'line-through')}>
        {a.customer_name || '顧客未登録'}
      </p>
      {h > 48 ? (
        <p className="truncate text-[11px] text-muted">
          {a.services.map((s) => s.name).join('・')}
        </p>
      ) : null}
      {h > 70 ? (
        <p className="mt-0.5 truncate text-[11px] text-subtle">
          {a.is_nominated ? '指名' : 'フリー'} ・ {SOURCE_LABEL[a.source] ?? a.source}
        </p>
      ) : null}
    </button>
  );
}

function Legend() {
  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted"
      aria-label="凡例"
    >
      <span className="inline-flex items-center gap-1.5">
        <span className="h-3 w-5 rounded border border-dashed border-primary" aria-hidden /> 仮予約
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="bg-closed h-3 w-5 rounded border border-border" aria-hidden /> 勤務時間外
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="h-0.5 w-5 bg-danger" aria-hidden /> 現在時刻
      </span>
      <span>空いている時間をクリックすると予約を作成できます</span>
    </div>
  );
}

// ------------------------------------------------------------------ week view

function WeekView({
  shopId,
  date,
  tz,
  showCancelled,
  onOpen,
  onPickDay,
}: {
  shopId: string;
  date: string;
  tz: string;
  showCancelled: boolean;
  onOpen: (id: string) => void;
  onPickDay: (d: string) => void;
}) {
  const start = startOfWeek(date);
  const days = dateRange(start, addDays(start, 6));
  const q = useAppointments({
    shopId,
    from: zonedToIso(start, '00:00', tz),
    to: zonedToIso(addDays(start, 7), '00:00', tz),
    limit: 1000,
  });
  const today = todayIn(tz);
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (q.isLoading) return <InlineLoading />;
  const byDay = new Map<string, AppointmentListItem[]>();
  for (const a of q.data ?? []) {
    if (!showCancelled && HIDDEN_STATUSES.has(a.status)) continue;
    const d = zonedParts(a.start_at, tz).date;
    byDay.set(d, [...(byDay.get(d) ?? []), a]);
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4 xl:grid-cols-7">
      {days.map((d) => {
        const list = (byDay.get(d) ?? []).sort((a, b) => a.start_at.localeCompare(b.start_at));
        const wd = weekdayOf(d);
        return (
          <section
            key={d}
            className={cn(
              'flex min-h-[10rem] flex-col rounded-2xl border bg-surface',
              d === today ? 'border-primary' : 'border-border',
            )}
            aria-label={formatDateJa(d)}
          >
            <button
              type="button"
              onClick={() => onPickDay(d)}
              className="flex items-baseline justify-between border-b border-border px-3 py-2 text-left hover:bg-surface-2"
            >
              <span
                className={cn(
                  'text-[13px] font-semibold',
                  wd === 0 ? 'text-danger' : wd === 6 ? 'text-info' : 'text-fg',
                )}
              >
                {Number(d.slice(8))}日（{WEEKDAYS_JA[wd]}）
              </span>
              <span className="text-xs text-muted tabular">{list.length}件</span>
            </button>
            <ul className="flex-1 space-y-1 p-2">
              {list.map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    onClick={() => onOpen(a.id)}
                    className="block w-full rounded-lg border-l-[3px] px-2 py-1.5 text-left hover:bg-surface-2"
                    style={{ borderLeftColor: a.staff_color ?? 'var(--subtle)' }}
                  >
                    <span className="flex items-center justify-between gap-1">
                      <span className="text-xs font-semibold tabular">
                        {formatTime(a.start_at, tz)}
                      </span>
                      {a.status !== 'confirmed' ? (
                        <StatusBadge status={a.status} size="sm" />
                      ) : null}
                    </span>
                    <span
                      className={cn(
                        'block truncate text-[13px] font-medium',
                        HIDDEN_STATUSES.has(a.status) && 'line-through opacity-60',
                      )}
                    >
                      {a.customer_name || '顧客未登録'}
                    </span>
                    <span className="block truncate text-[11px] text-muted">
                      {a.staff_name ?? '担当未定'}
                    </span>
                  </button>
                </li>
              ))}
              {!list.length ? <li className="px-2 py-3 text-xs text-subtle">予約なし</li> : null}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
