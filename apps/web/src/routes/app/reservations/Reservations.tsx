import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Clock, Plus, RotateCcw, Search, User, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
  type TouchEvent as ReactTouchEvent,
} from 'react';
import { useNavigate } from 'react-router';
import { appointmentKeys, appointmentsApi, useAppointments } from '../../../api/appointments';
import { useCategories, useMenus } from '../../../api/catalog';
import { useStaffList } from '../../../api/org';
import {
  scheduleKeys,
  schedulesApi,
  useBusinessHours,
  useExceptions,
  useShifts,
} from '../../../api/schedules';
import { staffScreenApi } from '../../../api/staffScreen';
import type { AppointmentListItem, DayStaffSchedule } from '../../../api/types';
import { Avatar, Badge, Button, Card, CardContent, Input, Select, Tabs } from '../../../components/shad';
import { useToast } from '../../../components/ui';
import { errorMessage } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { cx } from '../../../lib/cn';
import { useNow } from '../../../lib/hooks';
import {
  addDays,
  addMonths,
  startOfMonth,
  startOfWeek,
  todayIn,
  weekdayOf,
  zonedParts,
  zonedToIso,
} from '../../../lib/time';
import {
  GRID_START_MIN,
  SLOTS,
  categoryStyle,
  formatCurrency,
  hm,
  isInactive,
  layoutOverlaps,
  reservationBadges,
  statusClass,
  type BadgeSet,
  type ReservationBadge,
} from './model';

type View = 'day' | 'week' | 'month';
type Axis = 'time-row' | 'staff-row';

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

/** 2026年10月13日(火) */
function formatDateLong(date: string, tz: string) {
  return new Date(zonedToIso(date, '12:00', tz)).toLocaleDateString('ja-JP', {
    timeZone: tz,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  });
}

const pad2 = (n: number) => String(n).padStart(2, '0');

interface Ghost {
  date: string;
  hour: number;
  minute: number;
  cellTop: number;
  colLeft: number;
  colWidth: number;
  cellHeight: number;
}

function BadgeChips({ badges, className }: { badges: ReservationBadge[]; className: string }) {
  return (
    <>
      {badges.map((b) => (
        <span
          key={b.key}
          className={cx(className, b.className)}
          style={b.color ? { backgroundColor: b.color } : undefined}
        >
          {b.label}
        </span>
      ))}
    </>
  );
}

const BLOCK_BADGE =
  'inline-flex items-center justify-center px-0.5 text-[7px] leading-[12px] text-white rounded-sm font-normal shrink-0';
const ROW_BADGE =
  'inline-flex items-center px-0.5 text-[7px] leading-[11px] text-white rounded-sm font-normal shrink-0';

