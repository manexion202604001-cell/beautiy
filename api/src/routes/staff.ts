import { Hono } from 'hono';
import type { Bindings, Variables, Staff, StaffBusinessHours, StaffReservationSettings, BusinessHours } from '../types';
import { staffAuth, requireRole, hashPassword } from '../middleware/auth';
import { importLimeStaffToDb } from '../services/limeService';
import { insertReservationLog } from '../services/reservationLogService';

export const staffRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Apply auth middleware
staffRoutes.use('*', staffAuth);

// List staff
staffRoutes.get('/', async (c) => {
  const currentStaff = c.get('staff')!;
  const storeId = c.req.query('store_id');

  let query: string;
  const params: string[] = [];

  if (storeId) {
    // Filter by store using staff_stores junction table
    // Use ss.is_visible_to_customer (per-store) instead of s.is_visible_to_customer (legacy)
    query = `SELECT s.id, s.store_id, s.name, s.nickname, s.email, s.role, s.avatar_url, s.is_active,
        ss.is_visible_to_customer, s.notify_line, s.staff_code, s.salonboard_staff_id,
        s.salonboard_name, s.lime_name, s.email_verified, s.retired_at, s.created_at, ss.sort_order
      FROM staff s
      JOIN staff_stores ss ON s.id = ss.staff_id
      WHERE ss.store_id = ?
      ORDER BY ss.sort_order, s.name`;
    params.push(storeId);
  } else if (currentStaff.role === 'system_admin') {
    // System admin without store filter: show all
    query = 'SELECT * FROM staff ORDER BY name';
  } else {
    // Non-admin without store filter: show staff in same stores
    query = `SELECT DISTINCT s.* FROM staff s
      JOIN staff_stores ss ON s.id = ss.staff_id
      WHERE ss.store_id IN (SELECT store_id FROM staff_stores WHERE staff_id = ?)
      ORDER BY s.name`;
    params.push(currentStaff.id);
  }

  const result = await c.env.DB.prepare(query)
    .bind(...params)
    .all<Staff>();

  // Remove sensitive data (but include notify settings)
  const staffList = result.results.map((s) => ({
    id: s.id,
    store_id: s.store_id,
    name: s.name,
    nickname: s.nickname,
    email: s.email,
    role: s.role,
    avatar_url: s.avatar_url,
    is_active: s.is_active,
    is_visible_to_customer: s.is_visible_to_customer,
    notify_line: s.notify_line,
    staff_code: s.staff_code,
    salonboard_staff_id: s.salonboard_staff_id,
    salonboard_name: s.salonboard_name,
    lime_name: s.lime_name,
    email_verified: s.email_verified,
    retired_at: s.retired_at,
    created_at: s.created_at,
    sort_order: (s as Record<string, unknown>).sort_order ?? 0,
  }));

  return c.json({ staff: staffList });
});

// Get all staff with store assignments (matrix view)
staffRoutes.get('/store-assignments', requireRole('system_admin', 'owner'), async (c) => {
  const currentStaff = c.get('staff')!;

  // Get all staff visible to current user
  let staffQuery: string;
  const staffParams: string[] = [];

  if (currentStaff.role === 'system_admin') {
    staffQuery = 'SELECT id, name, nickname, email, role, staff_code, avatar_url FROM staff WHERE is_active = 1 ORDER BY name';
  } else {
    // Owner: get staff assigned to their stores + unassigned staff
    staffQuery = `SELECT DISTINCT s.id, s.name, s.nickname, s.email, s.role, s.staff_code, s.avatar_url
      FROM staff s
      LEFT JOIN staff_stores ss ON s.id = ss.staff_id
      WHERE s.is_active = 1
      AND (ss.store_id IN (SELECT store_id FROM staff_stores WHERE staff_id = ?) OR ss.store_id IS NULL)
      ORDER BY s.name`;
    staffParams.push(currentStaff.id);
  }

  const staffResult = await c.env.DB.prepare(staffQuery)
    .bind(...staffParams)
    .all<{ id: string; name: string; nickname: string | null; email: string; role: string; staff_code: string | null; avatar_url: string | null }>();

  // Get all store assignments
  const assignments = await c.env.DB.prepare(
    'SELECT ss.staff_id, ss.store_id, ss.is_primary, ss.is_visible_to_customer, st.name as store_name FROM staff_stores ss JOIN stores st ON st.id = ss.store_id'
  ).all<{ staff_id: string; store_id: string; is_primary: number; is_visible_to_customer: number; store_name: string }>();

  // Build assignment map
  const assignmentMap = new Map<string, { id: string; name: string; is_primary: number; is_visible_to_customer: number }[]>();
  for (const a of assignments.results) {
    if (!assignmentMap.has(a.staff_id)) {
      assignmentMap.set(a.staff_id, []);
    }
    assignmentMap.get(a.staff_id)!.push({ id: a.store_id, name: a.store_name, is_primary: a.is_primary, is_visible_to_customer: a.is_visible_to_customer });
  }

  const staffWithStores = staffResult.results.map(s => ({
    ...s,
    stores: assignmentMap.get(s.id) || [],
  }));

  return c.json({ staff: staffWithStores });
});

// Toggle staff visibility per store
staffRoutes.put('/store-visibility', requireRole('system_admin', 'owner'), async (c) => {
  const body = await c.req.json<{ staff_id: string; store_id: string; is_visible_to_customer: boolean }>();

  if (!body.staff_id || !body.store_id) {
    return c.json({ error: 'staff_id and store_id are required' }, 400);
  }

  const assignment = await c.env.DB.prepare(
    'SELECT id FROM staff_stores WHERE staff_id = ? AND store_id = ?'
  ).bind(body.staff_id, body.store_id).first();

  if (!assignment) {
    return c.json({ error: 'Staff is not assigned to this store' }, 404);
  }

  await c.env.DB.prepare(
    'UPDATE staff_stores SET is_visible_to_customer = ? WHERE staff_id = ? AND store_id = ?'
  ).bind(body.is_visible_to_customer ? 1 : 0, body.staff_id, body.store_id).run();

  return c.json({ success: true });
});

