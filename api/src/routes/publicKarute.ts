import { Hono } from 'hono';
import type { Bindings, Variables, Reservation, Customer, Karute, Menu } from '../types';
import { requirePublicToken } from '../utils/publicToken';
import { sanitizeCustomer } from '../utils/sanitize';

export const publicKaruteRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Get reservation info for karute entry (requires signed token)
publicKaruteRoutes.get('/reservation/:id', requirePublicToken('id'), async (c) => {
  const id = c.req.param('id');

  const reservation = await c.env.DB.prepare(
    `SELECT r.*,
            c.name as customer_name, c.name_kana, c.phone, c.email,
            c.gender, c.birthday, c.postal_code, c.address,
            m.name as menu_name, m.category as menu_category,
            s.name as store_name
     FROM reservations r
     LEFT JOIN customers c ON r.customer_id = c.id
     LEFT JOIN menus m ON r.menu_id = m.id
     LEFT JOIN stores s ON r.store_id = s.id
     WHERE r.id = ?`
  )
    .bind(id)
    .first<Reservation & {
      customer_name: string;
      name_kana: string | null;
      phone: string | null;
      email: string | null;
      gender: string | null;
      birthday: string | null;
      postal_code: string | null;
      address: string | null;
      menu_name: string;
      menu_category: string;
      store_name: string;
    }>();

  if (!reservation) {
    return c.json({ error: 'Reservation not found' }, 404);
  }

  // Check if karute already exists for this reservation
  const existingKarute = await c.env.DB.prepare(
    'SELECT id FROM karutes WHERE reservation_id = ?'
  )
    .bind(id)
    .first<{ id: string }>();

  return c.json({
    reservation,
    hasKarute: !!existingKarute,
    karuteId: existingKarute?.id || null
  });
});

// Get menus for the store (requires signed token)
publicKaruteRoutes.get('/reservation/:id/menus', requirePublicToken('id'), async (c) => {
  const id = c.req.param('id');

  // Get store_id from reservation
  const reservation = await c.env.DB.prepare(
    'SELECT store_id FROM reservations WHERE id = ?'
  )
    .bind(id)
    .first<{ store_id: string }>();

  if (!reservation) {
    return c.json({ error: 'Reservation not found' }, 404);
  }

  const menus = await c.env.DB.prepare(
    'SELECT id, category, name, description, duration, price FROM menus WHERE store_id = ? AND is_active = 1 ORDER BY category, sort_order'
  )
    .bind(reservation.store_id)
    .all<Menu>();

  // Group by category
  const byCategory: Record<string, Menu[]> = {};
  menus.results.forEach((menu) => {
    if (!byCategory[menu.category]) {
      byCategory[menu.category] = [];
    }
    byCategory[menu.category].push(menu);
  });

  return c.json({ menus: menus.results, byCategory });
});

