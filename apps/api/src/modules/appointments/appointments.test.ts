import { describe, expect, it } from 'vitest';
import { createCustomer, createMenu, createStaffUser, createTenant, jst, nextWeekday } from '../../test/helpers.js';

const WED = 3;
const TUE = 2;

async function setup() {
  const t = await createTenant();
  const stylist = await createStaffUser(t, 'stylist', { displayName: '指名スタイリスト' });
  const menu = await createMenu(t, { durationMin: 60, bufferAfterMin: 15 });
  const customer = await createCustomer(t);
  return { t, stylist, menu, customer };
}

describe('availability', () => {
  it('computes slots inside business hours and excludes closed days', async () => {
    const { t, stylist, menu } = await setup();
    const date = nextWeekday(WED);
    const res = await t.owner.get('/v1/availability', { shopId: t.shopId, menuIds: menu.id, staffId: stylist.staffId, from: date, to: date });
    expect(res.status).toBe(200);
    const slots = res.body.days[0].slots;
    // 10:00 open, 60min + 15min buffer must end by 20:00 -> last start 18:45
    expect(slots[0].start).toBe(jst(date, '10:00'));
    expect(slots[slots.length - 1].start).toBe(jst(date, '18:45'));
    const closed = nextWeekday(TUE);
    const res2 = await t.owner.get('/v1/availability', { shopId: t.shopId, menuIds: menu.id, from: closed, to: closed });
    expect(res2.body.days[0].slots).toHaveLength(0);
  });

  it('removes occupied ranges (with buffers) and honours shifts and blocks', async () => {
    const { t, stylist, menu, customer } = await setup();
    const date = nextWeekday(WED);
    const created = await t.owner.post('/v1/appointments', { shopId: t.shopId, customerId: customer.id, staffId: stylist.staffId, startAt: jst(date, '12:00'), menuIds: [menu.id] });
    expect(created.status).toBe(201);
    expect(created.body.occupied_end_at).toBe(jst(date, '13:15'));
    const res = await t.owner.get('/v1/availability', { shopId: t.shopId, menuIds: menu.id, staffId: stylist.staffId, from: date, to: date });
    const starts = res.body.days[0].slots.map((s: { start: string }) => s.start);
    expect(starts).toContain(jst(date, '10:45')); // 10:45-12:00 (incl. 15m buffer) ends exactly at 12:00
    expect(starts).not.toContain(jst(date, '11:00'));
    expect(starts).not.toContain(jst(date, '13:00'));
    expect(starts).toContain(jst(date, '13:15'));

    // shift: only 14:00-18:00 this day
    await t.owner.put('/v1/shifts', { shopId: t.shopId, shifts: [{ staffId: stylist.staffId, date, shiftType: 'work', startTime: '14:00', endTime: '18:00' }] });
    await t.owner.post('/v1/schedule-blocks', { shopId: t.shopId, staffId: stylist.staffId, startAt: jst(date, '15:00'), endAt: jst(date, '16:00'), reason: 'ミーティング' });
    const res2 = await t.owner.get('/v1/availability', { shopId: t.shopId, menuIds: menu.id, staffId: stylist.staffId, from: date, to: date });
    const s2 = res2.body.days[0].slots.map((s: { start: string }) => s.start);
    expect(s2).toEqual([jst(date, '16:00'), jst(date, '16:15'), jst(date, '16:30'), jst(date, '16:45')]);
  });

  it('requires a free resource unit when the menu needs one', async () => {
    const t = await createTenant();
    const s1 = await createStaffUser(t, 'stylist');
    const s2 = await createStaffUser(t, 'stylist');
    await t.owner.post('/v1/resources', { shopId: t.shopId, name: '個室', resourceType: 'room' });
    const menu = await createMenu(t, { name: 'ヘッドスパ', durationMin: 30, resourceRequirements: [{ resourceType: 'room', offsetMin: 0 }] });
    const date = nextWeekday(WED);
    const a = await t.owner.post('/v1/appointments', { shopId: t.shopId, staffId: s1.staffId, startAt: jst(date, '11:00'), menuIds: [menu.id] });
    expect(a.status).toBe(201);
    expect(a.body.resources).toHaveLength(1);
    // another staff is free but the only room is taken
    const b = await t.owner.post('/v1/appointments', { shopId: t.shopId, staffId: s2.staffId, startAt: jst(date, '11:15'), menuIds: [menu.id] });
    expect(b.status).toBe(409);
    expect(b.body.error.details.reason).toBe('resource_unavailable');
    // cancelling frees the room
    await t.owner.post(`/v1/appointments/${a.body.id}/cancel`, { reason: 'テスト' });
    const c = await t.owner.post('/v1/appointments', { shopId: t.shopId, staffId: s2.staffId, startAt: jst(date, '11:15'), menuIds: [menu.id] });
    expect(c.status).toBe(201);
  });
});

