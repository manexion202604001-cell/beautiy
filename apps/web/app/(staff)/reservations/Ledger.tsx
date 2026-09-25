'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, Plus, StickyNote, UserRound, Wallet, ClipboardCheck, BellRing } from 'lucide-react';
import { jaWeekday, minutesToHHMM, toLocalParts } from '@salonos/core';
import { moveAppointmentAction } from './actions';
import { AppointmentDrawer } from './AppointmentDrawer';
import { KIND_LABEL, SOURCE_LABEL, STATUS_LABEL, STATUS_TONE } from './labels';
import type {
  CouponOption, CreatePreset, DrawerMode, ForeignBlock, LedgerAppt, LedgerDay, MenuOption, PendingRequest, Perms, ShopInfo, StaffColumn, StaffOption,
} from './types';

const ROW_H = 16; // px per 15 minutes
const SLOT = 15;
const MOVABLE = new Set(['REQUESTED', 'CONFIRMED', 'ARRIVED', 'IN_SERVICE']);
const OCCUPYING = new Set(['REQUESTED', 'CONFIRMED', 'ARRIVED', 'IN_SERVICE', 'COMPLETED']);

interface Col {
  key: string; date: string; staffId: string | null | undefined; label: string; sub?: string; imageUrl?: string | null;
  openMin: number | null; closeMin: number | null; holiday: string | null; weekday: number;
}

interface Props {
  shop: ShopInfo; view: 'day' | 'week'; date: string; from: string; today: string; prevDate: string; nextDate: string;
  days: LedgerDay[]; columns: StaffColumn[]; appts: LedgerAppt[]; foreign: ForeignBlock[];
  staffOptions: StaffOption[]; menus: MenuOption[]; coupons: CouponOption[]; pending: PendingRequest[]; perms: Perms;
  preset?: CreatePreset; openId?: string;
}

interface Toast { id: number; text: string; tone: 'info' | 'error' | 'warn' }

interface DragState {
  id: string; mode: 'move' | 'resize'; x0: number; y0: number; col0: number; start0: number; end0: number;
  col: number; startMin: number; endMin: number; moved: boolean; pointerType: string; armed: boolean;
}

const dateLabel = (d: string) => {
  const [, m, day] = d.split('-').map(Number);
  return `${m}/${day}(${jaWeekday(new Date(d + 'T00:00:00Z').getUTCDay())})`;
};

/** Side-by-side lanes for overlapping blocks inside one column. */
function layoutLanes<T extends { id: string; startMin: number; endMin: number }>(items: T[]) {
  const sorted = [...items].sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);
  const out = new Map<string, { lane: number; lanes: number }>();
  let cluster: T[] = [], laneEnds: number[] = [], clusterEnd = -1;
  const flush = () => { for (const it of cluster) out.get(it.id)!.lanes = laneEnds.length; cluster = []; laneEnds = []; };
  for (const it of sorted) {
    if (it.startMin >= clusterEnd && cluster.length) flush();
    let lane = laneEnds.findIndex((e) => e <= it.startMin);
    if (lane < 0) { lane = laneEnds.length; laneEnds.push(it.endMin); } else laneEnds[lane] = it.endMin;
    out.set(it.id, { lane, lanes: 1 });
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.endMin);
  }
  if (cluster.length) flush();
  return out;
}

