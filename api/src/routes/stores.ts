import { Hono } from 'hono';
import type { Bindings, Variables, Store, BusinessHours, StoreClosure } from '../types';
import { staffAuth, requireRole, hashPassword } from '../middleware/auth';
import { sanitizeStore } from '../utils/sanitize';

export const storesRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Apply auth middleware
storesRoutes.use('*', staffAuth);

// List stores
storesRoutes.get('/', async (c) => {
  const staff = c.get('staff')!;

  let stores: Store[];
  if (staff.role === 'system_admin') {
    const result = await c.env.DB.prepare('SELECT * FROM stores ORDER BY name').all<Store>();
    stores = result.results;
  } else if (staff.store_id) {
    const store = await c.env.DB.prepare('SELECT * FROM stores WHERE id = ?')
      .bind(staff.store_id)
      .first<Store>();
    stores = store ? [store] : [];
  } else {
    stores = [];
  }

  return c.json({ stores });
});

// System overview: owners → stores → staff hierarchy (system_admin only)
storesRoutes.get('/system-overview', requireRole('system_admin'), async (c) => {
  // 1. Get all owners (including company info)
  const ownersResult = await c.env.DB.prepare(
    'SELECT id, name, email, login_id, onboarding_completed, is_active, retired_at, created_at, owner_type, company_name, company_postal_code, company_phone, company_address, company_email FROM staff WHERE role = ? ORDER BY created_at DESC'
  ).bind('owner').all<{ id: string; name: string; email: string | null; login_id: string | null; onboarding_completed: number; is_active: number; retired_at: string | null; created_at: string; owner_type: string | null; company_name: string | null; company_postal_code: string | null; company_phone: string | null; company_address: string | null; company_email: string | null }>();

  // 2. Get all owner-store assignments
  const ownerStoreResult = await c.env.DB.prepare(
    `SELECT ss.staff_id as owner_id, s.id, s.name, s.address, s.phone, s.email, s.salonboard_id, s.salonboard_password, s.salonboard_enabled, s.minimo_id, s.minimo_password
     FROM staff_stores ss
     JOIN stores s ON s.id = ss.store_id
     JOIN staff st ON st.id = ss.staff_id
     WHERE st.role = 'owner'
     ORDER BY s.name`
  ).all<{ owner_id: string; id: string; name: string; address: string | null; phone: string | null; email: string | null; salonboard_id: string | null; salonboard_password: string | null; salonboard_enabled: number; minimo_id: string | null; minimo_password: string | null }>();

  // 3. Get all non-owner staff with store assignments
  const staffResult = await c.env.DB.prepare(
    `SELECT ss.store_id, st.id, st.name, st.nickname, st.email, st.role, st.is_active, st.retired_at, st.created_at, st.salonboard_staff_id, st.salonboard_name, st.minimo_name, st.lime_name
     FROM staff_stores ss
     JOIN staff st ON st.id = ss.staff_id
     WHERE st.role != 'owner' AND st.role != 'system_admin'
     ORDER BY st.name`
  ).all<{ store_id: string; id: string; name: string; nickname: string | null; email: string; role: string; is_active: number; retired_at: string | null; created_at: string; salonboard_staff_id: string | null; salonboard_name: string | null; minimo_name: string | null; lime_name: string | null }>();

  // Build store → staff map
  const storeStaffMap = new Map<string, typeof staffResult.results>();
  for (const s of staffResult.results) {
    if (!storeStaffMap.has(s.store_id)) storeStaffMap.set(s.store_id, []);
    storeStaffMap.get(s.store_id)!.push(s);
  }

  // Build owner → stores map
  const ownerStoresMap = new Map<string, (typeof ownerStoreResult.results[0] & { staff: typeof staffResult.results })[]>();
  for (const os of ownerStoreResult.results) {
    if (!ownerStoresMap.has(os.owner_id)) ownerStoresMap.set(os.owner_id, []);
    ownerStoresMap.get(os.owner_id)!.push({
      ...os,
      staff: storeStaffMap.get(os.id) || [],
    });
  }

  const owners = ownersResult.results.map((owner) => ({
    id: owner.id,
    name: owner.name,
    email: owner.email,
    login_id: owner.login_id,
    onboarding_completed: owner.onboarding_completed,
    is_active: owner.is_active,
    retired_at: owner.retired_at,
    created_at: owner.created_at,
    owner_type: owner.owner_type,
    company_name: owner.company_name,
    company_postal_code: owner.company_postal_code,
    company_phone: owner.company_phone,
    company_address: owner.company_address,
    company_email: owner.company_email,
    stores: ownerStoresMap.get(owner.id) || [],
  }));

  return c.json({ owners });
});

