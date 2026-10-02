import { Hono } from 'hono';
import type { Bindings, Variables, Menu, MenuCategory, Staff } from '../types';
import { staffAuth, requireRole } from '../middleware/auth';

export const menusRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Check if staff has access to a store via staff_stores table
async function hasStoreAccess(db: D1Database, staffId: string, storeId: string): Promise<boolean> {
  const row = await db.prepare(
    'SELECT 1 FROM staff_stores WHERE staff_id = ? AND store_id = ?'
  ).bind(staffId, storeId).first();
  return !!row;
}

// Apply auth middleware
menusRoutes.use('*', staffAuth);

// List menus
menusRoutes.get('/', async (c) => {
  const staff = c.get('staff')!;
  const storeId = c.req.query('store_id') || staff.store_id;
  const activeOnly = c.req.query('active') !== 'false';

  if (!storeId && staff.role !== 'system_admin') {
    return c.json({ menus: [] });
  }

  let query = 'SELECT * FROM menus WHERE 1=1';
  const params: (string | number)[] = [];

  if (storeId) {
    query += ' AND store_id = ?';
    params.push(storeId);
  }

  if (activeOnly) {
    query += ' AND is_active = 1';
  }

  query += ` ORDER BY (CASE WHEN coupon_type IS NOT NULL THEN 0 ELSE 1 END), CASE WHEN coupon_type IS NOT NULL THEN '' ELSE (CASE WHEN INSTR(category, '：') > 0 THEN SUBSTR(category, 1, INSTR(category, '：') - 1) ELSE category END) END, sort_order, name`;

  const result = await c.env.DB.prepare(query)
    .bind(...params)
    .all<Menu>();

  // Get categories for this store
  const categoriesResult = await c.env.DB.prepare(
    'SELECT * FROM menu_categories WHERE store_id = ? ORDER BY sort_order, name'
  )
    .bind(storeId)
    .all<MenuCategory>();

  // Build color map: for children, use parent's color
  const parentMap = new Map<string, MenuCategory>();
  const categoryColors: Record<string, string> = {};
  for (const cat of categoriesResult.results) {
    if (!cat.parent_id) {
      parentMap.set(cat.id, cat);
      categoryColors[cat.name] = cat.color;
    }
  }
  for (const cat of categoriesResult.results) {
    if (cat.parent_id) {
      const parent = parentMap.get(cat.parent_id);
      categoryColors[cat.name] = parent?.color || cat.color;
    }
  }

  // Group by category
  const menusByCategory: Record<string, Menu[]> = {};
  for (const menu of result.results) {
    if (!menusByCategory[menu.category]) {
      menusByCategory[menu.category] = [];
    }
    menusByCategory[menu.category].push(menu);
  }

  // Batch-fetch staff assignments for all menus
  const menuIds = result.results.map(m => m.id);
  const assignmentMap = new Map<string, string[]>();

  if (menuIds.length > 0) {
    // D1/SQLite has a limit on bind variables, so chunk the query
    const CHUNK_SIZE = 50;
    for (let i = 0; i < menuIds.length; i += CHUNK_SIZE) {
      const chunk = menuIds.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      const assignments = await c.env.DB.prepare(
        `SELECT menu_id, staff_id FROM menu_staff WHERE menu_id IN (${placeholders})`
      ).bind(...chunk).all<{ menu_id: string; staff_id: string }>();

      for (const a of assignments.results) {
        if (!assignmentMap.has(a.menu_id)) assignmentMap.set(a.menu_id, []);
        assignmentMap.get(a.menu_id)!.push(a.staff_id);
      }
    }
  }

  // Batch-fetch equipment assignments for all menus
  const equipmentMap = new Map<string, string[]>();

  if (menuIds.length > 0) {
    const EQUIP_CHUNK = 50;
    for (let i = 0; i < menuIds.length; i += EQUIP_CHUNK) {
      const chunk = menuIds.slice(i, i + EQUIP_CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      const equipAssignments = await c.env.DB.prepare(
        `SELECT menu_id, equipment_id FROM menu_equipment WHERE menu_id IN (${placeholders})`
      ).bind(...chunk).all<{ menu_id: string; equipment_id: string }>();

      for (const a of equipAssignments.results) {
        if (!equipmentMap.has(a.menu_id)) equipmentMap.set(a.menu_id, []);
        equipmentMap.get(a.menu_id)!.push(a.equipment_id);
      }
    }
  }

  const menusWithStaff = result.results.map(m => ({
    ...m,
    assigned_staff_ids: assignmentMap.get(m.id) || [],
    assigned_equipment_ids: equipmentMap.get(m.id) || [],
  }));

  // Re-group with staff assignments
  const menusByCategoryWithStaff: Record<string, (Menu & { assigned_staff_ids: string[]; assigned_equipment_ids: string[] })[]> = {};
  for (const menu of menusWithStaff) {
    if (!menusByCategoryWithStaff[menu.category]) {
      menusByCategoryWithStaff[menu.category] = [];
    }
    menusByCategoryWithStaff[menu.category].push(menu);
  }

  return c.json({
    menus: menusWithStaff,
    byCategory: menusByCategoryWithStaff,
    categoryColors
  });
});

// Get menu by ID
menusRoutes.get('/:id', async (c) => {
  const staff = c.get('staff')!;
  const id = c.req.param('id');

  const menu = await c.env.DB.prepare('SELECT * FROM menus WHERE id = ?').bind(id).first<Menu>();

  if (!menu) {
    return c.json({ error: 'Menu not found' }, 404);
  }

  // Check access
  if (staff.role !== 'system_admin' && !await hasStoreAccess(c.env.DB, staff.id, menu.store_id)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  return c.json({ menu });
});

// Create menu (manager+ only)
menusRoutes.post('/', requireRole('system_admin', 'owner', 'manager'), async (c) => {
  const staff = c.get('staff')!;
  const body = await c.req.json<{
    store_id?: string;
    category: string;
    name: string;
    description?: string;
    image_url?: string;
    duration: number;
    price: number;
    price_new?: number;
    sort_order?: number;
    coupon_type?: 'new' | 'repeat' | 'all' | null;
    menu_type?: 'regular' | 'coupon';
    presentation_condition?: string;
    usage_condition?: string;
    expiry_date?: string;
    is_active?: number;
    sub_categories?: string;
    price_tilde?: number;
  }>();

  if (!body.name || body.duration === undefined || body.price === undefined) {
    return c.json({ error: 'Name, duration, and price are required' }, 400);
  }

  const storeId = body.store_id || staff.store_id;
  if (!storeId) {
    return c.json({ error: 'Store ID is required' }, 400);
  }

  // Check store access
  if (staff.role !== 'system_admin' && !await hasStoreAccess(c.env.DB, staff.id, storeId)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const id = crypto.randomUUID();

  await c.env.DB.prepare(
    `INSERT INTO menus (id, store_id, category, name, description, image_url, duration, price, price_new, sort_order, coupon_type, menu_type, presentation_condition, usage_condition, expiry_date, sub_categories, price_tilde, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      storeId,
      body.category || '',
      body.name,
      body.description || null,
      body.image_url || null,
      body.duration,
      body.price,
      body.price_new ?? null,
      body.sort_order || 0,
      body.coupon_type || null,
      body.menu_type || 'regular',
      body.presentation_condition || null,
      body.usage_condition || null,
      body.expiry_date || null,
      body.sub_categories || null,
      body.price_tilde ?? 0,
      body.is_active ?? 1
    )
    .run();

  const menu = await c.env.DB.prepare('SELECT * FROM menus WHERE id = ?').bind(id).first<Menu>();

  return c.json({ menu }, 201);
});

// Bulk update menu-equipment assignments (from matrix UI) — must be before /:id
menusRoutes.put('/equipment-assignments', requireRole('system_admin', 'owner', 'manager'), async (c) => {
  const currentStaff = c.get('staff')!;
  const body = await c.req.json<{
    store_id?: string;
    assignments: { menu_id: string; equipment_ids: string[] }[];
  }>();

  const storeId = body.store_id || currentStaff.store_id;
  if (!storeId) return c.json({ error: 'Store ID is required' }, 400);
  if (currentStaff.role !== 'system_admin' && !await hasStoreAccess(c.env.DB, currentStaff.id, storeId)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const statements: { query: string; binds: string[] }[] = [];
  for (const item of body.assignments) {
    statements.push({ query: 'DELETE FROM menu_equipment WHERE menu_id = ?', binds: [item.menu_id] });
    for (const eid of item.equipment_ids) {
      statements.push({
        query: 'INSERT INTO menu_equipment (id, menu_id, equipment_id) VALUES (?, ?, ?)',
        binds: [crypto.randomUUID(), item.menu_id, eid],
      });
    }
  }

  const BATCH = 50;
  for (let i = 0; i < statements.length; i += BATCH) {
    const batch = statements.slice(i, i + BATCH).map(s =>
      c.env.DB.prepare(s.query).bind(...s.binds)
    );
    await c.env.DB.batch(batch);
  }

  return c.json({ success: true, updated: body.assignments.length });
});

// Bulk update menu-staff assignments (from matrix UI) — must be before /:id
menusRoutes.put('/staff-assignments', async (c) => {
  const currentStaff = c.get('staff')!;
  const body = await c.req.json<{
    store_id?: string;
    assignments: { menu_id: string; staff_ids: string[] }[];
    self_only?: boolean;
  }>();

  const storeId = body.store_id || currentStaff.store_id;
  if (!storeId) return c.json({ error: 'Store ID is required' }, 400);

  // Staff role: only allowed in self_only mode (toggle own assignment only)
  if (currentStaff.role === 'staff') {
    if (!body.self_only) {
      return c.json({ error: 'Forbidden' }, 403);
    }
  } else if (currentStaff.role !== 'system_admin' && currentStaff.role !== 'owner' && currentStaff.role !== 'manager') {
    return c.json({ error: 'Forbidden' }, 403);
  }

  if (currentStaff.role !== 'system_admin' && !await hasStoreAccess(c.env.DB, currentStaff.id, storeId)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const statements: { query: string; binds: string[] }[] = [];

  if (body.self_only && currentStaff.role === 'staff') {
    // Self-only mode: only add/remove own staff_id per menu, don't touch other staff
    for (const item of body.assignments) {
      // Remove own assignment for this menu
      statements.push({
        query: 'DELETE FROM menu_staff WHERE menu_id = ? AND staff_id = ?',
        binds: [item.menu_id, currentStaff.id],
      });
      // Re-add if included in staff_ids
      if (item.staff_ids.includes(currentStaff.id)) {
        statements.push({
          query: 'INSERT INTO menu_staff (id, menu_id, staff_id) VALUES (?, ?, ?)',
          binds: [crypto.randomUUID(), item.menu_id, currentStaff.id],
        });
      }
    }
  } else {
    // Manager+ mode: replace all assignments for each menu
    for (const item of body.assignments) {
      statements.push({ query: 'DELETE FROM menu_staff WHERE menu_id = ?', binds: [item.menu_id] });
      for (const sid of item.staff_ids) {
        statements.push({
          query: 'INSERT INTO menu_staff (id, menu_id, staff_id) VALUES (?, ?, ?)',
          binds: [crypto.randomUUID(), item.menu_id, sid],
        });
      }
    }
  }

  const BATCH = 50;
  for (let i = 0; i < statements.length; i += BATCH) {
    const batch = statements.slice(i, i + BATCH).map(s =>
      c.env.DB.prepare(s.query).bind(...s.binds)
    );
    await c.env.DB.batch(batch);
  }

  return c.json({ success: true, updated: body.assignments.length });
});

// Batch reorder menus (manager+ only)
menusRoutes.put('/reorder', requireRole('system_admin', 'owner', 'manager'), async (c) => {
  const body = await c.req.json<{ items: { id: string; sort_order: number }[] }>();

  if (!Array.isArray(body.items) || body.items.length === 0) {
    return c.json({ error: 'items array is required' }, 400);
  }

  const stmts = body.items.map((item) =>
    c.env.DB.prepare("UPDATE menus SET sort_order = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(item.sort_order, item.id)
  );

  await c.env.DB.batch(stmts);

  return c.json({ success: true, updated: body.items.length });
});

// Update menu (manager+ only)
menusRoutes.put('/:id', requireRole('system_admin', 'owner', 'manager'), async (c) => {
  const staff = c.get('staff')!;
  const id = c.req.param('id');

  const menu = await c.env.DB.prepare('SELECT * FROM menus WHERE id = ?').bind(id).first<Menu>();

  if (!menu) {
    return c.json({ error: 'Menu not found' }, 404);
  }

  // Check access
  if (staff.role !== 'system_admin' && !await hasStoreAccess(c.env.DB, staff.id, menu.store_id)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const body = await c.req.json<{
    category?: string;
    name?: string;
    description?: string;
    image_url?: string | null;
    duration?: number;
    price?: number;
    price_new?: number | null;
    sort_order?: number;
    is_active?: boolean;
    coupon_type?: 'new' | 'repeat' | 'all' | null;
    menu_type?: 'regular' | 'coupon';
    presentation_condition?: string | null;
    usage_condition?: string | null;
    expiry_date?: string | null;
    sub_categories?: string | null;
    price_tilde?: number;
  }>();

  const updates: string[] = [];
  const values: (string | number | null)[] = [];

  if (body.category !== undefined) {
    updates.push('category = ?');
    values.push(body.category);
  }
  if (body.name !== undefined) {
    updates.push('name = ?');
    values.push(body.name);
  }
  if (body.description !== undefined) {
    updates.push('description = ?');
    values.push(body.description || null);
  }
  if (body.image_url !== undefined) {
    updates.push('image_url = ?');
    values.push(body.image_url || null);
  }
  if (body.duration !== undefined) {
    updates.push('duration = ?');
    values.push(body.duration);
  }
  if (body.price !== undefined) {
    updates.push('price = ?');
    values.push(body.price);
  }
  if (body.price_new !== undefined) {
    updates.push('price_new = ?');
    values.push(body.price_new);
  }
  if (body.sort_order !== undefined) {
    updates.push('sort_order = ?');
    values.push(body.sort_order);
  }
  if (body.is_active !== undefined) {
    updates.push('is_active = ?');
    values.push(body.is_active ? 1 : 0);
  }
  if (body.coupon_type !== undefined) {
    updates.push('coupon_type = ?');
    values.push(body.coupon_type);
  }
  if (body.menu_type !== undefined) {
    updates.push('menu_type = ?');
    values.push(body.menu_type);
  }
  if (body.presentation_condition !== undefined) {
    updates.push('presentation_condition = ?');
    values.push(body.presentation_condition);
  }
  if (body.usage_condition !== undefined) {
    updates.push('usage_condition = ?');
    values.push(body.usage_condition);
  }
  if (body.expiry_date !== undefined) {
    updates.push('expiry_date = ?');
    values.push(body.expiry_date);
  }
  if (body.sub_categories !== undefined) {
    updates.push('sub_categories = ?');
    values.push(body.sub_categories);
  }
  if (body.price_tilde !== undefined) {
    updates.push('price_tilde = ?');
    values.push(body.price_tilde);
  }
  if (updates.length === 0) {
    return c.json({ error: 'No updates provided' }, 400);
  }

  updates.push("updated_at = datetime('now')");
  values.push(id);

  await c.env.DB.prepare(`UPDATE menus SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();

  const updated = await c.env.DB.prepare('SELECT * FROM menus WHERE id = ?')
    .bind(id)
    .first<Menu>();

  return c.json({ menu: updated });
});

// Import image from external URL (manager+ only)
menusRoutes.post('/:id/image-from-url', requireRole('system_admin', 'owner', 'manager'), async (c) => {
  const staff = c.get('staff')!;
  const id = c.req.param('id');

  const menu = await c.env.DB.prepare('SELECT * FROM menus WHERE id = ?').bind(id).first<Menu>();
  if (!menu) {
    return c.json({ error: 'Menu not found' }, 404);
  }

  if (staff.role !== 'system_admin' && !await hasStoreAccess(c.env.DB, staff.id, menu.store_id)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const body = await c.req.json<{ url: string }>();
  if (!body.url) {
    return c.json({ error: 'URL is required' }, 400);
  }

  try {
    const response = await fetch(body.url);
    if (!response.ok) {
      return c.json({ error: 'Failed to fetch image' }, 400);
    }

    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';

    // Delete old image if exists
    if (menu.image_url) {
      const oldKey = menu.image_url.replace('/images/', '');
      try { await c.env.IMAGES.delete(oldKey); } catch { /* ignore */ }
    }

    const fileName = `menus/${menu.store_id}/${crypto.randomUUID()}.${ext}`;
    await c.env.IMAGES.put(fileName, response.body!, {
      httpMetadata: { contentType },
    });

    const imageUrl = `/images/${fileName}`;
    await c.env.DB.prepare("UPDATE menus SET image_url = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(imageUrl, id)
      .run();

    const updated = await c.env.DB.prepare('SELECT * FROM menus WHERE id = ?').bind(id).first<Menu>();
    return c.json({ menu: updated });
  } catch (error) {
    console.error('Failed to import image from URL:', error);
    return c.json({ error: 'Failed to import image' }, 500);
  }
});

// Upload menu image (manager+ only)
menusRoutes.post('/:id/image', requireRole('system_admin', 'owner', 'manager'), async (c) => {
  const staff = c.get('staff')!;
  const id = c.req.param('id');

  const menu = await c.env.DB.prepare('SELECT * FROM menus WHERE id = ?').bind(id).first<Menu>();

  if (!menu) {
    return c.json({ error: 'Menu not found' }, 404);
  }

  // Check access
  if (staff.role !== 'system_admin' && !await hasStoreAccess(c.env.DB, staff.id, menu.store_id)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const formData = await c.req.formData();
  const file = formData.get('file') as File;

  if (!file) {
    return c.json({ error: 'File is required' }, 400);
  }

  // Delete old image if exists
  if (menu.image_url) {
    const oldKey = menu.image_url.replace('/images/', '');
    try {
      await c.env.IMAGES.delete(oldKey);
    } catch {
      // Ignore errors when deleting old image
    }
  }

  // Upload to R2
  const fileName = `menus/${menu.store_id}/${crypto.randomUUID()}-${file.name}`;
  await c.env.IMAGES.put(fileName, file.stream(), {
    httpMetadata: {
      contentType: file.type,
    },
  });

  const imageUrl = `/images/${fileName}`;

  await c.env.DB.prepare("UPDATE menus SET image_url = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(imageUrl, id)
    .run();

  const updated = await c.env.DB.prepare('SELECT * FROM menus WHERE id = ?')
    .bind(id)
    .first<Menu>();

  return c.json({ menu: updated });
});

// Import menus from JSON paste (manager+ only)
menusRoutes.post('/import/json', requireRole('system_admin', 'owner', 'manager'), async (c) => {
  const staff = c.get('staff')!;
  const body = await c.req.json<{
    store_id?: string;
    menus: { name: string; category: string; price: number; duration: number }[];
  }>();

  const storeId = body.store_id || staff.store_id;
  if (!storeId) {
    return c.json({ error: 'Store ID is required' }, 400);
  }

  if (staff.role !== 'system_admin' && !await hasStoreAccess(c.env.DB, staff.id, storeId)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  if (!Array.isArray(body.menus) || body.menus.length === 0) {
    return c.json({ error: 'メニューデータが空です' }, 400);
  }

  const { created, skipped } = await importLimeMenusToDb(c.env.DB, storeId, body.menus);

  return c.json({
    success: true,
    message: `${body.menus.length}件中${created}件を登録しました。${skipped > 0 ? `（${skipped}件は既存のため省略）` : ''}`,
    created,
    skipped,
    total: body.menus.length,
  });
});

// Delete all menus for a store (manager+ only)
menusRoutes.delete('/all', requireRole('system_admin', 'owner', 'manager'), async (c) => {
  const staff = c.get('staff')!;
  const body = await c.req.json<{ store_id?: string }>().catch(() => ({ store_id: undefined }));
  const storeId = body.store_id || staff.store_id;

  if (!storeId) {
    return c.json({ error: 'Store ID is required' }, 400);
  }

  if (staff.role !== 'system_admin' && !await hasStoreAccess(c.env.DB, staff.id, storeId)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  // Get all menus with images to clean up R2
  const menusWithImages = await c.env.DB.prepare(
    'SELECT id, image_url FROM menus WHERE store_id = ? AND image_url IS NOT NULL'
  ).bind(storeId).all<{ id: string; image_url: string }>();

  // Delete images from R2
  for (const menu of menusWithImages.results) {
    if (menu.image_url) {
      const r2Key = menu.image_url.replace('/images/', '');
      try {
        await c.env.IMAGES.delete(r2Key);
      } catch {
        // Ignore R2 deletion errors
      }
    }
  }

  // Delete menu-staff assignments
  await c.env.DB.prepare(
    'DELETE FROM menu_staff WHERE menu_id IN (SELECT id FROM menus WHERE store_id = ?)'
  ).bind(storeId).run();

  // Delete menu-equipment assignments
  await c.env.DB.prepare(
    'DELETE FROM menu_equipment WHERE menu_id IN (SELECT id FROM menus WHERE store_id = ?)'
  ).bind(storeId).run();

  // Disable FK checks to avoid NOT NULL constraint on reservations.menu_id
  await c.env.DB.prepare('PRAGMA foreign_keys = OFF').run();

  // Delete all menus
  const result = await c.env.DB.prepare(
    'DELETE FROM menus WHERE store_id = ?'
  ).bind(storeId).run();

  await c.env.DB.prepare('PRAGMA foreign_keys = ON').run();

  // Delete orphaned menu categories
  await c.env.DB.prepare(
    'DELETE FROM menu_categories WHERE store_id = ?'
  ).bind(storeId).run();

  return c.json({ success: true, deleted: result.meta.changes || 0 });
});

// Get staff assignments for a menu
menusRoutes.get('/:id/staff', async (c) => {
  const staff = c.get('staff')!;
  const id = c.req.param('id');

  const menu = await c.env.DB.prepare('SELECT * FROM menus WHERE id = ?').bind(id).first<Menu>();
  if (!menu) {
    return c.json({ error: 'Menu not found' }, 404);
  }

  if (staff.role !== 'system_admin' && !await hasStoreAccess(c.env.DB, staff.id, menu.store_id)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const assignments = await c.env.DB.prepare(
    'SELECT staff_id FROM menu_staff WHERE menu_id = ?'
  ).bind(id).all<{ staff_id: string }>();

  return c.json({ staff_ids: assignments.results.map(a => a.staff_id) });
});

// Set staff assignments for a menu (replace all)
menusRoutes.put('/:id/staff', requireRole('system_admin', 'owner', 'manager'), async (c) => {
  const staff = c.get('staff')!;
  const id = c.req.param('id');

  const menu = await c.env.DB.prepare('SELECT * FROM menus WHERE id = ?').bind(id).first<Menu>();
  if (!menu) {
    return c.json({ error: 'Menu not found' }, 404);
  }

  if (staff.role !== 'system_admin' && !await hasStoreAccess(c.env.DB, staff.id, menu.store_id)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const body = await c.req.json<{ staff_ids: string[] }>();
  const staffIds = body.staff_ids || [];

  // Delete all existing assignments
  await c.env.DB.prepare('DELETE FROM menu_staff WHERE menu_id = ?').bind(id).run();

  // Insert new assignments
  for (const staffId of staffIds) {
    await c.env.DB.prepare(
      'INSERT INTO menu_staff (id, menu_id, staff_id) VALUES (?, ?, ?)'
    ).bind(crypto.randomUUID(), id, staffId).run();
  }

  return c.json({ success: true, staff_ids: staffIds });
});

// Get equipment assignments for a menu
menusRoutes.get('/:id/equipment', async (c) => {
  const staff = c.get('staff')!;
  const id = c.req.param('id');

  const menu = await c.env.DB.prepare('SELECT * FROM menus WHERE id = ?').bind(id).first<Menu>();
  if (!menu) {
    return c.json({ error: 'Menu not found' }, 404);
  }

  if (staff.role !== 'system_admin' && !await hasStoreAccess(c.env.DB, staff.id, menu.store_id)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const assignments = await c.env.DB.prepare(
    'SELECT equipment_id FROM menu_equipment WHERE menu_id = ?'
  ).bind(id).all<{ equipment_id: string }>();

  return c.json({ equipment_ids: assignments.results.map(a => a.equipment_id) });
});

// Set equipment assignments for a menu (replace all)
menusRoutes.put('/:id/equipment', requireRole('system_admin', 'owner', 'manager'), async (c) => {
  const staff = c.get('staff')!;
  const id = c.req.param('id');

  const menu = await c.env.DB.prepare('SELECT * FROM menus WHERE id = ?').bind(id).first<Menu>();
  if (!menu) {
    return c.json({ error: 'Menu not found' }, 404);
  }

  if (staff.role !== 'system_admin' && !await hasStoreAccess(c.env.DB, staff.id, menu.store_id)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const body = await c.req.json<{ equipment_ids: string[] }>();
  const equipmentIds = body.equipment_ids || [];

  // Delete all existing assignments
  await c.env.DB.prepare('DELETE FROM menu_equipment WHERE menu_id = ?').bind(id).run();

  // Insert new assignments
  for (const equipmentId of equipmentIds) {
    await c.env.DB.prepare(
      'INSERT INTO menu_equipment (id, menu_id, equipment_id) VALUES (?, ?, ?)'
    ).bind(crypto.randomUUID(), id, equipmentId).run();
  }

  return c.json({ success: true, equipment_ids: equipmentIds });
});

// Delete menu (manager+ only)
menusRoutes.delete('/:id', requireRole('system_admin', 'owner', 'manager'), async (c) => {
  const staff = c.get('staff')!;
  const id = c.req.param('id');

  const menu = await c.env.DB.prepare('SELECT * FROM menus WHERE id = ?').bind(id).first<Menu>();

  if (!menu) {
    return c.json({ error: 'Menu not found' }, 404);
  }

  // Check access
  if (staff.role !== 'system_admin' && !await hasStoreAccess(c.env.DB, staff.id, menu.store_id)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  // Check if menu is used in reservations
  const usedInReservations = await c.env.DB.prepare(
    'SELECT COUNT(*) as count FROM reservations WHERE menu_id = ?'
  )
    .bind(id)
    .first<{ count: number }>();

  if (usedInReservations && usedInReservations.count > 0) {
    // Check if force=true was passed (user confirmed deletion with reservations)
    const force = c.req.query('force') === 'true';
    if (!force) {
      return c.json({
        success: false,
        has_reservations: true,
        reservation_count: usedInReservations.count,
        message: `このメニューは${usedInReservations.count}件の予約で使用されています。`,
      }, 409);
    }
    // Force delete: soft delete (set is_active = 0)
    await c.env.DB.prepare("UPDATE menus SET is_active = 0, updated_at = datetime('now') WHERE id = ?")
      .bind(id)
      .run();
    return c.json({ success: true, soft_deleted: true, reservation_count: usedInReservations.count });
  }

  await c.env.DB.prepare('DELETE FROM menus WHERE id = ?').bind(id).run();

  return c.json({ success: true });
});

// Bulk import menu-staff assignments from Salonboard JSON
menusRoutes.post('/import/staff-assignments', requireRole('system_admin', 'owner', 'manager'), async (c) => {
  const currentStaff = c.get('staff')!;
  const body = await c.req.json<{
    store_id?: string;
    assignments: {
      menuName: string;
      noStaffNeeded: boolean;
      assignedStaff: string[];
    }[];
  }>();

  const storeId = body.store_id || currentStaff.store_id;
  if (!storeId) return c.json({ error: 'Store ID is required' }, 400);
  if (currentStaff.role !== 'system_admin' && !await hasStoreAccess(c.env.DB, currentStaff.id, storeId)) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  if (!Array.isArray(body.assignments) || body.assignments.length === 0) {
    return c.json({ error: 'データが空です' }, 400);
  }

  // Fetch all menus for this store
  const allMenus = await c.env.DB.prepare(
    'SELECT id, name FROM menus WHERE store_id = ? AND is_active = 1'
  ).bind(storeId).all<{ id: string; name: string }>();
  const menuMap = new Map<string, string>(); // name -> id
  for (const m of allMenus.results) {
    menuMap.set(m.name, m.id);
  }

  // Fetch all staff for this store (include nickname and salonboard_name for matching)
  const allStaff = await c.env.DB.prepare(
    `SELECT DISTINCT s.id, s.name, s.nickname, s.salonboard_name FROM staff s
     JOIN staff_stores ss ON s.id = ss.staff_id
     WHERE ss.store_id = ? AND s.is_active = 1`
  ).bind(storeId).all<Staff & { salonboard_name: string | null }>();

  // Build multiple matching maps for fuzzy staff name resolution
  // SB uses nicknames like "mi yu" → match against staff.nickname ("Miyu") or salonboard_name ("mi yu")
  const stripSpaces = (s: string) => s.replace(/\s+/g, '').toLowerCase();
  const stripJapanese = (s: string) => s.replace(/[\u3000-\u9FFF\uFF00-\uFFEF]+/g, '').trim().toLowerCase();

  const staffByExact = new Map<string, string>(); // exact lowercase
  const staffByNoSpace = new Map<string, string>(); // spaces removed
  for (const s of allStaff.results) {
    staffByExact.set(s.name.toLowerCase().trim(), s.id);
    staffByNoSpace.set(stripSpaces(s.name), s.id);
    // Also index by nickname for SB romaji matching
    const nick = (s as { nickname?: string }).nickname;
    if (nick) {
      staffByExact.set(nick.toLowerCase().trim(), s.id);
      staffByNoSpace.set(stripSpaces(nick), s.id);
    }
    // Also index by salonboard_name
    if (s.salonboard_name) {
      staffByExact.set(s.salonboard_name.toLowerCase().trim(), s.id);
      staffByNoSpace.set(stripSpaces(s.salonboard_name), s.id);
    }
  }

  const resolveStaffId = (salonboardName: string): string | undefined => {
    const lower = salonboardName.toLowerCase().trim();
    // 1. Exact match
    if (staffByExact.has(lower)) return staffByExact.get(lower);
    // 2. Remove all spaces ("e miri" → "emiri")
    const noSpace = stripSpaces(salonboardName);
    if (staffByNoSpace.has(noSpace)) return staffByNoSpace.get(noSpace);
    // 3. Strip Japanese chars ("chihiro アイリスト" → "chihiro")
    const romajiOnly = stripJapanese(salonboardName);
    if (romajiOnly && staffByExact.has(romajiOnly)) return staffByExact.get(romajiOnly);
    // 4. Strip Japanese + remove spaces
    const romajiNoSpace = stripSpaces(romajiOnly);
    if (romajiNoSpace && staffByNoSpace.has(romajiNoSpace)) return staffByNoSpace.get(romajiNoSpace);
    return undefined;
  };

  let updated = 0;
  let menuNotFound: string[] = [];
  let staffNotFound = new Set<string>();
  const staffMatched = new Map<string, string>(); // salonboard name → matched SALOGIC name
  const statements: { query: string; binds: string[] }[] = [];

  for (const item of body.assignments) {
    const menuId = menuMap.get(item.menuName);
    if (!menuId) {
      menuNotFound.push(item.menuName);
      continue;
    }

    // Resolve staff IDs with fuzzy matching
    const staffIds: string[] = [];
    if (!item.noStaffNeeded && item.assignedStaff.length > 0) {
      for (const name of item.assignedStaff) {
        const sid = resolveStaffId(name);
        if (sid) {
          staffIds.push(sid);
          if (!staffMatched.has(name)) {
            const matched = allStaff.results.find(s => s.id === sid);
            if (matched) staffMatched.set(name, matched.name);
          }
        } else {
          staffNotFound.add(name);
        }
      }
    }

    // Delete existing + insert new
    statements.push({ query: 'DELETE FROM menu_staff WHERE menu_id = ?', binds: [menuId] });
    for (const sid of staffIds) {
      statements.push({
        query: 'INSERT INTO menu_staff (id, menu_id, staff_id) VALUES (?, ?, ?)',
        binds: [crypto.randomUUID(), menuId, sid],
      });
    }
    updated++;
  }

  // Execute in batches
  const BATCH = 50;
  for (let i = 0; i < statements.length; i += BATCH) {
    const batch = statements.slice(i, i + BATCH).map(s =>
      c.env.DB.prepare(s.query).bind(...s.binds)
    );
    await c.env.DB.batch(batch);
  }

  let message = `${updated}件のメニューを更新しました。`;
  if (staffMatched.size > 0) {
    message += `\nスタッフマッチ: ${[...staffMatched.entries()].map(([sb, sl]) => `${sb}→${sl}`).join(', ')}`;
  }
  if (menuNotFound.length > 0) {
    message += `\nメニュー未検出(${menuNotFound.length}件): ${menuNotFound.slice(0, 10).join(', ')}`;
  }
  if (staffNotFound.size > 0) {
    message += `\nスタッフ未検出: ${[...staffNotFound].join(', ')}`;
  }

  return c.json({ success: true, message, updated, menuNotFound, staffNotFound: [...staffNotFound], staffMatched: Object.fromEntries(staffMatched) });
});

// Bulk import menu-equipment assignments from Salonboard JSON
menusRoutes.post('/import/equipment-assignments', requireRole('system_admin', 'owner', 'manager'), async (c) => {
  const currentStaff = c.get('staff')!;
  const body = await c.req.json<{
    store_id?: string;
    assignments: {
      menuName: string;
      assignedEquipment: string[];
    }[];
  }>();

  const storeId = body.store_id || currentStaff.store_id;
  if (!storeId) return c.json({ error: 'Store ID is required' }, 400);
  if (currentStaff.role !== 'system_admin' && !await hasStoreAccess(c.env.DB, currentStaff.id, storeId)) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  if (!Array.isArray(body.assignments) || body.assignments.length === 0) {
    return c.json({ error: 'データが空です' }, 400);
  }

  // Fetch all menus for this store
  const allMenus = await c.env.DB.prepare(
    'SELECT id, name FROM menus WHERE store_id = ? AND is_active = 1'
  ).bind(storeId).all<{ id: string; name: string }>();
  const menuMap = new Map<string, string>();
  for (const m of allMenus.results) {
    menuMap.set(m.name, m.id);
  }

  // Fetch all equipment for this store
  const allEquipment = await c.env.DB.prepare(
    'SELECT id, name FROM equipment WHERE store_id = ? AND is_active = 1'
  ).bind(storeId).all<{ id: string; name: string }>();
  const equipMap = new Map<string, string>();
  for (const e of allEquipment.results) {
    equipMap.set(e.name, e.id);
  }

  let updated = 0;
  const menuNotFound: string[] = [];
  const equipNotFound = new Set<string>();
  const statements: { query: string; binds: string[] }[] = [];

  for (const item of body.assignments) {
    const menuId = menuMap.get(item.menuName);
    if (!menuId) {
      menuNotFound.push(item.menuName);
      continue;
    }

    const equipIds: string[] = [];
    for (const name of item.assignedEquipment) {
      const eid = equipMap.get(name);
      if (eid) {
        equipIds.push(eid);
      } else {
        equipNotFound.add(name);
      }
    }

    statements.push({ query: 'DELETE FROM menu_equipment WHERE menu_id = ?', binds: [menuId] });
    for (const eid of equipIds) {
      statements.push({
        query: 'INSERT INTO menu_equipment (id, menu_id, equipment_id) VALUES (?, ?, ?)',
        binds: [crypto.randomUUID(), menuId, eid],
      });
    }
    updated++;
  }

  const BATCH = 50;
  for (let i = 0; i < statements.length; i += BATCH) {
    const batch = statements.slice(i, i + BATCH).map(s =>
      c.env.DB.prepare(s.query).bind(...s.binds)
    );
    await c.env.DB.batch(batch);
  }

  let message = `${updated}件のメニューの設備を更新しました。`;
  if (menuNotFound.length > 0) {
    message += `\nメニュー未検出(${menuNotFound.length}件): ${menuNotFound.slice(0, 10).join(', ')}`;
  }
  if (equipNotFound.size > 0) {
    message += `\n設備未検出: ${[...equipNotFound].join(', ')}`;
  }

  return c.json({ success: true, message, updated, menuNotFound, equipNotFound: [...equipNotFound] });
});