export function Ledger(props: Props) {
  const { shop, view, date, today, perms } = props;
  const router = useRouter();
  const [appts, setAppts] = useState<LedgerAppt[]>(props.appts);
  useEffect(() => setAppts(props.appts), [props.appts]);
  const [staffFilter, setStaffFilter] = useState<string>('');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; key: number } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const drawerSeq = useRef(0);

  const toast = useCallback((text: string, tone: Toast['tone'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 7000 : 4500);
  }, []);

  const openDrawer = useCallback((mode: DrawerMode) => {
    drawerSeq.current += 1;
    setToasts([]);
    setDrawer({ mode, key: drawerSeq.current });
  }, []);

  // Deep links: ?appt=<id> opens an appointment; ?waitlist=<id> opens a prefilled create drawer.
  useEffect(() => {
    if (props.preset) openDrawer({ kind: 'create', preset: props.preset });
    else if (props.openId) openDrawer({ kind: 'edit', id: props.openId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── columns ──
  const cols: Col[] = useMemo(() => {
    if (view === 'day') {
      const d = props.days[0];
      const base = { date, openMin: d?.openMin ?? null, closeMin: d?.closeMin ?? null, holiday: d?.holiday ?? null, weekday: d?.weekday ?? 0 };
      const list: Col[] = props.columns.map((c) => ({ ...base, key: c.staffId, staffId: c.staffId, label: c.name, imageUrl: c.imageUrl }));
      list.push({ ...base, key: '__none', staffId: null, label: '未割当', sub: '担当未定' });
      return list;
    }
    return props.days.map((d) => ({
      key: d.date, date: d.date, staffId: undefined, label: dateLabel(d.date), sub: d.holiday ?? (d.openMin === null ? '定休日' : `${minutesToHHMM(d.openMin)}–${minutesToHHMM(d.closeMin!)}`),
      openMin: d.openMin, closeMin: d.closeMin, holiday: d.holiday, weekday: d.weekday,
    }));
  }, [view, date, props.days, props.columns]);

  const visible = useMemo(() => appts.filter((a) => OCCUPYING.has(a.status) && (view === 'week' || a.date === date) && (!staffFilter || view === 'day' || a.staffId === staffFilter)), [appts, view, date, staffFilter]);
  const inactive = useMemo(() => appts.filter((a) => !OCCUPYING.has(a.status)), [appts]);

  const colIndexOf = useCallback((a: { date: string; staffId: string | null }) => {
    if (view === 'week') return cols.findIndex((c) => c.date === a.date);
    const i = cols.findIndex((c) => c.staffId === a.staffId);
    return i >= 0 ? i : cols.length - 1;
  }, [cols, view]);

  // ── time axis ──
  const [axisStart, axisEnd] = useMemo(() => {
    const opens = cols.map((c) => c.openMin).filter((x): x is number => x !== null);
    const closes = cols.map((c) => c.closeMin).filter((x): x is number => x !== null);
    let s = opens.length ? Math.min(...opens) : 600, e = closes.length ? Math.max(...closes) : 1200;
    for (const a of visible) { s = Math.min(s, a.startMin); e = Math.max(e, a.endMin); }
    s = Math.max(0, Math.floor(s / 60) * 60 - 60);
    e = Math.min(1440, Math.ceil(e / 60) * 60 + 60);
    return [s, e];
  }, [cols, visible]);
  const rows = (axisEnd - axisStart) / SLOT;
  const yOf = (min: number) => ((min - axisStart) / SLOT) * ROW_H;

  // ── now line ──
  const [nowMin, setNowMin] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => { const p = toLocalParts(new Date(), shop.timezone); setNowMin(p.date === today ? p.minutes : null); };
    tick();
    const t = setInterval(tick, 60_000);
    return () => clearInterval(t);
  }, [shop.timezone, today]);

  // initial scroll: now (today) or opening time
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const p = toLocalParts(new Date(), shop.timezone);
    const target = p.date === today && cols.some((c) => c.date === today) ? p.minutes - 90 : (cols.find((c) => c.openMin !== null)?.openMin ?? axisStart) - 30;
    el.scrollTop = Math.max(0, yOf(Math.max(axisStart, target)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── drag & drop ──
  const dragRef = useRef<DragState | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Block native scrolling while a touch drag is active.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const h = (e: TouchEvent) => { if (dragRef.current?.armed) e.preventDefault(); };
    el.addEventListener('touchmove', h, { passive: false });
    return () => el.removeEventListener('touchmove', h);
  }, []);

  const commit = useCallback(async (d: DragState, allowOverCapacity = false): Promise<void> => {
    const a = appts.find((x) => x.id === d.id);
    if (!a) return;
    const col = cols[d.col];
    const newDate = col.date;
    const staffChange = view === 'day' && col.staffId !== a.staffId ? (col.staffId ?? null) : undefined;
    if (newDate === a.date && d.startMin === a.startMin && d.endMin === a.endMin && staffChange === undefined) return;
    const before = appts;
    setAppts((list) => list.map((x) => (x.id === a.id ? { ...x, date: newDate, startMin: d.startMin, endMin: d.endMin, staffId: staffChange === undefined ? x.staffId : staffChange } : x)));
    setBusyId(a.id);
    try {
      const r = await moveAppointmentAction({ id: a.id, date: newDate, startMin: d.startMin, endMin: d.endMin, staffId: staffChange, allowOverCapacity });
      if (!r.ok) {
        if (r.code === 'SEAT_CAPACITY' && !allowOverCapacity && window.confirm('席数を超えますが登録しますか？')) {
          setAppts(before);
          return commit(d, true);
        }
        setAppts(before);
        toast(r.error, 'error');
        return;
      }
      const ws = r.data?.warnings ?? [];
      toast(ws.length ? `移動しました（注意：${ws.join('・')}）` : d.mode === 'resize' ? '時間を変更しました' : '予約を移動しました', ws.length ? 'warn' : 'info');
      router.refresh();
    } catch {
      setAppts(before);
      toast('通信に失敗しました。もう一度お試しください。', 'error');
    } finally {
      setBusyId(null);
    }
  }, [appts, cols, view, router, toast]);

  const onBlockPointerDown = (e: RPointerEvent, a: LedgerAppt, mode: 'move' | 'resize') => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.stopPropagation();
    const canDrag = perms.write && MOVABLE.has(a.status) && busyId !== a.id;
    const d: DragState = {
      id: a.id, mode, x0: e.clientX, y0: e.clientY, col0: colIndexOf(a), start0: a.startMin, end0: a.endMin,
      col: colIndexOf(a), startMin: a.startMin, endMin: a.endMin, moved: false, pointerType: e.pointerType, armed: e.pointerType !== 'touch' && canDrag,
    };
    dragRef.current = d;
    if (e.pointerType === 'touch' && canDrag) {
      // long-press to start dragging on touch devices; a quick swipe scrolls instead
      holdTimer.current = setTimeout(() => {
        if (dragRef.current && !dragRef.current.moved) { dragRef.current = { ...dragRef.current, armed: true }; setDrag(dragRef.current); navigator.vibrate?.(15); }
      }, 350);
    }

    const move = (ev: PointerEvent) => {
      const cur = dragRef.current;
      if (!cur) return;
      const dx = ev.clientX - cur.x0, dy = ev.clientY - cur.y0;
      if (!cur.armed) {
        if (Math.abs(dx) > 8 || Math.abs(dy) > 8) { cur.moved = true; if (holdTimer.current) clearTimeout(holdTimer.current); }
        return;
      }
      const delta = Math.round(dy / ROW_H) * SLOT;
      let next: DragState;
      if (cur.mode === 'resize') {
        const endMin = Math.min(axisEnd, Math.max(cur.start0 + SLOT, cur.end0 + delta));
        next = { ...cur, endMin, moved: cur.moved || Math.abs(dy) > 3 };
      } else {
        const dur = cur.end0 - cur.start0;
        const startMin = Math.min(axisEnd - dur, Math.max(axisStart, cur.start0 + delta));
        let col = cur.col;
        const hit = document.elementsFromPoint(ev.clientX, ev.clientY).find((el) => (el as HTMLElement).dataset?.colIdx !== undefined) as HTMLElement | undefined;
        if (hit) col = Number(hit.dataset.colIdx);
        next = { ...cur, startMin, endMin: startMin + dur, col, moved: cur.moved || Math.abs(dy) > 3 || Math.abs(dx) > 3 };
      }
      dragRef.current = next;
      setDrag(next);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      if (holdTimer.current) clearTimeout(holdTimer.current);
      const cur = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!cur) return;
      if (!cur.moved) { openDrawer({ kind: 'edit', id: cur.id }); return; }
      if (cur.armed) void commit(cur);
    };
    const cancel = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      if (holdTimer.current) clearTimeout(holdTimer.current);
      dragRef.current = null;
      setDrag(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  };

  const onSlotClick = (col: Col, min: number) => {
    if (!perms.write) return;
    openDrawer({
      kind: 'create',
      preset: { date: col.date, startMin: min, staffMode: view === 'week' ? 'auto' : col.staffId ? 'staff' : 'none', staffId: view === 'day' ? col.staffId ?? null : null },
    });
  };

  const hrefFor = (v: 'day' | 'week', d: string) => `/reservations?view=${v}&date=${d}`;
  const stats = useMemo(() => {
    const real = visible.filter((a) => a.kind !== 'PRIVATE');
    return { count: real.length, sales: real.reduce((s, a) => s + a.totalPrice, 0), requested: real.filter((a) => a.status === 'REQUESTED').length };
  }, [visible]);

  const minColW = view === 'day' ? 150 : 128;

  return (
    <div className="stack rsv">
      {/* toolbar */}
      <div className="rsv-toolbar">
        <div className="row-wrap">
          <div className="row" style={{ gap: 4 }}>
            <Link className="icon-btn" href={hrefFor(view, props.prevDate)} aria-label={view === 'day' ? '前の日' : '前の週'}><ChevronLeft size={16} /></Link>
            <Link className="btn secondary sm" href={hrefFor(view, today)}>今日</Link>
            <Link className="icon-btn" href={hrefFor(view, props.nextDate)} aria-label={view === 'day' ? '次の日' : '次の週'}><ChevronRight size={16} /></Link>
          </div>
          <label className="rsv-date">
            <CalendarDays size={15} />
            <input
              type="date" className="input sm" value={date} aria-label="日付を選択"
              onChange={(e) => e.target.value && router.push(hrefFor(view, e.target.value))}
            />
          </label>
          <h2 className="rsv-title">
            {view === 'day' ? dateLabel(date) : `${dateLabel(props.from)} 〜 ${dateLabel(props.days[props.days.length - 1]?.date ?? props.from)}`}
            {view === 'day' && props.days[0]?.holiday && <span className="badge red" style={{ marginLeft: 8 }}>{props.days[0].holiday}</span>}
            {view === 'day' && !props.days[0]?.holiday && props.days[0]?.openMin === null && <span className="badge" style={{ marginLeft: 8 }}>定休日</span>}
          </h2>
        </div>
        <div className="row-wrap">
          {view === 'week' && (
            <select className="select sm" value={staffFilter} onChange={(e) => setStaffFilter(e.target.value)} aria-label="スタッフで絞り込み" style={{ width: 'auto' }}>
              <option value="">全スタッフ</option>
              {props.columns.map((c) => <option key={c.staffId} value={c.staffId}>{c.name}</option>)}
            </select>
          )}
          <div className="seg" role="tablist" aria-label="表示切替">
            <Link className={view === 'day' ? 'active' : ''} href={hrefFor('day', date)}>日</Link>
            <Link className={view === 'week' ? 'active' : ''} href={hrefFor('week', date)}>週</Link>
          </div>
          {perms.write && (
            <button type="button" className="btn" onClick={() => {
              const p = toLocalParts(new Date(), shop.timezone);
              const base = view === 'day' ? date : (date >= props.from ? date : props.from);
              const min = base === today ? Math.min(1425, Math.ceil(p.minutes / SLOT) * SLOT) : (cols[0]?.openMin ?? 600);
              openDrawer({ kind: 'create', preset: { date: base, startMin: min, staffMode: 'auto' } });
            }}><Plus size={16} />新規予約</button>
          )}
        </div>
      </div>

      <div className="rsv-summary">
        <span>予約 <b className="num">{stats.count}</b> 件</span>
        <span>売上見込 <b className="num">¥{stats.sales.toLocaleString('ja-JP')}</b></span>
        {stats.requested > 0 && <span className="badge amber">承認待ち {stats.requested}</span>}
        <span className="rsv-legend">
          {(['REQUESTED', 'CONFIRMED', 'ARRIVED', 'IN_SERVICE', 'COMPLETED'] as const).map((s) => <span key={s} className={`rsv-chip s-${s}`}>{STATUS_LABEL[s]}</span>)}
          <span className="rsv-chip k-PRIVATE">プライベート</span>
        </span>
      </div>

      {props.pending.length > 0 && (
        <div className="alert warn rsv-pending">
          <BellRing size={15} />
          <span>承認待ちのネット予約リクエストが <b>{props.pending.length}</b> 件あります：</span>
          {props.pending.slice(0, 6).map((p) => (
            <button key={p.id} type="button" className="link rsv-linkbtn" onClick={() => openDrawer({ kind: 'edit', id: p.id })}>
              {dateLabel(p.date)} {p.time} {p.name}
            </button>
          ))}
        </div>
      )}

      {props.columns.length === 0 && view === 'day' && (
        <div className="alert info">この店舗にはネット予約・台帳に表示するスタッフが登録されていません。設定 &gt; スタッフ で「予約受付」を有効にしてください（未割当の列には予約を登録できます）。</div>
      )}

      {/* grid */}
      <div className={`ledger rsv-ledger ${drag?.armed ? 'is-dragging' : ''}`} ref={scrollRef}>
        <div className="ledger-grid" style={{ gridTemplateColumns: `56px repeat(${cols.length}, minmax(${minColW}px, 1fr))` }}>
          <div className="ledger-head rsv-corner" />
          {cols.map((c) => {
            const count = visible.filter((a) => (view === 'week' ? a.date === c.date : colIndexOf(a) === cols.indexOf(c)) && a.kind !== 'PRIVATE').length;
            return (
              <div key={c.key} className={`ledger-head rsv-colhead ${c.date === today && view === 'week' ? 'is-today' : ''} ${c.holiday || c.openMin === null ? 'is-closed' : ''}`}>
                {view === 'week' ? (
                  <Link href={hrefFor('day', c.date)} className="rsv-colhead-link">
                    <span className={c.weekday === 0 ? 'sun' : c.weekday === 6 ? 'sat' : ''}>{c.label}</span>
                    <span className="sub">{c.sub}</span>
                  </Link>
                ) : (
                  <div className="row" style={{ gap: 8 }}>
                    <span className="avatar rsv-avatar">{c.imageUrl ? <img src={c.imageUrl} alt="" /> : c.staffId ? c.label.slice(0, 1) : <UserRound size={14} />}</span>
                    <div style={{ minWidth: 0 }}>
                      <div className="rsv-colname">{c.label}</div>
                      <div className="sub">{count}件{c.sub ? `・${c.sub}` : ''}</div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {/* time axis */}
          <div className="ledger-time" style={{ height: rows * ROW_H }}>
            {Array.from({ length: (axisEnd - axisStart) / 60 }, (_, i) => (
              <div key={i} className="rsv-hour" style={{ height: ROW_H * 4 }}><span>{minutesToHHMM(axisStart + i * 60)}</span></div>
            ))}
          </div>

          {cols.map((c, ci) => {
            const colAppts = visible.filter((a) => colIndexOf(a) === ci);
            const lanes = layoutLanes(colAppts);
            const foreign = view === 'day' ? props.foreign.filter((f) => f.staffId === c.staffId && f.date === date) : [];
            const ghost = drag && drag.armed && drag.moved && drag.col === ci ? drag : null;
            return (
              <div key={c.key} className="ledger-col" data-col-idx={ci} style={{ height: rows * ROW_H }}>
                {Array.from({ length: rows }, (_, r) => {
                  const min = axisStart + r * SLOT;
                  const closed = !!c.holiday || c.openMin === null || min < c.openMin || min >= (c.closeMin ?? 0);
                  return (
                    <div
                      key={r}
                      className={`ledger-slot ${(min + SLOT) % 60 === 0 ? 'hour' : ''} ${closed ? 'closed' : ''} ${perms.write ? 'rsv-clickable' : ''}`}
                      style={{ height: ROW_H }}
                      data-col-idx={ci}
                      onClick={() => onSlotClick(c, min)}
                      title={perms.write ? `${minutesToHHMM(min)} に予約を追加` : undefined}
                    />
                  );
                })}
                {foreign.map((f, i) => (
                  <div key={i} className="rsv-foreign" style={{ top: yOf(f.startMin), height: Math.max(ROW_H, yOf(f.endMin) - yOf(f.startMin)) }} title={`${f.shopName}で予約あり`}>
                    {f.shopName}
                  </div>
                ))}
                {colAppts.map((a) => {
                  const l = lanes.get(a.id) ?? { lane: 0, lanes: 1 };
                  const isDragging = drag?.id === a.id && drag.armed && drag.moved;
                  const top = yOf(a.startMin);
                  const height = Math.max(ROW_H + 2, yOf(a.endMin) - top - 2);
                  return (
                    <div
                      key={a.id}
                      role="button"
                      tabIndex={0}
                      className={`appt-block s-${a.status} k-${a.kind} ${isDragging ? 'dragging' : ''} ${busyId === a.id ? 'rsv-busy' : ''} ${perms.write && MOVABLE.has(a.status) ? 'rsv-movable' : ''}`}
                      style={{ top, height, left: `calc(${(l.lane / l.lanes) * 100}% + 3px)`, width: `calc(${100 / l.lanes}% - 6px)`, right: 'auto' }}
                      onPointerDown={(e) => onBlockPointerDown(e, a, 'move')}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDrawer({ kind: 'edit', id: a.id }); } }}
                      aria-label={`${minutesToHHMM(a.startMin)} ${a.customerName ?? a.title ?? ''} ${STATUS_LABEL[a.status]}`}
                    >
                      <BlockBody a={a} narrow={l.lanes >= (view === 'week' ? 2 : 3)} showStaff={view === 'week' ? props.columns.find((s) => s.staffId === a.staffId)?.name ?? (a.staffId ? '' : '未割当') : null} />
                      {perms.write && MOVABLE.has(a.status) && <div className="resize" onPointerDown={(e) => onBlockPointerDown(e, a, 'resize')} aria-hidden />}
                    </div>
                  );
                })}
                {ghost && (() => {
                  const a = appts.find((x) => x.id === ghost.id);
                  if (!a) return null;
                  const top = yOf(ghost.startMin);
                  return (
                    <div className={`appt-block s-${a.status} k-${a.kind} rsv-ghost`} style={{ top, height: Math.max(ROW_H, yOf(ghost.endMin) - top - 2) }}>
                      <div className="rsv-time">{minutesToHHMM(ghost.startMin)}–{minutesToHHMM(ghost.endMin)}</div>
                      <div className="rsv-name">{a.customerName ?? a.title}</div>
                    </div>
                  );
                })()}
                {nowMin !== null && c.date === today && nowMin >= axisStart && nowMin <= axisEnd && (
                  <div className="now-line" style={{ top: yOf(nowMin) }} />
                )}
              </div>
            );
          })}
        </div>
      </div>
      {perms.write && <p className="sub hide-sm" style={{ margin: 0 }}>空き枠をクリックで新規予約・予約をドラッグで移動／下端をドラッグで時間変更（15分単位）。スマートフォンでは長押しで移動できます。</p>}

      {inactive.length > 0 && (
        <details className="card pad-sm rsv-inactive">
          <summary><b>キャンセル・無断キャンセル</b> <span className="badge">{inactive.length}</span></summary>
          <div className="list" style={{ marginTop: 8 }}>
            {inactive.map((a) => (
              <button key={a.id} type="button" className="list-item rsv-inactive-row" onClick={() => openDrawer({ kind: 'edit', id: a.id })}>
                <span className="num nowrap">{view === 'week' ? `${dateLabel(a.date)} ` : ''}{minutesToHHMM(a.startMin)}</span>
                <span className="grow">{a.customerName ?? a.title ?? '—'}<span className="sub">　{a.menus.join('・')}</span></span>
                <span className={`badge ${STATUS_TONE[a.status]}`}>{STATUS_LABEL[a.status]}</span>
              </button>
            ))}
          </div>
        </details>
      )}

      {drawer && (
        <AppointmentDrawer
          key={drawer.key}
          mode={drawer.mode}
          shop={shop}
          today={today}
          menus={props.menus}
          coupons={props.coupons}
          staffOptions={props.staffOptions}
          perms={perms}
          onClose={() => setDrawer(null)}
          onDone={(msg, warnings) => {
            setDrawer(null);
            toast(warnings.length ? `${msg}（注意：${warnings.join('・')}）` : msg, warnings.length ? 'warn' : 'info');
            router.refresh();
          }}
          onChanged={() => router.refresh()}
        />
      )}

      <div className="toast-stack" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.tone === 'error' ? 'error' : ''} ${t.tone === 'warn' ? 'rsv-toast-warn' : ''}`}>{t.text}</div>)}
      </div>
    </div>
  );
}

function BlockBody({ a, showStaff, narrow }: { a: LedgerAppt; showStaff: string | null; narrow?: boolean }) {
  const dur = a.endMin - a.startMin;
  const name = a.kind === 'PRIVATE' ? (a.title ?? 'プライベート') : (a.customerName ?? 'ゲスト');
  if (narrow) {
    return (
      <div className="rsv-narrow">
        <div className="rsv-time">{minutesToHHMM(a.startMin)}</div>
        <div className="rsv-name">{name}</div>
      </div>
    );
  }
  if (dur < 45) {
    return (
      <div className="rsv-compact">
        <span className="rsv-time">{minutesToHHMM(a.startMin)}</span> <b>{name}</b>
        {a.status === 'REQUESTED' && <span className="rsv-kind">要承認</span>}
        {a.menus.length > 0 && <span className="rsv-menus"> {a.menus.join('・')}</span>}
      </div>
    );
  }
  return (
    <>
      <div className="rsv-time">
        {minutesToHHMM(a.startMin)}–{minutesToHHMM(a.endMin)}
        {a.kind !== 'PRIVATE' && <span className={`rsv-src src-${a.source}`}>{SOURCE_LABEL[a.source] ?? a.source}</span>}
        {a.nominated && <span className="rsv-src rsv-nom">指名</span>}
      </div>
      <div className="rsv-name">
        {name}
        {a.kind === 'CONSULTATION' && <span className="rsv-kind">{KIND_LABEL.CONSULTATION}</span>}
        {a.status === 'REQUESTED' && <span className="rsv-kind">要承認</span>}
      </div>
      {dur >= 45 && a.menus.length > 0 && <div className="rsv-menus">{a.menus.join('・')}</div>}
      {dur >= 60 && showStaff !== null && showStaff !== '' && <div className="rsv-menus">担当：{showStaff}</div>}
      {dur >= 30 && (
        <div className="rsv-icons">
          {a.hasNote && <StickyNote size={11} aria-label="メモあり" />}
          {a.hasKarte && <ClipboardCheck size={11} aria-label="カルテあり" />}
          {a.paid && <Wallet size={11} aria-label="会計済み" />}
        </div>
      )}
    </>
  );
}