// Update customer info (requires signed token)
publicKaruteRoutes.put('/reservation/:id/customer', requirePublicToken('id'), async (c) => {
  const reservationId = c.req.param('id');

  const reservation = await c.env.DB.prepare(
    'SELECT customer_id FROM reservations WHERE id = ?'
  )
    .bind(reservationId)
    .first<{ customer_id: string }>();

  if (!reservation) {
    return c.json({ error: 'Reservation not found' }, 404);
  }

  const body = await c.req.json<{
    name?: string;
    name_kana?: string;
    phone?: string;
    email?: string;
    gender?: 'male' | 'female' | 'other';
    birthday?: string;
    postal_code?: string;
    address?: string;
  }>();

  const updates: string[] = [];
  const values: (string | null)[] = [];

  if (body.name !== undefined) {
    updates.push('name = ?');
    values.push(body.name);
  }
  if (body.name_kana !== undefined) {
    updates.push('name_kana = ?');
    values.push(body.name_kana || null);
  }
  if (body.phone !== undefined) {
    updates.push('phone = ?');
    values.push(body.phone || null);
  }
  if (body.email !== undefined) {
    updates.push('email = ?');
    values.push(body.email || null);
  }
  if (body.gender !== undefined) {
    updates.push('gender = ?');
    values.push(body.gender || null);
  }
  if (body.birthday !== undefined) {
    updates.push('birthday = ?');
    values.push(body.birthday || null);
  }
  if (body.postal_code !== undefined) {
    updates.push('postal_code = ?');
    values.push(body.postal_code || null);
  }
  if (body.address !== undefined) {
    updates.push('address = ?');
    values.push(body.address || null);
  }

  if (updates.length === 0) {
    return c.json({ error: 'No updates provided' }, 400);
  }

  updates.push("updated_at = datetime('now')");
  values.push(reservation.customer_id);

  await c.env.DB.prepare(`UPDATE customers SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();

  const customer = await c.env.DB.prepare('SELECT * FROM customers WHERE id = ?')
    .bind(reservation.customer_id)
    .first<Customer>();

  return c.json({ customer: sanitizeCustomer(customer as unknown as Record<string, unknown>) });
});

// Create karute from customer (requires signed token)
publicKaruteRoutes.post('/reservation/:id/karute', requirePublicToken('id'), async (c) => {
  const reservationId = c.req.param('id');

  const reservation = await c.env.DB.prepare(
    'SELECT * FROM reservations WHERE id = ?'
  )
    .bind(reservationId)
    .first<Reservation>();

  if (!reservation) {
    return c.json({ error: 'Reservation not found' }, 404);
  }

  // Check if karute already exists
  const existingKarute = await c.env.DB.prepare(
    'SELECT id FROM karutes WHERE reservation_id = ?'
  )
    .bind(reservationId)
    .first<{ id: string }>();

  if (existingKarute) {
    return c.json({ error: 'Karute already exists for this reservation', karuteId: existingKarute.id }, 400);
  }

  const body = await c.req.json<{
    menu_content?: string;
    hair_condition?: string;
    color_formula?: string;
    styling_notes?: string;
    customer_feedback?: string;
  }>();

  const id = crypto.randomUUID();
  const visitDate = reservation.start_at.split('T')[0];

  await c.env.DB.prepare(
    `INSERT INTO karutes (id, store_id, customer_id, reservation_id, staff_id, visit_date,
       menu_content, hair_condition, color_formula, styling_notes, customer_feedback)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      reservation.store_id,
      reservation.customer_id,
      reservationId,
      reservation.staff_id,
      visitDate,
      body.menu_content || null,
      body.hair_condition || null,
      body.color_formula || null,
      body.styling_notes || null,
      body.customer_feedback || null
    )
    .run();

  const karute = await c.env.DB.prepare('SELECT * FROM karutes WHERE id = ?')
    .bind(id)
    .first<Karute>();

  return c.json({ karute }, 201);
});

// Update karute from customer (requires signed token)
publicKaruteRoutes.put('/reservation/:id/karute', requirePublicToken('id'), async (c) => {
  const reservationId = c.req.param('id');

  const karute = await c.env.DB.prepare(
    'SELECT * FROM karutes WHERE reservation_id = ?'
  )
    .bind(reservationId)
    .first<Karute>();

  if (!karute) {
    return c.json({ error: 'Karute not found' }, 404);
  }

  const body = await c.req.json<{
    menu_content?: string;
    hair_condition?: string;
    color_formula?: string;
    styling_notes?: string;
    customer_feedback?: string;
  }>();

  const updates: string[] = [];
  const values: (string | null)[] = [];

  if (body.menu_content !== undefined) {
    updates.push('menu_content = ?');
    values.push(body.menu_content || null);
  }
  if (body.hair_condition !== undefined) {
    updates.push('hair_condition = ?');
    values.push(body.hair_condition || null);
  }
  if (body.color_formula !== undefined) {
    updates.push('color_formula = ?');
    values.push(body.color_formula || null);
  }
  if (body.styling_notes !== undefined) {
    updates.push('styling_notes = ?');
    values.push(body.styling_notes || null);
  }
  if (body.customer_feedback !== undefined) {
    updates.push('customer_feedback = ?');
    values.push(body.customer_feedback || null);
  }

  if (updates.length === 0) {
    return c.json({ error: 'No updates provided' }, 400);
  }

  updates.push("updated_at = datetime('now')");
  values.push(karute.id);

  await c.env.DB.prepare(`UPDATE karutes SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();

  const updated = await c.env.DB.prepare('SELECT * FROM karutes WHERE id = ?')
    .bind(karute.id)
    .first<Karute>();

  return c.json({ karute: updated });
});
