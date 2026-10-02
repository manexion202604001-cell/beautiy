import { Hono } from 'hono';
import type { Bindings, Variables, MenuCategory } from '../types';
import { staffAuth, requireRole } from '../middleware/auth';

export const menuCategoriesRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Check if staff has access to a store via staff_stores table
async function hasStoreAccess(db: D1Database, staffId: string, storeId: string): Promise<boolean> {
  const row = await db.prepare(
    'SELECT 1 FROM staff_stores WHERE staff_id = ? AND store_id = ?'
  ).bind(staffId, storeId).first();
  return !!row;
}

// Apply auth middleware
menuCategoriesRoutes.use('*', staffAuth);

// List menu categories
menuCategoriesRoutes.get('/', async (c) => {
  const staff = c.get('staff')!;
  const storeId = c.req.query('store_id') || staff.store_id;

  if (!storeId && staff.role !== 'system_admin') {
    return c.json({ categories: [] });
  }

  let query = 'SELECT * FROM menu_categories WHERE 1=1';
  const params: string[] = [];

  if (storeId) {
    query += ' AND store_id = ?';
    params.push(storeId);
  }

  query += ' ORDER BY sort_order, name';

  const result = await c.env.DB.prepare(query)
    .bind(...params)
    .all<MenuCategory>();

  return c.json({ categories: result.results });
});

