import { describe, expect, it } from 'vitest';
import { localToUtc } from '@salonos/core';
import { prisma } from '@salonos/db';
import { BookingError, createAppointment } from '@/lib/server/booking';
import { signLineLink } from '@/lib/server/line-link';
import {
  availableSlots, checkFormToken, couponDiscount, customerCanModify, publicBook, publicCancel, publicHold, publicReschedule, resolveSource, signFormToken,
  type PublicBookingInput,
} from '@/lib/server/reservations';
import { futureDate, makeOrg } from './helpers';

const TZ = 'Asia/Tokyo';
const at = (date: string, hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return localToUtc(date, h * 60 + m, TZ); };
let seq = 0;

async function setup(opts: { seats?: number; staff?: number } = {}) {
  const o = await makeOrg(opts);
  const cut = o.menus.find((m) => m.name === 'カット')!;
  const consult = o.menus.find((m) => m.isConsultation)!;
  return { ...o, cut, consult };
}

function form(o: Awaited<ReturnType<typeof setup>>, date: string, over: Partial<PublicBookingInput> = {}): PublicBookingInput {
  seq++;
  return {
    shopSlug: o.shop.slug, menuIds: [o.cut.id], staffId: null, startAt: at(date, '11:00').toISOString(),
    name: '予約 花子', kana: 'ヨヤク ハナコ', phone: `090-1234-${String(1000 + seq).slice(-4)}`, email: '', note: '',
    consent: true, idempotencyKey: `idem-${Date.now()}-${seq}`, formToken: signFormToken(Date.now() - 10_000), ...over,
  };
}

