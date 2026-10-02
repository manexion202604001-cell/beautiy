import { Hono } from 'hono';
import type { Bindings, Variables, Equipment } from '../types';
import { staffAuth, requireRole } from '../middleware/auth';

async function hasStoreAccess(db: D1Database, staffId: string, storeId: string): Promise<boolean> {
  const row = await db.prepare(
    'SELECT 1 FROM staff_stores WHERE staff_id = ? AND store_id = ?'
  ).bind(staffId, storeId).first();
  return !!row;
}

export const equipmentRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Apply auth middleware
equipmentRoutes.use('*', staffAuth);

// List equipment for a store
equipmentRoutes.get('/', async (c) => {
  const staff = c.get('staff')!;
  const storeId = c.req.query('store_id') || staff.store_id;

  if (!storeId && staff.role !== 'system_admin') {
    return c.json({ equipment: [] });
  }

  const activeOnly = c.req.query('active') !== 'false';
  let query = 'SELECT * FROM equipment WHERE store_id = ?';
  const params: (string | number)[] = [storeId!];

  if (activeOnly) {
    query += ' AND is_active = 1';
  }

  query += ' ORDER BY sort_order, name';

  const result = await c.env.DB.prepare(query)
    .bind(...params)
    .all<Equipment>();

  return c.json({ equipment: result.results });
});

// Get all menu-equipment mappings for a store (for frontend canDrop validation)
equipmentRoutes.get('/menu-mappings', async (c) => {
  const staff = c.get('staff')!;
  const storeId = c.req.query('store_id') || staff.store_id;

  if (!storeId) {
    return c.json({ mappings: {} });
  }

  // Get all active equipment for this store
  const equipmentResult = await c.env.DB.prepare(
    'SELECT id, quantity FROM equipment WHERE store_id = ? AND is_active = 1'
  ).bind(storeId).all<{ id: string; quantity: number }>();

  const equipmentIds = new Set(equipmentResult.results.map(e => e.id));

  // Get all menu_equipment mappings for equipment in this store
  const mappingsResult = await c.env.DB.prepare(
    `SELECT me.menu_id, me.equipment_id FROM menu_equipment me
     JOIN equipment e ON me.equipment_id = e.id
     WHERE e.store_id = ? AND e.is_active = 1`
  ).bind(storeId).all<{ menu_id: string; equipment_id: string }>();

  // Group by menu_id
  const mappings: Record<string, string[]> = {};
  for (const row of mappingsResult.results) {
    if (!mappings[row.menu_id]) {
      mappings[row.menu_id] = [];
    }
    mappings[row.menu_id].push(row.equipment_id);
  }

  // Also return equipment quantities
  const quantities: Record<string, number> = {};
  for (const eq of equipmentResult.results) {
    quantities[eq.id] = eq.quantity;
  }

  return c.json({ mappings, quantities });
});

// Create equipment (manager+ only)
equipmentRoutes.post('/', requireRole('system_admin', 'owner', 'manager'), async (c) => {
  const staff = c.get('staff')!;
  const body = await c.req.json<{
    store_id?: string;
    name: string;
    quantity?: number;
    sort_order?: number;
  }>();

  if (!body.name) {
    return c.json({ error: '設備名は必須です' }, 400);
  }

  const storeId = body.store_id || staff.store_id;
  if (!storeId) {
    return c.json({ error: 'Store ID is required' }, 400);
  }

  if (staff.role !== 'system_admin' && !await hasStoreAccess(c.env.DB, staff.id, storeId)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const id = crypto.randomUUID();

  try {
    await c.env.DB.prepare(
      `INSERT INTO equipment (id, store_id, name, quantity, sort_order)
       VALUES (?, ?, ?, ?, ?)`
    )
      .bind(id, storeId, body.name, body.quantity || 1, body.sort_order || 0)
      .run();
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes('UNIQUE')) {
      return c.json({ error: '同じ名前の設備が既に存在します' }, 409);
    }
    throw e;
  }

  const equipment = await c.env.DB.prepare('SELECT * FROM equipment WHERE id = ?')
    .bind(id)
    .first<Equipment>();

  return c.json({ equipment }, 201);
});

// Update equipment (manager+ only)
equipmentRoutes.put('/:id', requireRole('system_admin', 'owner', 'manager'), async (c) => {
  const staff = c.get('staff')!;
  const id = c.req.param('id');

  const equipment = await c.env.DB.prepare('SELECT * FROM equipment WHERE id = ?')
    .bind(id)
    .first<Equipment>();

  if (!equipment) {
    return c.json({ error: '設備が見つかりません' }, 404);
  }

  if (staff.role !== 'system_admin' && !await hasStoreAccess(c.env.DB, staff.id, equipment.store_id)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const body = await c.req.json<{
    name?: string;
    quantity?: number;
    is_active?: boolean;
    sort_order?: number;
  }>();

  const updates: string[] = [];
  const values: (string | number | null)[] = [];

  if (body.name !== undefined) {
    updates.push('name = ?');
    values.push(body.name);
  }
  if (body.quantity !== undefined) {
    updates.push('quantity = ?');
    values.push(body.quantity);
  }
  if (body.is_active !== undefined) {
    updates.push('is_active = ?');
    values.push(body.is_active ? 1 : 0);
  }
  if (body.sort_order !== undefined) {
    updates.push('sort_order = ?');
    values.push(body.sort_order);
  }

  if (updates.length === 0) {
    return c.json({ error: 'No updates provided' }, 400);
  }

  updates.push("updated_at = datetime('now')");
  values.push(id!);

  try {
    await c.env.DB.prepare(`UPDATE equipment SET ${updates.join(', ')} WHERE id = ?`)
      .bind(...values)
      .run();
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes('UNIQUE')) {
      return c.json({ error: '同じ名前の設備が既に存在します' }, 409);
    }
    throw e;
  }

  const updated = await c.env.DB.prepare('SELECT * FROM equipment WHERE id = ?')
    .bind(id)
    .first<Equipment>();

  return c.json({ equipment: updated });
});

// Delete equipment (manager+ only)
equipmentRoutes.delete('/:id', requireRole('system_admin', 'owner', 'manager'), async (c) => {
  const staff = c.get('staff')!;
  const id = c.req.param('id');

  const equipment = await c.env.DB.prepare('SELECT * FROM equipment WHERE id = ?')
    .bind(id)
    .first<Equipment>();

  if (!equipment) {
    return c.json({ error: '設備が見つかりません' }, 404);
  }

  if (staff.role !== 'system_admin' && !await hasStoreAccess(c.env.DB, staff.id, equipment.store_id)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  // Check if equipment is used in any menu
  const usedInMenus = await c.env.DB.prepare(
    'SELECT COUNT(*) as count FROM menu_equipment WHERE equipment_id = ?'
  ).bind(id).first<{ count: number }>();

  if (usedInMenus && usedInMenus.count > 0) {
    return c.json({
      error: `この設備は${usedInMenus.count}件のメニューで使用されています。先にメニューから設備を外してください。`,
      menu_count: usedInMenus.count,
    }, 409);
  }

  await c.env.DB.prepare('DELETE FROM equipment WHERE id = ?').bind(id).run();

  return c.json({ success: true });
});