// System staff list: all staff from current database (system_admin only)
storesRoutes.get('/system-staff', requireRole('system_admin'), async (c) => {
  type StaffRow = {
    id: string; name: string; nickname: string | null; email: string | null; role: string;
    is_active: number; retired_at: string | null; created_at: string;
    login_id: string | null; staff_code: string | null; email_verified: number;
    salonboard_name: string | null; salonboard_staff_id: string | null; minimo_name: string | null;
    store_names: string | null;
  };

  const result = await c.env.DB.prepare(`
    SELECT s.id, s.name, s.nickname, s.email, s.role, s.is_active, s.retired_at, s.created_at, s.login_id, s.staff_code, s.email_verified,
           s.salonboard_name, s.salonboard_staff_id, s.minimo_name,
           GROUP_CONCAT(st.name, ', ') as store_names
    FROM staff s
    LEFT JOIN staff_stores ss ON ss.staff_id = s.id
    LEFT JOIN stores st ON st.id = ss.store_id
    WHERE s.role != 'system_admin'
    GROUP BY s.id
    ORDER BY s.created_at DESC
  `).all<StaffRow>();

  const staff = result.results.map(r => ({
    id: r.id,
    name: r.name,
    nickname: r.nickname,
    email: r.email,
    role: r.role,
    is_active: r.is_active,
    retired_at: r.retired_at,
    created_at: r.created_at,
    login_id: r.login_id,
    staff_code: r.staff_code,
    email_verified: r.email_verified,
    salonboard_name: r.salonboard_name,
    salonboard_staff_id: r.salonboard_staff_id,
    minimo_name: r.minimo_name,
    stores: r.store_names ? r.store_names.split(', ') : [],
  }));

  return c.json({ staff });
});

// Get staff related data counts for deletion confirmation (system_admin only)
storesRoutes.get('/system-staff/:id/related-data', requireRole('system_admin'), async (c) => {
  const id = c.req.param('id');

  const staff = await c.env.DB.prepare(
    'SELECT id, name, email, role, login_id FROM staff WHERE id = ?'
  ).bind(id).first<{ id: string; name: string; email: string | null; role: string; login_id: string | null }>();

  if (!staff) {
    return c.json({ error: 'Staff not found' }, 404);
  }

  const [reservations, karutes, karuteImages, customers, messages, stores] = await Promise.all([
    c.env.DB.prepare('SELECT COUNT(*) as count FROM reservations WHERE staff_id = ?').bind(id).first<{ count: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) as count FROM karutes WHERE staff_id = ?').bind(id).first<{ count: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) as count FROM karute_images WHERE karute_id IN (SELECT id FROM karutes WHERE staff_id = ?)').bind(id).first<{ count: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) as count FROM customers WHERE staff_id = ?').bind(id).first<{ count: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) as count FROM messages WHERE staff_id = ?').bind(id).first<{ count: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) as count FROM staff_stores WHERE staff_id = ?').bind(id).first<{ count: number }>(),
  ]);

  return c.json({
    staff,
    counts: {
      reservations: reservations?.count || 0,
      karutes: karutes?.count || 0,
      karute_images: karuteImages?.count || 0,
      customers: customers?.count || 0,
      messages: messages?.count || 0,
      stores: stores?.count || 0,
    },
  });
});

