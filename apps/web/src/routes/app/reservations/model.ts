/**
 * 予約管理 (reservation calendar) model: the time grid, status / category colouring, badges and the
 * side-by-side layout of overlapping reservations. Pure functions, no React.
 */
import type { CSSProperties } from 'react';
import type { AppointmentListItem, AppointmentStatus } from '../../../api/types';

/** The grid shows 6:30 – 22:50 in 5-minute slots */
export const GRID_START_MIN = 6 * 60 + 30;

export interface Slot {
  hour: number;
  minute: number;
  /** "7:00" (no leading zero) */
  label: string;
}

export const SLOTS: Slot[] = (() => {
  const out: Slot[] = [];
  for (let hour = 6; hour <= 22; hour++) {
    for (let minute = 0; minute < 60; minute += 5) {
      if (hour === 6 && minute < 30) continue;
      if (hour === 22 && minute > 45) break;
      out.push({ hour, minute, label: `${hour}:${String(minute).padStart(2, '0')}` });
    }
  }
  return out;
})();

export const isInactive = (s: AppointmentStatus) => s === 'cancelled' || s === 'no_show';

/** Block colours by status (overridden by the menu category colour when there is one) */
export function statusClass(status: AppointmentStatus): string {
  switch (status) {
    case 'tentative':
      return 'bg-yellow-100 border-yellow-300 text-yellow-800';
    case 'confirmed':
      return 'bg-green-100 border-green-300 text-green-800';
    case 'completed':
      return 'bg-gray-100 border-gray-300 text-gray-600';
    case 'cancelled':
    case 'no_show':
      return 'bg-red-100 border-red-300 text-red-800 line-through';
    default:
      return 'bg-primary/10 border-primary/30';
  }
}

/** Category colour: tinted background, solid border, thick left edge */
export function categoryStyle(color: string | null | undefined, status: AppointmentStatus): CSSProperties {
  if (!color || isInactive(status)) return {};
  return { backgroundColor: `${color}20`, borderColor: color, borderLeftWidth: '4px' };
}

export interface ReservationBadge {
  key: string;
  label: string;
  /** inline background colour, or a class when `className` is set */
  color?: string;
  className?: string;
}

const MEDIA_ORIGIN_HPB = new Set(['hotpepper_mail', 'hotpepper']);

export const isHotPepper = (a: AppointmentListItem) =>
  a.source === 'phone_hpb' || MEDIA_ORIGIN_HPB.has(a.media_sync?.origin?.provider ?? '');

export const isNewCustomer = (a: AppointmentListItem) =>
  a.is_new_customer != null ? a.is_new_customer : a.customer_visit_count === 0;

/**
 * 1 = reflected on the booking medium, -1 = still to be reflected / failed, 0 = nothing to show.
 * A slot that staff must still block (or reopen) on a medium counts as -1: it is a double-booking risk.
 */
export function mediaSyncState(a: AppointmentListItem): -1 | 0 | 1 {
  const sync = a.media_sync;
  if (!sync) return 0;
  const bad = (s: string) => ['action_required', 'remove_required', 'error', 'conflict'].includes(s);
  if (sync.blocks.some((b) => bad(b.state))) return -1;
  if (sync.origin && bad(sync.origin.sync_state)) return -1;
  if (sync.origin || sync.blocks.length > 0) return 1;
  return 0;
}

export type BadgeSet = 'block' | 'row' | 'month' | 'search';

/**
 * Badges of a reservation. The order differs per place, as on the original screens:
 *  - block (week / day columns): 新, HPB, mini, 指名|フリー, 同意済, SB|SB!
 *  - row (staff rows):           新規, HPB, minimo, 同意済, 指名|フリー, SB|SB!
 *  - month:                      新規, HPB, minimo, 同意済
 *  - search:                     HPB, mini, 同意済
 */
