import { describe, expect, it } from 'vitest';
import { localToUtc } from '@salonos/core';
import { prisma } from '@salonos/db';
import { BookingError, createAppointment } from '@/lib/server/booking';
import { piiColumns } from '@/lib/server/pii';
import { reviewableAppointment } from '@/lib/server/reviews';
import { createStoreOrder } from '@/lib/server/commerce';
import { signLineLink } from '@/lib/server/line-link';
import {
  availableSlots, checkFormToken, couponDiscount, customerCanModify, loadManagedAppointment, publicBook, publicCancel, publicHold, publicReschedule, resolveSource, signFormToken,
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

  it('H1: a known phone with a different name never reveals or attaches to the stored customer', async () => {
    const o = await setup({ seats: 3 });
    const date = futureDate();
    const victim = await prisma.customer.create({ data: {
      organizationId: o.org.id, lastName: '山田', firstName: '花子', lastNameKana: 'ヤマダ', firstNameKana: 'ハナコ', lineOptIn: true,
      ...piiColumns({ phone: '090-5555-0001', email: 'hanako.victim@example.com' }),
      identities: { create: { organizationId: o.org.id, provider: 'LINE', externalId: 'U-victim' } },
    } });

    // stranger types the victim's phone number with another name
    const r = await publicBook(form(o, date, { name: '攻撃 太郎', kana: 'コウゲキ タロウ', phone: '090-5555-0001', email: 'attacker@example.com' }));
    const a = await prisma.appointment.findUniqueOrThrow({ where: { id: r.appointmentId } });
    expect(a.customerId).not.toBe(victim.id);
    expect(a.guestName).toBe('攻撃 太郎');
    expect(a.guestPhone).toBe('09055550001');
    const fresh = await prisma.customer.findUniqueOrThrow({ where: { id: a.customerId! }, include: { identities: true } });
    expect(fresh).toMatchObject({ lastName: '攻撃', firstName: '太郎', phoneHash: victim.phoneHash });
    expect(fresh.identities).toHaveLength(0);
    // what the public manage page loads contains only the submitted name
    const managed = await loadManagedAppointment(a.manageToken);
    const json = JSON.stringify(managed);
    for (const secret of ['山田', '花子', 'ハナコ', 'hanako.victim']) expect(json).not.toContain(secret);
    expect(json).toContain('攻撃 太郎');
    expect((managed as any).customer).toBeUndefined();
    // the confirmation went to the new record's own (submitted) address, never to the victim's LINE/email
    const msgs = await prisma.message.findMany({ where: { appointmentId: a.id } });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ customerId: fresh.id, channel: 'EMAIL', status: 'SENT' });
    expect(await prisma.message.count({ where: { customerId: victim.id } })).toBe(0);
    // the review page projection never includes the stored customer either
    await prisma.appointment.update({ where: { id: a.id }, data: { status: 'COMPLETED' } });
    const rv = await reviewableAppointment(a.manageToken);
    expect(JSON.stringify(rv)).not.toContain('花子');

    // the real customer (same phone, same name written in kana/without space) is matched
    const own = await publicBook(form(o, date, { name: 'やまだ はなこ', kana: 'ヤマダ ハナコ', phone: '09055550001', startAt: at(date, '15:00').toISOString() }));
    const ownAppt = await prisma.appointment.findUniqueOrThrow({ where: { id: own.appointmentId } });
    expect(ownAppt.customerId).toBe(victim.id);
    expect(ownAppt.guestName).toBe('やまだ はなこ');
    // a second booking by the same stranger reuses the stranger's own record, not the victim's
    const again = await publicBook(form(o, date, { name: '攻撃 太郎', kana: 'コウゲキ タロウ', phone: '090-5555-0001', startAt: at(date, '16:00').toISOString() }));
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: again.appointmentId } })).customerId).toBe(fresh.id);

    // storefront orders follow the same rule
    const product = await prisma.product.create({ data: { organizationId: o.org.id, name: 'オイル', price: 2000, stock: 5 } });
    const so = await createStoreOrder({ shopSlug: o.shop.slug, items: [{ productId: product.id, quantity: 1 }], name: '別人 次郎', email: 'hanako.victim@example.com', phone: '09055550001', address: '東京都1-1' });
    const order = await prisma.order.findUniqueOrThrow({ where: { id: so.orderId } });
    expect(order.customerId).not.toBe(victim.id);
    expect(order.contactName).toBe('別人 次郎');
    const so2 = await createStoreOrder({ shopSlug: o.shop.slug, items: [{ productId: product.id, quantity: 1 }], name: '山田 花子', email: 'x@example.com', phone: '09055550001', address: '東京都1-1' });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: so2.orderId } })).customerId).toBe(victim.id);
  });

  it('M5: only offered slots are bookable (grid, horizon, chosen stylist)', async () => {
    const o = await setup({ seats: 3 });
    const date = futureDate();
    // off the 30-minute slot grid
    await expect(publicBook(form(o, date, { startAt: at(date, '11:10').toISOString() }))).rejects.toMatchObject({ reason: 'STAFF_CONFLICT' });
    // beyond bookingHorizonDays
    await prisma.shop.update({ where: { id: o.shop.id }, data: { bookingHorizonDays: 5 } });
    const far = futureDate(10);
    await expect(publicBook(form(o, far))).rejects.toBeInstanceOf(BookingError);
    // chosen stylist is busy even though the shop still has capacity
    await createAppointment({ orgId: o.org.id, shopId: o.shop.id, staffId: o.staff[1].userId, startAt: at(date, '13:00'), menus: [{ name: 'x', price: 1, durationMin: 60 }] });
    await expect(publicBook(form(o, date, { staffId: o.staff[1].userId, startAt: at(date, '13:00').toISOString() }))).rejects.toBeInstanceOf(BookingError);
    expect(await prisma.appointment.count({ where: { organizationId: o.org.id, source: { not: 'STAFF' } } })).toBe(0);
    // on-grid, within horizon → fine
    const ok = await publicBook(form(o, date, { startAt: at(date, '11:30').toISOString() }));
    expect(ok.status).toBe('CONFIRMED');
  });
});