// Delete staff and all related data (system_admin only)
storesRoutes.delete('/system-staff/:id', requireRole('system_admin'), async (c) => {
  const currentStaff = c.get('staff')!;
  const id = c.req.param('id');

  if (currentStaff.id === id) {
    return c.json({ error: '自分自身は削除できません' }, 400);
  }

  const staff = await c.env.DB.prepare('SELECT id FROM staff WHERE id = ?').bind(id).first();
  if (!staff) {
    return c.json({ error: 'Staff not found' }, 404);
  }

  // Delete in order: karute_images → karutes → reservations → staff_stores → staff
  await c.env.DB.prepare('DELETE FROM karute_images WHERE karute_id IN (SELECT id FROM karutes WHERE staff_id = ?)').bind(id).run();
  await c.env.DB.prepare('DELETE FROM karutes WHERE staff_id = ?').bind(id).run();
  await c.env.DB.prepare('DELETE FROM reservations WHERE staff_id = ?').bind(id).run();
  await c.env.DB.prepare('DELETE FROM staff_stores WHERE staff_id = ?').bind(id).run();
  await c.env.DB.prepare('DELETE FROM staff WHERE id = ?').bind(id).run();

  return c.json({ success: true });
});

// Generate login_id for owner accounts
function generateLoginId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes).map(b => chars[b % chars.length]).join('');
  return `owner_${suffix}`;
}

// Generate temporary password
function generateTempPassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => chars[b % chars.length]).join('');
}

// Create owner account (system_admin only)
storesRoutes.post('/create-owner', requireRole('system_admin'), async (c) => {
  const body = await c.req.json<{
    owner_name: string;
  }>();

  if (!body.owner_name) {
    return c.json({ error: 'オーナー名は必須です' }, 400);
  }

  // Generate unique login_id
  let loginId = '';
  for (let i = 0; i < 10; i++) {
    loginId = generateLoginId();
    const exists = await c.env.DB.prepare('SELECT id FROM staff WHERE login_id = ?')
      .bind(loginId).first();
    if (!exists) break;
    if (i === 9) return c.json({ error: 'ログインIDの生成に失敗しました。再度お試しください。' }, 500);
  }

  const tempPassword = generateTempPassword();
  const ownerId = crypto.randomUUID();
  const passwordHash = await hashPassword(tempPassword);

  await c.env.DB.prepare(
    `INSERT INTO staff (id, name, password_hash, role, login_id, email_verified, must_change_password, onboarding_completed)
     VALUES (?, ?, ?, 'owner', ?, 1, 1, 0)`
  ).bind(
    ownerId,
    body.owner_name,
    passwordHash,
    loginId,
  ).run();

  return c.json({
    owner: {
      id: ownerId,
      name: body.owner_name,
      login_id: loginId,
      temp_password: tempPassword,
    },
  }, 201);
});

