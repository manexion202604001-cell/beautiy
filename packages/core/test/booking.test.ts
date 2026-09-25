import { describe, expect, it } from 'vitest';
import { canBook, canTransition, computeAvailability, maxConcurrency, overlaps, pickStaff } from '../src/booking';
import { localToUtc } from '../src/time';

const H = 3600_000;
const iv = (s: number, e: number) => ({ start: s * H, end: e * H });

describe('overlaps / maxConcurrency', () => {
  it('treats intervals as half-open', () => {
    expect(overlaps(iv(10, 11), iv(11, 12))).toBe(false);
    expect(overlaps(iv(10, 11.5), iv(11, 12))).toBe(true);
  });
  it('counts peak concurrency inside window only', () => {
    const busy = [iv(10, 12), iv(11, 13), iv(12, 14), iv(8, 9)];
    expect(maxConcurrency(busy, iv(10, 14))).toBe(2);
    expect(maxConcurrency(busy, iv(8, 9))).toBe(1);
    expect(maxConcurrency(busy, iv(14, 15))).toBe(0);
  });
  it('back-to-back appointments do not stack', () => {
    expect(maxConcurrency([iv(10, 11), iv(11, 12), iv(12, 13)], iv(10, 13))).toBe(1);
  });
});

describe('canBook', () => {
  it('rejects staff double booking', () => {
    const r = canBook({ candidate: iv(10, 11), staffBusy: [iv(10.5, 11.5)], seatBusy: [], seatCapacity: 3 });
    expect(r).toMatchObject({ ok: false, reason: 'STAFF_CONFLICT' });
  });
  it('rejects when seats are full', () => {
    const r = canBook({ candidate: iv(10, 11), staffBusy: [], seatBusy: [iv(10, 11), iv(10, 11)], seatCapacity: 2 });
    expect(r).toMatchObject({ ok: false, reason: 'SEAT_CAPACITY' });
  });
  it('private blocks do not consume seats', () => {
    const r = canBook({ candidate: iv(10, 11), staffBusy: [], seatBusy: [iv(10, 11), iv(10, 11)], seatCapacity: 2, usesSeat: false });
    expect(r.ok).toBe(true);
  });
  it('rejects invalid range', () => {
    expect(canBook({ candidate: iv(11, 10), seatBusy: [], seatCapacity: 1 })).toMatchObject({ ok: false, reason: 'INVALID_RANGE' });
  });
  it('returns soft warnings for outside hours / past', () => {
    const r = canBook({ candidate: iv(8, 9), seatBusy: [], seatCapacity: 1, openWindow: iv(10, 19), now: 9 * H });
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual(expect.arrayContaining(['OUTSIDE_HOURS', 'IN_PAST']));
  });
});

describe('computeAvailability', () => {
  const base = {
    openWindow: iv(10, 14), holiday: false, durationMin: 60, slotIntervalMin: 30, seatCapacity: 2,
    seatBusy: [], now: 0, minNoticeMin: 0,
  };
  it('lists all slots when free', () => {
    const slots = computeAvailability({ ...base, staff: [{ id: 'a', busy: [] }] });
    expect(slots.map((s) => s.start / H)).toEqual([10, 10.5, 11, 11.5, 12, 12.5, 13]);
  });
  it('excludes staff-busy and seat-full windows', () => {
    const slots = computeAvailability({
      ...base, seatCapacity: 1, seatBusy: [iv(12, 13)],
      staff: [{ id: 'a', busy: [iv(10, 11)] }, { id: 'b', busy: [] }],
    });
    const starts = slots.map((s) => s.start / H);
    expect(starts).not.toContain(11.5);
    expect(starts).not.toContain(12);
    expect(slots.find((s) => s.start === 10 * H)?.staffIds).toEqual(['b']);
  });
  it('respects requested staff, notice and closure', () => {
    const slots = computeAvailability({ ...base, staffId: 'a', now: 11 * H, minNoticeMin: 60, staff: [{ id: 'a', busy: [] }, { id: 'b', busy: [] }] });
    expect(slots[0].start).toBe(12 * H);
    expect(slots.every((s) => s.staffIds.length === 1 && s.staffIds[0] === 'a')).toBe(true);
    expect(computeAvailability({ ...base, holiday: true, staff: [{ id: 'a', busy: [] }] })).toEqual([]);
    expect(computeAvailability({ ...base, openWindow: null, staff: [{ id: 'a', busy: [] }] })).toEqual([]);
  });
  it('works with real timezone windows', () => {
    const open = localToUtc('2026-10-01', 10 * 60, 'Asia/Tokyo').getTime();
    expect(new Date(open).toISOString()).toBe('2026-10-01T01:00:00.000Z');
  });
});

describe('status machine & staff pick', () => {
  it('allows only defined transitions', () => {
    expect(canTransition('REQUESTED', 'CONFIRMED')).toBe(true);
    expect(canTransition('CANCELLED', 'COMPLETED')).toBe(false);
    expect(canTransition('COMPLETED', 'NO_SHOW')).toBe(false);
  });
  it('picks least loaded staff', () => {
    expect(pickStaff(['a', 'b', 'c'], { a: 3, b: 1, c: 2 })).toBe('b');
    expect(pickStaff([], {})).toBeNull();
  });
});
