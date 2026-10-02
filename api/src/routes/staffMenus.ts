import { Hono } from 'hono';
import type { Bindings, Variables } from '../types';
import { staffAuth } from '../middleware/auth';

export interface StaffMenu {
  id: string;
  staff_id: string;
  name: string;
  category: string;
  duration: number;
  price: number;
  sort_order: number;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export const staffMenusRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

staffMenusRoutes.use('*', staffAuth);

// List my menus
staffMenusRoutes.get('/', async (c) => {
  const staff = c.get('staff')!;

  const menus = await c.env.DB.prepare(
    'SELECT * FROM staff_menus WHERE staff_id = ? ORDER BY category, sort_order, name'
  ).bind(staff.id).all<StaffMenu>();

  return c.json({ menus: menus.results });
});

// Create menu
staffMenusRoutes.post('/', async (c) => {
  const staff = c.get('staff')!;
  const body = await c.req.json();
  const id = crypto.randomUUID();

  const maxOrder = await c.env.DB.prepare(
    'SELECT MAX(sort_order) as max_order FROM staff_menus WHERE staff_id = ? AND category = ?'
  ).bind(staff.id, body.category || '').first<{ max_order: number | null }>();

  await c.env.DB.prepare(
    `INSERT INTO staff_menus (id, staff_id, name, category, duration, price, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id,
    staff.id,
    body.name,
    body.category || '',
    body.duration,
    body.price,
    (maxOrder?.max_order ?? -1) + 1
  ).run();

  const menu = await c.env.DB.prepare('SELECT * FROM staff_menus WHERE id = ?')
    .bind(id).first<StaffMenu>();

  return c.json({ menu }, 201);
});

// Update menu
staffMenusRoutes.put('/:id', async (c) => {
  const staff = c.get('staff')!;
  const menuId = c.req.param('id');
  const body = await c.req.json();

  const existing = await c.env.DB.prepare(
    'SELECT * FROM staff_menus WHERE id = ? AND staff_id = ?'
  ).bind(menuId, staff.id).first<StaffMenu>();

  if (!existing) {
    return c.json({ error: 'Not found' }, 404);
  }

  await c.env.DB.prepare(
    `UPDATE staff_menus SET name = ?, category = ?, duration = ?, price = ?, updated_at = datetime('now')
     WHERE id = ? AND staff_id = ?`
  ).bind(
    body.name ?? existing.name,
    body.category ?? existing.category,
    body.duration ?? existing.duration,
    body.price ?? existing.price,
    menuId,
    staff.id
  ).run();

  const menu = await c.env.DB.prepare('SELECT * FROM staff_menus WHERE id = ?')
    .bind(menuId).first<StaffMenu>();

  return c.json({ menu });
});

// Delete menu
staffMenusRoutes.delete('/:id', async (c) => {
  const staff = c.get('staff')!;
  const menuId = c.req.param('id');

  const existing = await c.env.DB.prepare(
    'SELECT * FROM staff_menus WHERE id = ? AND staff_id = ?'
  ).bind(menuId, staff.id).first<StaffMenu>();

  if (!existing) {
    return c.json({ error: 'Not found' }, 404);
  }

  await c.env.DB.prepare('DELETE FROM staff_menus WHERE id = ? AND staff_id = ?')
    .bind(menuId, staff.id).run();

  return c.json({ success: true });
});

// Reorder menus
staffMenusRoutes.put('/batch/reorder', async (c) => {
  const staff = c.get('staff')!;
  const body = await c.req.json<{ items: { id: string; sort_order: number }[] }>();

  const stmts = body.items.map((item) =>
    c.env.DB.prepare('UPDATE staff_menus SET sort_order = ? WHERE id = ? AND staff_id = ?')
      .bind(item.sort_order, item.id, staff.id)
  );

  await c.env.DB.batch(stmts);

  return c.json({ success: true });
});