// Get menu category by ID
menuCategoriesRoutes.get('/:id', async (c) => {
  const staff = c.get('staff')!;
  const id = c.req.param('id');

  const category = await c.env.DB.prepare('SELECT * FROM menu_categories WHERE id = ?')
    .bind(id)
    .first<MenuCategory>();

  if (!category) {
    return c.json({ error: 'Category not found' }, 404);
  }

  // Check access
  if (staff.role !== 'system_admin' && !await hasStoreAccess(c.env.DB, staff.id, category.store_id)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  return c.json({ category });
});

// Create menu category (manager+ only)
menuCategoriesRoutes.post('/', requireRole('system_admin', 'owner', 'manager'), async (c) => {
  const staff = c.get('staff')!;
  const body = await c.req.json<{
    store_id?: string;
    name: string;
    color?: string;
    sort_order?: number;
    parent_id?: string | null;
  }>();

  if (!body.name) {
    return c.json({ error: 'Name is required' }, 400);
  }

  const storeId = body.store_id || staff.store_id;
  if (!storeId) {
    return c.json({ error: 'Store ID is required' }, 400);
  }

  // Check store access
  if (staff.role !== 'system_admin' && !await hasStoreAccess(c.env.DB, staff.id, storeId)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  // Check if category name already exists for this store
  const existing = await c.env.DB.prepare(
    'SELECT id FROM menu_categories WHERE store_id = ? AND name = ?'
  )
    .bind(storeId, body.name)
    .first();

  if (existing) {
    return c.json({ error: 'Category with this name already exists' }, 400);
  }

  const id = crypto.randomUUID();

  await c.env.DB.prepare(
    `INSERT INTO menu_categories (id, store_id, name, color, sort_order, parent_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(id, storeId, body.name, body.color || '#6B7280', body.sort_order || 0, body.parent_id || null)
    .run();

  const category = await c.env.DB.prepare('SELECT * FROM menu_categories WHERE id = ?')
    .bind(id)
    .first<MenuCategory>();

  return c.json({ category }, 201);
});

// Update menu category (manager+ only)
menuCategoriesRoutes.put('/:id', requireRole('system_admin', 'owner', 'manager'), async (c) => {
  const staff = c.get('staff')!;
  const id = c.req.param('id');

  const category = await c.env.DB.prepare('SELECT * FROM menu_categories WHERE id = ?')
    .bind(id)
    .first<MenuCategory>();

  if (!category) {
    return c.json({ error: 'Category not found' }, 404);
  }

  // Check access
  if (staff.role !== 'system_admin' && !await hasStoreAccess(c.env.DB, staff.id, category.store_id)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const body = await c.req.json<{
    name?: string;
    color?: string;
    sort_order?: number;
    parent_id?: string | null;
    salonboard_equipment_id?: string | null;
  }>();

  const updates: string[] = [];
  const values: (string | number | null)[] = [];

  if (body.name !== undefined && body.name !== category.name) {
    // Check if new name already exists
    const existing = await c.env.DB.prepare(
      'SELECT id FROM menu_categories WHERE store_id = ? AND name = ? AND id != ?'
    )
      .bind(category.store_id, body.name, id)
      .first();

    if (existing) {
      return c.json({ error: 'Category with this name already exists' }, 400);
    }

    // Update menus that use this category
    await c.env.DB.prepare(
      "UPDATE menus SET category = ?, updated_at = datetime('now') WHERE store_id = ? AND category = ?"
    )
      .bind(body.name, category.store_id, category.name)
      .run();

    updates.push('name = ?');
    values.push(body.name);
  }

  if (body.color !== undefined) {
    updates.push('color = ?');
    values.push(body.color);
  }

  if (body.sort_order !== undefined) {
    updates.push('sort_order = ?');
    values.push(body.sort_order);
  }

  if (body.parent_id !== undefined) {
    updates.push('parent_id = ?');
    values.push(body.parent_id || null);
  }

  if (body.salonboard_equipment_id !== undefined) {
    updates.push('salonboard_equipment_id = ?');
    values.push(body.salonboard_equipment_id || null);
  }

  if (updates.length === 0) {
    return c.json({ error: 'No updates provided' }, 400);
  }

  updates.push("updated_at = datetime('now')");
  values.push(id);

  await c.env.DB.prepare(`UPDATE menu_categories SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();

  const updated = await c.env.DB.prepare('SELECT * FROM menu_categories WHERE id = ?')
    .bind(id)
    .first<MenuCategory>();

  return c.json({ category: updated });
});

// Delete all menu categories for a store (manager+ only) — must be before /:id
menuCategoriesRoutes.delete('/all', requireRole('system_admin', 'owner', 'manager'), async (c) => {
  const staff = c.get('staff')!;
  const storeId = c.req.query('store_id') || staff.store_id;

  if (!storeId) {
    return c.json({ error: 'Store ID is required' }, 400);
  }

  if (staff.role !== 'system_admin' && !await hasStoreAccess(c.env.DB, staff.id, storeId)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const result = await c.env.DB.prepare('DELETE FROM menu_categories WHERE store_id = ?')
    .bind(storeId)
    .run();

  return c.json({ success: true, deleted: result.meta.changes || 0 });
});

// Delete menu category (manager+ only)
menuCategoriesRoutes.delete('/:id', requireRole('system_admin', 'owner', 'manager'), async (c) => {
  const staff = c.get('staff')!;
  const id = c.req.param('id');

  const category = await c.env.DB.prepare('SELECT * FROM menu_categories WHERE id = ?')
    .bind(id)
    .first<MenuCategory>();

  if (!category) {
    return c.json({ error: 'Category not found' }, 404);
  }

  // Check access
  if (staff.role !== 'system_admin' && !await hasStoreAccess(c.env.DB, staff.id, category.store_id)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  // Check if category is used in menus
  const usedInMenus = await c.env.DB.prepare(
    'SELECT COUNT(*) as count FROM menus WHERE store_id = ? AND category = ?'
  )
    .bind(category.store_id, category.name)
    .first<{ count: number }>();

  if (usedInMenus && usedInMenus.count > 0) {
    return c.json({ error: 'Cannot delete category that is used by menus' }, 400);
  }

  // Also delete children if this is a parent category
  if (!category.parent_id) {
    await c.env.DB.prepare('DELETE FROM menu_categories WHERE parent_id = ?').bind(id).run();
  }

  await c.env.DB.prepare('DELETE FROM menu_categories WHERE id = ?').bind(id).run();

  return c.json({ success: true });
});