// Reorder staff within a store (customer-facing display order)
staffRoutes.put('/reorder', requireRole('system_admin', 'owner', 'manager'), async (c) => {
  const body = await c.req.json<{ store_id: string; items: { staff_id: string; sort_order: number }[] }>();

  if (!body.store_id || !Array.isArray(body.items) || body.items.length === 0) {
    return c.json({ error: 'store_id and items array are required' }, 400);
  }

  const stmts = body.items.map((item) =>
    c.env.DB.prepare('UPDATE staff_stores SET sort_order = ? WHERE staff_id = ? AND store_id = ?')
      .bind(item.sort_order, item.staff_id, body.store_id)
  );

  await c.env.DB.batch(stmts);

  return c.json({ success: true, updated: body.items.length });
});

// Bulk update lime_name for staff (must be before /:id)
staffRoutes.put('/bulk-lime-name', requireRole('system_admin', 'owner', 'manager'), async (c) => {
  const body = await c.req.json<{
    mappings: { staff_id: string; lime_name: string }[];
  }>();

  if (!Array.isArray(body.mappings) || body.mappings.length === 0) {
    return c.json({ error: 'マッピングデータが空です' }, 400);
  }

  const statements = body.mappings.map(m =>
    c.env.DB.prepare('UPDATE staff SET lime_name = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .bind(m.lime_name || null, m.staff_id)
  );

  await c.env.DB.batch(statements);

  return c.json({ success: true, updated: body.mappings.length });
});

// Search staff by code (must be before /:id)
staffRoutes.get('/search/code/:code', requireRole('system_admin', 'owner', 'manager'), async (c) => {
  const code = c.req.param('code');

  const staff = await c.env.DB.prepare(
    'SELECT id, name, email, role, staff_code, avatar_url, email_verified, store_id FROM staff WHERE staff_code = ?'
  ).bind(code).first();

  if (!staff) {
    return c.json({ error: 'スタッフが見つかりません' }, 404);
  }

  return c.json({ staff });
});

// Approve email verification manually
staffRoutes.put('/:id/approve-email', requireRole('system_admin', 'owner'), async (c) => {
  const currentStaff = c.get('staff')!;
  const id = c.req.param('id');

  const targetStaff = await c.env.DB.prepare('SELECT * FROM staff WHERE id = ?').bind(id).first<Staff>();
  if (!targetStaff) {
    return c.json({ error: 'スタッフが見つかりません' }, 404);
  }

  if (targetStaff.email_verified === 1) {
    return c.json({ error: '既にメール認証済みです' }, 400);
  }

  // Owner can only approve staff in their own stores
  if (currentStaff.role === 'owner') {
    const sameStore = await c.env.DB.prepare(
      `SELECT 1 FROM staff_stores ss1
       JOIN staff_stores ss2 ON ss1.store_id = ss2.store_id
       WHERE ss1.staff_id = ? AND ss2.staff_id = ?`
    ).bind(currentStaff.id, targetStaff.id).first();

    // Also check if target staff has no store yet (just registered)
    if (!sameStore && targetStaff.store_id !== null) {
      return c.json({ error: '自店舗のスタッフのみ承認できます' }, 403);
    }
  }

  await c.env.DB.prepare(
    `UPDATE staff SET email_verified = 1, verification_token = NULL, verification_token_expires_at = NULL, updated_at = datetime('now') WHERE id = ?`
  ).bind(id).run();

  return c.json({ success: true, message: 'メール認証を承認しました' });
});

// Send store invitation to staff by code
staffRoutes.post('/link-by-code', requireRole('system_admin', 'owner', 'manager'), async (c) => {
  const currentStaff = c.get('staff')!;
  const { staff_code, store_id, role } = await c.req.json<{ staff_code: string; store_id: string; role?: string }>();

  if (!staff_code || !store_id) {
    return c.json({ error: 'スタッフコードと店舗IDは必須です' }, 400);
  }

  const targetStaff = await c.env.DB.prepare(
    'SELECT * FROM staff WHERE staff_code = ?'
  ).bind(staff_code).first<Staff>();

  if (!targetStaff) {
    return c.json({ error: 'スタッフが見つかりません' }, 404);
  }

  if (targetStaff.email_verified === 0) {
    return c.json({ error: 'このスタッフはまだメール認証が完了していません' }, 400);
  }

  // Verify store access for non-admin
  if (currentStaff.role !== 'system_admin') {
    const hasAccess = await c.env.DB.prepare(
      'SELECT 1 FROM staff_stores WHERE staff_id = ? AND store_id = ? UNION ALL SELECT 1 FROM staff WHERE id = ? AND store_id = ?'
    ).bind(currentStaff.id, store_id, currentStaff.id, store_id).first();
    if (!hasAccess) {
      return c.json({ error: 'この店舗へのアクセス権がありません' }, 403);
    }
  }

  // Check if already linked
  const existingLink = await c.env.DB.prepare(
    'SELECT id FROM staff_stores WHERE staff_id = ? AND store_id = ?'
  ).bind(targetStaff.id, store_id).first();
  if (existingLink) {
    return c.json({ error: 'このスタッフは既にこの店舗に所属しています' }, 400);
  }

  // Check for existing pending invitation
  const existingInvitation = await c.env.DB.prepare(
    "SELECT id FROM store_invitations WHERE staff_id = ? AND store_id = ? AND status = 'pending'"
  ).bind(targetStaff.id, store_id).first();
  if (existingInvitation) {
    return c.json({ error: 'このスタッフには既に招待を送信済みです' }, 400);
  }

  const invitationId = crypto.randomUUID();
  const invitationRole = role || 'staff';

  await c.env.DB.prepare(
    `INSERT INTO store_invitations (id, staff_id, store_id, invited_by, status, role)
     VALUES (?, ?, ?, ?, 'pending', ?)`
  ).bind(invitationId, targetStaff.id, store_id, currentStaff.id, invitationRole).run();

  return c.json({
    message: '招待を送信しました',
    invitation: { id: invitationId, staff_name: targetStaff.name, status: 'pending' },
  });
});

// Get all invitations for admin/owner (sent from their stores)
staffRoutes.get('/invitations/list', requireRole('system_admin', 'owner', 'manager'), async (c) => {
  const currentStaff = c.get('staff')!;

  let query: string;
  const params: string[] = [];

  if (currentStaff.role === 'system_admin') {
    query = `SELECT si.id, si.staff_id, si.store_id, si.status, si.role, si.created_at, si.responded_at,
                    s.name as store_name,
                    t.name as staff_name, t.staff_code, t.avatar_url,
                    inv.name as invited_by_name
             FROM store_invitations si
             JOIN stores s ON s.id = si.store_id
             JOIN staff t ON t.id = si.staff_id
             JOIN staff inv ON inv.id = si.invited_by
             ORDER BY si.created_at DESC`;
  } else {
    query = `SELECT si.id, si.staff_id, si.store_id, si.status, si.role, si.created_at, si.responded_at,
                    s.name as store_name,
                    t.name as staff_name, t.staff_code, t.avatar_url,
                    inv.name as invited_by_name
             FROM store_invitations si
             JOIN stores s ON s.id = si.store_id
             JOIN staff t ON t.id = si.staff_id
             JOIN staff inv ON inv.id = si.invited_by
             WHERE si.store_id IN (SELECT store_id FROM staff_stores WHERE staff_id = ?)
             ORDER BY si.created_at DESC`;
    params.push(currentStaff.id);
  }

  const result = await c.env.DB.prepare(query)
    .bind(...params)
    .all<{
      id: string; staff_id: string; store_id: string; status: string; role: string;
      created_at: string; responded_at: string | null;
      store_name: string; staff_name: string; staff_code: string | null; avatar_url: string | null;
      invited_by_name: string;
    }>();

  return c.json({ invitations: result.results });
});

// Get pending invitations for current staff
staffRoutes.get('/invitations/pending', async (c) => {
  const currentStaff = c.get('staff')!;

  const result = await c.env.DB.prepare(
    `SELECT si.id, si.store_id, si.role, si.created_at,
            s.name as store_name,
            inv.name as invited_by_name
     FROM store_invitations si
     JOIN stores s ON s.id = si.store_id
     JOIN staff inv ON inv.id = si.invited_by
     WHERE si.staff_id = ? AND si.status = 'pending'
     ORDER BY si.created_at DESC`
  ).bind(currentStaff.id).all();

  return c.json({ invitations: result.results });
});

// Accept invitation
staffRoutes.post('/invitations/:invitationId/accept', async (c) => {
  const currentStaff = c.get('staff')!;
  const invitationId = c.req.param('invitationId');

  const invitation = await c.env.DB.prepare(
    "SELECT * FROM store_invitations WHERE id = ? AND staff_id = ? AND status = 'pending'"
  ).bind(invitationId, currentStaff.id).first<{ id: string; staff_id: string; store_id: string; role: string }>();

  if (!invitation) {
    return c.json({ error: '招待が見つかりません' }, 404);
  }

  // Check if already linked
  const existingLink = await c.env.DB.prepare(
    'SELECT id FROM staff_stores WHERE staff_id = ? AND store_id = ?'
  ).bind(currentStaff.id, invitation.store_id).first();

  if (!existingLink) {
    // Create staff_stores record
    const linkId = crypto.randomUUID();
    const isPrimary = currentStaff.store_id === null ? 1 : 0;

    await c.env.DB.prepare(
      'INSERT INTO staff_stores (id, staff_id, store_id, is_primary, is_visible_to_customer) VALUES (?, ?, ?, ?, 1)'
    ).bind(linkId, currentStaff.id, invitation.store_id, isPrimary).run();

    // Update legacy store_id if null
    if (currentStaff.store_id === null) {
      await c.env.DB.prepare(
        "UPDATE staff SET store_id = ?, updated_at = datetime('now') WHERE id = ?"
      ).bind(invitation.store_id, currentStaff.id).run();
    }

    // Apply role if not default
    if (invitation.role && invitation.role !== 'staff' && invitation.role !== currentStaff.role) {
      await c.env.DB.prepare(
        "UPDATE staff SET role = ?, updated_at = datetime('now') WHERE id = ?"
      ).bind(invitation.role, currentStaff.id).run();
    }
  }

  // Mark invitation as accepted
  await c.env.DB.prepare(
    "UPDATE store_invitations SET status = 'accepted', responded_at = datetime('now') WHERE id = ?"
  ).bind(invitationId).run();

  return c.json({ message: '招待を承認しました' });
});

// Reject invitation
staffRoutes.post('/invitations/:invitationId/reject', async (c) => {
  const currentStaff = c.get('staff')!;
  const invitationId = c.req.param('invitationId');

  const invitation = await c.env.DB.prepare(
    "SELECT id FROM store_invitations WHERE id = ? AND staff_id = ? AND status = 'pending'"
  ).bind(invitationId, currentStaff.id).first();

  if (!invitation) {
    return c.json({ error: '招待が見つかりません' }, 404);
  }

  await c.env.DB.prepare(
    "UPDATE store_invitations SET status = 'rejected', responded_at = datetime('now') WHERE id = ?"
  ).bind(invitationId).run();

  return c.json({ message: '招待を辞退しました' });
});

// Get staff by ID
staffRoutes.get('/:id', async (c) => {
  const currentStaff = c.get('staff')!;
  const id = c.req.param('id');

  const staff = await c.env.DB.prepare('SELECT * FROM staff WHERE id = ?').bind(id).first<Staff>();

  if (!staff) {
    return c.json({ error: 'Staff not found' }, 404);
  }

  // Check access
  if (
    currentStaff.role !== 'system_admin' &&
    currentStaff.store_id !== staff.store_id &&
    currentStaff.id !== staff.id
  ) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  return c.json({
    staff: {
      id: staff.id,
      store_id: staff.store_id,
      name: staff.name,
      email: staff.email,
      role: staff.role,
      avatar_url: staff.avatar_url,
      is_active: staff.is_active,
      notify_line: staff.notify_line,
      line_user_id: staff.line_user_id,
      salonboard_staff_id: staff.salonboard_staff_id,
      lime_name: staff.lime_name,
      staff_line_channel_id: staff.staff_line_channel_id,
      staff_line_channel_secret: staff.staff_line_channel_secret,
      staff_line_access_token: staff.staff_line_access_token,
      created_at: staff.created_at,
    },
  });
});

// Create staff
staffRoutes.post('/', requireRole('system_admin'), async (c) => {
  const currentStaff = c.get('staff')!;
  const body = await c.req.json<{
    store_id: string;
    name: string;
    email: string;
    password: string;
    role: Staff['role'];
  }>();

  // Validate required fields
  if (!body.name || !body.email || !body.password || !body.role) {
    return c.json({ error: 'Missing required fields' }, 400);
  }

  // Validate role assignment
  if (body.role === 'system_admin' && currentStaff.role !== 'system_admin') {
    return c.json({ error: 'Cannot create system_admin' }, 403);
  }

  if (body.role === 'owner' && currentStaff.role !== 'system_admin') {
    return c.json({ error: 'Only system_admin can create owners' }, 403);
  }

  // Check store access
  if (currentStaff.role !== 'system_admin') {
    if (!body.store_id || body.store_id !== currentStaff.store_id) {
      return c.json({ error: 'Cannot create staff for other stores' }, 403);
    }
  }

  // Check if email already exists
  const existing = await c.env.DB.prepare('SELECT id FROM staff WHERE email = ?')
    .bind(body.email)
    .first();

  if (existing) {
    return c.json({ error: 'Email already exists' }, 400);
  }

  const id = crypto.randomUUID();
  const passwordHash = await hashPassword(body.password);

  await c.env.DB.prepare(
    `INSERT INTO staff (id, store_id, name, email, password_hash, role, email_verified)
     VALUES (?, ?, ?, ?, ?, ?, 1)`
  )
    .bind(
      id,
      body.role === 'system_admin' ? null : body.store_id,
      body.name,
      body.email,
      passwordHash,
      body.role
    )
    .run();

  const staff = await c.env.DB.prepare('SELECT * FROM staff WHERE id = ?').bind(id).first<Staff>();

  return c.json(
    {
      staff: {
        id: staff!.id,
        store_id: staff!.store_id,
        name: staff!.name,
        email: staff!.email,
        role: staff!.role,
        is_active: staff!.is_active,
      },
    },
    201
  );
});

// Update staff
staffRoutes.put('/:id', async (c) => {
  const currentStaff = c.get('staff')!;
  const id = c.req.param('id');

  const staff = await c.env.DB.prepare('SELECT * FROM staff WHERE id = ?').bind(id).first<Staff>();

  if (!staff) {
    return c.json({ error: 'Staff not found' }, 404);
  }

  // Check permissions
  let canEdit =
    currentStaff.role === 'system_admin' ||
    currentStaff.id === id;

  if (!canEdit && (currentStaff.role === 'owner' || currentStaff.role === 'manager')) {
    // Check via staff_stores junction table (multi-store support)
    const sameStore = await c.env.DB.prepare(
      `SELECT 1 FROM staff_stores ss1
       JOIN staff_stores ss2 ON ss1.store_id = ss2.store_id
       WHERE ss1.staff_id = ? AND ss2.staff_id = ?
       LIMIT 1`
    ).bind(currentStaff.id, id).first();

    // Fallback to legacy store_id comparison
    canEdit = !!(sameStore || currentStaff.store_id === staff.store_id);
  }

  if (!canEdit) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const body = await c.req.json<{
    name?: string;
    nickname?: string;
    email?: string;
    password?: string;
    role?: Staff['role'];
    is_active?: boolean;
    is_visible_to_customer?: boolean;
    notify_line?: boolean;
    line_user_id?: string;
    salonboard_staff_id?: string;
    salonboard_name?: string;
    minimo_name?: string;
    lime_name?: string;
    staff_line_channel_id?: string;
    staff_line_channel_secret?: string;
    staff_line_access_token?: string;
    retired_at?: string | null;
  }>();

  const updates: string[] = [];
  const values: (string | number | null)[] = [];

  if (body.name !== undefined) {
    updates.push('name = ?');
    values.push(body.name);
  }

  if (body.nickname !== undefined) {
    updates.push('nickname = ?');
    values.push(body.nickname || null);
  }

  if (body.email !== undefined && body.email !== staff.email) {
    // Check if email is taken
    const existing = await c.env.DB.prepare('SELECT id FROM staff WHERE email = ? AND id != ?')
      .bind(body.email, id)
      .first();

    if (existing) {
      return c.json({ error: 'Email already exists' }, 400);
    }

    updates.push('email = ?');
    values.push(body.email);
  }

  if (body.password !== undefined) {
    const passwordHash = await hashPassword(body.password);
    updates.push('password_hash = ?');
    values.push(passwordHash);
  }

  // Only certain roles can change roles
  if (body.role !== undefined && body.role !== staff.role) {
    if (currentStaff.role !== 'system_admin' && currentStaff.role !== 'owner') {
      return c.json({ error: 'Cannot change role' }, 403);
    }

    if (body.role === 'system_admin' && currentStaff.role !== 'system_admin') {
      return c.json({ error: 'Cannot assign system_admin role' }, 403);
    }

    updates.push('role = ?');
    values.push(body.role);
  }

  if (body.is_active !== undefined) {
    if (currentStaff.id === id) {
      return c.json({ error: '自分自身を無効にすることはできません（別の管理者に依頼してください）' }, 400);
    }
    updates.push('is_active = ?');
    values.push(body.is_active ? 1 : 0);
  }

  if (body.is_visible_to_customer !== undefined) {
    updates.push('is_visible_to_customer = ?');
    values.push(body.is_visible_to_customer ? 1 : 0);
  }

  if (body.notify_line !== undefined) {
    updates.push('notify_line = ?');
    values.push(body.notify_line ? 1 : 0);
  }

  if (body.line_user_id !== undefined) {
    updates.push('line_user_id = ?');
    values.push(body.line_user_id || '');
  }

  if (body.salonboard_staff_id !== undefined) {
    updates.push('salonboard_staff_id = ?');
    values.push(body.salonboard_staff_id || null);
  }

  // Track if salonboard_staff_id is being set (for triggering held syncs later)
  const isSettingHpbId = body.salonboard_staff_id !== undefined && !!body.salonboard_staff_id;

  if (body.salonboard_name !== undefined) {
    updates.push('salonboard_name = ?');
    values.push(body.salonboard_name || null);
  }

  if (body.minimo_name !== undefined) {
    updates.push('minimo_name = ?');
    values.push(body.minimo_name || null);
  }

  if (body.lime_name !== undefined) {
    updates.push('lime_name = ?');
    values.push(body.lime_name || null);
  }

  if (body.staff_line_channel_id !== undefined) {
    updates.push('staff_line_channel_id = ?');
    values.push(body.staff_line_channel_id || null);
  }

  if (body.staff_line_channel_secret !== undefined) {
    updates.push('staff_line_channel_secret = ?');
    values.push(body.staff_line_channel_secret || null);
  }

  if (body.staff_line_access_token !== undefined) {
    updates.push('staff_line_access_token = ?');
    values.push(body.staff_line_access_token || null);
  }

  if (body.retired_at !== undefined) {
    updates.push('retired_at = ?');
    values.push(body.retired_at);

    // 退職するとログインも不可にする(is_active=0)、退職取り消しで復帰(is_active=1)。
    // 明示的に is_active が指定されている時はそちらを優先（二重指定を避ける）。
    if (body.is_active === undefined) {
      if (body.retired_at !== null && currentStaff.id === id) {
        return c.json({ error: '自分自身を退職にすることはできません（別の管理者に依頼してください）' }, 400);
      }
      updates.push('is_active = ?');
      values.push(body.retired_at !== null ? 0 : 1);
    }

    // When retiring: hide from all stores' customer views
    if (body.retired_at !== null) {
      await c.env.DB.prepare(
        'UPDATE staff_stores SET is_visible_to_customer = 0 WHERE staff_id = ?'
      ).bind(id).run();
    }
  }

  if (updates.length === 0) {
    return c.json({ error: 'No updates provided' }, 400);
  }

  updates.push("updated_at = datetime('now')");
  values.push(id);

  await c.env.DB.prepare(`UPDATE staff SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();

  const updated = await c.env.DB.prepare('SELECT * FROM staff WHERE id = ?')
    .bind(id)
    .first<Staff>();

  // If HPB ID was just set, trigger sync for held reservations (salonboard_synced = -2)
  if (isSettingHpbId) {
    const db = c.env.DB;
    const heldReservations = await db.prepare(
      `SELECT r.id, r.store_id FROM reservations r
       WHERE r.staff_id = ? AND r.salonboard_synced = -2
         AND r.status IN ('confirmed', 'pending')
         AND r.start_at > datetime('now')`
    ).bind(id).all<{ id: string; store_id: string }>();

    // Queue held reservations for the store's VPS worker (polls salonboard_synced = 0)
    for (const r of heldReservations.results) {
      await db.prepare(
        "UPDATE reservations SET salonboard_synced = 0, salonboard_sync_error = NULL, updated_at = datetime('now') WHERE id = ?"
      ).bind(r.id).run();
      await insertReservationLog(db, {
        reservationId: r.id, eventType: 'salonboard_sync_requested', actorType: 'system',
        actorName: 'サロンボード', description: 'HPB ID設定により保留を解除し、サロンボード連携をキューに入れました',
      });
    }
  }

  return c.json({
    staff: {
      id: updated!.id,
      store_id: updated!.store_id,
      name: updated!.name,
      nickname: updated!.nickname,
      email: updated!.email,
      role: updated!.role,
      is_active: updated!.is_active,
      is_visible_to_customer: updated!.is_visible_to_customer,
      notify_line: updated!.notify_line,
      line_user_id: updated!.line_user_id,
      salonboard_staff_id: updated!.salonboard_staff_id,
      salonboard_name: updated!.salonboard_name,
      lime_name: updated!.lime_name,
      staff_line_channel_id: updated!.staff_line_channel_id,
      staff_line_channel_secret: updated!.staff_line_channel_secret,
      staff_line_access_token: updated!.staff_line_access_token,
      retired_at: updated!.retired_at,
    },
  });
});

// Upload staff avatar
staffRoutes.post('/:id/avatar', async (c) => {
  const currentStaff = c.get('staff')!;
  const id = c.req.param('id');

  const staff = await c.env.DB.prepare('SELECT * FROM staff WHERE id = ?').bind(id).first<Staff>();

  if (!staff) {
    return c.json({ error: 'Staff not found' }, 404);
  }

  // Check permissions - can upload for self, or managers can upload for their store's staff
  const canUpload =
    currentStaff.id === id ||
    currentStaff.role === 'system_admin' ||
    ((currentStaff.role === 'owner' || currentStaff.role === 'manager') &&
      currentStaff.store_id === staff.store_id);

  if (!canUpload) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const formData = await c.req.formData();
  const file = formData.get('file') as File;

  if (!file) {
    return c.json({ error: 'File is required' }, 400);
  }

  // Delete old avatar if exists
  if (staff.avatar_url) {
    const oldKey = staff.avatar_url.replace('/images/', '');
    try {
      await c.env.IMAGES.delete(oldKey);
    } catch {
      // Ignore errors when deleting old image
    }
  }

  // Upload to R2
  const fileName = `staff/${staff.store_id || 'system'}/${crypto.randomUUID()}-${file.name}`;
  await c.env.IMAGES.put(fileName, file.stream(), {
    httpMetadata: {
      contentType: file.type,
    },
  });

  const avatarUrl = `/images/${fileName}`;

  await c.env.DB.prepare("UPDATE staff SET avatar_url = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(avatarUrl, id)
    .run();

  const updated = await c.env.DB.prepare('SELECT * FROM staff WHERE id = ?')
    .bind(id)
    .first<Staff>();

  return c.json({
    staff: {
      id: updated!.id,
      store_id: updated!.store_id,
      name: updated!.name,
      email: updated!.email,
      role: updated!.role,
      avatar_url: updated!.avatar_url,
      is_active: updated!.is_active,
    },
  });
});

// Import staff avatar from external URL (server-side fetch to bypass CORS)
staffRoutes.post('/:id/avatar-from-url', requireRole('system_admin', 'owner', 'manager'), async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ url: string }>();

  if (!body.url) {
    return c.json({ error: 'URL is required' }, 400);
  }

  const staff = await c.env.DB.prepare('SELECT * FROM staff WHERE id = ?').bind(id).first<Staff>();
  if (!staff) {
    return c.json({ error: 'Staff not found' }, 404);
  }

  // Fetch image from external URL server-side
  const response = await fetch(body.url);
  if (!response.ok) {
    return c.json({ error: `Failed to fetch image: ${response.status}` }, 400);
  }

  const contentType = response.headers.get('content-type') || 'image/jpeg';
  const ext = contentType.includes('png') ? 'png' : 'jpg';

  // Delete old avatar if exists
  if (staff.avatar_url) {
    const oldKey = staff.avatar_url.replace('/images/', '');
    try { await c.env.IMAGES.delete(oldKey); } catch { /* ignore */ }
  }

  // Upload to R2
  const fileName = `staff/${staff.store_id || 'system'}/${crypto.randomUUID()}.${ext}`;
  await c.env.IMAGES.put(fileName, response.body, {
    httpMetadata: { contentType },
  });

  const avatarUrl = `/images/${fileName}`;
  await c.env.DB.prepare("UPDATE staff SET avatar_url = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(avatarUrl, id).run();

  return c.json({ success: true, avatar_url: avatarUrl });
});

// Delete staff
staffRoutes.delete('/:id', requireRole('system_admin', 'owner'), async (c) => {
  const currentStaff = c.get('staff')!;
  const id = c.req.param('id');

  if (currentStaff.id === id) {
    return c.json({ error: 'Cannot delete yourself' }, 400);
  }

  const staff = await c.env.DB.prepare('SELECT * FROM staff WHERE id = ?').bind(id).first<Staff>();

  if (!staff) {
    return c.json({ error: 'Staff not found' }, 404);
  }

  // Check access - owner must share a store with target staff
  if (currentStaff.role !== 'system_admin') {
    // Get all store IDs the owner has access to
    const ownerStores = await c.env.DB.prepare(
      `SELECT store_id FROM staff_stores WHERE staff_id = ?
       UNION
       SELECT store_id FROM staff WHERE id = ? AND store_id IS NOT NULL`
    ).bind(currentStaff.id, currentStaff.id).all<{ store_id: string }>();
    const ownerStoreIds = new Set(ownerStores.results.map(r => r.store_id));

    // Get all store IDs the target staff belongs to
    const targetStores = await c.env.DB.prepare(
      `SELECT store_id FROM staff_stores WHERE staff_id = ?
       UNION
       SELECT store_id FROM staff WHERE id = ? AND store_id IS NOT NULL`
    ).bind(id, id).all<{ store_id: string }>();

    const hasAccess = targetStores.results.some(r => ownerStoreIds.has(r.store_id));
    if (!hasAccess) {
      return c.json({ error: 'Forbidden' }, 403);
    }
  }

  // Clean up references with RESTRICT constraints
  await c.env.DB.prepare('DELETE FROM karute_images WHERE karute_id IN (SELECT id FROM karutes WHERE staff_id = ?)').bind(id).run();
  await c.env.DB.prepare('DELETE FROM karutes WHERE staff_id = ?').bind(id).run();
  await c.env.DB.prepare('DELETE FROM reservations WHERE staff_id = ?').bind(id).run();
  // Clean up staff_stores (CASCADE but explicit for clarity)
  await c.env.DB.prepare('DELETE FROM staff_stores WHERE staff_id = ?').bind(id).run();

  await c.env.DB.prepare('DELETE FROM staff WHERE id = ?').bind(id).run();

  return c.json({ success: true });
});

// Get staff's assigned stores
staffRoutes.get('/:id/stores', async (c) => {
  const currentStaff = c.get('staff')!;
  const id = c.req.param('id');

  // Check permissions
  if (currentStaff.role !== 'system_admin' && currentStaff.role !== 'owner' && currentStaff.id !== id) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const result = await c.env.DB.prepare(
    `SELECT s.id, s.name, ss.is_primary, ss.created_at
     FROM staff_stores ss
     JOIN stores s ON s.id = ss.store_id
     WHERE ss.staff_id = ?
     ORDER BY ss.is_primary DESC, s.name`
  )
    .bind(id)
    .all<{ id: string; name: string; is_primary: number; created_at: string }>();

  return c.json({ stores: result.results });
});

// Assign staff to stores (owner or system_admin only)
staffRoutes.put('/:id/stores', requireRole('system_admin', 'owner'), async (c) => {
  const currentStaff = c.get('staff')!;
  const id = c.req.param('id');

  const staff = await c.env.DB.prepare('SELECT * FROM staff WHERE id = ?').bind(id).first<Staff>();

  if (!staff) {
    return c.json({ error: 'Staff not found' }, 404);
  }

  // Owner access check: allow if staff shares a store, has matching store_id, or has no stores yet
  if (currentStaff.role === 'owner') {
    const sameStore = await c.env.DB.prepare(
      `SELECT 1 FROM staff_stores ss1
       JOIN staff_stores ss2 ON ss1.store_id = ss2.store_id
       WHERE ss1.staff_id = ? AND ss2.staff_id = ?
       LIMIT 1`
    ).bind(currentStaff.id, id).first();

    const hasAnyStore = await c.env.DB.prepare(
      'SELECT 1 FROM staff_stores WHERE staff_id = ? LIMIT 1'
    ).bind(id).first();

    if (!sameStore && hasAnyStore && staff.store_id !== currentStaff.store_id) {
      return c.json({ error: 'Cannot modify staff from other stores' }, 403);
    }
  }

  const body = await c.req.json<{
    store_ids: string[];
    primary_store_id?: string;
  }>();

  if (!body.store_ids || !Array.isArray(body.store_ids)) {
    return c.json({ error: 'store_ids array is required' }, 400);
  }

  // Verify all store_ids exist
  for (const storeId of body.store_ids) {
    const store = await c.env.DB.prepare('SELECT id FROM stores WHERE id = ?').bind(storeId).first();
    if (!store) {
      return c.json({ error: `Store ${storeId} not found` }, 400);
    }
  }

  // Get staff's current store assignments (for permission check and visibility preservation)
  const currentAssignments = await c.env.DB.prepare(
    'SELECT store_id, is_visible_to_customer FROM staff_stores WHERE staff_id = ?'
  ).bind(id).all<{ store_id: string; is_visible_to_customer: number }>();
  const currentStoreIds = new Set(currentAssignments.results.map((s) => s.store_id));
  const visibilityMap = new Map(currentAssignments.results.map((s) => [s.store_id, s.is_visible_to_customer]));

  // Owner can only add/remove stores they own
  if (currentStaff.role === 'owner') {
    const ownerStores = await c.env.DB.prepare(
      `SELECT store_id FROM staff_stores WHERE staff_id = ?
       UNION SELECT ? WHERE ? IS NOT NULL`
    )
      .bind(currentStaff.id, currentStaff.store_id, currentStaff.store_id)
      .all<{ store_id: string }>();

    const ownerStoreIds = new Set(ownerStores.results.map((s) => s.store_id));

    // Only validate newly added stores (existing assignments are allowed)
    for (const storeId of body.store_ids) {
      if (!currentStoreIds.has(storeId) && !ownerStoreIds.has(storeId)) {
        return c.json({ error: 'Cannot assign staff to stores you do not own' }, 403);
      }
    }
  }

  // Delete existing assignments and insert new ones
  await c.env.DB.prepare('DELETE FROM staff_stores WHERE staff_id = ?').bind(id).run();

  const primaryStoreId = body.primary_store_id || body.store_ids[0];

  for (const storeId of body.store_ids) {
    const isPrimary = storeId === primaryStoreId ? 1 : 0;
    const visibility = visibilityMap.get(storeId) ?? 1;
    await c.env.DB.prepare(
      `INSERT INTO staff_stores (id, staff_id, store_id, is_primary, is_visible_to_customer)
       VALUES (?, ?, ?, ?, ?)`
    )
      .bind(crypto.randomUUID(), id, storeId, isPrimary, visibility)
      .run();
  }

  // Update legacy store_id to primary store
  await c.env.DB.prepare("UPDATE staff SET store_id = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(primaryStoreId, id)
    .run();

  const result = await c.env.DB.prepare(
    `SELECT s.id, s.name, ss.is_primary
     FROM staff_stores ss
     JOIN stores s ON s.id = ss.store_id
     WHERE ss.staff_id = ?
     ORDER BY ss.is_primary DESC, s.name`
  )
    .bind(id)
    .all<{ id: string; name: string; is_primary: number }>();

  return c.json({ stores: result.results });
});

// Import staff from JSON (manager+ only)
staffRoutes.post('/import/json', requireRole('system_admin', 'owner', 'manager'), async (c) => {
  const currentStaff = c.get('staff')!;
  const body = await c.req.json<{
    store_id?: string;
    staff: { name: string; role: string; avatar_url?: string }[];
  }>();

  const storeId = body.store_id || currentStaff.store_id;
  if (!storeId) {
    return c.json({ error: 'Store ID is required' }, 400);
  }

  if (currentStaff.role !== 'system_admin' && currentStaff.store_id !== storeId) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  if (!Array.isArray(body.staff) || body.staff.length === 0) {
    return c.json({ error: 'スタッフデータが空です' }, 400);
  }

  const { created, skipped } = await importLimeStaffToDb(c.env.DB, storeId, body.staff);

  return c.json({
    success: true,
    message: `${body.staff.length}件中${created}件を登録しました。${skipped > 0 ? `（${skipped}件は既存のため省略）` : ''}`,
    created,
    skipped,
    total: body.staff.length,
  });
});

// ===== Staff Business Hours =====

// Get staff business hours
staffRoutes.get('/:id/business-hours', async (c) => {
  const staffId = c.req.param('id');
  const storeId = c.req.query('store_id');

  if (!storeId) {
    return c.json({ error: 'store_id is required' }, 400);
  }

  const hours = await c.env.DB.prepare(
    'SELECT * FROM staff_business_hours WHERE staff_id = ? AND store_id = ? ORDER BY day_of_week'
  )
    .bind(staffId, storeId)
    .all<StaffBusinessHours>();

  return c.json({ business_hours: hours.results });
});

// Update staff business hours
staffRoutes.put('/:id/business-hours', async (c) => {
  const currentStaff = c.get('staff')!;
  const staffId = c.req.param('id');
  const body = await c.req.json<{
    store_id: string;
    hours: {
      day_of_week: number;
      open_time: string | null;
      close_time: string | null;
      is_closed: boolean;
    }[];
  }>();

  if (!body.store_id) {
    return c.json({ error: 'store_id is required' }, 400);
  }

  // Permission: self, manager+, or system_admin
  if (currentStaff.role !== 'system_admin' && currentStaff.id !== staffId) {
    if (!['owner', 'manager'].includes(currentStaff.role)) {
      return c.json({ error: 'Forbidden' }, 403);
    }
  }

  // Delete existing and insert new
  await c.env.DB.prepare(
    'DELETE FROM staff_business_hours WHERE staff_id = ? AND store_id = ?'
  )
    .bind(staffId, body.store_id)
    .run();

  for (const h of body.hours) {
    await c.env.DB.prepare(
      `INSERT INTO staff_business_hours (id, staff_id, store_id, day_of_week, open_time, close_time, is_closed)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        crypto.randomUUID(),
        staffId,
        body.store_id,
        h.day_of_week,
        h.open_time,
        h.close_time,
        h.is_closed ? 1 : 0
      )
      .run();
  }

  const hours = await c.env.DB.prepare(
    'SELECT * FROM staff_business_hours WHERE staff_id = ? AND store_id = ? ORDER BY day_of_week'
  )
    .bind(staffId, body.store_id)
    .all<StaffBusinessHours>();

  return c.json({ business_hours: hours.results });
});

