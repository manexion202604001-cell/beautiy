import { describe, expect, it } from 'vitest';
import { api, createMenu, createStaffUser, createTenant, jst, nextWeekday } from '../../test/helpers.js';

async function setup() {
  const t = await createTenant();
  const stylist = await createStaffUser(t, 'stylist', { displayName: '公開スタイリスト' });
  const menu = await createMenu(t, { name: 'カット+カラー', durationMin: 90, price: 12000 });
  const hidden = await createMenu(t, { name: '非公開メニュー', isPublic: false });
  const shop = (await t.owner.get(`/v1/shops/${t.shopId}`)).body;
  return { t, stylist, menu, hidden, slug: shop.slug as string };
}

describe('public booking', () => {
  it('exposes public shop info without private menus', async () => {
    const { slug, menu, hidden, stylist } = await setup();
    const res = await api().get(`/v1/public/shops/${slug}`);
    expect(res.status).toBe(200);
    expect(res.body.menus.map((m: { id: string }) => m.id)).toContain(menu.id);
    expect(res.body.menus.map((m: { id: string }) => m.id)).not.toContain(hidden.id);
    expect(res.body.staff.map((s: { id: string }) => s.id)).toContain(stylist.staffId);
    expect(res.body.businessHours.length).toBeGreaterThan(0);
    expect(JSON.stringify(res.body)).not.toContain('settings');
  });

  it('books as a guest, resolves the customer and supports manage-link cancel', async () => {
    const { t, slug, menu, stylist } = await setup();
    const date = nextWeekday(3);
    const avail = await api().get(`/v1/public/shops/${slug}/availability`, { menuIds: menu.id, staffId: stylist.staffId, from: date, to: date });
    expect(avail.body.days[0].slots.length).toBeGreaterThan(0);
    const startAt = avail.body.days[0].slots[0].start;
    const body = {
      menuIds: [menu.id],
      staffId: stylist.staffId,
      startAt,
      clientRequestId: 'req-1',
      utm: { source: 'instagram' },
      customer: { lastName: '予約', firstName: '花子', lastNameKana: 'ヨヤク', firstNameKana: 'ハナコ', phone: '090-5555-6666' },
    };
    const res = await api().post(`/v1/public/shops/${slug}/appointments`, body);
    expect(res.status).toBe(201);
    expect(res.body.appointment.status).toBe('confirmed');
    expect(res.body.appointment.isNominated).toBe(true);
    expect(res.body.manageUrl).toContain('/b/manage/');
    // replay with same clientRequestId does not duplicate
    const replay = await api().post(`/v1/public/shops/${slug}/appointments`, body);
    expect(replay.status).toBe(200);
    expect(replay.body.appointment.id).toBe(res.body.appointment.id);

    const appt = (await t.owner.get(`/v1/appointments/${res.body.appointment.id}`)).body;
    expect(appt.source).toBe('web');
    expect(appt.source_detail.utm.source).toBe('instagram');
    const customers = (await t.owner.get('/v1/customers', { q: '09055556666' })).body.items;
    expect(customers).toHaveLength(1);

    const token = res.body.manageUrl.split('/').pop();
    const view = await api().get(`/v1/public/bookings/${token}`);
    expect(view.body.bookingReference).toBe(res.body.appointment.bookingReference);
    const cancel = await api().post(`/v1/public/bookings/${token}/cancel`, { reason: '予定変更' });
    expect(cancel.status).toBe(200);
    expect(cancel.body.status).toBe('cancelled');
    const after = (await t.owner.get(`/v1/appointments/${res.body.appointment.id}`)).body;
    expect(after.cancelled_by_type).toBe('customer');
  });

  it('enforces the booking horizon for online booking', async () => {
    const { slug, menu, t } = await setup();
    const bad = await t.owner.patch(`/v1/shops/${t.shopId}`, { settings: { booking: { leadTimeMin: 60 * 24 * 30 } } });
    expect(bad.status).toBe(400);
    const ok = await t.owner.patch(`/v1/shops/${t.shopId}`, { settings: { booking: { horizonDays: 1 } } });
    expect(ok.body.settings.booking.horizonDays).toBe(1);
    expect(ok.body.settings.booking.slotIntervalMin).toBe(15);
    const date = nextWeekday(3);
    const avail = await api().get(`/v1/public/shops/${slug}/availability`, { menuIds: menu.id, from: date, to: date });
    expect(avail.body.days[0].slots).toHaveLength(0);
    const res = await api().post(`/v1/public/shops/${slug}/appointments`, {
      menuIds: [menu.id],
      startAt: jst(date, '11:00'),
      customer: { lastName: 'A', firstName: 'B', phone: '09000000000' },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe('horizon');
  });

  it('logs in with LINE (mock LIFF), books, lists and cancels within the deadline', async () => {
    const { slug, menu, t } = await setup();
    const login = await api().post(`/v1/public/shops/${slug}/auth/line`, { idToken: 'mock:U-line-1:ラインユーザー' });
    expect(login.status).toBe(200);
    expect(login.body.isNew).toBe(true);
    expect(login.body.profileComplete).toBe(false);
    const customer = api(login.body.token);
    const date = nextWeekday(4);
    const booking = await customer.post(`/v1/public/shops/${slug}/appointments`, {
      menuIds: [menu.id],
      startAt: jst(date, '14:00'),
      customer: { lastName: 'ライン', firstName: '太郎', phone: '08077778888' },
    });
    expect(booking.status).toBe(201);
    const appt = (await t.owner.get(`/v1/appointments/${booking.body.appointment.id}`)).body;
    expect(appt.source).toBe('line');
    expect(appt.is_nominated).toBe(false);
    const me = await customer.get('/v1/public/me');
    expect(me.body.last_name).toBe('ライン');
    const upcoming = await customer.get('/v1/public/me/appointments');
    expect(upcoming.body).toHaveLength(1);
    expect(upcoming.body[0].canModify).toBe(true);

    // second login maps to the same customer
    const again = await api().post(`/v1/public/shops/${slug}/auth/line`, { idToken: 'mock:U-line-1' });
    expect(again.body.customerId).toBe(login.body.customerId);

    // staff token cannot use customer endpoints and vice versa
    expect((await t.owner.get('/v1/public/me')).status).toBe(403);
    expect((await customer.get('/v1/customers')).status).toBe(403);

    const cancel = await customer.post(`/v1/public/me/appointments/${booking.body.appointment.id}/cancel`, {});
    expect(cancel.body.status).toBe('cancelled');
  });

  it('rejects customer cancellation after the deadline', async () => {
    const { slug, menu, t } = await setup();
    await t.owner.patch(`/v1/shops/${t.shopId}`, { settings: { booking: { cancelDeadlineHours: 24 * 14, leadTimeMin: 0 } } });
    const login = await api().post(`/v1/public/shops/${slug}/auth/line`, { idToken: 'mock:U-line-2' });
    const customer = api(login.body.token);
    const date = nextWeekday(3);
    const booking = await customer.post(`/v1/public/shops/${slug}/appointments`, {
      menuIds: [menu.id],
      startAt: jst(date, '12:00'),
      customer: { lastName: '期限', firstName: '切れ', phone: '08011110000' },
    });
    expect(booking.status).toBe(201);
    const cancel = await customer.post(`/v1/public/me/appointments/${booking.body.appointment.id}/cancel`, {});
    expect(cancel.status).toBe(422);
    expect(cancel.body.error.code).toBe('CANCEL_DEADLINE_PASSED');
  });

  it('authenticates customers via SMS OTP', async () => {
    const { slug } = await setup();
    const req = await api().post(`/v1/public/shops/${slug}/auth/otp/request`, { destination: '090-1212-3434' });
    expect(req.status).toBe(200);
    const verify = await api().post('/v1/public/auth/otp/verify', { challengeId: req.body.challengeId, code: req.body.devCode, profile: { lastName: 'OTP', firstName: '顧客' } });
    expect(verify.status).toBe(200);
    const me = await api(verify.body.token).get('/v1/public/me');
    expect(me.body.phone_normalized ?? me.body.phone).toBeTruthy();
    const reuse = await api().post('/v1/public/auth/otp/verify', { challengeId: req.body.challengeId, code: req.body.devCode });
    expect(reuse.status).toBe(401);
  });
});