// List HPB emails (system_admin only)
storesRoutes.get('/system-emails', requireRole('system_admin'), async (c) => {
  const limit = parseInt(c.req.query('limit') || '50');
  const offset = parseInt(c.req.query('offset') || '0');
  const search = c.req.query('search') || '';

  let whereClause = '';
  const binds: unknown[] = [];

  if (search) {
    whereClause = 'WHERE (e.subject LIKE ? OR e.body_text LIKE ?)';
    binds.push(`%${search}%`, `%${search}%`);
  }

  const result = await c.env.DB.prepare(`
    SELECT e.id, e.recipient, e.sender, e.subject, e.store_id, e.is_read, e.received_at,
           s.name as store_name
    FROM hpb_emails e
    LEFT JOIN stores s ON s.id = e.store_id
    ${whereClause}
    ORDER BY e.received_at DESC
    LIMIT ? OFFSET ?
  `).bind(...binds, limit, offset).all();

  const countResult = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM hpb_emails e ${whereClause}`
  ).bind(...binds).first<{ count: number }>();

  return c.json({
    emails: result.results,
    total: countResult?.count || 0,
  });
});

// Get HPB email detail (system_admin only)
storesRoutes.get('/system-emails/:id', requireRole('system_admin'), async (c) => {
  const id = c.req.param('id');

  const email = await c.env.DB.prepare(`
    SELECT e.*, s.name as store_name
    FROM hpb_emails e
    LEFT JOIN stores s ON s.id = e.store_id
    WHERE e.id = ?
  `).bind(id).first();

  if (!email) {
    return c.json({ error: 'Email not found' }, 404);
  }

  // Mark as read
  await c.env.DB.prepare(
    'UPDATE hpb_emails SET is_read = 1 WHERE id = ? AND is_read = 0'
  ).bind(id).run();

  return c.json({ email: { ...email, is_read: 1 } });
});

// Get store by ID
storesRoutes.get('/:id', async (c) => {
  const staff = c.get('staff')!;
  const id = c.req.param('id');

  // Check access - system_admin can access all, others need store assignment
  if (staff.role !== 'system_admin') {
    // Check staff_stores table
    const hasAccess = await c.env.DB.prepare(
      'SELECT 1 FROM staff_stores WHERE staff_id = ? AND store_id = ?'
    )
      .bind(staff.id, id)
      .first();

    // Also check legacy store_id
    if (!hasAccess && staff.store_id !== id) {
      return c.json({ error: 'Forbidden' }, 403);
    }
  }

  const store = await c.env.DB.prepare('SELECT * FROM stores WHERE id = ?').bind(id).first<Store>();

  if (!store) {
    return c.json({ error: 'Store not found' }, 404);
  }

  // Get business hours
  const hours = await c.env.DB.prepare(
    'SELECT * FROM business_hours WHERE store_id = ? ORDER BY day_of_week'
  )
    .bind(id)
    .all<BusinessHours>();

  return c.json({ store: sanitizeStore(store), business_hours: hours.results });
});

// Create store (system_admin or owner)
storesRoutes.post('/', requireRole('system_admin', 'owner'), async (c) => {
  const staff = c.get('staff')!;
  const body = await c.req.json<{
    name: string;
    postal_code?: string;
    address?: string;
    phone?: string;
    email?: string;
    owner_name?: string;
    owner_email?: string;
    owner_password?: string;
  }>();

  if (!body.name) {
    return c.json({ error: 'Name is required' }, 400);
  }

  // Validate owner fields if any are provided (system_admin only)
  const createOwner = body.owner_name && body.owner_email && body.owner_password;
  if (createOwner) {
    if (staff.role !== 'system_admin') {
      return c.json({ error: 'オーナー作成はsystem_adminのみ可能です' }, 403);
    }
    if (body.owner_password!.length < 8) {
      return c.json({ error: 'パスワードは8文字以上にしてください' }, 400);
    }
    const existing = await c.env.DB.prepare('SELECT id FROM staff WHERE email = ?')
      .bind(body.owner_email).first();
    if (existing) {
      return c.json({ error: 'このメールアドレスは既に登録されています' }, 400);
    }
  }

  const id = crypto.randomUUID();

  await c.env.DB.prepare(
    `INSERT INTO stores (id, name, postal_code, address, phone, email) VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(id, body.name, body.postal_code || null, body.address || null, body.phone || null, body.email || null)
    .run();

  // Create default business hours (Mon-Sat 9:00-19:00, Sun closed, Holiday 9:00-19:00)
  const days = [
    { day: 0, open: null, close: null, closed: 1 }, // Sunday
    { day: 1, open: '09:00', close: '19:00', closed: 0 },
    { day: 2, open: '09:00', close: '19:00', closed: 0 },
    { day: 3, open: '09:00', close: '19:00', closed: 0 },
    { day: 4, open: '09:00', close: '19:00', closed: 0 },
    { day: 5, open: '09:00', close: '19:00', closed: 0 },
    { day: 6, open: '09:00', close: '19:00', closed: 0 }, // Saturday
    { day: 7, open: '09:00', close: '19:00', closed: 0 }, // Holiday
  ];

  for (const d of days) {
    await c.env.DB.prepare(
      `INSERT INTO business_hours (id, store_id, day_of_week, open_time, close_time, is_closed)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(crypto.randomUUID(), id, d.day, d.open, d.close, d.closed)
      .run();
  }

  // Create owner account if provided
  let owner = null;
  if (createOwner) {
    const ownerId = crypto.randomUUID();
    const passwordHash = await hashPassword(body.owner_password!);

    await c.env.DB.prepare(
      `INSERT INTO staff (id, store_id, name, email, password_hash, role, email_verified)
       VALUES (?, ?, ?, ?, ?, 'owner', 1)`
    ).bind(ownerId, id, body.owner_name, body.owner_email, passwordHash).run();

    await c.env.DB.prepare(
      `INSERT INTO staff_stores (id, staff_id, store_id, is_primary, is_visible_to_customer) VALUES (?, ?, ?, 1, 1)`
    ).bind(crypto.randomUUID(), ownerId, id).run();

    owner = { id: ownerId, name: body.owner_name, email: body.owner_email };
  }

  // If existing owner creates a store, automatically assign them access to it
  if (!createOwner && staff.role === 'owner') {
    await c.env.DB.prepare(
      `INSERT INTO staff_stores (id, staff_id, store_id, is_primary) VALUES (?, ?, ?, ?)`
    )
      .bind(crypto.randomUUID(), staff.id, id, 0)
      .run();
  }

  const store = await c.env.DB.prepare('SELECT * FROM stores WHERE id = ?').bind(id).first<Store>();

  return c.json({ store: sanitizeStore(store), owner }, 201);
});

// Update store
storesRoutes.put('/:id', requireRole('system_admin', 'owner', 'manager'), async (c) => {
  const staff = c.get('staff')!;
  const id = c.req.param('id');

  // Check access - system_admin can access all; owners/managers need store assignment
  // (the staff_stores / primary-store check below scopes them to stores they manage)
  if (staff.role !== 'system_admin') {
    const hasAccess = await c.env.DB.prepare(
      'SELECT 1 FROM staff_stores WHERE staff_id = ? AND store_id = ?'
    )
      .bind(staff.id, id)
      .first();

    if (!hasAccess && staff.store_id !== id) {
      return c.json({ error: 'Forbidden' }, 403);
    }
  }

  const body = await c.req.json<{
    name?: string;
    postal_code?: string;
    address?: string;
    phone?: string;
    email?: string;
    line_channel_id?: string;
    line_channel_secret?: string;
    line_access_token?: string;
    line_liff_id?: string;
    salonboard_id?: string;
    salonboard_password?: string;
    salonboard_enabled?: boolean;
    hpb_email?: string;
    lime_id?: string;
    lime_password?: string;
    minimo_id?: string;
    minimo_password?: string;
    minimo_email?: string;
    seat_limit?: number;
    enable_seat_alert?: boolean;
  }>();

  const updates: string[] = [];
  const values: (string | number | null)[] = [];

  if (body.name !== undefined) {
    updates.push('name = ?');
    values.push(body.name);
  }
  if (body.postal_code !== undefined) {
    updates.push('postal_code = ?');
    values.push(body.postal_code || null);
  }
  if (body.address !== undefined) {
    updates.push('address = ?');
    values.push(body.address || null);
  }
  if (body.phone !== undefined) {
    updates.push('phone = ?');
    values.push(body.phone || null);
  }
  if (body.email !== undefined) {
    updates.push('email = ?');
    values.push(body.email || null);
  }
  if (body.line_channel_id !== undefined) {
    updates.push('line_channel_id = ?');
    values.push(body.line_channel_id || null);
  }
  if (body.line_channel_secret !== undefined) {
    updates.push('line_channel_secret = ?');
    values.push(body.line_channel_secret || null);
  }
  if (body.line_access_token !== undefined) {
    updates.push('line_access_token = ?');
    values.push(body.line_access_token || null);
  }
  if (body.line_liff_id !== undefined) {
    updates.push('line_liff_id = ?');
    values.push(body.line_liff_id || null);
  }
  if (body.salonboard_id !== undefined) {
    updates.push('salonboard_id = ?');
    values.push(body.salonboard_id || null);
  }
  if (body.salonboard_password !== undefined) {
    updates.push('salonboard_password = ?');
    values.push(body.salonboard_password || null);
    // パスワード変更時はVPS再起動フラグを立てる
    if (body.salonboard_password) {
      updates.push('salonboard_restart_requested = 1');
    }
  }
  if (body.salonboard_enabled !== undefined) {
    updates.push('salonboard_enabled = ?');
    values.push(body.salonboard_enabled ? 1 : 0);
  }
  if (body.hpb_email !== undefined) {
    updates.push('hpb_email = ?');
    values.push(body.hpb_email || null);
  }
  if (body.lime_id !== undefined) {
    updates.push('lime_id = ?');
    values.push(body.lime_id || null);
  }
  if (body.lime_password !== undefined) {
    updates.push('lime_password = ?');
    values.push(body.lime_password || null);
  }
  if (body.minimo_id !== undefined) {
    updates.push('minimo_id = ?');
    values.push(body.minimo_id || null);
  }
  if (body.minimo_password !== undefined) {
    updates.push('minimo_password = ?');
    values.push(body.minimo_password || null);
  }
  if (body.minimo_email !== undefined) {
    updates.push('minimo_email = ?');
    values.push(body.minimo_email || null);
  }
  if (body.seat_limit !== undefined) {
    updates.push('seat_limit = ?');
    values.push(body.seat_limit);
  }
  if (body.enable_seat_alert !== undefined) {
    updates.push('enable_seat_alert = ?');
    values.push(body.enable_seat_alert ? 1 : 0);
  }

  if (updates.length === 0) {
    return c.json({ error: 'No updates provided' }, 400);
  }

  updates.push("updated_at = datetime('now')");
  values.push(id!);

  await c.env.DB.prepare(`UPDATE stores SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();

  const store = await c.env.DB.prepare('SELECT * FROM stores WHERE id = ?').bind(id).first<Store>();

  return c.json({ store: sanitizeStore(store) });
});

// Update business hours
storesRoutes.put('/:id/hours', requireRole('system_admin', 'owner'), async (c) => {
  const staff = c.get('staff')!;
  const id = c.req.param('id');

  // Check access - system_admin can access all, owners need store assignment
  if (staff.role !== 'system_admin') {
    const hasAccess = await c.env.DB.prepare(
      'SELECT 1 FROM staff_stores WHERE staff_id = ? AND store_id = ?'
    )
      .bind(staff.id, id)
      .first();

    if (!hasAccess && staff.store_id !== id) {
      return c.json({ error: 'Forbidden' }, 403);
    }
  }

  const body = await c.req.json<{
    hours: {
      day_of_week: number;
      open_time: string | null;
      close_time: string | null;
      is_closed: boolean;
      max_concurrent?: number | null;
    }[];
  }>();

  for (const h of body.hours) {
    // Use INSERT OR REPLACE to handle day_of_week=7 (holiday) which may not exist yet
    const existing = await c.env.DB.prepare(
      'SELECT id FROM business_hours WHERE store_id = ? AND day_of_week = ?'
    ).bind(id, h.day_of_week).first<{ id: string }>();

    if (existing) {
      await c.env.DB.prepare(
        `UPDATE business_hours SET open_time = ?, close_time = ?, is_closed = ?, max_concurrent = ?
         WHERE store_id = ? AND day_of_week = ?`
      )
        .bind(h.open_time, h.close_time, h.is_closed ? 1 : 0, h.max_concurrent ?? null, id, h.day_of_week)
        .run();
    } else {
      await c.env.DB.prepare(
        `INSERT INTO business_hours (id, store_id, day_of_week, open_time, close_time, is_closed, max_concurrent)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(crypto.randomUUID(), id, h.day_of_week, h.open_time, h.close_time, h.is_closed ? 1 : 0, h.max_concurrent ?? null)
        .run();
    }
  }

  const hours = await c.env.DB.prepare(
    'SELECT * FROM business_hours WHERE store_id = ? ORDER BY day_of_week'
  )
    .bind(id)
    .all<BusinessHours>();

  return c.json({ business_hours: hours.results });
});

// Update store reservation settings
storesRoutes.put('/:id/reservation-settings', requireRole('system_admin', 'owner', 'manager'), async (c) => {
  const staff = c.get('staff')!;
  const id = c.req.param('id');

  if (staff.role !== 'system_admin') {
    const hasAccess = await c.env.DB.prepare(
      'SELECT 1 FROM staff_stores WHERE staff_id = ? AND store_id = ?'
    )
      .bind(staff.id, id)
      .first();

    if (!hasAccess && staff.store_id !== id) {
      return c.json({ error: 'Forbidden' }, 403);
    }
  }

  const body = await c.req.json<{
    advance_booking_days?: number;
    advance_booking_months?: number;
    same_day_cutoff_hours?: number;
    max_concurrent?: number;
    accept_same_start_time?: boolean;
    accept_outside_hours?: boolean;
    booking_cutoff_type?: string;
    booking_cutoff_days_before?: number;
    booking_cutoff_time?: string | null;
    booking_cutoff_same_day_minutes?: number;
    booking_calc_method?: string;
    holiday_hours_enabled?: boolean;
  }>();

  const updates: string[] = [];
  const params: (string | number | null)[] = [];

  if (body.advance_booking_days !== undefined) {
    updates.push('advance_booking_days = ?');
    params.push(body.advance_booking_days);
  }
  if (body.advance_booking_months !== undefined) {
    updates.push('advance_booking_months = ?');
    params.push(body.advance_booking_months);
  }
  if (body.same_day_cutoff_hours !== undefined) {
    updates.push('same_day_cutoff_hours = ?');
    params.push(body.same_day_cutoff_hours);
  }
  if (body.max_concurrent !== undefined) {
    updates.push('max_concurrent = ?');
    params.push(body.max_concurrent);
  }
  if (body.accept_same_start_time !== undefined) {
    updates.push('accept_same_start_time = ?');
    params.push(body.accept_same_start_time ? 1 : 0);
  }
  if (body.accept_outside_hours !== undefined) {
    updates.push('accept_outside_hours = ?');
    params.push(body.accept_outside_hours ? 1 : 0);
  }
  if (body.booking_cutoff_type !== undefined) {
    updates.push('booking_cutoff_type = ?');
    params.push(body.booking_cutoff_type);
  }
  if (body.booking_cutoff_days_before !== undefined) {
    updates.push('booking_cutoff_days_before = ?');
    params.push(body.booking_cutoff_days_before);
  }
  if (body.booking_cutoff_time !== undefined) {
    updates.push('booking_cutoff_time = ?');
    params.push(body.booking_cutoff_time);
  }
  if (body.booking_cutoff_same_day_minutes !== undefined) {
    updates.push('booking_cutoff_same_day_minutes = ?');
    params.push(body.booking_cutoff_same_day_minutes);
  }
  if (body.booking_calc_method !== undefined) {
    updates.push('booking_calc_method = ?');
    params.push(body.booking_calc_method);
  }
  if (body.holiday_hours_enabled !== undefined) {
    updates.push('holiday_hours_enabled = ?');
    params.push(body.holiday_hours_enabled ? 1 : 0);
  }

  if (updates.length === 0) {
    return c.json({ error: 'No fields to update' }, 400);
  }

  updates.push('updated_at = datetime(\'now\')');
  params.push(id!);

  await c.env.DB.prepare(
    `UPDATE stores SET ${updates.join(', ')} WHERE id = ?`
  )
    .bind(...params)
    .run();

  const store = await c.env.DB.prepare('SELECT * FROM stores WHERE id = ?').bind(id).first<Store>();

  return c.json({
    settings: {
      advance_booking_days: store!.advance_booking_days,
      advance_booking_months: (store as any).advance_booking_months ?? 4,
      same_day_cutoff_hours: store!.same_day_cutoff_hours,
      max_concurrent: store!.max_concurrent,
      accept_same_start_time: store!.accept_same_start_time,
      accept_outside_hours: store!.accept_outside_hours,
      booking_cutoff_type: store!.booking_cutoff_type,
      booking_cutoff_days_before: store!.booking_cutoff_days_before,
      booking_cutoff_time: store!.booking_cutoff_time,
      booking_cutoff_same_day_minutes: store!.booking_cutoff_same_day_minutes,
      booking_calc_method: store!.booking_calc_method,
      holiday_hours_enabled: (store as any).holiday_hours_enabled ?? 0,
    }
  });
});

// List store closures
storesRoutes.get('/:id/closures', async (c) => {
  const staff = c.get('staff')!;
  const id = c.req.param('id');

  if (staff.role !== 'system_admin') {
    const hasAccess = await c.env.DB.prepare(
      'SELECT 1 FROM staff_stores WHERE staff_id = ? AND store_id = ?'
    ).bind(staff.id, id).first();
    if (!hasAccess && staff.store_id !== id) {
      return c.json({ error: 'Forbidden' }, 403);
    }
  }

  const from = c.req.query('from');
  const to = c.req.query('to');

  let query = 'SELECT * FROM store_closures WHERE store_id = ?';
  const params: string[] = [id];

  if (from) {
    query += ' AND date >= ?';
    params.push(from);
  }
  if (to) {
    query += ' AND date <= ?';
    params.push(to);
  }

  query += ' ORDER BY date ASC';

  const result = await c.env.DB.prepare(query).bind(...params).all<StoreClosure>();
  return c.json({ closures: result.results });
});

// Add store closure
storesRoutes.post('/:id/closures', requireRole('system_admin', 'owner', 'manager'), async (c) => {
  const staff = c.get('staff')!;
  const id = c.req.param('id');

  if (staff.role !== 'system_admin') {
    const hasAccess = await c.env.DB.prepare(
      'SELECT 1 FROM staff_stores WHERE staff_id = ? AND store_id = ?'
    ).bind(staff.id, id).first();
    if (!hasAccess && staff.store_id !== id) {
      return c.json({ error: 'Forbidden' }, 403);
    }
  }

  const body = await c.req.json<{ date: string; reason?: string }>();

  if (!body.date || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
    return c.json({ error: '日付の形式が不正です (YYYY-MM-DD)' }, 400);
  }

  const closureId = crypto.randomUUID();

  try {
    await c.env.DB.prepare(
      'INSERT INTO store_closures (id, store_id, date, reason) VALUES (?, ?, ?, ?)'
    ).bind(closureId, id, body.date, body.reason || null).run();
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes('UNIQUE')) {
      return c.json({ error: 'この日付は既に登録されています' }, 400);
    }
    throw e;
  }

  const closure = await c.env.DB.prepare(
    'SELECT * FROM store_closures WHERE id = ?'
  ).bind(closureId).first<StoreClosure>();

  return c.json({ closure }, 201);
});

// Delete store closure
storesRoutes.delete('/:id/closures/:closureId', requireRole('system_admin', 'owner', 'manager'), async (c) => {
  const staff = c.get('staff')!;
  const id = c.req.param('id');
  const closureId = c.req.param('closureId');

  if (staff.role !== 'system_admin') {
    const hasAccess = await c.env.DB.prepare(
      'SELECT 1 FROM staff_stores WHERE staff_id = ? AND store_id = ?'
    ).bind(staff.id, id).first();
    if (!hasAccess && staff.store_id !== id) {
      return c.json({ error: 'Forbidden' }, 403);
    }
  }

  const closure = await c.env.DB.prepare(
    'SELECT id FROM store_closures WHERE id = ? AND store_id = ?'
  ).bind(closureId, id).first();

  if (!closure) {
    return c.json({ error: '臨時休業日が見つかりません' }, 404);
  }

  await c.env.DB.prepare('DELETE FROM store_closures WHERE id = ?').bind(closureId).run();

  return c.json({ success: true });
});

// Delete store (system_admin or owner)
storesRoutes.delete('/:id', requireRole('system_admin', 'owner'), async (c) => {
  const staff = c.get('staff')!;
  const id = c.req.param('id');

  if (staff.role === 'owner') {
    // Check the owner is linked to this store
    const link = await c.env.DB.prepare(
      'SELECT id FROM staff_stores WHERE staff_id = ? AND store_id = ?'
    ).bind(staff.id, id).first();
    if (!link) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    // Prevent deleting the last store
    const count = await c.env.DB.prepare(
      'SELECT COUNT(*) as cnt FROM staff_stores WHERE staff_id = ?'
    ).bind(staff.id).first<{ cnt: number }>();
    if (count && count.cnt <= 1) {
      return c.json({ error: '最後の店舗は削除できません' }, 400);
    }
  }

  await c.env.DB.prepare('DELETE FROM stores WHERE id = ?').bind(id).run();

  return c.json({ success: true });
});
