import { describe, expect, it } from 'vitest';
import { localToUtc } from '@salonos/core';
import { prisma } from '@salonos/db';
import { BookingError, changeAppointmentStatus, createAppointment, createHold, getAvailability, updateAppointment } from '@/lib/server/booking';
import { futureDate, makeOrg } from './helpers';

const TZ = 'Asia/Tokyo';
const at = (date: string, hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return localToUtc(date, h * 60 + m, TZ); };

describe('booking engine (DB)', () => {
  it('prevents staff double-booking under concurrency', async () => {
    const { org, shop, staff } = await makeOrg({ seats: 5 });
    const date = futureDate();
    const attempts = await Promise.allSettled(Array.from({ length: 8 }, () =>
      createAppointment({ orgId: org.id, shopId: shop.id, staffId: staff[0].userId, startAt: at(date, '11:00'), menus: [{ name: 'カット', price: 5500, durationMin: 60 }] })));
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
    const rejected = attempts.filter((a): a is PromiseRejectedResult => a.status === 'rejected');
    expect(rejected.every((r) => r.reason instanceof BookingError && r.reason.reason === 'STAFF_CONFLICT')).toBe(true);
  });

  it('enforces seat capacity under concurrency (no staff)', async () => {
    const { org, shop } = await makeOrg({ seats: 2 });
    const date = futureDate();
    const attempts = await Promise.allSettled(Array.from({ length: 6 }, () =>
      createAppointment({ orgId: org.id, shopId: shop.id, startAt: at(date, '12:00'), menus: [{ name: 'x', price: 1, durationMin: 30 }] })));
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(2);
  });

  it('allows staff override of capacity with a warning, never for public', async () => {
    const { org, shop } = await makeOrg({ seats: 1 });
    const date = futureDate();
    await createAppointment({ orgId: org.id, shopId: shop.id, startAt: at(date, '12:00'), menus: [{ name: 'x', price: 1, durationMin: 60 }] });
    const r = await createAppointment({ orgId: org.id, shopId: shop.id, startAt: at(date, '12:00'), menus: [{ name: 'x', price: 1, durationMin: 60 }], allowOverCapacity: true });
    expect(r.warnings).toContain('SEAT_CAPACITY');
    await expect(createAppointment({ orgId: org.id, shopId: shop.id, startAt: at(date, '12:30'), menus: [{ name: 'x', price: 1, durationMin: 60 }], allowOverCapacity: true, enforceHours: true })).rejects.toThrow(BookingError);
  });

  it('is idempotent by key, including concurrent replays', async () => {
    const { org, shop, staff } = await makeOrg();
    const date = futureDate();
    const input = { orgId: org.id, shopId: shop.id, staffId: staff[0].userId, startAt: at(date, '15:00'), menus: [{ name: 'x', price: 1, durationMin: 60 }], idempotencyKey: 'idem-1' };
    const rs = await Promise.all([createAppointment(input), createAppointment(input), createAppointment(input)]);
    expect(new Set(rs.map((r) => r.appointmentId)).size).toBe(1);
    expect(await prisma.appointment.count({ where: { organizationId: org.id } })).toBe(1);
  });

  it('public bookings respect hours, holidays and notice', async () => {
    const { org, shop, staff } = await makeOrg();
    const date = futureDate();
    const base = { orgId: org.id, shopId: shop.id, staffId: staff[0].userId, menus: [{ name: 'x', price: 1, durationMin: 60 }], enforceHours: true };
    await expect(createAppointment({ ...base, startAt: at(date, '19:30') })).rejects.toMatchObject({ reason: 'OUTSIDE_HOURS' });
    await prisma.shopHoliday.create({ data: { shopId: shop.id, date } });
    await expect(createAppointment({ ...base, startAt: at(date, '11:00') })).rejects.toMatchObject({ reason: 'HOLIDAY' });
    // staff (non-public) may still book outside hours with a warning
    const r = await createAppointment({ ...base, enforceHours: false, startAt: at(date, '20:30') });
    expect(r.warnings).toEqual(expect.arrayContaining(['OUTSIDE_HOURS', 'HOLIDAY']));
  });

  it('auto-assigns least-loaded free staff', async () => {
    const { org, shop, staff } = await makeOrg({ seats: 5, staff: 2 });
    const date = futureDate();
    await createAppointment({ orgId: org.id, shopId: shop.id, staffId: staff[0].userId, startAt: at(date, '10:00'), menus: [{ name: 'x', price: 1, durationMin: 60 }] });
    const r = await createAppointment({ orgId: org.id, shopId: shop.id, autoAssignStaff: true, startAt: at(date, '13:00'), menus: [{ name: 'x', price: 1, durationMin: 60 }] });
    const a = await prisma.appointment.findUniqueOrThrow({ where: { id: r.appointmentId } });
    expect(a.staffId).toBe(staff[1].userId);
    expect(a.nominated).toBe(false);
  });

  it('availability excludes busy staff and full seats; holds block slots', async () => {
    const { org, shop, staff } = await makeOrg({ seats: 1, staff: 2 });
    const date = futureDate();
    await createAppointment({ orgId: org.id, shopId: shop.id, staffId: staff[0].userId, startAt: at(date, '10:00'), menus: [{ name: 'x', price: 1, durationMin: 60 }] });
    let slots = await getAvailability({ shopId: shop.id, date, durationMin: 60 });
    const t = (s: { start: number }) => new Date(s.start).toISOString();
    expect(slots.map(t)).not.toContain(at(date, '10:00').toISOString());
    expect(slots.map(t)).toContain(at(date, '11:00').toISOString());
    const hold = await createHold(shop.id, null, at(date, '11:00'), at(date, '12:00'));
    slots = await getAvailability({ shopId: shop.id, date, durationMin: 60 });
    expect(slots.map(t)).not.toContain(at(date, '11:00').toISOString());
    // holder can still see/book it
    slots = await getAvailability({ shopId: shop.id, date, durationMin: 60, excludeHoldToken: hold.token });
    expect(slots.map(t)).toContain(at(date, '11:00').toISOString());
    const r = await createAppointment({ orgId: org.id, shopId: shop.id, autoAssignStaff: true, startAt: at(date, '11:00'), menus: [{ name: 'x', price: 1, durationMin: 60 }], holdToken: hold.token, enforceHours: true });
    expect(r.appointmentId).toBeTruthy();
    expect(await prisma.slotHold.count({ where: { token: hold.token } })).toBe(0);
  });

  it('move/resize re-validates and status machine guards reactivation', async () => {
    const { org, shop, staff } = await makeOrg({ seats: 3 });
    const date = futureDate();
    const a = await createAppointment({ orgId: org.id, shopId: shop.id, staffId: staff[0].userId, startAt: at(date, '10:00'), menus: [{ name: 'x', price: 1, durationMin: 60 }] });
    const b = await createAppointment({ orgId: org.id, shopId: shop.id, staffId: staff[0].userId, startAt: at(date, '12:00'), menus: [{ name: 'x', price: 1, durationMin: 60 }] });
    await expect(updateAppointment({ orgId: org.id, id: b.appointmentId, startAt: at(date, '10:30') })).rejects.toMatchObject({ reason: 'STAFF_CONFLICT' });
    await updateAppointment({ orgId: org.id, id: b.appointmentId, startAt: at(date, '11:00') }); // back-to-back ok
    await changeAppointmentStatus(org.id, a.appointmentId, 'CANCELLED');
    await createAppointment({ orgId: org.id, shopId: shop.id, staffId: staff[0].userId, startAt: at(date, '10:00'), menus: [{ name: 'x', price: 1, durationMin: 60 }] });
    await expect(changeAppointmentStatus(org.id, a.appointmentId, 'CONFIRMED')).rejects.toMatchObject({ reason: 'STAFF_CONFLICT' });
    await expect(changeAppointmentStatus(org.id, b.appointmentId, 'NO_SHOW' as any).then(() => changeAppointmentStatus(org.id, b.appointmentId, 'COMPLETED'))).rejects.toThrow();
  });

  it('staff busy is checked across shops of the organization', async () => {
    const { org, shop, staff } = await makeOrg();
    const shop2 = await prisma.shop.create({ data: { organizationId: org.id, name: 'Shop2', slug: `s2-${shop.slug}`, seatCount: 2 } });
    const date = futureDate();
    await createAppointment({ orgId: org.id, shopId: shop.id, staffId: staff[0].userId, startAt: at(date, '10:00'), menus: [{ name: 'x', price: 1, durationMin: 60 }] });
    await expect(createAppointment({ orgId: org.id, shopId: shop2.id, staffId: staff[0].userId, startAt: at(date, '10:30'), menus: [{ name: 'x', price: 1, durationMin: 60 }] })).rejects.toMatchObject({ reason: 'STAFF_CONFLICT' });
  });

  it('private blocks occupy staff but not seats', async () => {
    const { org, shop, staff } = await makeOrg({ seats: 1 });
    const date = futureDate();
    await createAppointment({ orgId: org.id, shopId: shop.id, staffId: staff[0].userId, startAt: at(date, '10:00'), endAt: at(date, '11:00'), kind: 'PRIVATE', title: '休憩' });
    await createAppointment({ orgId: org.id, shopId: shop.id, staffId: staff[1].userId, startAt: at(date, '10:00'), menus: [{ name: 'x', price: 1, durationMin: 60 }] });
    await expect(createAppointment({ orgId: org.id, shopId: shop.id, staffId: staff[0].userId, startAt: at(date, '10:00'), menus: [{ name: 'x', price: 1, durationMin: 30 }] })).rejects.toBeInstanceOf(BookingError);
  });
});