describe('appointments', () => {
  it('prevents double booking sequentially and under concurrency', async () => {
    const { t, stylist, menu } = await setup();
    const date = nextWeekday(WED);
    const body = { shopId: t.shopId, staffId: stylist.staffId, startAt: jst(date, '15:00'), menuIds: [menu.id] };
    const first = await t.owner.post('/v1/appointments', body);
    expect(first.status).toBe(201);
    const second = await t.owner.post('/v1/appointments', { ...body, startAt: jst(date, '15:30') });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('SLOT_UNAVAILABLE');

    const concurrent = await Promise.all(
      Array.from({ length: 8 }, () => t.owner.post('/v1/appointments', { ...body, startAt: jst(date, '17:00') })),
    );
    expect(concurrent.filter((r) => r.status === 201)).toHaveLength(1);
    expect(concurrent.filter((r) => r.status === 409)).toHaveLength(7);
  });

  it('auto-assigns free bookings to the least busy staff', async () => {
    const t = await createTenant();
    const a = await createStaffUser(t, 'stylist');
    const b = await createStaffUser(t, 'stylist');
    // owner is also bookable; make owner non-bookable for a deterministic test
    await t.owner.patch(`/v1/staff/${t.ownerStaffId}`, { isBookable: false });
    const menu = await createMenu(t);
    const date = nextWeekday(WED);
    const r1 = await t.owner.post('/v1/appointments', { shopId: t.shopId, staffId: a.staffId, startAt: jst(date, '10:00'), menuIds: [menu.id] });
    expect(r1.body.is_nominated).toBe(true);
    const r2 = await t.owner.post('/v1/appointments', { shopId: t.shopId, startAt: jst(date, '14:00'), menuIds: [menu.id] });
    expect(r2.status).toBe(201);
    expect(r2.body.staff_id).toBe(b.staffId);
    expect(r2.body.is_nominated).toBe(false);
  });

  it('replays idempotent creates without duplicating', async () => {
    const { t, stylist, menu } = await setup();
    const date = nextWeekday(WED);
    const body = { shopId: t.shopId, staffId: stylist.staffId, startAt: jst(date, '11:00'), menuIds: [menu.id] };
    const h = { 'idempotency-key': 'key-123' };
    const r1 = await t.owner.post('/v1/appointments', body, h);
    const r2 = await t.owner.post('/v1/appointments', body, h);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r2.headers['idempotent-replayed']).toBe('true');
    expect(r2.body.id).toBe(r1.body.id);
    const reuse = await t.owner.post('/v1/appointments', { ...body, startAt: jst(date, '12:00') }, h);
    expect(reuse.status).toBe(422);
    expect(reuse.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('reschedules with optimistic locking and records history', async () => {
    const { t, stylist, menu, customer } = await setup();
    const date = nextWeekday(WED);
    const a = (await t.owner.post('/v1/appointments', { shopId: t.shopId, customerId: customer.id, staffId: stylist.staffId, startAt: jst(date, '10:00'), menuIds: [menu.id] })).body;
    const moved = await t.owner.patch(`/v1/appointments/${a.id}`, { version: a.version, startAt: jst(date, '10:30') });
    expect(moved.status).toBe(200);
    expect(moved.body.start_at).toBe(jst(date, '10:30'));
    expect(moved.body.version).toBe(2);
    const stale = await t.owner.patch(`/v1/appointments/${a.id}`, { version: 1, startAt: jst(date, '11:00') });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    const history = await t.owner.get(`/v1/appointments/${a.id}/history`);
    expect(history.body.map((e: { event_type: string }) => e.event_type)).toEqual(['created', 'rescheduled']);
    const cust = await t.owner.get(`/v1/customers/${customer.id}`);
    expect(cust.body.next_appointment_at).toBe(jst(date, '10:30'));
  });

  it('enforces the status state machine (cancel, restore, no-show)', async () => {
    const { t, stylist, menu } = await setup();
    const date = nextWeekday(WED);
    const a = (await t.owner.post('/v1/appointments', { shopId: t.shopId, staffId: stylist.staffId, startAt: jst(date, '13:00'), menuIds: [menu.id] })).body;
    const noShowEarly = await t.owner.post(`/v1/appointments/${a.id}/no-show`);
    expect(noShowEarly.body.error.code).toBe('NO_SHOW_BEFORE_START');
    const cancelled = await t.owner.post(`/v1/appointments/${a.id}/cancel`, { reason: '体調不良' });
    expect(cancelled.body.status).toBe('cancelled');
    expect(cancelled.body.cancelled_by_type).toBe('staff');
    const invalid = await t.owner.post(`/v1/appointments/${a.id}/check-in`);
    expect(invalid.body.error.code).toBe('INVALID_TRANSITION');
    // slot was freed; someone else books it, so restore must fail
    const other = await t.owner.post('/v1/appointments', { shopId: t.shopId, staffId: stylist.staffId, startAt: jst(date, '13:00'), menuIds: [menu.id] });
    expect(other.status).toBe(201);
    const restore = await t.owner.post(`/v1/appointments/${a.id}/restore`);
    expect(restore.status).toBe(409);
    expect(restore.body.error.code).toBe('APPOINTMENT_OVERLAP');
  });

  it('allows staff override outside schedule but never overlapping', async () => {
    const { t, stylist, menu } = await setup();
    const date = nextWeekday(WED);
    const outside = { shopId: t.shopId, staffId: stylist.staffId, startAt: jst(date, '20:30'), menuIds: [menu.id] };
    const denied = await t.owner.post('/v1/appointments', outside);
    expect(denied.status).toBe(409);
    expect(denied.body.error.details.reason).toBe('outside_schedule');
    const ok = await t.owner.post('/v1/appointments', { ...outside, allowOutsideSchedule: true });
    expect(ok.status).toBe(201);
    const overlap = await t.owner.post('/v1/appointments', { ...outside, startAt: jst(date, '21:00'), allowOutsideSchedule: true });
    expect(overlap.status).toBe(409);
  });

  it('forbids other shops and users without permission', async () => {
    const { t, menu } = await setup();
    const assistant = await createStaffUser(t, 'assistant');
    const date = nextWeekday(WED);
    const res = await assistant.api.post('/v1/appointments', { shopId: t.shopId, startAt: jst(date, '10:00'), menuIds: [menu.id] });
    expect(res.status).toBe(403);
    const other = await createTenant();
    const res2 = await other.owner.post('/v1/appointments', { shopId: t.shopId, startAt: jst(date, '10:00'), menuIds: [menu.id] });
    expect([403, 404]).toContain(res2.status);
  });
});
