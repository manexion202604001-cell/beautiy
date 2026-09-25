// Reservation engine: pure conflict / capacity / availability rules.
// The DB layer must evaluate these inside a transaction guarded by a shop-level lock.

export interface Interval { start: number; end: number } // epoch ms, half-open [start,end)

export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Maximum number of intervals simultaneously active inside `window`. */
export function maxConcurrency(intervals: Interval[], window: Interval): number {
  const events: [number, number][] = [];
  for (const iv of intervals) {
    if (!overlaps(iv, window)) continue;
    events.push([Math.max(iv.start, window.start), 1]);
    events.push([Math.min(iv.end, window.end), -1]);
  }
  // ends before starts at the same instant (half-open intervals)
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0, max = 0;
  for (const [, d] of events) { cur += d; if (cur > max) max = cur; }
  return max;
}

export type BookingConflict =
  | 'INVALID_RANGE' | 'STAFF_CONFLICT' | 'SEAT_CAPACITY' | 'OUTSIDE_HOURS' | 'HOLIDAY' | 'IN_PAST' | 'TOO_SOON';

export interface CanBookInput {
  candidate: Interval;
  /** Busy windows of the requested staff (appointments incl. private, holds). */
  staffBusy?: Interval[];
  /** Windows occupying a seat in the shop (non-private appointments, holds). */
  seatBusy: Interval[];
  seatCapacity: number;
  /** Candidate occupies a seat (false for private staff blocks). */
  usesSeat?: boolean;
  /** Shop-local open window for the day, as absolute ms. null = closed. */
  openWindow?: Interval | null;
  holiday?: boolean;
  now?: number;
  minNoticeMin?: number;
}

export type CanBookResult = { ok: true; warnings: BookingConflict[] } | { ok: false; reason: BookingConflict; warnings: BookingConflict[] };

/**
 * Hard rules: valid range, no staff double-booking, seat capacity.
 * Soft rules (returned as warnings so staff can override, enforced for public booking):
 * outside business hours, holiday, past, min notice.
 */
export function canBook(input: CanBookInput): CanBookResult {
  const { candidate } = input;
  const warnings: BookingConflict[] = [];
  if (!(candidate.end > candidate.start)) return { ok: false, reason: 'INVALID_RANGE', warnings };
  if (input.holiday) warnings.push('HOLIDAY');
  if (input.openWindow === null) warnings.push('OUTSIDE_HOURS');
  else if (input.openWindow && (candidate.start < input.openWindow.start || candidate.end > input.openWindow.end)) warnings.push('OUTSIDE_HOURS');
  if (input.now !== undefined) {
    if (candidate.start < input.now) warnings.push('IN_PAST');
    else if (input.minNoticeMin && candidate.start < input.now + input.minNoticeMin * 60000) warnings.push('TOO_SOON');
  }
  if (input.staffBusy?.some((x) => overlaps(candidate, x))) return { ok: false, reason: 'STAFF_CONFLICT', warnings };
  if (input.usesSeat !== false) {
    const used = maxConcurrency(input.seatBusy, candidate);
    if (used + 1 > input.seatCapacity) return { ok: false, reason: 'SEAT_CAPACITY', warnings };
  }
  return { ok: true, warnings };
}

export interface AvailabilityStaff { id: string; busy: Interval[] }

export interface AvailabilityInput {
  /** Day open/close as absolute ms; null when closed. */
  openWindow: Interval | null;
  holiday: boolean;
  durationMin: number;
  slotIntervalMin: number;
  seatCapacity: number;
  seatBusy: Interval[];
  staff: AvailabilityStaff[];
  /** When set, only this staff member may serve. */
  staffId?: string | null;
  now: number;
  minNoticeMin: number;
}

export interface Slot { start: number; end: number; staffIds: string[] }

/** Enumerate bookable start times for one day (public booking). */
export function computeAvailability(input: AvailabilityInput): Slot[] {
  if (!input.openWindow || input.holiday || input.durationMin <= 0) return [];
  const step = Math.max(5, input.slotIntervalMin) * 60000;
  const dur = input.durationMin * 60000;
  const earliest = input.now + input.minNoticeMin * 60000;
  const candidates = input.staffId ? input.staff.filter((s) => s.id === input.staffId) : input.staff;
  const slots: Slot[] = [];
  for (let t = input.openWindow.start; t + dur <= input.openWindow.end; t += step) {
    if (t < earliest) continue;
    const window = { start: t, end: t + dur };
    if (maxConcurrency(input.seatBusy, window) + 1 > input.seatCapacity) continue;
    const free = candidates.filter((s) => !s.busy.some((b) => overlaps(b, window))).map((s) => s.id);
    if (free.length === 0) continue;
    slots.push({ start: t, end: t + dur, staffIds: free });
  }
  return slots;
}

/** Pick staff for a no-preference booking: least-loaded that day, then stable order. */
export function pickStaff(staffIds: string[], loadByStaff: Record<string, number>): string | null {
  if (staffIds.length === 0) return null;
  return [...staffIds].sort((a, b) => (loadByStaff[a] ?? 0) - (loadByStaff[b] ?? 0))[0];
}

export const STATUS_TRANSITIONS: Record<string, string[]> = {
  REQUESTED: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['ARRIVED', 'IN_SERVICE', 'COMPLETED', 'CANCELLED', 'NO_SHOW', 'REQUESTED'],
  ARRIVED: ['IN_SERVICE', 'COMPLETED', 'CANCELLED', 'CONFIRMED'],
  IN_SERVICE: ['COMPLETED', 'ARRIVED'],
  COMPLETED: ['IN_SERVICE'],
  CANCELLED: ['CONFIRMED', 'REQUESTED'],
  NO_SHOW: ['CONFIRMED'],
};

export function canTransition(from: string, to: string): boolean {
  return from === to || (STATUS_TRANSITIONS[from]?.includes(to) ?? false);
}

/** Statuses that occupy time on the ledger. */
export const ACTIVE_STATUSES = ['REQUESTED', 'CONFIRMED', 'ARRIVED', 'IN_SERVICE', 'COMPLETED'] as const;