// Copy store business hours to staff
staffRoutes.post('/:id/business-hours/copy-store', async (c) => {
  const currentStaff = c.get('staff')!;
  const staffId = c.req.param('id');
  const body = await c.req.json<{ store_id: string }>();

  if (!body.store_id) {
    return c.json({ error: 'store_id is required' }, 400);
  }

  // Permission: self, manager+, or system_admin
  if (currentStaff.role !== 'system_admin' && currentStaff.id !== staffId) {
    if (!['owner', 'manager'].includes(currentStaff.role)) {
      return c.json({ error: 'Forbidden' }, 403);
    }
  }

  // Get store business hours
  const storeHours = await c.env.DB.prepare(
    'SELECT * FROM business_hours WHERE store_id = ? ORDER BY day_of_week'
  )
    .bind(body.store_id)
    .all<BusinessHours>();

  // Use defaults if store has no business hours configured
  const sourceHours = storeHours.results.length > 0
    ? storeHours.results
    : Array.from({ length: 7 }, (_, i) => ({
        day_of_week: i,
        open_time: i === 0 ? null : '09:00',
        close_time: i === 0 ? null : '19:00',
        is_closed: i === 0 ? 1 : 0,
      }));

  // Delete existing staff hours
  await c.env.DB.prepare(
    'DELETE FROM staff_business_hours WHERE staff_id = ? AND store_id = ?'
  )
    .bind(staffId, body.store_id)
    .run();

  // Copy store hours to staff
  for (const h of sourceHours) {
    await c.env.DB.prepare(
      `INSERT INTO staff_business_hours (id, staff_id, store_id, day_of_week, open_time, close_time, is_closed)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        crypto.randomUUID(),
        staffId,
        body.store_id,
        h.day_of_week,
        h.open_time,
        h.close_time,
        h.is_closed
      )
      .run();
  }

  const hours = await c.env.DB.prepare(
    'SELECT * FROM staff_business_hours WHERE staff_id = ? AND store_id = ? ORDER BY day_of_week'
  )
    .bind(staffId, body.store_id)
    .all<StaffBusinessHours>();

  return c.json({ business_hours: hours.results });
});

// ===== Staff Reservation Settings =====

// Get staff reservation settings
staffRoutes.get('/:id/reservation-settings', async (c) => {
  const staffId = c.req.param('id');
  const storeId = c.req.query('store_id');

  if (!storeId) {
    return c.json({ error: 'store_id is required' }, 400);
  }

  const settings = await c.env.DB.prepare(
    'SELECT * FROM staff_reservation_settings WHERE staff_id = ? AND store_id = ?'
  )
    .bind(staffId, storeId)
    .first<StaffReservationSettings>();

  // Return defaults if not configured
  return c.json({
    settings: settings || {
      advance_booking_days: 365,
      same_day_cutoff_hours: 1,
      max_concurrent: 1,
      accept_same_start_time: 0,
      accept_outside_hours: 0,
    },
  });
});

// Update staff reservation settings
staffRoutes.put('/:id/reservation-settings', async (c) => {
  const currentStaff = c.get('staff')!;
  const staffId = c.req.param('id');
  const body = await c.req.json<{
    store_id: string;
    advance_booking_days?: number;
    same_day_cutoff_hours?: number;
    max_concurrent?: number;
    accept_same_start_time?: boolean;
    accept_outside_hours?: boolean;
  }>();

  if (!body.store_id) {
    return c.json({ error: 'store_id is required' }, 400);
  }

  // Permission: self, manager+, or system_admin
  if (currentStaff.role !== 'system_admin' && currentStaff.id !== staffId) {
    if (!['owner', 'manager'].includes(currentStaff.role)) {
      return c.json({ error: 'Forbidden' }, 403);
    }
  }

  const existing = await c.env.DB.prepare(
    'SELECT id FROM staff_reservation_settings WHERE staff_id = ? AND store_id = ?'
  )
    .bind(staffId, body.store_id)
    .first<{ id: string }>();

  if (existing) {
    const updates: string[] = [];
    const values: (string | number)[] = [];

    if (body.advance_booking_days !== undefined) {
      updates.push('advance_booking_days = ?');
      values.push(body.advance_booking_days);
    }
    if (body.same_day_cutoff_hours !== undefined) {
      updates.push('same_day_cutoff_hours = ?');
      values.push(body.same_day_cutoff_hours);
    }
    if (body.max_concurrent !== undefined) {
      updates.push('max_concurrent = ?');
      values.push(body.max_concurrent);
    }
    if (body.accept_same_start_time !== undefined) {
      updates.push('accept_same_start_time = ?');
      values.push(body.accept_same_start_time ? 1 : 0);
    }
    if (body.accept_outside_hours !== undefined) {
      updates.push('accept_outside_hours = ?');
      values.push(body.accept_outside_hours ? 1 : 0);
    }

    if (updates.length > 0) {
      updates.push("updated_at = datetime('now')");
      values.push(existing.id);
      await c.env.DB.prepare(
        `UPDATE staff_reservation_settings SET ${updates.join(', ')} WHERE id = ?`
      )
        .bind(...values)
        .run();
    }
  } else {
    await c.env.DB.prepare(
      `INSERT INTO staff_reservation_settings (id, staff_id, store_id, advance_booking_days, same_day_cutoff_hours, max_concurrent, accept_same_start_time, accept_outside_hours)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        crypto.randomUUID(),
        staffId,
        body.store_id,
        body.advance_booking_days ?? 365,
        body.same_day_cutoff_hours ?? 1,
        body.max_concurrent ?? 1,
        body.accept_same_start_time ? 1 : 0,
        body.accept_outside_hours ? 1 : 0
      )
      .run();
  }

  const settings = await c.env.DB.prepare(
    'SELECT * FROM staff_reservation_settings WHERE staff_id = ? AND store_id = ?'
  )
    .bind(staffId, body.store_id)
    .first<StaffReservationSettings>();

  return c.json({ settings });
});
