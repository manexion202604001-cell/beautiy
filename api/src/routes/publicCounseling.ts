import { Hono } from 'hono';
import type { Bindings, Variables } from '../types';
import { requirePublicToken } from '../utils/publicToken';

const publicCounselingRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Get counseling sheet by reservation_id (no token - customer self-service)
publicCounselingRoutes.get('/:reservationId', async (c) => {
  const reservationId = c.req.param('reservationId');

  const reservation = await c.env.DB.prepare(
    'SELECT customer_id, store_id FROM reservations WHERE id = ?'
  ).bind(reservationId).first<{ customer_id: string; store_id: string }>();

  if (!reservation) {
    return c.json({ error: 'Reservation not found' }, 404);
  }

  const sheet = await c.env.DB.prepare(
    'SELECT * FROM counseling_sheets WHERE customer_id = ? AND store_id = ?'
  ).bind(reservation.customer_id, reservation.store_id).first();

  return c.json({
    counseling_sheet: sheet
      ? { ...sheet, data: JSON.parse(sheet.data as string) }
      : null,
    store_id: reservation.store_id,
    customer_id: reservation.customer_id,
  });
});

// Save counseling sheet by reservation_id (no token - customer self-service)
publicCounselingRoutes.put('/:reservationId', async (c) => {
  const reservationId = c.req.param('reservationId');

  const reservation = await c.env.DB.prepare(
    'SELECT customer_id, store_id FROM reservations WHERE id = ?'
  ).bind(reservationId).first<{ customer_id: string; store_id: string }>();

  if (!reservation) {
    return c.json({ error: 'Reservation not found' }, 404);
  }

  const { data } = await c.req.json<{ data: Record<string, unknown> }>();
  if (!data) {
    return c.json({ error: 'data is required' }, 400);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];

  await c.env.DB.prepare(
    `INSERT INTO counseling_sheets (id, store_id, customer_id, data, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(store_id, customer_id)
     DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
  ).bind(id, reservation.store_id, reservation.customer_id, JSON.stringify(data), now, now).run();

  // Notify staff via Web Push
  try {
    const staffInfo = await c.env.DB.prepare(
      `SELECT r.staff_id, c.name as customer_name
       FROM reservations r
       JOIN customers c ON r.customer_id = c.id
       WHERE r.id = ?`
    ).bind(reservationId).first<{ staff_id: string; customer_name: string | null }>();

    if (staffInfo?.staff_id && c.env.VAPID_PUBLIC_KEY && c.env.VAPID_PRIVATE_KEY) {
      const customerName = staffInfo.customer_name || 'お客様';
      const { PushNotificationService } = await import('../services/pushService');
      await PushNotificationService.notifyStaff(
        c.env.DB, staffInfo.staff_id,
        {
          title: 'カウンセリングシート記入完了',
          body: `${customerName}様がカウンセリングシートを記入しました`,
          url: `/customers?id=${reservation.customer_id}&tab=counseling`,
          tag: `counseling-${reservationId}`,
        },
        c.env.VAPID_PUBLIC_KEY, c.env.VAPID_PRIVATE_KEY
      );
    }
  } catch (e) {
    console.error('Staff notification error:', e);
  }

  return c.json({ success: true });
});

// Save counseling sheet by store_id only (no reservation, e.g. from consent form flow)
publicCounselingRoutes.put('/by-store/:storeId', async (c) => {
  const storeId = c.req.param('storeId');

  const store = await c.env.DB.prepare(
    'SELECT id FROM stores WHERE id = ?'
  ).bind(storeId).first();

  if (!store) {
    return c.json({ error: 'Store not found' }, 404);
  }

  const { data } = await c.req.json<{ data: Record<string, unknown> }>();
  if (!data) {
    return c.json({ error: 'data is required' }, 400);
  }

  // Save as anonymous counseling sheet (customer_id = 'anonymous_' + timestamp)
  const id = crypto.randomUUID();
  const anonymousCustomerId = `anonymous_${Date.now()}`;
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];

  await c.env.DB.prepare(
    `INSERT INTO counseling_sheets (id, store_id, customer_id, data, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(id, storeId, anonymousCustomerId, JSON.stringify(data), now, now).run();

  return c.json({ success: true });
});

// 受付QR（純Web）保留レコードのカウンセリングを取得（再開用）
publicCounselingRoutes.get('/walkin/:walkinId', async (c) => {
  const walkinId = c.req.param('walkinId');
  const row = await c.env.DB.prepare(
    'SELECT store_id, counseling_data FROM walkin_intakes WHERE id = ?'
  ).bind(walkinId).first<{ store_id: string; counseling_data: string | null }>();

  if (!row) {
    return c.json({ error: 'Walk-in not found' }, 404);
  }

  return c.json({
    counseling_sheet: row.counseling_data ? { data: JSON.parse(row.counseling_data) } : null,
    store_id: row.store_id,
  });
});

// 受付QR（純Web）保留レコードにカウンセリングを保存（顧客はまだ作らない）
publicCounselingRoutes.put('/walkin/:walkinId', async (c) => {
  const walkinId = c.req.param('walkinId');

  const row = await c.env.DB.prepare(
    "SELECT id FROM walkin_intakes WHERE id = ? AND status = 'pending'"
  ).bind(walkinId).first<{ id: string }>();

  if (!row) {
    return c.json({ error: 'Walk-in not found' }, 404);
  }

  const { data } = await c.req.json<{ data: Record<string, unknown> }>();
  if (!data) {
    return c.json({ error: 'data is required' }, 400);
  }

  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  await c.env.DB.prepare(
    "UPDATE walkin_intakes SET counseling_data = ?, counseling_submitted_at = ?, updated_at = ? WHERE id = ?"
  ).bind(JSON.stringify(data), now, now, walkinId).run();

  return c.json({ success: true });
});

export { publicCounselingRoutes };