export function reservationBadges(a: AppointmentListItem, set: BadgeSet, hasConsent = false): ReservationBadge[] {
  const fresh: ReservationBadge | null = isNewCustomer(a)
    ? { key: 'new', label: set === 'block' ? '新' : '新規', color: '#3A76FD' }
    : null;
  const hpb: ReservationBadge | null = isHotPepper(a) ? { key: 'hpb', label: 'HPB', color: '#CB006D' } : null;
  const minimo: ReservationBadge | null =
    a.source === 'minimo'
      ? { key: 'minimo', label: set === 'block' || set === 'search' ? 'mini' : 'minimo', color: '#00A7FF' }
      : null;
  const nominated: ReservationBadge = a.is_nominated
    ? { key: 'nominated', label: '指名', color: '#FD7878' }
    : { key: 'free', label: 'フリー', color: '#3A76FD' };
  const consent: ReservationBadge | null = hasConsent ? { key: 'consent', label: '同意済', color: '#F36C21' } : null;
  const sync = mediaSyncState(a);
  const sb: ReservationBadge | null =
    sync === 1
      ? { key: 'sb', label: 'SB', className: 'bg-blue-600' }
      : sync === -1
        ? { key: 'sb-error', label: 'SB!', className: 'bg-red-600' }
        : null;
  const pick = (...xs: (ReservationBadge | null)[]) => xs.filter((x): x is ReservationBadge => x !== null);
  switch (set) {
    case 'block':
      return pick(fresh, hpb, minimo, nominated, consent, sb);
    case 'row':
      return pick(fresh, hpb, minimo, consent, nominated, sb);
    case 'month':
      return pick(fresh, hpb, minimo, consent);
    case 'search':
      return pick(hpb, minimo, consent);
  }
}

export interface Span {
  id: string;
  top: number;
  bottom: number;
}

/**
 * Side-by-side columns for overlapping reservations of one day. Each reservation takes the first
 * column that is free at its start; reservations that overlap (directly or through a chain) share
 * the same column count, so a group of three is drawn in thirds.
 */
export function layoutOverlaps(spans: Span[]): Map<string, { col: number; total: number }> {
  const out = new Map<string, { col: number; total: number }>();
  if (spans.length === 0) return out;
  const sorted = [...spans].sort((a, b) => a.top - b.top || b.bottom - b.top - (a.bottom - a.top));
  const columnEnds: number[] = [];
  const colOf = new Map<string, number>();
  for (const s of sorted) {
    let col = columnEnds.findIndex((end) => s.top >= end);
    if (col === -1) {
      col = columnEnds.length;
      columnEnds.push(s.bottom);
    } else {
      columnEnds[col] = s.bottom;
    }
    colOf.set(s.id, col);
  }
  // union-find over overlapping pairs
  const parent = new Map<string, string>(sorted.map((s) => [s.id, s.id]));
  const find = (id: string): string => {
    let cur = id;
    while (parent.get(cur) !== cur) {
      parent.set(cur, parent.get(parent.get(cur)!)!);
      cur = parent.get(cur)!;
    }
    return cur;
  };
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j]!.top < sorted[i]!.bottom) {
        const a = find(sorted[i]!.id);
        const b = find(sorted[j]!.id);
        if (a !== b) parent.set(a, b);
      }
    }
  }
  const maxCol = new Map<string, number>();
  for (const s of sorted) {
    const root = find(s.id);
    maxCol.set(root, Math.max(maxCol.get(root) ?? 0, colOf.get(s.id)!));
  }
  for (const s of sorted) out.set(s.id, { col: colOf.get(s.id)!, total: maxCol.get(find(s.id))! + 1 });
  return out;
}

/** 14:05 without a leading zero on the hour ("9:05"), as shown inside the blocks */
export const hm = (hour: number, minute: number) => `${hour}:${String(minute).padStart(2, '0')}`;

const yenFormat = new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY' });
/** ￥9,900 */
export const formatCurrency = (amount: number) => yenFormat.format(amount);

/** 45分 / 1時間 / 1時間30分 */
export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h === 0 ? `${m}分` : m === 0 ? `${h}時間` : `${h}時間${m}分`;
}

/** A menu picked for a reservation (carried between the form and the menu picker) */
export interface PickedMenu {
  id: string;
  name: string;
  duration: number;
  price: number;
}

/** Booking routes of the reservation form, in the order the front desk is used to */
export const BOOKING_ROUTES: { value: string; label: string; source: import('../../../api/types').AppointmentSource }[] = [
  { value: 'phone', label: '電話（自社）', source: 'phone' },
  { value: 'phone-hpb', label: '電話（HPB）', source: 'phone_hpb' },
  { value: 'line', label: '公式LINE', source: 'line' },
  { value: 'next-visit', label: '次回予約', source: 'next_visit' },
  { value: 'walk-in', label: '直接来店', source: 'walk_in' },
  { value: 'instagram', label: 'インスタ', source: 'instagram' },
  { value: 'minimo', label: 'minimo', source: 'minimo' },
  { value: 'nailie', label: 'ネイリー', source: 'nailie' },
  { value: 'friend', label: '友人', source: 'referral' },
  { value: 'practice-model', label: '練習モデル', source: 'practice_model' },
  { value: 'fix', label: 'お直し', source: 'redo' },
  { value: 'web', label: 'Web', source: 'web' },
];
