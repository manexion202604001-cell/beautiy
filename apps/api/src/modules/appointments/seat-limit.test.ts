import { describe, expect, it } from 'vitest';
import { createMenu, createStaffUser, createTenant, jst, nextWeekday } from '../../test/helpers.js';
import { peakConcurrency } from './seat-limit.js';

const WED = 3;
const at = (h: number, m = 0) => new Date(Date.UTC(2026, 0, 7, h, m));

describe('peakConcurrency', () => {
  it('counts the most ranges running at one moment inside the window', () => {
    expect(peakConcurrency([], at(10), at(11))).toBe(0);
    // back-to-back bookings never overlap
    expect(peakConcurrency([{ start: at(10), end: at(11) }, { start: at(11), end: at(12) }], at(10), at(12))).toBe(1);
    expect(peakConcurrency([{ start: at(10), end: at(11, 30) }, { start: at(11), end: at(12) }], at(10), at(12))).toBe(2);
    // ranges outside the window are ignored
    expect(peakConcurrency([{ start: at(8), end: at(10) }, { start: at(12), end: at(13) }], at(10), at(12))).toBe(0);
  });
});

describe('席数アラート (店舗設定)', () => {
  it('refuses a booking beyond the simultaneous limit only while the alert is on', async () => {
    const t = await createTenant();
    const [s1, s2, s3] = await Promise.all([createStaffUser(t, 'stylist'), createStaffUser(t, 'stylist'), createStaffUser(t, 'stylist')]);
    const menu = await createMenu(t, { durationMin: 60 });
    const date = nextWeekday(WED);
    const book = (staffId: string, time: string) => t.owner.post('/v1/appointments', { shopId: t.shopId, staffId, startAt: jst(date, time), menuIds: [menu.id] });

    const saved = await t.owner.patch(`/v1/shops/${t.shopId}`, { settings: { seats: { alertEnabled: true, limit: 2 } } });
    expect(saved.status).toBe(200);
    expect(saved.body.settings.seats).toEqual({ alertEnabled: true, limit: 2 });

    expect((await book(s1.staffId, '11:00')).status).toBe(201);
    const second = await book(s2.staffId, '11:30');
    expect(second.status).toBe(201);
    const third = await book(s3.staffId, '11:15');
    expect(third.status).toBe(409);
    expect(third.body.error.code).toBe('SEAT_LIMIT_EXCEEDED');
    expect(third.body.error.details).toEqual({ limit: 2, current: 2 });
    // 12:30 starts when the second booking ends → only one other booking at any moment
    expect((await book(s3.staffId, '12:30')).status).toBe(201);

    // moving a booking into the full slot is refused too; moving it within its own slot is fine
    const free = await book(s3.staffId, '15:00');
    const moved = await t.owner.patch(`/v1/appointments/${free.body.id}`, { version: free.body.version, startAt: jst(date, '11:15') });
    expect(moved.status).toBe(409);
    expect(moved.body.error.code).toBe('SEAT_LIMIT_EXCEEDED');
    const nudged = await t.owner.patch(`/v1/appointments/${second.body.id}`, { version: second.body.version, startAt: jst(date, '11:45') });
    expect(nudged.status).toBe(200);

    // cancelling frees a seat
    await t.owner.post(`/v1/appointments/${nudged.body.id}/cancel`, { reason: 'テスト' });
    expect((await book(s2.staffId, '11:15')).status).toBe(201);

    // switched off → no cap (the number stays saved)
    const off = await t.owner.patch(`/v1/shops/${t.shopId}`, { settings: { seats: { alertEnabled: false } } });
    expect(off.body.settings.seats).toEqual({ alertEnabled: false, limit: 2 });
    const s4 = await createStaffUser(t, 'stylist');
    expect((await book(s4.staffId, '11:15')).status).toBe(201);
  });

  it('validates the limit and needs shop.manage', async () => {
    const t = await createTenant();
    expect((await t.owner.patch(`/v1/shops/${t.shopId}`, { settings: { seats: { limit: -1 } } })).status).toBe(400);
    const stylist = await createStaffUser(t, 'stylist');
    expect((await stylist.api.patch(`/v1/shops/${t.shopId}`, { settings: { seats: { alertEnabled: true, limit: 1 } } })).status).toBe(403);
    expect((await t.owner.get(`/v1/shops/${t.shopId}`)).body.settings.seats).toEqual({ alertEnabled: false, limit: 0 });
  });
});
