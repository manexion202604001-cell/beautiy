import { useQueries, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useStaffList } from '../../api/org';
import {
  scheduleKeys,
  schedulesApi,
  useBusinessHours,
  useExceptions,
  useShifts,
} from '../../api/schedules';
import type { Shift, ShiftInput, Staff } from '../../api/types';
import {
  Alert,
  Avatar,
  Badge,
  Button,
  DateNav,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  InlineLoading,
  Input,
  PageHeader,
  Segmented,
  useToast,
} from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { cn } from '../../lib/cn';
import { WEEKDAYS_JA, formatDateJa } from '../../lib/format';
import { addDays, dateRange, startOfWeek, todayIn, weekdayOf } from '../../lib/time';

type Draft =
  | { kind: 'work'; start: string; end: string; note: string }
  | { kind: 'off'; note: string }
  | { kind: 'reset' };
const key = (staffId: string, date: string) => `${staffId}:${date}`;

export default function Shifts() {
  const { currentShopId: shopId, timezone: tz, can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const today = todayIn(tz);
  const [weekStart, setWeekStart] = useState(startOfWeek(today));
  const days = dateRange(weekStart, addDays(weekStart, 6));
  const weekEnd = days[6]!;
  const staff = useStaffList({ shopId: shopId ?? undefined, bookableOnly: true }, !!shopId);
  const shifts = useShifts(shopId, weekStart, weekEnd);
  const hours = useBusinessHours(shopId);
  const exceptions = useExceptions(shopId, weekStart, weekEnd);
  const weekly = useQueries({
    queries: (staff.data ?? []).map((s) => ({
      queryKey: scheduleKeys.weekly(s.id, shopId ?? ''),
      queryFn: () => schedulesApi.weekly(s.id, shopId!),
      enabled: !!shopId,
      staleTime: 60_000,
    })),
  });
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [editing, setEditing] = useState<{ staff: Staff; date: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [copying, setCopying] = useState(false);
  const manage = can('schedule.manage');
  const dirtyCount = Object.keys(drafts).length;

  const shiftMap = useMemo(() => {
    const m = new Map<string, Shift[]>();
    for (const s of shifts.data ?? [])
      m.set(key(s.staff_id, s.date), [...(m.get(key(s.staff_id, s.date)) ?? []), s]);
    return m;
  }, [shifts.data]);

  const shopClosed = (date: string) => {
    const ex = exceptions.data?.find((e) => e.date === date);
    if (ex) return ex.is_closed;
    return !(hours.data ?? []).some((h) => h.weekday === weekdayOf(date));
  };

  /** effective state for display */
  const cellState = (
    s: Staff,
    idx: number,
    date: string,
  ): {
    label: string;
    kind: 'work' | 'off' | 'base' | 'baseoff' | 'closed';
    draft: boolean;
    note?: string | null;
  } => {
    const d = drafts[key(s.id, date)];
    const base = () => {
      const rows = weekly[idx]?.data;
      if (shopClosed(date)) return { label: '店休', kind: 'closed' as const };
      if (!rows || rows.length === 0) {
        const h = hours.data?.find((x) => x.weekday === weekdayOf(date));
        return {
          label: h ? `${h.open_time}-${h.close_time}` : '店休',
          kind: h ? ('base' as const) : ('closed' as const),
        };
      }
      const r = rows.filter((x) => x.weekday === weekdayOf(date));
      return r.length
        ? { label: r.map((x) => `${x.start_time}-${x.end_time}`).join(', '), kind: 'base' as const }
        : { label: '休み', kind: 'baseoff' as const };
    };
    if (d) {
      if (d.kind === 'work')
        return { label: `${d.start}-${d.end}`, kind: 'work', draft: true, note: d.note };
      if (d.kind === 'off') return { label: '休み', kind: 'off', draft: true, note: d.note };
      return { ...base(), draft: true };
    }
    const rows = shiftMap.get(key(s.id, date));
    if (rows?.length) {
      const off = rows.find((r) => r.shift_type === 'off');
      if (off) return { label: '休み', kind: 'off', draft: false, note: off.note };
      return {
        label: rows.map((r) => `${r.start_time}-${r.end_time}`).join(', '),
        kind: 'work',
        draft: false,
        note: rows[0]?.note,
      };
    }
    return { ...base(), draft: false };
  };

  const save = async () => {
    if (!shopId) return;
    const payload: ShiftInput[] = Object.entries(drafts).map(([k, d]) => {
      const [staffId, date] = k.split(':') as [string, string];
      if (d.kind === 'work')
        return {
          staffId,
          date,
          shiftType: 'work',
          startTime: d.start,
          endTime: d.end,
          note: d.note || null,
        };
      if (d.kind === 'off') return { staffId, date, shiftType: 'off', note: d.note || null };
      // work without times = remove the date-specific shift (fall back to the weekly pattern)
      return { staffId, date, shiftType: 'work', startTime: null, endTime: null };
    });
    setSaving(true);
    try {
      await schedulesApi.upsertShifts(shopId, payload);
      setDrafts({});
      void qc.invalidateQueries({ queryKey: scheduleKeys.all });
      toast.success(`シフトを保存しました（${payload.length}件）`);
    } catch (e) {
      toast.error(e);
    } finally {
      setSaving(false);
    }
  };

  const copyPrevWeek = async () => {
    if (!shopId) return;
    setCopying(true);
    try {
      const prevStart = addDays(weekStart, -7);
      const prev = await schedulesApi.shifts(shopId, prevStart, addDays(prevStart, 6));
      const next: Record<string, Draft> = {};
      for (const s of staff.data ?? []) {
        for (const date of days) {
          const src = prev.filter((p) => p.staff_id === s.id && p.date === addDays(date, -7));
          const hasCurrent = shiftMap.has(key(s.id, date));
          if (src.length) {
            const off = src.find((x) => x.shift_type === 'off');
            next[key(s.id, date)] = off
              ? { kind: 'off', note: off.note ?? '' }
              : {
                  kind: 'work',
                  start: src[0]!.start_time!,
                  end: src[0]!.end_time!,
                  note: src[0]!.note ?? '',
                };
          } else if (hasCurrent) next[key(s.id, date)] = { kind: 'reset' };
        }
      }
      setDrafts(next);
      toast.info(
        Object.keys(next).length
          ? '前週のシフトをコピーしました（未保存）'
          : '前週に個別シフトはありません',
        Object.keys(next).length ? '内容を確認して「保存」を押してください' : undefined,
      );
    } catch (e) {
      toast.error(e);
    } finally {
      setCopying(false);
    }
  };

  if (!shopId) return <InlineLoading />;

  return (
    <div>
      <PageHeader
        title="シフト"
        description="日ごとの出勤・休みを登録します。登録がない日は、スタッフの基本勤務パターン（スタッフ詳細）に従います。"
        actions={
          manage ? (
            <>
              <Button icon="copy" onClick={copyPrevWeek} loading={copying}>
                前週をコピー
              </Button>
              <Button variant="primary" onClick={save} loading={saving} disabled={!dirtyCount}>
                保存{dirtyCount ? `（${dirtyCount}）` : ''}
              </Button>
            </>
          ) : null
        }
      />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <DateNav
          value={weekStart}
          today={startOfWeek(today)}
          step={7}
          onChange={(d) => {
            if (dirtyCount && !window.confirm('未保存の変更があります。破棄して移動しますか？'))
              return;
            setDrafts({});
            setWeekStart(startOfWeek(d));
          }}
          label={`${formatDateJa(weekStart)} 〜 ${formatDateJa(weekEnd)}`}
        />
        {dirtyCount ? (
          <Button size="sm" variant="ghost" onClick={() => setDrafts({})}>
            変更を破棄
          </Button>
        ) : null}
      </div>
      {dirtyCount ? (
        <Alert tone="warning" className="mb-4">
          未保存の変更が{dirtyCount}件あります。
        </Alert>
      ) : null}
      {staff.isLoading || shifts.isLoading ? <InlineLoading /> : null}
      {staff.error ? <ErrorState error={staff.error} /> : null}
      {staff.data && !staff.data.length ? (
        <EmptyState icon="user" title="予約受付可のスタッフがいません" />
      ) : null}
      {staff.data?.length ? (
        <div className="scrollbar-thin overflow-x-auto rounded-2xl border border-border bg-surface">
          <table className="w-full min-w-[56rem] table-fixed border-collapse text-[13px]">
            <caption className="sr-only">週間シフト表</caption>
            <thead>
              <tr className="border-b border-border bg-surface-2/60">
                <th
                  scope="col"
                  className="sticky left-0 z-10 w-44 bg-surface-2 px-4 py-2.5 text-left text-xs font-medium text-muted"
                >
                  スタッフ
                </th>
                {days.map((d) => {
                  const wd = weekdayOf(d);
                  return (
                    <th
                      key={d}
                      scope="col"
                      className={cn(
                        'px-2 py-2.5 text-center text-xs font-medium',
                        d === today
                          ? 'text-primary'
                          : wd === 0
                            ? 'text-danger'
                            : wd === 6
                              ? 'text-info'
                              : 'text-muted',
                      )}
                    >
                      <span className="block text-sm font-semibold">{Number(d.slice(8))}</span>
                      {WEEKDAYS_JA[wd]}
                      {shopClosed(d) ? (
                        <span className="block text-[10px] text-subtle">店休</span>
                      ) : null}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {staff.data.map((s, idx) => (
                <tr key={s.id}>
                  <th
                    scope="row"
                    className="sticky left-0 z-10 bg-surface px-4 py-2 text-left font-normal"
                  >
                    <span className="flex items-center gap-2">
                      <Avatar name={s.display_name} color={s.color} size={26} />
                      <span className="truncate font-medium">{s.display_name}</span>
                    </span>
                  </th>
                  {days.map((d) => {
                    const st = cellState(s, idx, d);
                    return (
                      <td key={d} className="p-1.5">
                        <button
                          type="button"
                          disabled={!manage}
                          onClick={() => setEditing({ staff: s, date: d })}
                          aria-label={`${s.display_name} ${formatDateJa(d)}: ${st.label}${st.draft ? '（未保存）' : ''}`}
                          className={cn(
                            'flex h-14 w-full flex-col items-center justify-center rounded-lg border text-xs transition-colors disabled:cursor-default',
                            st.kind === 'work' &&
                              'border-primary/40 bg-primary-soft font-semibold text-primary',
                            st.kind === 'off' &&
                              'border-danger/30 bg-danger-soft font-semibold text-danger',
                            st.kind === 'base' && 'border-border bg-surface text-fg',
                            st.kind === 'baseoff' && 'border-border bg-surface-2 text-muted',
                            st.kind === 'closed' && 'bg-closed border-border text-subtle',
                            st.draft &&
                              'ring-2 ring-warning ring-offset-1 ring-offset-[var(--surface)]',
                            manage && 'hover:border-primary',
                          )}
                        >
                          <span className="tabular">{st.label}</span>
                          {st.kind === 'base' || st.kind === 'baseoff' ? (
                            <span className="text-[10px] font-normal text-subtle">基本</span>
                          ) : null}
                          {st.note ? (
                            <span className="max-w-full truncate px-1 text-[10px] font-normal text-muted">
                              {st.note}
                            </span>
                          ) : null}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-3 text-xs text-muted">
        <span className="inline-flex items-center gap-1.5">
          <Badge tone="primary" size="sm">
            10:00-19:00
          </Badge>
          個別シフト（出勤）
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Badge tone="danger" size="sm">
            休み
          </Badge>
          個別シフト（休み）
        </span>
        <span>「基本」= 基本勤務パターン</span>
      </div>

      {editing ? (
        <CellEditor
          staff={editing.staff}
          date={editing.date}
          initial={
            drafts[key(editing.staff.id, editing.date)] ??
            fromShift(shiftMap.get(key(editing.staff.id, editing.date)))
          }
          onClose={() => setEditing(null)}
          onApply={(d) => {
            setDrafts((x) => ({ ...x, [key(editing.staff.id, editing.date)]: d }));
            setEditing(null);
          }}
        />
      ) : null}
    </div>
  );
}

function fromShift(rows: Shift[] | undefined): Draft {
  if (!rows?.length) return { kind: 'reset' };
  const off = rows.find((r) => r.shift_type === 'off');
  if (off) return { kind: 'off', note: off.note ?? '' };
  return {
    kind: 'work',
    start: rows[0]!.start_time ?? '10:00',
    end: rows[0]!.end_time ?? '19:00',
    note: rows[0]!.note ?? '',
  };
}

function CellEditor({
  staff,
  date,
  initial,
  onClose,
  onApply,
}: {
  staff: Staff;
  date: string;
  initial: Draft;
  onClose: () => void;
  onApply: (d: Draft) => void;
}) {
  const [kind, setKind] = useState<Draft['kind']>(initial.kind);
  const [start, setStart] = useState(initial.kind === 'work' ? initial.start : '10:00');
  const [end, setEnd] = useState(initial.kind === 'work' ? initial.end : '19:00');
  const [note, setNote] = useState(initial.kind !== 'reset' ? initial.note : '');
  const invalid = kind === 'work' && end <= start;
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={`${staff.display_name} ・ ${formatDateJa(date)}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            キャンセル
          </Button>
          <Button
            variant="primary"
            disabled={invalid}
            onClick={() =>
              onApply(
                kind === 'work'
                  ? { kind, start, end, note }
                  : kind === 'off'
                    ? { kind, note }
                    : { kind: 'reset' },
              )
            }
          >
            反映
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Segmented
          label="勤務区分"
          value={kind}
          onChange={setKind}
          options={[
            { value: 'work', label: '出勤' },
            { value: 'off', label: '休み' },
            { value: 'reset', label: '基本に戻す' },
          ]}
        />
        {kind === 'work' ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label="開始">
              <Input
                type="time"
                step={900}
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </Field>
            <Field label="終了" error={invalid ? '終了は開始より後にしてください' : undefined}>
              <Input type="time" step={900} value={end} onChange={(e) => setEnd(e.target.value)} />
            </Field>
          </div>
        ) : null}
        {kind !== 'reset' ? (
          <Field label="メモ" optional>
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={200}
              placeholder="希望休、研修など"
            />
          </Field>
        ) : (
          <p className="text-[13px] text-muted">
            この日の個別シフトを削除し、基本勤務パターンに従います。
          </p>
        )}
      </div>
    </Dialog>
  );
}