describe('public booking service', () => {
  it('validates input and the bot guard', async () => {
    const o = await setup();
    const date = futureDate();
    await expect(publicBook({ ...form(o, date), phone: '12' })).rejects.toMatchObject({ name: 'ZodError' });
    await expect(publicBook({ ...form(o, date), kana: 'yoyaku' })).rejects.toMatchObject({ name: 'ZodError' });
    await expect(publicBook({ ...form(o, date), consent: false as any })).rejects.toMatchObject({ name: 'ZodError' });
    await expect(publicBook({ ...form(o, date), website: 'http://spam' })).rejects.toThrow('送信内容');
    await expect(publicBook({ ...form(o, date), formToken: signFormToken(Date.now() - 500) })).rejects.toThrow('送信内容');
    await expect(publicBook({ ...form(o, date), formToken: '123.deadbeef' })).rejects.toThrow('送信内容');
    expect(checkFormToken(signFormToken(Date.now() - 4000))).toBe('ok');
    expect(checkFormToken(signFormToken(Date.now() - 13 * 3600_000))).toBe('expired');
    // unknown / non-public menu
    await prisma.menu.update({ where: { id: o.cut.id }, data: { publicBookable: false } });
    await expect(publicBook(form(o, date))).rejects.toThrow('メニュー');
    expect(await prisma.appointment.count({ where: { organizationId: o.org.id } })).toBe(0);
  });

  it('hold → book: auto-assigns staff, consumes the hold, creates customer, is idempotent', async () => {
    const o = await setup({ seats: 3, staff: 2 });
    const date = futureDate();
    const start = at(date, '13:00').toISOString();
    const hold = await publicHold({ shopSlug: o.shop.slug, menuIds: [o.cut.id], staffId: null, startAt: start });
    // the held slot is no longer offered to others (one stylist reserved by the hold)
    const others = await availableSlots({ shopId: o.shop.id, date, durationMin: 60, staffId: null });
    expect(others.find((s) => s.start === Date.parse(start))?.staffIds).toHaveLength(1);

    const input = form(o, date, { startAt: start, holdToken: hold.token, email: 'hanako@example.com', note: '前髪短め' });
    const r = await publicBook(input);
    expect(r.status).toBe('CONFIRMED');
    const a = await prisma.appointment.findUniqueOrThrow({ where: { id: r.appointmentId }, include: { menus: true } });
    expect(a.source).toBe('WEB');
    expect(a.staffId).toBeTruthy();
    expect(a.nominated).toBe(false);
    expect(a.customerNote).toBe('前髪短め');
    expect(a.endAt.getTime() - a.startAt.getTime()).toBe(60 * 60000);
    expect(a.totalPrice).toBe(o.cut.price);
    expect(await prisma.slotHold.count({ where: { token: hold.token } })).toBe(0);
    const c = await prisma.customer.findUniqueOrThrow({ where: { id: a.customerId! } });
    expect(c.lastName).toBe('予約');
    expect(c.lastNameKana).toBe('ヨヤク');
    expect(c.phoneHash).toBeTruthy();
    // confirmation message logged (sandbox)
    expect(await prisma.message.count({ where: { appointmentId: a.id } })).toBe(1);

    // replay with same key → same appointment, no second notification
    const again = await publicBook(input);
    expect(again.appointmentId).toBe(r.appointmentId);
    expect(again.replay).toBe(true);
    expect(await prisma.message.count({ where: { appointmentId: a.id } })).toBe(1);
    // same key but different phone must not leak the first booking
    const other = await publicBook({ ...input, phone: '080-9999-0000', holdToken: null });
    expect(other.appointmentId).not.toBe(r.appointmentId);
  });

  it('conflicts are reported when the slot got taken; expired holds fall back gracefully', async () => {
    const o = await setup({ seats: 1, staff: 2 });
    const date = futureDate();
    await createAppointment({ orgId: o.org.id, shopId: o.shop.id, startAt: at(date, '11:00'), menus: [{ name: 'x', price: 1, durationMin: 60 }] });
    await expect(publicBook(form(o, date))).rejects.toBeInstanceOf(BookingError);
    await expect(publicHold({ shopSlug: o.shop.slug, menuIds: [o.cut.id], startAt: at(date, '11:00').toISOString() })).rejects.toBeInstanceOf(BookingError);
    // hold that expired: booking still succeeds when the slot is free
    const hold = await publicHold({ shopSlug: o.shop.slug, menuIds: [o.cut.id], startAt: at(date, '14:00').toISOString() });
    await prisma.slotHold.update({ where: { token: hold.token }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const r = await publicBook(form(o, date, { startAt: at(date, '14:00').toISOString(), holdToken: hold.token }));
    expect(r.appointmentId).toBeTruthy();
    // outside business hours is a hard error for public bookings
    await expect(publicBook(form(o, date, { startAt: at(date, '19:30').toISOString() }))).rejects.toMatchObject({ reason: 'OUTSIDE_HOURS' });
  });

  it('nominated staff adds nomination fee; coupon discount is applied', async () => {
    const o = await setup({ seats: 3 });
    const date = futureDate();
    await prisma.membership.update({ where: { id: o.staff[1].membershipId }, data: { nominationFee: 550 } });
    const coupon = await prisma.coupon.create({ data: { organizationId: o.org.id, shopId: o.shop.id, name: 'カット20%', discountType: 'PERCENT', discountValue: 20, menuIds: [o.cut.id] } });
    const r = await publicBook(form(o, date, { staffId: o.staff[1].userId, couponId: coupon.id }));
    const a = await prisma.appointment.findUniqueOrThrow({ where: { id: r.appointmentId }, include: { menus: true } });
    expect(a.staffId).toBe(o.staff[1].userId);
    expect(a.nominated).toBe(true);
    expect(a.menus.map((m) => m.name)).toContain('指名料');
    expect(a.couponId).toBe(coupon.id);
    expect(a.totalPrice).toBe(o.cut.price + 550 - Math.floor(o.cut.price * 0.2));
    expect(couponDiscount({ discountType: 'AMOUNT', discountValue: 99999, menuIds: [] }, [{ menuId: 'a', price: 1000 }, { menuId: null, price: 500 }])).toBe(1000);

    // coupon restricted to other menus → rejected
    const color = o.menus.find((m) => m.name === 'カラー')!;
    const c2 = await prisma.coupon.create({ data: { organizationId: o.org.id, shopId: o.shop.id, name: 'カラー1000円引', discountValue: 1000, menuIds: [color.id] } });
    await expect(publicBook(form(o, date, { startAt: at(date, '15:00').toISOString(), couponId: c2.id }))).rejects.toThrow('対象メニュー');
    // new-customer-only coupon rejected for returning customers
    const c3 = await prisma.coupon.create({ data: { organizationId: o.org.id, shopId: o.shop.id, name: '新規', discountValue: 500, newCustomerOnly: true } });
    const returning = form(o, date, { startAt: at(date, '16:00').toISOString(), couponId: c3.id });
    const first = await publicBook({ ...returning, couponId: null });
    await prisma.appointment.update({ where: { id: first.appointmentId }, data: { status: 'COMPLETED' } });
    await expect(publicBook({ ...returning, idempotencyKey: 'another-key-1', startAt: at(date, '17:30').toISOString() })).rejects.toThrow('初めて');
    // a staff member who is not bookable cannot be chosen
    await prisma.membership.update({ where: { id: o.staff[0].membershipId }, data: { bookable: false } });
    await expect(publicBook(form(o, date, { staffId: o.staff[0].userId, startAt: at(date, '12:00').toISOString() }))).rejects.toThrow('スタッフ');
  });

  it('attaches LINE identity from a valid link token and attributes source', async () => {
    const o = await setup();
    const date = futureDate();
    const lk = signLineLink(o.org.id, 'U-line-123');
    const r = await publicBook(form(o, date, { lk }));
    const a = await prisma.appointment.findUniqueOrThrow({ where: { id: r.appointmentId } });
    expect(a.source).toBe('LINE');
    const ident = await prisma.customerIdentity.findFirstOrThrow({ where: { organizationId: o.org.id, provider: 'LINE', externalId: 'U-line-123' } });
    expect(ident.customerId).toBe(a.customerId);
    // next booking from the same LINE user resolves to the same customer even with another phone
    const r2 = await publicBook(form(o, date, { lk, startAt: at(date, '15:00').toISOString(), phone: '080-0000-1111' }));
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: r2.appointmentId } })).customerId).toBe(a.customerId);
    // token from another org is ignored
    expect(resolveSource('other-org', lk, null).source).toBe('WEB');
    expect(resolveSource(o.org.id, null, 'instagram').source).toBe('INSTAGRAM');
    expect(resolveSource(o.org.id, 'garbage.token', 'google').source).toBe('GOOGLE');
  });

  it('request mode creates REQUESTED bookings; consultation menus make consultation bookings', async () => {
    const o = await setup();
    await prisma.shop.update({ where: { id: o.shop.id }, data: { bookingMode: 'REQUEST' } });
    const date = futureDate();
    const r = await publicBook(form(o, date, { menuIds: [o.consult.id] }));
    expect(r.status).toBe('REQUESTED');
    const a = await prisma.appointment.findUniqueOrThrow({ where: { id: r.appointmentId } });
    expect(a.kind).toBe('CONSULTATION');
    const msg = await prisma.message.findFirstOrThrow({ where: { appointmentId: a.id } });
    expect(msg.body).toContain('リクエスト');
    await expect(publicBook(form(o, date, { menuIds: [o.consult.id, o.cut.id], startAt: at(date, '15:00').toISOString() }))).rejects.toThrow('相談予約');
  });

  it('customer cancel respects the cancellation deadline', async () => {
    const o = await setup();
    const date = futureDate(5);
    const r = await publicBook(form(o, date));
    const a = await prisma.appointment.findUniqueOrThrow({ where: { id: r.appointmentId } });
    const shop = await prisma.shop.findUniqueOrThrow({ where: { id: o.shop.id } });
    const lateNow = new Date(a.startAt.getTime() - 2 * 3600_000);
    expect(customerCanModify(a, shop, lateNow)).toEqual({ ok: false, reason: 'PAST_DEADLINE' });
    await prisma.shop.update({ where: { id: o.shop.id }, data: { phone: '03-0000-0000' } });
    await expect(publicCancel(a.manageToken, null, lateNow)).rejects.toThrow('03-0000-0000');
    await publicCancel(a.manageToken, '体調不良');
    const after = await prisma.appointment.findUniqueOrThrow({ where: { id: a.id } });
    expect(after.status).toBe('CANCELLED');
    expect(after.cancelReason).toContain('体調不良');
    expect(await prisma.auditLog.count({ where: { organizationId: o.org.id, action: 'appointment.cancel', resourceId: a.id } })).toBe(1);
    await expect(publicCancel(a.manageToken, null)).rejects.toThrow('できません');
  });

  it('customer reschedule re-validates hours/conflicts and keeps a nominated stylist', async () => {
    const o = await setup({ seats: 3 });
    const date = futureDate(4);
    const r = await publicBook(form(o, date, { staffId: o.staff[1].userId }));
    const a = await prisma.appointment.findUniqueOrThrow({ where: { id: r.appointmentId } });
    // overlapping its own slot is fine (self excluded)
    await publicReschedule({ token: a.manageToken, startAt: at(date, '11:30').toISOString() });
    let cur = await prisma.appointment.findUniqueOrThrow({ where: { id: a.id } });
    expect(cur.startAt.toISOString()).toBe(at(date, '11:30').toISOString());
    expect(cur.staffId).toBe(o.staff[1].userId);
    // stylist busy elsewhere → rejected
    await createAppointment({ orgId: o.org.id, shopId: o.shop.id, staffId: o.staff[1].userId, startAt: at(date, '15:00'), menus: [{ name: 'x', price: 1, durationMin: 60 }] });
    await expect(publicReschedule({ token: a.manageToken, startAt: at(date, '15:00').toISOString() })).rejects.toBeInstanceOf(BookingError);
    await expect(publicReschedule({ token: a.manageToken, startAt: at(date, '19:30').toISOString() })).rejects.toBeInstanceOf(BookingError);
    await publicReschedule({ token: a.manageToken, startAt: at(date, '17:00').toISOString() });
    cur = await prisma.appointment.findUniqueOrThrow({ where: { id: a.id } });
    expect(cur.startAt.toISOString()).toBe(at(date, '17:00').toISOString());
    expect(await prisma.message.count({ where: { appointmentId: a.id } })).toBe(3); // booked + 2 changes
  });
});