export default function Reservations() {
  const { currentShopId: shopId, timezone: tz, can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const now = useNow(60_000);
  const today = todayIn(tz, now);

  const [date, setDate] = useState(today);
  const [view, setView] = useState<View>('week');
  const [axis, setAxis] = useState<Axis>('time-row');
  const [staffFilter, setStaffFilter] = useState('all');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [showCancelled, setShowCancelled] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [ghost, setGhost] = useState<Ghost | null>(null);

  // --- visible range
  const range = useMemo(() => {
    if (view === 'day') return { start: date, end: date };
    if (view === 'week') {
      const start = startOfWeek(date);
      return { start, end: addDays(start, 6) };
    }
    const start = startOfMonth(date);
    return { start, end: addDays(addMonths(start, 1), -1) };
  }, [date, view]);

  // --- data
  const canRead = can('appointment.read');
  const staffQ = useStaffList({ shopId: shopId ?? undefined }, !!shopId);
  const staff = useMemo(
    () => (staffQ.data ?? []).filter((s) => s.status === 'active' || s.status === 'invited'),
    [staffQ.data],
  );
  const menusQ = useMenus(shopId, true);
  const categoriesQ = useCategories(shopId ?? undefined);
  const hoursQ = useBusinessHours(shopId);
  const exceptionsQ = useExceptions(shopId, range.start, range.end);
  const shiftsQ = useShifts(view === 'month' && staffFilter !== 'all' ? shopId : null, range.start, range.end);

  const apptsQ = useAppointments(
    {
      shopId: shopId ?? undefined,
      from: zonedToIso(range.start, '00:00', tz),
      to: zonedToIso(addDays(range.end, 1), '00:00', tz),
      staffId: staffFilter !== 'all' ? staffFilter : undefined,
      limit: 1000,
    },
    !!shopId && canRead,
  );
  const reservations = useMemo(() => apptsQ.data ?? [], [apptsQ.data]);

  // search (debounced like typing in the original: 400ms)
  useEffect(() => {
    if (!searchInput.trim()) {
      setSearch('');
      return;
    }
    const t = window.setTimeout(() => setSearch(searchInput.trim()), 400);
    return () => window.clearTimeout(t);
  }, [searchInput]);
  const searchQ = useAppointments(
    { shopId: shopId ?? undefined, q: search || undefined, limit: 1000 },
    !!shopId && canRead && !!search,
  );
  const searchResults = useMemo(
    () =>
      [...(searchQ.data ?? [])]
        .sort((a, b) => new Date(b.start_at).getTime() - new Date(a.start_at).getTime())
        .slice(0, 50),
    [searchQ.data],
  );

  // per-day opening / working ranges for the day and week grids
  const scheduleDates = useMemo(() => {
    if (view === 'day') return [date];
    if (view === 'week') return Array.from({ length: 7 }, (_, i) => addDays(range.start, i));
    return [];
  }, [view, date, range.start]);
  const scheduleQs = useQueries({
    queries: scheduleDates.map((d) => ({
      queryKey: scheduleKeys.staffSchedule(shopId ?? '', d),
      queryFn: () => schedulesApi.staffSchedule(shopId!, d),
      enabled: !!shopId,
      staleTime: 60_000,
    })),
  });
  const schedules = new Map<string, DayStaffSchedule>();
  scheduleQs.forEach((q, i) => {
    if (q.data) schedules.set(scheduleDates[i]!, q.data);
  });

  const inRanges = useCallback(
    (ranges: { start: string; end: string }[], dateStr: string, minutes: number) =>
      ranges.some((r) => {
        const s = zonedParts(r.start, tz);
        const e = zonedParts(r.end, tz);
        const startMin = s.date < dateStr ? 0 : s.minutes;
        const endMin = e.date > dateStr ? 24 * 60 : e.minutes;
        return minutes >= startMin && minutes < endMin;
      }),
    [tz],
  );
  /** outside the shop's opening hours on that date */
  const shopClosed = (dateStr: string, hour: number, minute: number) => {
    const s = schedules.get(dateStr);
    if (!s) return false;
    return !inRanges(s.shopOpen, dateStr, hour * 60 + minute);
  };
  /** outside the staff member's working hours on that date */
  const staffClosed = (staffId: string, dateStr: string, hour: number, minute: number) => {
    const s = schedules.get(dateStr);
    if (!s) return false;
    const working = s.staff.find((x) => x.staffId === staffId)?.working ?? [];
    return !inRanges(working, dateStr, hour * 60 + minute);
  };
  /** month view: the whole day is closed for the shop */
  const shopClosedDay = useCallback(
    (dateStr: string) => {
      const ex = (exceptionsQ.data ?? []).find((e) => e.date === dateStr);
      if (ex) return ex.is_closed;
      const hours = hoursQ.data ?? [];
      if (hours.length === 0) return false;
      return !hours.some((h) => h.weekday === weekdayOf(dateStr));
    },
    [exceptionsQ.data, hoursQ.data],
  );
  // the selected staff member's weekly pattern (スタッフ別 営業時間): 休み weekdays are greyed in the month view
  const staffHoursQ = useQuery({
    queryKey: ['staff', 'business-hours', staffFilter, shopId ?? ''],
    queryFn: () => staffScreenApi.businessHours(staffFilter, shopId!),
    enabled: view === 'month' && staffFilter !== 'all' && !!shopId,
    staleTime: 60_000,
  });
  /** month view: the staff member does not work that day (a dated shift wins over the weekly pattern) */
  const staffOffDay = useCallback(
    (staffId: string, dateStr: string) => {
      const shifts = (shiftsQ.data ?? []).filter((s) => s.staff_id === staffId && s.date === dateStr);
      if (shifts.length) return !shifts.some((s) => s.shift_type === 'work');
      const hours = staffHoursQ.data;
      if (!hours?.configured) return false;
      return hours.hours.find((h) => h.weekday === weekdayOf(dateStr))?.isClosed ?? false;
    },
    [shiftsQ.data, staffHoursQ.data],
  );

  // --- colours
  const categoryColorOf = useMemo(() => {
    const colorByCategory = new Map((categoriesQ.data ?? []).map((c) => [c.id, c.color]));
    const colorByMenu = new Map(
      (menusQ.data ?? []).map((m) => [m.id, m.categoryId ? (colorByCategory.get(m.categoryId) ?? null) : null]),
    );
    return (a: AppointmentListItem): CSSProperties => {
      const menuId = a.services[0]?.menu_id;
      return categoryStyle(menuId ? colorByMenu.get(menuId) : null, a.status);
    };
  }, [categoriesQ.data, menusQ.data]);

  // --- derived lists
  const active = useMemo(() => reservations.filter((r) => !isInactive(r.status)), [reservations]);
  const cancelled = useMemo(() => reservations.filter((r) => isInactive(r.status)), [reservations]);
  const byDate = useMemo(() => {
    const m: Record<string, AppointmentListItem[]> = {};
    for (const r of active) (m[zonedParts(r.start_at, tz).date] ??= []).push(r);
    for (const k of Object.keys(m)) m[k]!.sort((a, b) => a.start_at.localeCompare(b.start_at));
    return m;
  }, [active, tz]);

  const menuName = (a: AppointmentListItem) => a.services.map((s) => s.name).join('、');
  const staffName = (a: AppointmentListItem) => a.staff_name ?? '';
  const timeOf = (iso: string) => zonedParts(iso, tz).time;
  /** minutes from the top of the grid (6:30) */
  const offsetOf = (iso: string) => zonedParts(iso, tz).minutes - GRID_START_MIN;

  // --- navigation
  const move = useCallback(
    (dir: number) => {
      setDate((d) => (view === 'day' ? addDays(d, dir) : view === 'week' ? addDays(d, 7 * dir) : addMonths(d, dir)));
    },
    [view],
  );
  const title = useMemo(() => {
    if (view === 'day') return formatDateLong(date, tz);
    if (view === 'week') {
      const s = range.start.split('-').map(Number);
      const e = range.end.split('-').map(Number);
      return `${s[1]}/${s[2]} - ${e[1]}/${e[2]}`;
    }
    const [y, m] = date.split('-').map(Number);
    return `${y}年${m}月`;
  }, [view, date, range, tz]);

  // swipe left / right on touch screens (day and month views)
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const swipe =
    view !== 'week'
      ? {
          onTouchStart: (e: ReactTouchEvent) => {
            const t = e.touches[0]!;
            touchStart.current = { x: t.clientX, y: t.clientY };
          },
          onTouchEnd: (e: ReactTouchEvent) => {
            if (!touchStart.current) return;
            const t = e.changedTouches[0]!;
            const dx = t.clientX - touchStart.current.x;
            const dy = t.clientY - touchStart.current.y;
            touchStart.current = null;
            if (Math.abs(dy) > Math.abs(dx) || Math.abs(dx) < 50) return;
            move(dx < 0 ? 1 : -1);
          },
        }
      : {};

  // --- create
  const canWrite = can('appointment.write');
  const startCreate = useCallback(
    (dateStr: string, hour?: number, minute?: number) => {
      if (!canWrite || !shopId) return;
      const q = new URLSearchParams({ date: dateStr });
      if (hour !== undefined) q.set('time', `${pad2(hour)}:${pad2(minute ?? 0)}`);
      navigate(`/app/calendar/new?${q.toString()}`);
    },
    [canWrite, shopId, navigate],
  );

  // long press (500ms) on a day-view cell starts a reservation at that hour
  const pressTimer = useRef<number | null>(null);
  const cancelPress = useCallback(() => {
    if (pressTimer.current) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  }, []);
  const startPress = useCallback(
    (fn: () => void) => {
      cancelPress();
      pressTimer.current = window.setTimeout(() => {
        pressTimer.current = null;
        fn();
      }, 500);
    },
    [cancelPress],
  );
  useEffect(() => cancelPress, [cancelPress]);

  // long press on a week cell shows a one-hour ghost that follows the pointer; releasing creates
  const weekTimer = useRef<number | null>(null);
  const cancelWeekPress = useCallback(() => {
    if (weekTimer.current) {
      window.clearTimeout(weekTimer.current);
      weekTimer.current = null;
    }
  }, []);
  const weekPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>, dateStr: string, hour: number, minute: number) => {
      if (e.button !== 0 || !canWrite) return;
      const cell = e.currentTarget;
      cancelWeekPress();
      weekTimer.current = window.setTimeout(() => {
        weekTimer.current = null;
        window.getSelection()?.removeAllRanges();
        const rect = cell.getBoundingClientRect();
        setGhost({
          date: dateStr,
          hour,
          minute,
          cellTop: rect.top,
          colLeft: rect.left,
          colWidth: rect.width,
          cellHeight: rect.height,
        });
        navigator.vibrate?.(50);
      }, 500);
    },
    [cancelWeekPress, canWrite],
  );
  useEffect(() => cancelWeekPress, [cancelWeekPress]);
  useEffect(() => {
    if (!ghost) return;
    const onMove = (e: PointerEvent) => {
      const ghostEl = document.getElementById('week-drag-ghost');
      if (ghostEl) ghostEl.style.visibility = 'hidden';
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (ghostEl) ghostEl.style.visibility = '';
      const cell = el instanceof HTMLElement ? el.closest<HTMLElement>('[data-week-cell]') : null;
      if (!cell?.dataset.weekDate) return;
      const rect = cell.getBoundingClientRect();
      setGhost({
        date: cell.dataset.weekDate,
        hour: parseInt(cell.dataset.slotHour || '0', 10),
        minute: parseInt(cell.dataset.slotMinute || '0', 10),
        cellTop: rect.top,
        colLeft: rect.left,
        colWidth: rect.width,
        cellHeight: rect.height,
      });
    };
    const onUp = () => {
      setGhost(null);
      const start = ghost.hour * 60 + ghost.minute - 55;
      startCreate(ghost.date, Math.max(0, Math.floor(start / 60)), Math.max(0, start % 60));
    };
    const onCancel = () => setGhost(null);
    const onTouchMove = (e: TouchEvent) => e.preventDefault();
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    return () => {
      document.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
  }, [ghost, startCreate]);

  // --- drag & drop (day view): move to another staff member and / or time.
  // Like SALOGIC the booking keeps its length and may land in greyed (closed) time;
  // the API still refuses overlaps, busy resources and completed / cancelled bookings.
  const moveReservation = async (id: string, staffId: string, hour?: number, minute?: number) => {
    const r = reservations.find((x) => x.id === id);
    if (!r) return;
    const lengthMin = Math.round((new Date(r.end_at).getTime() - new Date(r.start_at).getTime()) / 60_000);
    try {
      await appointmentsApi.update(id, {
        version: r.version,
        staffId,
        allowOutsideSchedule: true,
        ...(lengthMin >= 5 && lengthMin <= 720 && lengthMin % 5 === 0 ? { durationMin: lengthMin } : {}),
        ...(hour !== undefined && minute !== undefined
          ? { startAt: zonedToIso(date, `${pad2(hour)}:${pad2(minute)}`, tz) }
          : {}),
      });
    } catch (e) {
      toast.error('予約の移動に失敗しました', errorMessage(e));
    } finally {
      void qc.invalidateQueries({ queryKey: appointmentKeys.all });
    }
  };
  const onDragStart = (e: DragEvent<HTMLDivElement>, r: AppointmentListItem) => {
    e.dataTransfer.setData('reservationId', r.id);
    e.dataTransfer.setData('currentStaffId', r.staff_id ?? '');
    e.dataTransfer.effectAllowed = 'move';
    e.currentTarget.style.opacity = '0.5';
    setDragging(true);
  };
  const onDragEnd = (e: DragEvent<HTMLDivElement>) => {
    e.currentTarget.style.opacity = '1';
    setDragging(false);
  };
  const onDragOver = (e: DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };
  const onDragEnter = (e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    e.currentTarget.classList.add('bg-primary/20');
  };
  const onDragLeave = (e: DragEvent<HTMLElement>) => {
    e.currentTarget.classList.remove('bg-primary/20');
  };
  const onDropSlot = (e: DragEvent<HTMLElement>, staffId: string, hour: number, minute: number) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.classList.remove('bg-primary/20');
    const id = e.dataTransfer.getData('reservationId');
    if (id) void moveReservation(id, staffId, hour, minute);
  };
  const onDropStaff = (e: DragEvent<HTMLElement>, staffId: string) => {
    e.preventDefault();
    e.currentTarget.classList.remove('bg-primary/20');
    const id = e.dataTransfer.getData('reservationId');
    const current = e.dataTransfer.getData('currentStaffId');
    if (id && current !== staffId) void moveReservation(id, staffId);
  };

  const badges = (a: AppointmentListItem, set: BadgeSet) => reservationBadges(a, set, !!a.has_consent);
  const isToday = (d: string) => d === today;
  const weekDates = view === 'week' ? Array.from({ length: 7 }, (_, i) => addDays(range.start, i)) : [];
  const monthCells = useMemo(() => {
    if (view !== 'month') return [];
    const first = startOfMonth(date);
    const start = addDays(first, -weekdayOf(first));
    return Array.from({ length: 42 }, (_, i) => {
      const d = addDays(start, i);
      return { date: d, isCurrentMonth: d.slice(0, 7) === first.slice(0, 7) };
    });
  }, [view, date]);
  const narrow = typeof window !== 'undefined' && window.innerWidth < 768;

  return (
    <div className="sy-4 md:sy-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold md:text-2xl">予約管理</h1>
        <Button size="sm" onClick={() => startCreate(date)}>
          <Plus className="mr-1 h-4 w-4 md:mr-2" />
          <span className="hidden sm:inline">新規予約</span>
          <span className="sm:hidden">追加</span>
        </Button>
      </div>

      <Card>
        <CardContent className="py-3 md:py-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="flex items-center gap-2">
              <Button variant="outline" size="icon" className="h-8 w-8" aria-label="前へ" onClick={() => move(-1)}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button variant="outline" size="sm" onClick={() => setDate(today)}>
                今日
              </Button>
              <Button variant="outline" size="icon" className="h-8 w-8" aria-label="次へ" onClick={() => move(1)}>
                <ChevronRight className="h-4 w-4" />
              </Button>
              <span className="ml-2 text-sm font-medium md:text-base">{title}</span>
            </div>
            <div className="flex items-center gap-2">
              <Tabs
                label="表示切替"
                value={view}
                onValueChange={setView}
                listClassName="h-8"
                triggerClassName="text-xs px-2 md:px-3"
                items={[
                  { value: 'day', label: '日' },
                  { value: 'week', label: '週' },
                  { value: 'month', label: '月' },
                ]}
              />
              <Select
                label="スタッフ"
                value={staffFilter}
                onValueChange={setStaffFilter}
                placeholder="スタッフ"
                className="h-8 w-[100px] md:w-[150px]"
                options={[{ value: 'all', label: '全員' }, ...staff.map((s) => ({ value: s.id, label: s.display_name }))]}
              />
            </div>
          </div>
          <div className="relative mt-3">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="名前・電話番号で検索..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="h-8 pl-9 text-sm"
            />
            {searchInput ? (
              <Button
                variant="ghost"
                size="icon"
                className="absolute right-1 top-1/2 h-6 w-6 -translate-y-1/2"
                aria-label="検索をクリア"
                onClick={() => {
                  setSearchInput('');
                  setSearch('');
                }}
              >
                <X className="h-3 w-3" />
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {search ? (
        <Card>
          <CardContent className="p-3 md:p-4">
            <div className="mb-3 text-sm font-medium">
              検索結果: 「{search}」{searchQ.isFetching ? ' 検索中...' : ` ${searchResults.length}件`}
            </div>
            {!searchQ.isFetching && searchResults.length === 0 ? (
              <div className="py-4 text-center text-sm text-muted-foreground">
                該当する予約が見つかりません
              </div>
            ) : null}
            <div className="sy-2">
              {searchResults.map((r) => (
                <div
                  key={r.id}
                  className={cx(
                    'flex cursor-pointer items-center gap-3 rounded-md border p-2 transition-colors hover:bg-muted/50',
                    isInactive(r.status) && 'opacity-60',
                  )}
                  onClick={() => navigate(`/app/calendar/${r.id}`)}
                >
                  <div className="w-[90px] shrink-0 text-xs text-muted-foreground">
                    <div>{formatDateLong(zonedParts(r.start_at, tz).date, tz)}</div>
                    <div>
                      {timeOf(r.start_at)}~{timeOf(r.end_at)}
                    </div>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1 truncate text-sm font-medium">
                      {r.customer_name}
                      {r.customer_phone ? (
                        <span className="text-xs font-normal text-muted-foreground">{r.customer_phone}</span>
                      ) : null}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {menuName(r)} / {staffName(r)}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <BadgeChips
                      badges={badges(r, 'search')}
                      className="inline-flex items-center px-1 text-[9px] leading-[14px] text-white rounded-sm"
                    />
                    {r.status === 'cancelled' ? (
                      <Badge variant="destructive" className="text-[10px]">
                        キャンセル
                      </Badge>
                    ) : null}
                    {r.status === 'no_show' ? (
                      <Badge variant="destructive" className="text-[10px]">
                        無断
                      </Badge>
                    ) : null}
                    {r.status === 'confirmed' ? <Badge className="bg-green-600 text-[10px]">確定</Badge> : null}
                    {r.status === 'tentative' ? (
                      <Badge className="bg-yellow-500 text-[10px]">確認待ち</Badge>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card className={search ? 'hidden' : ''}>
        <CardContent className="p-2 md:p-4" data-testid="calendar-grid" {...swipe}>
          {apptsQ.isLoading ? (
            <div className="py-8 text-center text-muted-foreground">読み込み中...</div>
          ) : view === 'month' ? (
            <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg bg-border">
              {WEEKDAYS.map((w, i) => (
                <div
                  key={w}
                  className={cx(
                    'bg-muted p-2 text-center text-xs font-medium',
                    i === 0 && 'text-red-500',
                    i === 6 && 'text-blue-500',
                  )}
                >
                  {w}
                </div>
              ))}
              {monthCells.map(({ date: d, isCurrentMonth }) => {
                const list = byDate[d] ?? [];
                const wd = weekdayOf(d);
                const closed = shopClosedDay(d) || (staffFilter !== 'all' && staffOffDay(staffFilter, d));
                return (
                  <div
                    key={d}
                    className={cx(
                      'min-h-[80px] cursor-pointer bg-card p-1 hover:bg-muted/50 md:min-h-[100px] md:p-2',
                      !isCurrentMonth && 'bg-muted/50',
                      isToday(d) && 'bg-primary/5',
                      closed && 'bg-gray-200/60',
                    )}
                    onClick={() => {
                      setDate(d);
                      setView('day');
                    }}
                  >
                    <div
                      className={cx(
                        'mb-1 text-xs font-medium md:text-sm',
                        !isCurrentMonth && 'text-muted-foreground',
                        wd === 0 && 'text-red-500',
                        wd === 6 && 'text-blue-500',
                        isToday(d) && 'flex h-6 w-6 items-center justify-center rounded-full bg-primary text-white',
                      )}
                    >
                      {Number(d.slice(8))}
                    </div>
                    <div className="sy-0.5">
                      {list.slice(0, 3).map((r) => (
                        <div
                          key={r.id}
                          data-appt={r.id}
                          className={cx('truncate rounded-sm border px-1 text-[10px] md:text-xs', statusClass(r.status))}
                          style={categoryColorOf(r)}
                          title={`${r.customer_name} - ${staffName(r)}`}
                        >
                          {timeOf(r.start_at)} {staffName(r)}
                          <BadgeChips
                            badges={badges(r, 'month')}
                            className="inline-flex items-center ml-0.5 px-0.5 text-[7px] leading-[11px] text-white rounded-sm shrink-0"
                          />
                        </div>
                      ))}
                      {list.length > 3 ? (
                        <div className="px-1 text-[10px] text-muted-foreground">+{list.length - 3}件</div>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : view === 'week' ? (
            <div className="overflow-x-auto">
              <div className="min-w-[1000px]">
                <div className="grid grid-cols-[60px_repeat(7,1fr)] border-b">
                  <div className="p-2 text-center text-xs font-medium text-muted-foreground">時間</div>
                  {weekDates.map((d) => {
                    const wd = weekdayOf(d);
                    return (
                      <div
                        key={d}
                        className={cx(
                          'cursor-pointer border-l p-2 text-center hover:bg-muted/50',
                          isToday(d) && 'bg-primary/5',
                        )}
                        onClick={() => {
                          setDate(d);
                          setView('day');
                        }}
                      >
                        <div
                          className={cx(
                            'text-xs text-muted-foreground',
                            wd === 0 && 'text-red-500',
                            wd === 6 && 'text-blue-500',
                          )}
                        >
                          {WEEKDAYS[wd]}
                        </div>
                        <div
                          className={cx(
                            'text-sm font-medium',
                            isToday(d) &&
                              'mx-auto flex h-6 w-6 items-center justify-center rounded-full bg-primary text-white',
                          )}
                        >
                          {Number(d.slice(8))}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="flex">
                  <div className="w-[60px] shrink-0 bg-background">
                    {SLOTS.map((s) => (
                      <div key={s.label} className="relative h-[5px]">
                        {s.minute === 0 ? (
                          <span className="absolute -top-[7px] left-0 right-0 z-10 text-center text-[10px] font-medium leading-none text-muted-foreground">
                            {s.label}
                          </span>
                        ) : null}
                      </div>
                    ))}
                  </div>
                  <div className="grid flex-1 grid-cols-7">
                    {weekDates.map((d) => {
                      const list = byDate[d] ?? [];
                      const layout = layoutOverlaps(
                        list
                          .map((r) => ({ id: r.id, top: offsetOf(r.start_at), bottom: offsetOf(r.end_at) }))
                          .filter((s) => s.bottom > s.top),
                      );
                      return (
                        <div key={d} className="relative border-l">
                          {SLOTS.map((s) => (
                            <div
                              key={s.label}
                              data-week-cell
                              data-week-date={d}
                              data-slot-hour={s.hour}
                              data-slot-minute={s.minute}
                              className={cx(
                                'h-[5px] cursor-pointer',
                                s.minute === 55
                                  ? 'border-b border-b-border'
                                  : s.minute % 30 === 25
                                    ? 'border-b border-b-border/30'
                                    : '',
                                (shopClosed(d, s.hour, s.minute) ||
                                  (staffFilter !== 'all' && staffClosed(staffFilter, d, s.hour, s.minute))) &&
                                  'bg-gray-200/60',
                              )}
                              onPointerDown={(e) => weekPointerDown(e, d, s.hour, s.minute)}
                              onPointerUp={cancelWeekPress}
                              onPointerCancel={cancelWeekPress}
                              onContextMenu={(e) => e.preventDefault()}
                            />
                          ))}
                          {list.map((r) => {
                            const top = offsetOf(r.start_at);
                            const height = offsetOf(r.end_at) - top;
                            if (height <= 0) return null;
                            const pos = layout.get(r.id);
                            const col = pos?.col ?? 0;
                            const total = pos?.total ?? 1;
                            const s = zonedParts(r.start_at, tz);
                            const e = zonedParts(r.end_at, tz);
                            return (
                              <div
                                key={r.id}
                                data-appt={r.id}
                                className="absolute z-10 cursor-pointer overflow-hidden rounded-sm border px-0.5"
                                style={{
                                  ...categoryColorOf(r),
                                  top: `${top + 1}px`,
                                  height: `${height - 2}px`,
                                  left: `calc(${(col / total) * 100}% + 1px)`,
                                  width: `calc(${(1 / total) * 100}% - 2px)`,
                                }}
                                title={`${r.customer_name} - ${menuName(r)} (${staffName(r)})`}
                                onClick={(ev) => {
                                  ev.stopPropagation();
                                  navigate(`/app/calendar/${r.id}`);
                                }}
                              >
                                <div className="flex items-center gap-0.5">
                                  <BadgeChips badges={badges(r, 'block')} className={BLOCK_BADGE} />
                                </div>
                                <div className="truncate text-[11px] font-medium" style={{ color: '#1a1a1a' }}>
                                  {r.customer_name || '顧客'}
                                </div>
                                {height >= 7 ? (
                                  <div className="truncate text-[10px]" style={{ color: '#1a1a1a' }}>
                                    {hm(s.hour, s.minute)}-{hm(e.hour, e.minute)}
                                  </div>
                                ) : null}
                              </div>
                            );
                          })}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div>
              <div className="mb-2 flex justify-end">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => setAxis(axis === 'staff-row' ? 'time-row' : 'staff-row')}
                >
                  <RotateCcw className="mr-1 h-3 w-3" />
                  {axis === 'staff-row' ? '時間を縦軸に' : 'スタッフを縦軸に'}
                </Button>
              </div>
              {staff.length === 0 ? (
                <div className="py-8 text-center text-muted-foreground">スタッフが登録されていません</div>
              ) : axis === 'staff-row' ? (
                <div className="overflow-hidden rounded-lg border">
                  <div className="flex border-b bg-muted/30">
                    <div className="flex h-8 w-[56px] shrink-0 items-center justify-center border-r text-xs font-medium text-muted-foreground md:h-10 md:w-[64px]">
                      <User className="h-4 w-4" />
                    </div>
                    <div className="flex-1 overflow-x-auto" id="day-time-header">
                      <div className="flex min-w-max">
                        {SLOTS.map((s) => (
                          <div key={s.label} className="relative h-8 w-[7px] shrink-0 md:h-10 md:w-[10px]">
                            {s.minute === 0 ? (
                              <span className="absolute -left-[6px] bottom-0 top-0 flex items-center text-[10px] font-medium leading-none text-muted-foreground md:-left-[8px] md:text-xs md:leading-4">
                                {s.hour}
                              </span>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className="max-h-[350px] overflow-y-auto md:max-h-[420px]" id="day-staff-container">
                    {staff.map((st) => {
                      const list = active.filter((r) => r.staff_id === st.id);
                      const selected = staffFilter === st.id;
                      return (
                        <div
                          key={st.id}
                          className="flex border-b transition-colors last:border-b-0"
                          onDragOver={onDragOver}
                          onDragEnter={onDragEnter}
                          onDragLeave={onDragLeave}
                          onDrop={(e) => onDropStaff(e, st.id)}
                        >
                          <div
                            className={cx(
                              'flex h-[50px] w-[56px] shrink-0 cursor-pointer flex-col items-center justify-center border-r py-1 transition-colors md:h-[60px] md:w-[64px]',
                              selected ? 'bg-primary/10 ring-2 ring-inset ring-primary' : 'bg-muted/10 hover:bg-muted/30',
                            )}
                            onClick={() => setStaffFilter(st.id)}
                            title={st.display_name}
                          >
                            <Avatar
                              name={st.display_name}
                              src={st.avatar_url}
                              className={cx('h-6 w-6 md:h-8 md:w-8', selected && 'ring-2 ring-primary')}
                              fallbackClassName="text-[10px] md:text-xs"
                            />
                            <span
                              className={cx(
                                'mt-0.5 max-w-[52px] truncate text-[8px] md:max-w-[60px] md:text-[10px]',
                                selected ? 'font-medium text-primary' : 'text-muted-foreground',
                              )}
                            >
                              {st.display_name}
                            </span>
                          </div>
                          <div
                            className="day-time-scroll flex-1 overflow-x-auto"
                            onDragOver={onDragOver}
                            onDragEnter={onDragEnter}
                            onDragLeave={onDragLeave}
                            onDrop={(e) => onDropStaff(e, st.id)}
                            onScroll={(e) => {
                              const header = document.getElementById('day-time-header');
                              if (header) header.scrollLeft = e.currentTarget.scrollLeft;
                              document.querySelectorAll('.day-time-scroll').forEach((el) => {
                                if (el !== e.currentTarget) el.scrollLeft = e.currentTarget.scrollLeft;
                              });
                            }}
                          >
                            <div
                              className="relative flex h-[50px] min-w-max md:h-[60px]"
                              onDragOver={onDragOver}
                              onDrop={(e) => onDropStaff(e, st.id)}
                            >
                              {SLOTS.map((s) => (
                                <div
                                  key={s.label}
                                  className={cx(
                                    'w-[7px] shrink-0 cursor-pointer hover:bg-muted/30 md:w-[10px]',
                                    s.minute === 0
                                      ? 'border-l border-l-border'
                                      : s.minute % 15 === 0
                                        ? 'border-l border-l-border/30'
                                        : '',
                                    (shopClosed(date, s.hour, s.minute) || staffClosed(st.id, date, s.hour, s.minute)) &&
                                      'bg-gray-200/60',
                                  )}
                                  onDragOver={onDragOver}
                                  onDragEnter={onDragEnter}
                                  onDragLeave={onDragLeave}
                                  onDrop={(e) => onDropSlot(e, st.id, s.hour, s.minute)}
                                  onPointerDown={() => startPress(() => startCreate(date, s.hour))}
                                  onPointerUp={cancelPress}
                                  onPointerCancel={cancelPress}
                                  onContextMenu={(e) => e.preventDefault()}
                                />
                              ))}
                              {list.map((r) => {
                                const left = offsetOf(r.start_at);
                                const slotW = narrow ? 7 : 10;
                                const width = ((offsetOf(r.end_at) - left) / 5) * slotW;
                                return (
                                  <div
                                    key={r.id}
                                    data-appt={r.id}
                                    draggable
                                    onDragStart={(e) => onDragStart(e, r)}
                                    onDragEnd={onDragEnd}
                                    className={cx(
                                      'absolute bottom-1 top-1 cursor-grab overflow-hidden rounded-sm border px-1 py-0.5 text-[10px] md:px-2 md:text-xs',
                                      statusClass(r.status),
                                    )}
                                    style={{
                                      left: `${(left / 5) * slotW}px`,
                                      width: `${Math.max(width - 4, 30)}px`,
                                      ...categoryColorOf(r),
                                    }}
                                    title={`${r.customer_name} - ${menuName(r)}（ドラッグで移動）`}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      navigate(`/app/calendar/${r.id}`);
                                    }}
                                  >
                                    <div className="flex items-center gap-1 truncate font-medium">
                                      {r.customer_name}
                                      <BadgeChips badges={badges(r, 'row')} className={ROW_BADGE} />
                                    </div>
                                    <div className="truncate text-[8px] md:text-[10px]">{menuName(r)}</div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div className="overflow-hidden rounded-lg border">
                  <div className="flex border-b bg-muted/30">
                    <div className="flex h-[52px] w-[44px] shrink-0 items-center justify-center border-r text-xs font-medium text-muted-foreground md:h-[60px] md:w-[52px]">
                      <Clock className="h-4 w-4" />
                    </div>
                    <div className="flex-1 overflow-x-auto" id="day-staff-header">
                      <div className="flex min-w-max">
                        {staff.map((st) => {
                          const selected = staffFilter === st.id;
                          return (
                            <div
                              key={st.id}
                              className={cx(
                                'flex h-[52px] w-[80px] shrink-0 cursor-pointer flex-col items-center justify-center border-l py-1 transition-colors md:h-[60px] md:w-[100px]',
                                selected ? 'bg-primary/10 ring-2 ring-inset ring-primary' : 'hover:bg-muted/50',
                              )}
                              onClick={() => setStaffFilter(st.id)}
                              title={st.display_name}
                            >
                              <Avatar
                                name={st.display_name}
                                src={st.avatar_url}
                                className={cx('h-6 w-6 md:h-8 md:w-8', selected && 'ring-2 ring-primary')}
                                fallbackClassName="text-[10px] md:text-xs"
                              />
                              <span
                                className={cx(
                                  'mt-0.5 max-w-[76px] truncate text-[8px] md:max-w-[96px] md:text-[10px]',
                                  selected ? 'font-medium text-primary' : 'text-muted-foreground',
                                )}
                              >
                                {st.display_name}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                  <div
                    className="max-h-[500px] overflow-y-auto [--slot-h:10px] md:max-h-[700px] md:[--slot-h:11px]"
                    id="day-time-container"
                  >
                    <div className="flex">
                      <div className="w-[44px] shrink-0 md:w-[52px]">
                        {SLOTS.map((s) => (
                          <div
                            key={s.label}
                            className={cx(
                              'relative h-[var(--slot-h)] border-r',
                              shopClosed(date, s.hour, s.minute) && 'bg-gray-200/60',
                            )}
                          >
                            {s.minute === 0 || s.minute === 30 ? (
                              <span className="absolute -top-[7px] left-0 right-0 text-center text-[10px] font-medium leading-none text-muted-foreground md:-top-[8px] md:text-xs md:leading-4">
                                {s.label}
                              </span>
                            ) : null}
                          </div>
                        ))}
                      </div>
                      <div
                        className="flex-1 overflow-x-auto"
                        id="day-staff-body"
                        onScroll={(e) => {
                          const header = document.getElementById('day-staff-header');
                          if (header) header.scrollLeft = e.currentTarget.scrollLeft;
                        }}
                      >
                        <div className="flex min-w-max">
                          {staff.map((st) => {
                            const list = active.filter((r) => r.staff_id === st.id);
                            return (
                              <div key={st.id} className="relative w-[80px] shrink-0 border-l md:w-[100px]">
                                {SLOTS.map((s, i) => (
                                  <div
                                    key={s.label}
                                    className={cx(
                                      'h-[var(--slot-h)] cursor-pointer transition-colors hover:bg-muted/30',
                                      s.minute === 55
                                        ? 'border-b border-b-border'
                                        : s.minute % 15 === 10
                                          ? 'border-b border-b-border/30'
                                          : '',
                                      i === 0 && 'border-t border-t-border',
                                      (shopClosed(date, s.hour, s.minute) ||
                                        staffClosed(st.id, date, s.hour, s.minute)) &&
                                        'bg-gray-200/60',
                                    )}
                                    onPointerDown={() => startPress(() => startCreate(date, s.hour))}
                                    onPointerUp={cancelPress}
                                    onPointerCancel={cancelPress}
                                    onContextMenu={(e) => e.preventDefault()}
                                    onDragOver={onDragOver}
                                    onDragEnter={onDragEnter}
                                    onDragLeave={onDragLeave}
                                    onDrop={(e) => onDropSlot(e, st.id, s.hour, s.minute)}
                                  />
                                ))}
                                {list.map((r) => {
                                  const top = offsetOf(r.start_at);
                                  const minutes = offsetOf(r.end_at) - top;
                                  if (minutes <= 0) return null;
                                  const slots = minutes / 5;
                                  const s = zonedParts(r.start_at, tz);
                                  const e = zonedParts(r.end_at, tz);
                                  return (
                                    <div
                                      key={r.id}
                                      data-appt={r.id}
                                      draggable
                                      onDragStart={(ev) => onDragStart(ev, r)}
                                      onDragEnd={onDragEnd}
                                      className={cx(
                                        'absolute left-0.5 right-0.5 z-10 cursor-grab overflow-hidden rounded-sm border px-1 py-0.5',
                                        statusClass(r.status),
                                        dragging && 'pointer-events-none',
                                      )}
                                      style={{
                                        top: `calc(${top / 5} * var(--slot-h))`,
                                        height: `calc(${slots} * var(--slot-h) - 2px)`,
                                        ...categoryColorOf(r),
                                      }}
                                      title={`${r.customer_name} - ${menuName(r)}（ドラッグで移動）`}
                                      onClick={(ev) => {
                                        ev.stopPropagation();
                                        navigate(`/app/calendar/${r.id}`);
                                      }}
                                    >
                                      <div className="flex items-center gap-0.5">
                                        <BadgeChips badges={badges(r, 'block')} className={BLOCK_BADGE} />
                                      </div>
                                      <div className="truncate text-[11px] font-medium" style={{ color: '#1a1a1a' }}>
                                        {r.customer_name || '顧客'}
                                      </div>
                                      {slots >= 2 ? (
                                        <div className="truncate text-[10px]" style={{ color: '#1a1a1a' }}>
                                          {hm(s.hour, s.minute)}-{hm(e.hour, e.minute)}
                                        </div>
                                      ) : null}
                                      {slots >= 3 ? (
                                        <div className="truncate text-[9px] text-muted-foreground">{menuName(r)}</div>
                                      ) : null}
                                      {slots >= 5 && r.estimated_total ? (
                                        <div className="truncate text-[9px] text-muted-foreground">
                                          ¥{r.estimated_total.toLocaleString()}
                                        </div>
                                      ) : null}
                                    </div>
                                  );
                                })}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-5 md:gap-4">
        <Card>
          <CardContent className="p-3 md:p-4">
            <div className="text-xs text-muted-foreground md:text-sm">総予約数</div>
            <div className="text-xl font-bold md:text-2xl">{active.length}件</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 md:p-4">
            <div className="text-xs text-muted-foreground md:text-sm">確認待ち</div>
            <div className="text-xl font-bold text-yellow-600 md:text-2xl">
              {active.filter((r) => r.status === 'tentative').length}件
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 md:p-4">
            <div className="text-xs text-muted-foreground md:text-sm">確定済み</div>
            <div className="text-xl font-bold text-green-600 md:text-2xl">
              {active.filter((r) => r.status === 'confirmed').length}件
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 md:p-4">
            <div className="text-xs text-muted-foreground md:text-sm">売上見込</div>
            <div className="text-xl font-bold md:text-2xl">
              {formatCurrency(active.reduce((sum, r) => sum + (r.estimated_total || 0), 0))}
            </div>
          </CardContent>
        </Card>
        <Card
          className={cx('cursor-pointer transition-colors hover:bg-muted/50', showCancelled && 'ring-2 ring-red-300')}
          onClick={() => setShowCancelled((v) => !v)}
        >
          <CardContent className="p-3 md:p-4">
            <div className="text-xs text-muted-foreground md:text-sm">キャンセル</div>
            <div className="text-xl font-bold text-red-600 md:text-2xl">{cancelled.length}件</div>
          </CardContent>
        </Card>
      </div>

      {showCancelled && cancelled.length > 0 ? (
        <Card className="border-red-200">
          <CardContent className="p-3 md:p-4">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-sm font-medium text-red-600">キャンセル済み予約</div>
              <Button variant="ghost" size="sm" aria-label="閉じる" onClick={() => setShowCancelled(false)}>
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="sy-2">
              {cancelled.map((r) => (
                <div
                  key={r.id}
                  className="flex cursor-pointer items-center gap-3 rounded-md border border-red-100 bg-red-50 p-2 transition-colors hover:bg-red-100"
                  onClick={() => navigate(`/app/calendar/${r.id}`)}
                >
                  <div className="w-[70px] shrink-0 text-xs text-muted-foreground">
                    {timeOf(r.start_at)}~{timeOf(r.end_at)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">
                      {r.customer_name}
                      {reservationBadges(r, 'month')
                        .filter((b) => b.key === 'new')
                        .map((b) => (
                          <span
                            key={b.key}
                            className="inline-flex items-center ml-1 px-0.5 text-[7px] leading-[11px] text-white rounded-sm font-normal shrink-0"
                            style={{ backgroundColor: b.color }}
                          >
                            {b.label}
                          </span>
                        ))}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {menuName(r)} / {staffName(r)}
                    </div>
                  </div>
                  <div className="shrink-0">
                    <Badge variant="destructive" className="text-[10px]">
                      {r.status === 'no_show' ? '無断' : 'キャンセル'}
                    </Badge>
                  </div>
                  {r.estimated_total ? (
                    <div className="shrink-0 text-xs text-muted-foreground">{formatCurrency(r.estimated_total)}</div>
                  ) : null}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {ghost ? (
        <div
          id="week-drag-ghost"
          className="pointer-events-none fixed z-50 select-none"
          style={{
            left: ghost.colLeft,
            top: ghost.cellTop - 11 * ghost.cellHeight,
            width: ghost.colWidth,
            height: 12 * ghost.cellHeight,
          }}
        >
          <div className="h-full w-full rounded-sm border-2 border-dashed border-primary/60 bg-primary/20 px-1 py-0.5">
            <div className="flex items-center gap-0.5 text-[10px] font-bold text-primary md:text-xs">
              <Plus className="h-3 w-3" />
              新規予約
            </div>
            <div className="text-[9px] font-medium text-primary/80 md:text-[10px]">
              {(() => {
                const start = ghost.hour * 60 + ghost.minute - 55;
                return `${Math.max(0, Math.floor(start / 60))}:${pad2(Math.max(0, start % 60))} - ${ghost.hour}:${pad2(ghost.minute + 5)}`;
              })()}
            </div>
          </div>
        </div>
      ) : null}

    </div>
  );
}
