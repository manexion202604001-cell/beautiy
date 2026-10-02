import { Hono } from 'hono';
import type { Bindings, Variables, Reservation, Menu, Staff } from '../types';
import { staffAuth, requireRole } from '../middleware/auth';
import { LineService, LineNotifyService, getLineUserId, getStoreLineAccessToken } from '../services/lineService';
import { isSalonboardEnabled } from '../services/salonboardService';
import { isStaffBlocked } from '../services/staffBlockService';
import { insertReservationLog } from '../services/reservationLogService';
import { insertReservationConfirmedMessage, insertReservationChangedMessage } from '../services/reservationMessageService';
import { findEquipmentConflict } from '../services/equipmentService';

export const reservationsRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Check if staff has access to a store (via staff_stores multi-store support)
async function hasStoreAccess(db: D1Database, staff: Staff, storeId: string): Promise<boolean> {
  if (staff.role === 'system_admin') return true;
  if (staff.store_id === storeId) return true;
  const link = await db.prepare(
    'SELECT 1 FROM staff_stores WHERE staff_id = ? AND store_id = ?'
  ).bind(staff.id, storeId).first();
  return !!link;
}

// Apply auth middleware
reservationsRoutes.use('*', staffAuth);

// Delete all reservations for a store (system_admin only - dev tool)
reservationsRoutes.delete('/all', requireRole('system_admin', 'owner'), async (c) => {
  const staff = c.get('staff')!;
  const body = await c.req.json<{ store_id?: string }>().catch(() => ({ store_id: undefined }));
  const storeId = body.store_id || staff.store_id;

  if (!storeId) {
    return c.json({ error: 'Store ID is required' }, 400);
  }

  if (!await hasStoreAccess(c.env.DB, staff, storeId)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const result = await c.env.DB.prepare(
    'DELETE FROM reservations WHERE store_id = ?'
  ).bind(storeId).run();

  return c.json({ success: true, deleted: result.meta.changes || 0 });
});

// List reservations
reservationsRoutes.get('/', async (c) => {
  const staff = c.get('staff')!;
  const storeId = c.req.query('store_id') || staff.store_id;
  const date = c.req.query('date'); // YYYY-MM-DD
  const startDate = c.req.query('start_date');
  const endDate = c.req.query('end_date');
  const status = c.req.query('status');
  const staffId = c.req.query('staff_id');
  const customerId = c.req.query('customer_id');
  const search = c.req.query('search');

  if (!storeId && staff.role !== 'system_admin') {
    return c.json({ reservations: [] });
  }

  const limit = parseInt(c.req.query('limit') || '0');
  const offset = parseInt(c.req.query('offset') || '0');

  let query = `
    SELECT r.*,
           c.name as customer_name, c.name_kana as customer_name_kana, c.phone as customer_phone, c.visit_count as customer_visit_count, c.is_minimo,
           CASE WHEN cl.line_user_id IS NOT NULL THEN 1 ELSE 0 END as has_line,
           m.name as menu_name, m.duration, m.price,
           s.name as staff_name, s.nickname as staff_nickname, s.salonboard_staff_id,
           st.name as store_name, st.salonboard_id as store_salonboard_id
    FROM reservations r
    LEFT JOIN customers c ON r.customer_id = c.id
    LEFT JOIN customer_line cl ON c.id = cl.customer_id AND cl.store_id = r.store_id
    LEFT JOIN menus m ON r.menu_id = m.id
    LEFT JOIN staff s ON r.staff_id = s.id
    LEFT JOIN stores st ON r.store_id = st.id
    WHERE 1=1
  `;
  const params: (string | number)[] = [];

  if (storeId) {
    query += ' AND r.store_id = ?';
    params.push(storeId);
  }

  // Staff filter (explicit staff_id param from frontend self/store toggle)
  if (staffId) {
    query += ' AND r.staff_id = ?';
    params.push(staffId);
  }

  if (customerId) {
    query += ' AND r.customer_id = ?';
    params.push(customerId);
  }

  // Date filters
  if (date) {
    query += ' AND DATE(r.start_at) = ?';
    params.push(date);
  } else if (startDate && endDate) {
    query += ' AND DATE(r.start_at) >= ? AND DATE(r.start_at) <= ?';
    params.push(startDate, endDate);
  } else if (startDate) {
    query += ' AND DATE(r.start_at) >= ?';
    params.push(startDate);
  }

  // Search by customer name, phone, or menu name
  if (search) {
    query += ' AND (c.name LIKE ? OR c.phone LIKE ? OR m.name LIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  if (status) {
    query += ' AND r.status = ?';
    params.push(status);
  }

  const sort = c.req.query('sort');
  if (sort === 'recent_activity') {
    // Add subquery for latest activity timestamp
    query = query.replace(
      'SELECT r.*,',
      'SELECT r.*, (SELECT MAX(created_at) FROM reservation_logs WHERE reservation_id = r.id) as last_activity_at,'
    );
    query += ' ORDER BY COALESCE((SELECT MAX(created_at) FROM reservation_logs WHERE reservation_id = r.id), r.updated_at, r.created_at) DESC';
  } else if (sort === 'updated_at_desc') {
    query += ' ORDER BY r.updated_at DESC';
  } else {
    query += ' ORDER BY r.start_at';
  }

  // Count total before applying limit/offset
  let total = 0;
  if (limit > 0) {
    const countQuery = query.replace(/SELECT r\.\*[\s\S]*?FROM reservations r/, 'SELECT COUNT(*) as cnt FROM reservations r');
    const countResult = await c.env.DB.prepare(countQuery).bind(...params).first<{ cnt: number }>();
    total = countResult?.cnt || 0;
    query += ' LIMIT ? OFFSET ?';
    params.push(limit, offset);
  }

  const result = await c.env.DB.prepare(query)
    .bind(...params)
    .all();

  const reservations = result.results as Record<string, unknown>[];
  if (limit === 0) total = reservations.length;

  // Fetch consent status for all reservations (batch)
  if (reservations.length > 0) {
    const ids = reservations.map(r => r.id as string);
    const BATCH_SIZE = 80;
    const consentSet = new Set<string>();

    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batch = ids.slice(i, i + BATCH_SIZE);
      const placeholders = batch.map(() => '?').join(',');
      const crResult = await c.env.DB.prepare(
        `SELECT DISTINCT reservation_id FROM consent_records WHERE reservation_id IN (${placeholders})`
      ).bind(...batch).all();
      for (const cr of crResult.results) {
        consentSet.add((cr as Record<string, unknown>).reservation_id as string);
      }
    }

    for (const r of reservations) {
      (r as Record<string, unknown>).has_consent = consentSet.has(r.id as string);
    }
  }

  // Fetch menus for all reservations from reservation_menus table (batch to stay within D1 bind limit)
  if (reservations.length > 0) {
    const ids = reservations.map(r => r.id as string);
    const BATCH_SIZE = 80;
    const menusMap: Record<string, { id: string; name: string; duration: number; price: number }[]> = {};

    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batch = ids.slice(i, i + BATCH_SIZE);
      const placeholders = batch.map(() => '?').join(',');
      const rmResult = await c.env.DB.prepare(
        `SELECT rm.reservation_id, rm.menu_id, rm.menu_name, rm.duration, rm.price, rm.sort_order
         FROM reservation_menus rm
         WHERE rm.reservation_id IN (${placeholders})
         ORDER BY rm.sort_order`
      ).bind(...batch).all();

      for (const rm of rmResult.results as Record<string, unknown>[]) {
        const rid = rm.reservation_id as string;
        if (!menusMap[rid]) menusMap[rid] = [];
        menusMap[rid].push({
          id: rm.menu_id as string,
          name: rm.menu_name as string,
          duration: rm.duration as number,
          price: rm.price as number,
        });
      }
    }

    for (const r of reservations) {
      const menus = menusMap[r.id as string] || [];
      (r as Record<string, unknown>).menus = menus;
      (r as Record<string, unknown>).total_duration = menus.reduce((s, m) => s + m.duration, 0);
      (r as Record<string, unknown>).total_price = menus.reduce((s, m) => s + m.price, 0);
      // Override menu_name with reservation_menus data (menu_id FK may point to placeholder)
      if (menus.length > 0) {
        (r as Record<string, unknown>).menu_name = menus.map(m => m.name).join('、');
      }
    }
  }

  return c.json({ reservations, total });
});

// GET /pending-count — Count pending (unconfirmed) reservations for badge
reservationsRoutes.get('/pending-count', async (c) => {
  const staff = c.get('staff')!;

  let query = "SELECT count(*) as count FROM reservations WHERE status = 'pending'";
  const params: string[] = [];

  if (staff.role === 'staff') {
    query += ' AND staff_id = ?';
    params.push(staff.id);
  } else {
    // manager/owner: filter by accessible stores
    const storeIds = await c.env.DB.prepare(
      'SELECT store_id FROM staff_stores WHERE staff_id = ?'
    ).bind(staff.id).all<{ store_id: string }>();
    if (storeIds.results.length > 0) {
      query += ` AND store_id IN (${storeIds.results.map(() => '?').join(',')})`;
      params.push(...storeIds.results.map(s => s.store_id));
    }
  }

  const stmt = params.length > 0
    ? c.env.DB.prepare(query).bind(...params)
    : c.env.DB.prepare(query);
  const result = await stmt.first<{ count: number }>();

  return c.json({ count: result?.count || 0 });
});

// GET /retired-staff — confirmed upcoming reservations whose assigned staff is retired (is_active = 0)
reservationsRoutes.get('/retired-staff', async (c) => {
  const staff = c.get('staff')!;

  const result = await c.env.DB.prepare(
    `SELECT r.id, r.customer_id, r.start_at, r.end_at, r.status, r.store_id, r.is_nominated, r.salonboard_reserve_id,
            c.name AS customer_name, c.phone AS customer_phone,
            s.name AS staff_name, s.nickname AS staff_nickname,
            (SELECT m.name FROM reservation_menus rm LEFT JOIN menus m ON m.id = rm.menu_id WHERE rm.reservation_id = r.id ORDER BY rm.sort_order LIMIT 1) AS menu_name,
            st.name AS store_name,
            CASE WHEN EXISTS(SELECT 1 FROM customer_line cl WHERE cl.customer_id = r.customer_id AND cl.store_id = r.store_id AND cl.line_user_id IS NOT NULL AND cl.line_user_id != '' AND cl.is_blocked = 0) THEN 1 ELSE 0 END AS has_line
     FROM reservations r
     JOIN staff s ON s.id = r.staff_id
     LEFT JOIN customers c ON c.id = r.customer_id
     LEFT JOIN stores st ON st.id = r.store_id
     WHERE s.is_active = 0 AND r.status = 'confirmed' AND r.start_at >= date('now')
       AND r.store_id IN (SELECT store_id FROM staff_stores WHERE staff_id = ?)
     ORDER BY r.start_at`
  ).bind(staff.id).all();

  return c.json({ reservations: result.results });
});

// GET /retired-staff/count — count for header badge
reservationsRoutes.get('/retired-staff/count', async (c) => {
  const staff = c.get('staff')!;

  const result = await c.env.DB.prepare(
    `SELECT count(*) as count
     FROM reservations r
     JOIN staff s ON s.id = r.staff_id
     WHERE s.is_active = 0 AND r.status = 'confirmed' AND r.start_at >= date('now')
       AND r.store_id IN (SELECT store_id FROM staff_stores WHERE staff_id = ?)`
  ).bind(staff.id).first<{ count: number }>();

  return c.json({ count: result?.count || 0 });
});

// Get reservation by ID
reservationsRoutes.get('/:id', async (c) => {
  const staff = c.get('staff')!;
  const id = c.req.param('id');

  const reservation = await c.env.DB.prepare(
    `SELECT r.*,
            c.name as customer_name, c.name_kana as customer_name_kana, c.phone as customer_phone, c.email as customer_email, c.visit_count as customer_visit_count,
            m.name as menu_name, m.duration, m.price, m.category as menu_category,
            s.name as staff_name, s.nickname as staff_nickname, s.salonboard_staff_id,
            st.salonboard_id as store_salonboard_id,
            CASE WHEN EXISTS(SELECT 1 FROM customer_line cl WHERE cl.customer_id = r.customer_id AND cl.store_id = r.store_id AND cl.line_user_id <> '' AND cl.is_blocked = 0) THEN 1 ELSE 0 END AS has_line
     FROM reservations r
     LEFT JOIN customers c ON r.customer_id = c.id
     LEFT JOIN menus m ON r.menu_id = m.id
     LEFT JOIN staff s ON r.staff_id = s.id
     LEFT JOIN stores st ON r.store_id = st.id
     WHERE r.id = ?`
  )
    .bind(id)
    .first();

  if (!reservation) {
    return c.json({ error: 'Reservation not found' }, 404);
  }

  // Check access (store-level)
  if (!await hasStoreAccess(c.env.DB, staff, reservation.store_id as string)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  // Fetch menus from reservation_menus
  const rmResult = await c.env.DB.prepare(
    `SELECT menu_id, menu_name, duration, price, sort_order
     FROM reservation_menus WHERE reservation_id = ? ORDER BY sort_order`
  ).bind(id).all();

  const menus = rmResult.results.map(rm => ({
    id: (rm as Record<string, unknown>).menu_id as string,
    name: (rm as Record<string, unknown>).menu_name as string,
    duration: (rm as Record<string, unknown>).duration as number,
    price: (rm as Record<string, unknown>).price as number,
  }));

  // Check for pending merge candidates for this customer
  const mergeCount = await c.env.DB.prepare(
    "SELECT COUNT(*) as count FROM customer_merge_candidates WHERE (line_customer_id = ? OR existing_customer_id = ?) AND status = 'pending'"
  ).bind(reservation.customer_id, reservation.customer_id).first<{ count: number }>();

  // Check consent status
  const consentRecord = await c.env.DB.prepare(
    'SELECT id FROM consent_records WHERE reservation_id = ? LIMIT 1'
  ).bind(id).first();

  const result = {
    ...reservation as Record<string, unknown>,
    menus,
    total_duration: menus.reduce((s, m) => s + m.duration, 0),
    total_price: menus.reduce((s, m) => s + m.price, 0),
    merge_candidate_count: mergeCount?.count || 0,
    has_consent: !!consentRecord,
  };

  return c.json({ reservation: result });
});

// Get consent record for a reservation
reservationsRoutes.get('/:id/consent', async (c) => {
  const staff = c.get('staff')!;
  const id = c.req.param('id');

  const record = await c.env.DB.prepare(
    `SELECT cr.*, r.store_id FROM consent_records cr
     JOIN reservations r ON cr.reservation_id = r.id
     WHERE cr.reservation_id = ?
     ORDER BY cr.agreed_at DESC LIMIT 1`
  ).bind(id).first();

  if (!record) {
    return c.json({ error: 'Consent record not found' }, 404);
  }

  if (!await hasStoreAccess(c.env.DB, staff, record.store_id as string)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  return c.json({
    consent: {
      ...record,
      template_snapshot: record.template_snapshot ? JSON.parse(record.template_snapshot as string) : null,
    },
  });
});

// Create reservation
reservationsRoutes.post('/', async (c) => {
  const staff = c.get('staff')!;
  const body = await c.req.json<{
    store_id?: string;
    customer_id: string;
    staff_id: string;
    menu_id?: string;
    menu_ids?: string[];
    menu_data?: { id?: string | null; name?: string; duration?: number; price?: number }[];
    start_at: string;
    end_at: string;
    memo?: string;
    source?: Reservation['source'];
    is_nominated?: number;
    salonboard_route?: string;
    force?: boolean;
  }>();

  // Support both menu_id (single, backward compat) and menu_ids (multiple)
  const menuIds = body.menu_ids || (body.menu_id ? [body.menu_id] : []);
  // Optional per-menu fallback data (name/duration/price) aligned with menu_ids;
  // used when an id resolves to neither menus nor staff_menus (deleted menu, staff menu with null id)
  const menuData = body.menu_data;

  if (!body.customer_id || !body.staff_id || menuIds.length === 0 || !body.start_at || !body.end_at) {
    return c.json({ error: 'Missing required fields' }, 400);
  }

  const storeId = body.store_id || staff.store_id;
  if (!storeId) {
    return c.json({ error: 'Store ID is required' }, 400);
  }

  // Check store access
  if (!await hasStoreAccess(c.env.DB, staff, storeId)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  // Staff-created reservations skip closure and business hours checks
  // (staff can book on holidays, closed days, and outside hours)

  // Load staff reservation settings (staff → store → hardcoded defaults)
  const staffSettings = await c.env.DB.prepare(
    'SELECT * FROM staff_reservation_settings WHERE staff_id = ? AND store_id = ?'
  )
    .bind(body.staff_id, storeId)
    .first<{ max_concurrent: number; accept_same_start_time: number; accept_outside_hours: number }>();

  const storeReservationSettings = await c.env.DB.prepare(
    'SELECT accept_outside_hours, max_concurrent, accept_same_start_time FROM stores WHERE id = ?'
  )
    .bind(storeId)
    .first<{ accept_outside_hours: number; max_concurrent: number; accept_same_start_time: number }>();

  // Check staff blocks (personal day-off / time blocks)
  // force=true allows staff to override block warnings
  const blocked = await isStaffBlocked(c.env.DB, body.staff_id, storeId, body.start_at, body.end_at);
  if (blocked && !body.force) {
    return c.json({ error: 'このスタッフはこの時間帯にブロックが設定されています', warning: true }, 400);
  }

  // Check for overlapping reservations based on staff settings
  // For individual staff, use staff-level setting (default 1)
  // business_hours.max_concurrent is store-level capacity, not per-staff
  const maxConcurrent = staffSettings?.max_concurrent ?? 1;
  const acceptSameStartTime = staffSettings?.accept_same_start_time ?? storeReservationSettings?.accept_same_start_time ?? 0;

  if (maxConcurrent <= 1 && !acceptSameStartTime && !body.force) {
    // Default behavior: any overlap = blocked (skip if force=true)
    const overlap = await c.env.DB.prepare(
      `SELECT id FROM reservations
       WHERE staff_id = ?
       AND status NOT IN ('cancelled', 'noshow')
       AND ((start_at < ? AND end_at > ?) OR (start_at < ? AND end_at > ?) OR (start_at >= ? AND end_at <= ?))`
    )
      .bind(
        body.staff_id,
        body.end_at,
        body.start_at,
        body.end_at,
        body.start_at,
        body.start_at,
        body.end_at
      )
      .first();

    if (overlap) {
      return c.json({ error: 'Time slot is not available' }, 400);
    }
  } else if (!body.force) {
    // Count-based check for concurrent reservations (skip if force=true)
    const concurrentCount = await c.env.DB.prepare(
      `SELECT COUNT(*) as count FROM reservations
       WHERE staff_id = ? AND start_at < ? AND end_at > ?
       AND status NOT IN ('cancelled', 'noshow')`
    )
      .bind(body.staff_id, body.end_at, body.start_at)
      .first<{ count: number }>();

    if (concurrentCount && concurrentCount.count >= maxConcurrent) {
      return c.json({ error: `このスタッフの同時予約数上限（${maxConcurrent}件）に達しています` }, 400);
    }
  }

  // Seat limit check
  const store = await c.env.DB.prepare('SELECT seat_limit, enable_seat_alert FROM stores WHERE id = ?')
    .bind(storeId).first<{ seat_limit: number; enable_seat_alert: number }>();

  if (store?.enable_seat_alert && store.seat_limit > 0) {
    const concurrent = await c.env.DB.prepare(
      `SELECT COUNT(*) as count FROM reservations
       WHERE store_id = ? AND start_at < ? AND end_at > ?
       AND status NOT IN ('cancelled', 'noshow')`
    ).bind(storeId, body.end_at, body.start_at).first<{ count: number }>();

    if (concurrent && concurrent.count >= store.seat_limit) {
      return c.json({
        error: `この時間帯の予約数が上限（${store.seat_limit}席）に達しています`,
        code: 'SEAT_LIMIT_EXCEEDED',
        current: concurrent.count,
        limit: store.seat_limit,
      }, 409);
    }
  }

  // Equipment availability check (peak simultaneous usage across all selected menus)
  const equipmentConflict = await findEquipmentConflict(
    c.env.DB,
    menuIds,
    storeId,
    body.start_at,
    body.end_at
  );
  if (equipmentConflict) {
    return c.json({
      error: `設備「${equipmentConflict.equipment_name}」が空いていません（${equipmentConflict.quantity}台中${equipmentConflict.in_use}台使用中）`,
      code: 'EQUIPMENT_UNAVAILABLE',
      equipment_name: equipmentConflict.equipment_name,
      quantity: equipmentConflict.quantity,
      in_use: equipmentConflict.in_use,
    }, 409);
  }

  const id = crypto.randomUUID();
  // Check if primary menu exists in menus table (staff_menus IDs won't match due to FK constraint)
  const primaryMenuCheck = await c.env.DB.prepare('SELECT id FROM menus WHERE id = ?').bind(menuIds[0]).first();
  let primaryMenuId = primaryMenuCheck ? menuIds[0] : null;
  if (!primaryMenuId) {
    // Staff menu: use any store menu as FK placeholder (reservation_menus has the real data)
    const fallbackMenu = await c.env.DB.prepare('SELECT id FROM menus WHERE store_id = ? AND is_active = 1 LIMIT 1')
      .bind(storeId).first<{ id: string }>();
    primaryMenuId = fallbackMenu?.id || menuIds[0];
  }

  // Determine is_new_customer at creation time (fixed snapshot)
  let isNewCustomer: number | null = null;
  if (body.customer_id) {
    const customer = await c.env.DB.prepare(
      'SELECT visit_count FROM customers WHERE id = ?'
    ).bind(body.customer_id).first<{ visit_count: number }>();
    isNewCustomer = customer ? (customer.visit_count === 0 ? 1 : 0) : null;
  }

  // Check HPB ID before INSERT to prevent race condition with VPS workers
  const salonboardEnabled = await isSalonboardEnabled(c.env.DB, storeId);
  let initialSyncStatus = 0; // default
  if (salonboardEnabled && body.source !== 'hotpepper') {
    const staffHpbRow = await c.env.DB.prepare(
      'SELECT salonboard_staff_id FROM staff WHERE id = ?'
    ).bind(body.staff_id).first<{ salonboard_staff_id: string | null }>();
    if (!staffHpbRow?.salonboard_staff_id) {
      initialSyncStatus = -2; // HPB ID未設定 — 保留
    }
  }

  await c.env.DB.prepare(
    `INSERT INTO reservations (id, store_id, customer_id, staff_id, menu_id, start_at, end_at, status, memo, source, is_new_customer, is_nominated, salonboard_route, salonboard_synced, salonboard_sync_error)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      storeId,
      body.customer_id,
      body.staff_id,
      primaryMenuId,
      body.start_at,
      body.end_at,
      body.memo || null,
      body.source || 'web',
      isNewCustomer,
      body.is_nominated ?? 1,
      body.salonboard_route || null,
      initialSyncStatus,
      initialSyncStatus === -2 ? 'HPB ID未設定' : null
    )
    .run();

  // Insert into reservation_menus
  const menuDataList: { id: string; name: string; duration: number; price: number }[] = [];
  for (let i = 0; i < menuIds.length; i++) {
    const mid = menuIds[i];
    let menuRow = await c.env.DB.prepare('SELECT name, duration, price FROM menus WHERE id = ?')
      .bind(mid).first<{ name: string; duration: number; price: number }>();
    let isStoreMenu = !!menuRow;
    if (!menuRow) {
      // Fallback: check staff_menus (personal menus)
      menuRow = await c.env.DB.prepare('SELECT name, duration, price FROM staff_menus WHERE id = ?')
        .bind(mid).first<{ name: string; duration: number; price: number }>();
    }
    const rmId = crypto.randomUUID();
    const fallback = menuData?.[i];
    const name = menuRow?.name || fallback?.name || '不明なメニュー';
    const duration = menuRow?.duration || fallback?.duration || 60;
    const price = menuRow?.price ?? fallback?.price ?? 0;
    // Use NULL for menu_id if it's a staff menu (FK constraint references menus table)
    const fkMenuId = isStoreMenu ? mid : null;
    await c.env.DB.prepare(
      `INSERT INTO reservation_menus (id, reservation_id, menu_id, menu_name, duration, price, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(rmId, id, fkMenuId, name, duration, price, i).run();
    menuDataList.push({ id: mid, name, duration, price });
  }

  // Log creation
  await insertReservationLog(c.env.DB, {
    reservationId: id,
    eventType: 'created',
    actorType: 'staff',
    actorId: staff.id,
    actorName: staff.name,
    description: 'スタッフが予約を作成しました',
    metadata: { source: body.source || 'web' },
  });

  const reservation = await c.env.DB.prepare(
    `SELECT r.*,
            c.name as customer_name,
            m.name as menu_name,
            s.name as staff_name
     FROM reservations r
     LEFT JOIN customers c ON r.customer_id = c.id
     LEFT JOIN menus m ON r.menu_id = m.id
     LEFT JOIN staff s ON r.staff_id = s.id
     WHERE r.id = ?`
  )
    .bind(id)
    .first<Reservation & { customer_name: string; menu_name: string; staff_name: string }>();

  // Insert system message into conversation thread
  if (reservation) {
    const allMenuNames = menuDataList.map(m => m.name).join('、');
    const staffData = await c.env.DB.prepare('SELECT COALESCE(nickname, name) as name FROM staff WHERE id = ?')
      .bind(body.staff_id).first<{ name: string }>();
    try {
      await insertReservationConfirmedMessage(c.env.DB, {
        storeId,
        customerId: body.customer_id,
        staffName: staffData?.name || '',
        menuName: allMenuNames || '',
        startAt: body.start_at,
      });
    } catch (e) { console.error('Failed to insert reservation message:', e); }

  // Send LINE notification to customer (reservation confirmed)
    try {
      const lineUserId = await getLineUserId(c.env.DB, body.customer_id, storeId);
      if (lineUserId) {
        const accessToken = await getStoreLineAccessToken(c.env.DB, storeId);
        if (accessToken) {
          const lineService = new LineService(accessToken);
          const startAtUtc = new Date(body.start_at);
          const startAtJst = new Date(startAtUtc.getTime() + 9 * 60 * 60 * 1000);
          const month = startAtJst.getUTCMonth() + 1;
          const day = startAtJst.getUTCDate();
          const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
          const weekday = weekdays[startAtJst.getUTCDay()];
          const hours = startAtJst.getUTCHours();
          const minutes = String(startAtJst.getUTCMinutes()).padStart(2, '0');
          const totalDuration = menuDataList.reduce((s, m) => s + m.duration, 0);
          const totalPrice = menuDataList.reduce((s, m) => s + m.price, 0);

          await lineService.sendReservationConfirmation(lineUserId, {
            date: `${month}月${day}日(${weekday})`,
            time: `${hours}:${minutes}`,
            menuName: allMenuNames || '施術',
            staffName: staffData?.name || '',
            price: totalPrice,
            duration: totalDuration,
          });
        }
      }
    } catch (error) {
      console.error('Failed to send LINE notification to customer:', error);
    }
  }

  const result = {
    ...reservation as Record<string, unknown>,
    menus: menuDataList,
    total_duration: menuDataList.reduce((s, m) => s + m.duration, 0),
    total_price: menuDataList.reduce((s, m) => s + m.price, 0),
  };

  return c.json({ reservation: result }, 201);
});

// Bulk update reservations with LiME menu names and is_new_customer flag
reservationsRoutes.put('/bulk-update-lime', requireRole('system_admin', 'owner'), async (c) => {
  const body = await c.req.json<{
    store_id: string;
    items: { date: string; time: string; name: string; menu: string; is_new: boolean; is_free?: boolean }[];
  }>();

  if (!body.store_id || !body.items?.length) {
    return c.json({ error: 'store_id and items are required' }, 400);
  }

  const storeId = body.store_id;

  // Normalize name for matching: remove [フリー] prefix, lowercase, remove all spaces
  const normalize = (s: string) => s.replace(/^[\[［]フリー[\]］]\s*/, '').toLowerCase().replace(/[\s\u3000]/g, '').trim();

  // Get date range from items
  const dates = body.items.map(i => i.date).filter(Boolean);
  const minDate = dates.sort()[0];
  const maxDate = dates.sort().reverse()[0];

  // Fetch reservations in date range with customer names
  const reservations = await c.env.DB.prepare(
    `SELECT r.id, r.customer_id, r.start_at, c.name as customer_name
     FROM reservations r
     INNER JOIN customers c ON r.customer_id = c.id
     WHERE r.store_id = ? AND r.start_at >= ? AND r.start_at < ?`
  ).bind(storeId, `${minDate}T00:00:00`, `${maxDate}T23:59:59`).all<{
    id: string; customer_id: string; start_at: string; customer_name: string;
  }>();

  // Build lookup: "date|time" -> array of { reservationId, customerId, normalizedName }
  const lookupByDateTime = new Map<string, { reservationId: string; customerId: string; normalizedName: string }[]>();
  for (const r of reservations.results) {
    const dt = new Date(r.start_at.endsWith('Z') ? r.start_at : r.start_at + 'Z');
    // Convert UTC to JST
    const jst = new Date(dt.getTime() + 9 * 60 * 60 * 1000);
    const date = jst.toISOString().slice(0, 10);
    const hh = String(jst.getHours()).padStart(2, '0');
    const mm = String(jst.getMinutes()).padStart(2, '0');
    const time = `${hh}:${mm}`;
    const dateTimeKey = `${date}|${time}`;
    const entry = { reservationId: r.id, customerId: r.customer_id, normalizedName: normalize(r.customer_name) };
    const existing = lookupByDateTime.get(dateTimeKey) || [];
    existing.push(entry);
    lookupByDateTime.set(dateTimeKey, existing);
  }

  let updated = 0;
  let visitCountUpdated = 0;
  const notFound: { date: string; time: string; name: string }[] = [];
  const matched = new Set<string>(); // track matched reservation IDs

  for (const item of body.items) {
    const dateTimeKey = `${item.date}|${item.time}`;
    const candidates = (lookupByDateTime.get(dateTimeKey) || []).filter(c => !matched.has(c.reservationId));
    const normalizedItemName = normalize(item.name);

    // 1. Exact match
    let match = candidates.find(c => c.normalizedName === normalizedItemName);

    // 2. LiME name starts with customer name (handles name+menu concatenation)
    if (!match) {
      match = candidates.find(c => c.normalizedName.length >= 2 && normalizedItemName.startsWith(c.normalizedName));
    }

    // 3. If only one candidate at this time slot, match it
    if (!match && candidates.length === 1) {
      match = candidates[0];
    }

    if (match) {
      matched.add(match.reservationId);
      await c.env.DB.prepare(
        `UPDATE reservations SET lime_menu_name = ?, is_new_customer = ?, updated_at = datetime('now') WHERE id = ?`
      ).bind(item.menu, item.is_new ? 1 : 0, match.reservationId).run();
      updated++;

      // If customer is a repeater according to LiME, ensure visit_count >= 1
      if (!item.is_new) {
        const result = await c.env.DB.prepare(
          `UPDATE customers SET visit_count = 1, updated_at = datetime('now') WHERE id = ? AND visit_count = 0`
        ).bind(match.customerId).run();
        if (result.meta.changes > 0) visitCountUpdated++;
      }
    } else {
      notFound.push({ date: item.date, time: item.time, name: item.name });
    }
  }

  return c.json({ success: true, updated, visit_count_updated: visitCountUpdated, not_found: notFound });
});

// Update reservation
reservationsRoutes.put('/:id', async (c) => {
  const staff = c.get('staff')!;
  const id = c.req.param('id');

  const reservation = await c.env.DB.prepare('SELECT * FROM reservations WHERE id = ?')
    .bind(id)
    .first<Reservation>();

  if (!reservation) {
    return c.json({ error: 'Reservation not found' }, 404);
  }

  // Check access
  if (!await hasStoreAccess(c.env.DB, staff, reservation.store_id as string)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const body = await c.req.json<{
    staff_id?: string;
    menu_id?: string;
    menu_ids?: string[];
    menu_data?: { id?: string | null; name?: string; duration?: number; price?: number }[];
    start_at?: string;
    end_at?: string;
    memo?: string;
    status?: string;
    is_new_customer?: number | null;
    hotpepper_id?: string | null;
    is_nominated?: number;
  }>();

  const updates: string[] = [];
  const values: (string | number | null)[] = [];

  if (body.status !== undefined) {
    const validStatuses = ['pending', 'confirmed', 'completed', 'cancelled', 'noshow'];
    if (validStatuses.includes(body.status)) {
      updates.push('status = ?');
      values.push(body.status);
    }
  }

  // Support both menu_id and menu_ids
  const menuIds = body.menu_ids || (body.menu_id ? [body.menu_id] : undefined);
  const menuData = body.menu_data;

  if (body.staff_id !== undefined) {
    updates.push('staff_id = ?');
    values.push(body.staff_id);
  }
  if (body.is_new_customer !== undefined) {
    updates.push('is_new_customer = ?');
    values.push(body.is_new_customer);
  }
  if (body.hotpepper_id !== undefined) {
    updates.push('hotpepper_id = ?');
    values.push(body.hotpepper_id);
    // When HPB ID is manually set, mark as synced so future changes are detected
    if (body.hotpepper_id) {
      updates.push('salonboard_reserve_id = COALESCE(salonboard_reserve_id, ?)');
      values.push(body.hotpepper_id);
      updates.push('salonboard_synced = 1');
      updates.push('salonboard_synced_at = datetime(\'now\')');
      updates.push('salonboard_synced_start_at = COALESCE(salonboard_synced_start_at, start_at)');
      updates.push('salonboard_synced_end_at = COALESCE(salonboard_synced_end_at, end_at)');
      updates.push('salonboard_synced_staff_id = COALESCE(salonboard_synced_staff_id, staff_id)');
    }
  }
  if (body.is_nominated !== undefined) {
    updates.push('is_nominated = ?');
    values.push(body.is_nominated);
  }
  if (menuIds && menuIds.length > 0) {
    // Check if primary menu exists in menus table (staff_menus IDs won't match due to FK constraint)
    const primaryMenuCheck = await c.env.DB.prepare('SELECT id FROM menus WHERE id = ?').bind(menuIds[0]).first();
    let primaryMenuId = primaryMenuCheck ? menuIds[0] : null;
    if (!primaryMenuId) {
      // Staff menu: use any store menu as FK placeholder
      const reservation = await c.env.DB.prepare('SELECT store_id FROM reservations WHERE id = ?').bind(id).first<{ store_id: string }>();
      if (reservation) {
        const fallbackMenu = await c.env.DB.prepare('SELECT id FROM menus WHERE store_id = ? AND is_active = 1 LIMIT 1')
          .bind(reservation.store_id).first<{ id: string }>();
        primaryMenuId = fallbackMenu?.id || menuIds[0];
      } else {
        primaryMenuId = menuIds[0];
      }
    }
    updates.push('menu_id = ?');
    values.push(primaryMenuId);
  }
  if (body.start_at !== undefined) {
    updates.push('start_at = ?');
    values.push(body.start_at);
  }
  if (body.end_at !== undefined) {
    updates.push('end_at = ?');
    values.push(body.end_at);
  }
  if (body.memo !== undefined) {
    updates.push('memo = ?');
    values.push(body.memo || null);
  }

  if (updates.length === 0 && !menuIds) {
    return c.json({ error: 'No updates provided' }, 400);
  }

  // Validate end_at > start_at
  const effectiveStartAt = body.start_at || reservation.start_at;
  const effectiveEndAt = body.end_at || reservation.end_at;
  if (effectiveStartAt && effectiveEndAt && effectiveEndAt <= effectiveStartAt) {
    return c.json({ error: '終了時刻は開始時刻より後に設定してください' }, 400);
  }

  // Clear salonboard_sync_error when relevant fields are re-edited so sync retries
  if (body.start_at !== undefined || body.end_at !== undefined || body.staff_id !== undefined || menuIds) {
    updates.push('salonboard_sync_error = NULL');
    // A reservation that never successfully registered (synced=-1) isn't picked up by
    // any VPS queue (registration needs synced=0; time/staff-change needs synced=1).
    // Clearing just the error left it stuck forever — requeue it for registration too.
    if (reservation.salonboard_synced === -1) {
      updates.push('salonboard_synced = 0');
    }
  }

  if (updates.length > 0) {
    updates.push("updated_at = datetime('now')");
    updates.push("reviewed_at = NULL");
    values.push(id);
    await c.env.DB.prepare(`UPDATE reservations SET ${updates.join(', ')} WHERE id = ?`)
      .bind(...values)
      .run();
  }

  // Update reservation_menus if menu_ids provided
  let oldMenuNames: string | null = null; // pre-update names, for change detection/notification
  let menusActuallyChanged = false;
  if (menuIds && menuIds.length > 0) {
    // Fetch existing menus before deleting so null-id entries (staff menus) can preserve their names
    const existingRm = await c.env.DB.prepare(
      'SELECT sort_order, menu_id, menu_name, duration, price FROM reservation_menus WHERE reservation_id = ? ORDER BY sort_order'
    ).bind(id).all<{ sort_order: number; menu_id: string | null; menu_name: string; duration: number; price: number }>();
    const existingByOrder = new Map(existingRm.results.map(m => [m.sort_order, m]));
    oldMenuNames = existingRm.results.map(m => m.menu_name).join('、');

    // Detect real menu changes: same count and same ids (null ids compared by position) = unchanged
    const oldIds = existingRm.results.map(m => m.menu_id);
    menusActuallyChanged = menuIds.length !== oldIds.length ||
      menuIds.some((mid, i) => (mid || null) !== (oldIds[i] || null) && !!mid);

    await c.env.DB.prepare('DELETE FROM reservation_menus WHERE reservation_id = ?')
      .bind(id).run();

    for (let i = 0; i < menuIds.length; i++) {
      const mid = menuIds[i];
      const rmId = crypto.randomUUID();

      // null id = staff menu or non-store menu; preserve the existing stored name
      if (!mid) {
        const existing = existingByOrder.get(i);
        const fallback = menuData?.[i];
        await c.env.DB.prepare(
          `INSERT INTO reservation_menus (id, reservation_id, menu_id, menu_name, duration, price, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).bind(rmId, id, null, existing?.menu_name || fallback?.name || '不明なメニュー', existing?.duration || fallback?.duration || 60, existing?.price ?? fallback?.price ?? 0, i).run();
        continue;
      }

      let isStoreMenu = true;
      let menuRow = await c.env.DB.prepare('SELECT name, duration, price FROM menus WHERE id = ?')
        .bind(mid).first<{ name: string; duration: number; price: number }>();
      if (!menuRow) {
        isStoreMenu = false;
        menuRow = await c.env.DB.prepare('SELECT name, duration, price FROM staff_menus WHERE id = ?')
          .bind(mid).first<{ name: string; duration: number; price: number }>();
      }
      const fkMenuId = isStoreMenu ? mid : null;
      await c.env.DB.prepare(
        `INSERT INTO reservation_menus (id, reservation_id, menu_id, menu_name, duration, price, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(rmId, id, fkMenuId, menuRow?.name || menuData?.[i]?.name || '不明なメニュー', menuRow?.duration || menuData?.[i]?.duration || 60, menuRow?.price ?? menuData?.[i]?.price ?? 0, i).run();
    }
  }

  // Log changes
  const changeParts: string[] = [];
  const changes: Record<string, unknown> = {};
  if (body.staff_id !== undefined && body.staff_id !== reservation.staff_id) {
    changeParts.push('担当スタッフ');
    changes.staff_id = { from: reservation.staff_id, to: body.staff_id };
  }
  if (body.start_at !== undefined && body.start_at !== reservation.start_at) {
    changeParts.push('日時');
    changes.start_at = { from: reservation.start_at, to: body.start_at };
  }
  if (body.end_at !== undefined && body.end_at !== reservation.end_at) {
    changeParts.push('終了時間');
    changes.end_at = { from: reservation.end_at, to: body.end_at };
  }
  if (menuIds && menusActuallyChanged) {
    changeParts.push('メニュー');
  }
  if (body.memo !== undefined && body.memo !== reservation.memo) {
    changeParts.push('メモ');
  }
  if (changeParts.length > 0) {
    await insertReservationLog(c.env.DB, {
      reservationId: id,
      eventType: 'updated',
      actorType: 'staff',
      actorId: staff.id,
      actorName: staff.name,
      description: `${changeParts.join('・')}を変更しました`,
      changes,
    });
  }

  // Insert system message for any reservation changes (time, menu, staff)
  if (changeParts.length > 0) {
    try {
      // Current (post-update) menu names from reservation_menus — handles staff menus with null ids too
      const currentRmMenus = await c.env.DB.prepare(
        'SELECT menu_name FROM reservation_menus WHERE reservation_id = ? ORDER BY sort_order'
      ).bind(id).all<{ menu_name: string }>();
      const newMenuName = currentRmMenus.results.length > 0
        ? currentRmMenus.results.map(m => m.menu_name).join('、')
        : (await c.env.DB.prepare('SELECT name FROM menus WHERE id = ?').bind(reservation.menu_id).first<{ name: string }>())?.name || '';
      // Old names were captured before reservation_menus was replaced
      const oldMenuName = oldMenuNames ?? newMenuName;

      const oldStaffData = await c.env.DB.prepare('SELECT COALESCE(nickname, name) as name FROM staff WHERE id = ?')
        .bind(reservation.staff_id).first<{ name: string }>();
      const newStaffData = body.staff_id && body.staff_id !== reservation.staff_id
        ? await c.env.DB.prepare('SELECT COALESCE(nickname, name) as name FROM staff WHERE id = ?').bind(body.staff_id).first<{ name: string }>()
        : oldStaffData;

      await insertReservationChangedMessage(c.env.DB, {
        storeId: reservation.store_id,
        customerId: reservation.customer_id,
        staffName: newStaffData?.name || '',
        menuName: newMenuName,
        startAt: body.start_at || reservation.start_at,
        oldStartAt: body.start_at !== undefined && body.start_at !== reservation.start_at ? reservation.start_at : undefined,
        oldMenuName: menusActuallyChanged ? oldMenuName : undefined,
        oldStaffName: body.staff_id && body.staff_id !== reservation.staff_id ? oldStaffData?.name : undefined,
      });
    } catch (e) { console.error('Failed to insert change message:', e); }
  }

  const updated = await c.env.DB.prepare(
    `SELECT r.*,
            c.name as customer_name,
            m.name as menu_name,
            s.name as staff_name
     FROM reservations r
     LEFT JOIN customers c ON r.customer_id = c.id
     LEFT JOIN menus m ON r.menu_id = m.id
     LEFT JOIN staff s ON r.staff_id = s.id
     WHERE r.id = ?`
  )
    .bind(id)
    .first();

  // Fetch updated menus
  const rmResult = await c.env.DB.prepare(
    'SELECT menu_id, menu_name, duration, price FROM reservation_menus WHERE reservation_id = ? ORDER BY sort_order'
  ).bind(id).all();

  const menus = rmResult.results.map(rm => ({
    id: (rm as Record<string, unknown>).menu_id as string,
    name: (rm as Record<string, unknown>).menu_name as string,
    duration: (rm as Record<string, unknown>).duration as number,
    price: (rm as Record<string, unknown>).price as number,
  }));

  const result = { ...updated as Record<string, unknown>, menus, total_duration: menus.reduce((s, m) => s + m.duration, 0), total_price: menus.reduce((s, m) => s + m.price, 0) };

  // Send LINE notification for time changes
  if (body.start_at !== undefined || body.end_at !== undefined) {
    try {
      const lineUserId = await getLineUserId(c.env.DB, reservation.customer_id, reservation.store_id);
      if (lineUserId) {
        const accessToken = await getStoreLineAccessToken(c.env.DB, reservation.store_id);
        if (accessToken) {
          const lineService = new LineService(accessToken);
          const rmMenus = await c.env.DB.prepare(
            'SELECT menu_name FROM reservation_menus WHERE reservation_id = ? ORDER BY sort_order'
          ).bind(id).all<{ menu_name: string }>();
          const menuData = rmMenus.results.length > 0
            ? { name: rmMenus.results.map(m => m.menu_name).join('、') }
            : await c.env.DB.prepare('SELECT name FROM menus WHERE id = ?').bind(reservation.menu_id).first<{ name: string }>();
          const staffData = await c.env.DB.prepare('SELECT COALESCE(nickname, name) as name FROM staff WHERE id = ?')
            .bind(body.staff_id || reservation.staff_id)
            .first<{ name: string }>();
          const newStartAt = body.start_at || reservation.start_at;
          const startAtUtc = new Date(newStartAt);
          const startAtJst = new Date(startAtUtc.getTime() + 9 * 60 * 60 * 1000);
          const month = startAtJst.getUTCMonth() + 1;
          const day = startAtJst.getUTCDate();
          const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
          const weekday = weekdays[startAtJst.getUTCDay()];
          const hours = startAtJst.getUTCHours();
          const minutes = String(startAtJst.getUTCMinutes()).padStart(2, '0');
          await lineService.sendReservationTimeChange(lineUserId, {
            date: `${month}月${day}日(${weekday})`,
            time: `${hours}:${minutes}`,
            menuName: menuData?.name || '施術',
            staffName: staffData?.name || 'スタッフ',
          });
        }
      }
    } catch (error) {
      console.error('Failed to send LINE time change notification:', error);
    }
  }

  return c.json({ reservation: result });
});

// Confirm reservation
reservationsRoutes.put('/:id/confirm', async (c) => {
  const staff = c.get('staff')!;
  const id = c.req.param('id');

  const reservation = await c.env.DB.prepare('SELECT * FROM reservations WHERE id = ?')
    .bind(id)
    .first<Reservation>();

  if (!reservation) {
    return c.json({ error: 'Reservation not found' }, 404);
  }

  if (!await hasStoreAccess(c.env.DB, staff, reservation.store_id as string)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  if (reservation.status !== 'pending') {
    return c.json({ error: 'Can only confirm pending reservations' }, 400);
  }

  await c.env.DB.prepare(
    "UPDATE reservations SET status = 'confirmed', updated_at = datetime('now'), reviewed_at = NULL WHERE id = ?"
  )
    .bind(id)
    .run();

  await insertReservationLog(c.env.DB, {
    reservationId: id,
    eventType: 'confirmed',
    actorType: 'staff',
    actorId: staff.id,
    actorName: staff.name,
    description: '予約を確定しました',
  });

  // Insert system message into conversation thread
  try {
    const rmMenus = await c.env.DB.prepare(
      'SELECT menu_name FROM reservation_menus WHERE reservation_id = ? ORDER BY sort_order'
    ).bind(id).all<{ menu_name: string }>();
    const menuName = rmMenus.results.length > 0
      ? rmMenus.results.map(m => m.menu_name).join('、')
      : (await c.env.DB.prepare('SELECT name FROM menus WHERE id = ?').bind(reservation.menu_id).first<{ name: string }>())?.name || '';
    const staffData = await c.env.DB.prepare('SELECT COALESCE(nickname, name) as name FROM staff WHERE id = ?')
      .bind(reservation.staff_id).first<{ name: string }>();
    await insertReservationConfirmedMessage(c.env.DB, {
      storeId: reservation.store_id,
      customerId: reservation.customer_id,
      staffName: staffData?.name || '',
      menuName,
      startAt: reservation.start_at,
    });
  } catch (e) { console.error('Failed to insert confirmation message:', e); }

  // Send LINE notification to customer
  try {
    const lineUserId = await getLineUserId(c.env.DB, reservation.customer_id, reservation.store_id);
    console.log('[Confirm] LINE user ID:', lineUserId, 'for customer:', reservation.customer_id);

    if (lineUserId) {
      const accessToken = await getStoreLineAccessToken(c.env.DB, reservation.store_id);
      console.log('[Confirm] Access token exists:', !!accessToken, 'for store:', reservation.store_id);

      if (accessToken) {
        const lineService = new LineService(accessToken);

        // Get menu and staff info for the notification
        const rmMenus = await c.env.DB.prepare(
          'SELECT menu_name, price, duration FROM reservation_menus WHERE reservation_id = ? ORDER BY sort_order'
        ).bind(id).all<{ menu_name: string; price: number; duration: number }>();
        const menuData = rmMenus.results.length > 0
          ? { name: rmMenus.results.map(m => m.menu_name).join('、'), price: rmMenus.results.reduce((s, m) => s + m.price, 0), duration: rmMenus.results.reduce((s, m) => s + m.duration, 0) }
          : await c.env.DB.prepare('SELECT name, price, duration FROM menus WHERE id = ?').bind(reservation.menu_id).first<{ name: string; price: number; duration: number }>();
        const staffData = await c.env.DB.prepare('SELECT COALESCE(nickname, name) as name FROM staff WHERE id = ?')
          .bind(reservation.staff_id)
          .first<{ name: string }>();

        // Format date for display (convert to JST)
        const startAtUtc = new Date(reservation.start_at);
        // Convert to JST by adding 9 hours
        const startAtJst = new Date(startAtUtc.getTime() + 9 * 60 * 60 * 1000);
        const month = startAtJst.getUTCMonth() + 1;
        const day = startAtJst.getUTCDate();
        const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
        const weekday = weekdays[startAtJst.getUTCDay()];
        const hours = startAtJst.getUTCHours();
        const minutes = String(startAtJst.getUTCMinutes()).padStart(2, '0');

        const customerUrl = c.env.CUSTOMER_APP_URL || 'https://example.com';
        const counselingUrl = `${customerUrl}/mypage/counseling`;

        console.log('[Confirm] Sending LINE notification...');
        await lineService.sendReservationConfirmation(lineUserId, {
          date: `${month}月${day}日(${weekday})`,
          time: `${hours}:${minutes}`,
          menuName: menuData?.name || '施術',
          staffName: staffData?.name || 'スタッフ',
          price: menuData?.price || 0,
          duration: menuData?.duration || 0,
        }, counselingUrl);
        console.log('[Confirm] LINE notification sent successfully');
      }
    }
  } catch (error) {
    console.error('Failed to send LINE notification:', error);
    // Don't fail the request if LINE notification fails
  }

  // Auto-create karute on confirm
  const existingKarute = await c.env.DB.prepare(
    'SELECT id FROM karutes WHERE reservation_id = ?'
  ).bind(id).first();

  if (!existingKarute && reservation.customer_id) {
    const karuteId = crypto.randomUUID();
    const visitDate = reservation.start_at
      ? (reservation.start_at as string).split('T')[0]
      : new Date().toISOString().split('T')[0];

    await c.env.DB.prepare(
      `INSERT INTO karutes (id, store_id, customer_id, reservation_id, staff_id, visit_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
    )
      .bind(
        karuteId,
        reservation.store_id,
        reservation.customer_id,
        id,
        reservation.staff_id,
        visitDate
      )
      .run();
  }

  // Sync to Salonboard if enabled (do this asynchronously, don't wait)
  try {
    const salonboardEnabled = await isSalonboardEnabled(c.env.DB, reservation.store_id);
    if (salonboardEnabled && reservation.source !== 'hotpepper') {
      const db = c.env.DB;

      // Check if the staff has a salonboard_staff_id (already checked at INSERT for initialSyncStatus)
      const staffRow = await db.prepare(
        'SELECT salonboard_staff_id FROM staff WHERE id = ?'
      ).bind(reservation.staff_id).first<{ salonboard_staff_id: string | null }>();

      if (!staffRow?.salonboard_staff_id) {
        // Already set to -2 at INSERT time — just log
        await insertReservationLog(db, {
          reservationId: id, eventType: 'salonboard_sync_error', actorType: 'system',
          actorName: 'サロンボード', description: '担当スタッフのHPB IDが未設定のため、サロンボード連携を保留しました',
        });
      }
      // Registration itself is handled by the store's VPS worker, which polls
      // /api/salonboard/pending (salonboard_synced = 0). The legacy direct call to
      // the Browser Rendering worker was removed: it raced the VPS and its failures
      // (Result unclear / Navigation timeout) marked reservations -1 before the VPS
      // ever saw them.
    }
  } catch (error) {
    console.error('Failed to check salonboard status:', error);
  }

  return c.json({ success: true, status: 'confirmed' });
});

// Complete reservation
reservationsRoutes.put('/:id/complete', async (c) => {
  const staff = c.get('staff')!;
  const id = c.req.param('id');

  const reservation = await c.env.DB.prepare('SELECT * FROM reservations WHERE id = ?')
    .bind(id)
    .first<Reservation>();

  if (!reservation) {
    return c.json({ error: 'Reservation not found' }, 404);
  }

  if (!await hasStoreAccess(c.env.DB, staff, reservation.store_id as string)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  await c.env.DB.prepare(
    "UPDATE reservations SET status = 'completed', updated_at = datetime('now'), reviewed_at = NULL WHERE id = ?"
  )
    .bind(id)
    .run();

  await insertReservationLog(c.env.DB, {
    reservationId: id,
    eventType: 'completed',
    actorType: 'staff',
    actorId: staff.id,
    actorName: staff.name,
    description: '施術完了にしました',
  });

  // Update customer visit stats
  await c.env.DB.prepare(
    `UPDATE customers SET
       visit_count = visit_count + 1,
       last_visit_at = datetime('now'),
       first_visit_at = COALESCE(first_visit_at, datetime('now')),
       updated_at = datetime('now')
     WHERE id = ?`
  )
    .bind(reservation.customer_id)
    .run();

  // Auto-create karute if not already created (e.g. confirmed without karute)
  const existingKarute = await c.env.DB.prepare(
    'SELECT id FROM karutes WHERE reservation_id = ?'
  ).bind(id).first();

  if (!existingKarute && reservation.customer_id) {
    const karuteId = crypto.randomUUID();
    const visitDate = reservation.start_at
      ? (reservation.start_at as string).split('T')[0]
      : new Date().toISOString().split('T')[0];

    await c.env.DB.prepare(
      `INSERT INTO karutes (id, store_id, customer_id, reservation_id, staff_id, visit_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
    )
      .bind(
        karuteId,
        reservation.store_id,
        reservation.customer_id,
        id,
        reservation.staff_id,
        visitDate
      )
      .run();
  }

  return c.json({ success: true, status: 'completed' });
});

// Cancel reservation
reservationsRoutes.put('/:id/cancel', async (c) => {
  const staff = c.get('staff')!;
  const id = c.req.param('id');

  const reservation = await c.env.DB.prepare('SELECT * FROM reservations WHERE id = ?')
    .bind(id)
    .first<Reservation>();

  if (!reservation) {
    return c.json({ error: 'Reservation not found' }, 404);
  }

  if (!await hasStoreAccess(c.env.DB, staff, reservation.store_id as string)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const body = await c.req.json<{ cancel_reason?: string }>();

  await c.env.DB.prepare(
    "UPDATE reservations SET status = 'cancelled', cancel_reason = ?, updated_at = datetime('now'), reviewed_at = NULL WHERE id = ?"
  )
    .bind(body.cancel_reason || null, id)
    .run();

  await insertReservationLog(c.env.DB, {
    reservationId: id,
    eventType: 'cancelled',
    actorType: 'staff',
    actorId: staff.id,
    actorName: staff.name,
    description: 'スタッフが予約をキャンセルしました',
    metadata: body.cancel_reason ? { cancel_reason: body.cancel_reason } : null,
  });

  // Send LINE notification to customer
  try {
    const lineUserId = await getLineUserId(c.env.DB, reservation.customer_id, reservation.store_id);
    if (lineUserId) {
      const accessToken = await getStoreLineAccessToken(c.env.DB, reservation.store_id);
      if (accessToken) {
        const lineService = new LineService(accessToken);

        // Get menu info for the notification
        const rmMenusCancel = await c.env.DB.prepare(
          'SELECT menu_name FROM reservation_menus WHERE reservation_id = ? ORDER BY sort_order'
        ).bind(id).all<{ menu_name: string }>();
        const menuData = rmMenusCancel.results.length > 0
          ? { name: rmMenusCancel.results.map(m => m.menu_name).join('、') }
          : await c.env.DB.prepare('SELECT name FROM menus WHERE id = ?').bind(reservation.menu_id).first<{ name: string }>();

        // Format date for display (convert to JST)
        const startAtUtc = new Date(reservation.start_at);
        // Convert to JST by adding 9 hours
        const startAtJst = new Date(startAtUtc.getTime() + 9 * 60 * 60 * 1000);
        const month = startAtJst.getUTCMonth() + 1;
        const day = startAtJst.getUTCDate();
        const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
        const weekday = weekdays[startAtJst.getUTCDay()];
        const hours = startAtJst.getUTCHours();
        const minutes = String(startAtJst.getUTCMinutes()).padStart(2, '0');

        // cancel_reason is internal staff memo — never sent to the customer
        await lineService.sendReservationCancellation(lineUserId, {
          date: `${month}月${day}日(${weekday})`,
          time: `${hours}:${minutes}`,
          menuName: menuData?.name || '施術',
        });
      }
    }
  } catch (error) {
    console.error('Failed to send LINE notification:', error);
    // Don't fail the request if LINE notification fails
  }

  return c.json({ success: true, status: 'cancelled' });
});

// Mark as no-show
reservationsRoutes.put('/:id/noshow', async (c) => {
  const staff = c.get('staff')!;
  const id = c.req.param('id');

  const reservation = await c.env.DB.prepare('SELECT * FROM reservations WHERE id = ?')
    .bind(id)
    .first<Reservation>();

  if (!reservation) {
    return c.json({ error: 'Reservation not found' }, 404);
  }

  if (!await hasStoreAccess(c.env.DB, staff, reservation.store_id as string)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  await c.env.DB.prepare(
    "UPDATE reservations SET status = 'noshow', updated_at = datetime('now'), reviewed_at = NULL WHERE id = ?"
  )
    .bind(id)
    .run();

  await insertReservationLog(c.env.DB, {
    reservationId: id,
    eventType: 'noshow',
    actorType: 'staff',
    actorId: staff.id,
    actorName: staff.name,
    description: '無断キャンセルにしました',
  });

  return c.json({ success: true, status: 'noshow' });
});

// Mark reservation as reviewed
reservationsRoutes.put('/:id/review', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare(
    "UPDATE reservations SET reviewed_at = datetime('now') WHERE id = ?"
  ).bind(id).run();
  return c.json({ success: true });
});

// Manually sync reservation to Salonboard
reservationsRoutes.post('/:id/sync-salonboard', async (c) => {
  const staff = c.get('staff')!;
  const id = c.req.param('id');

  const reservation = await c.env.DB.prepare('SELECT * FROM reservations WHERE id = ?')
    .bind(id)
    .first<Reservation>();

  if (!reservation) {
    return c.json({ error: 'Reservation not found' }, 404);
  }

  if (!await hasStoreAccess(c.env.DB, staff, reservation.store_id as string)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  if (reservation.source === 'hotpepper') {
    return c.json({ error: 'HPB経由の予約はサロンボードに連携できません' }, 400);
  }

  if (reservation.status !== 'confirmed') {
    return c.json({ error: '確定済みの予約のみ連携可能です' }, 400);
  }

  const salonboardEnabled = await isSalonboardEnabled(c.env.DB, reservation.store_id);
  if (!salonboardEnabled) {
    return c.json({ error: 'サロンボード連携が有効になっていません' }, 400);
  }

  // Queue for the store's VPS worker (polls salonboard_synced = 0 every ~30s).
  // If SB may already have this reservation (previous unclear attempt), use
  // verification (synced = 2) instead to avoid duplicates — see /sb-retry.
  await c.env.DB.prepare(
    "UPDATE reservations SET salonboard_synced = 0, salonboard_sync_error = NULL, updated_at = datetime('now') WHERE id = ?"
  ).bind(id).run();

  await insertReservationLog(c.env.DB, {
    reservationId: id,
    eventType: 'salonboard_sync_requested',
    actorType: 'staff',
    actorId: staff.id,
    actorName: staff.name,
    description: 'サロンボード連携をリクエストしました（VPSが数分以内に処理します）',
  });

  return c.json({
    success: true,
    message: 'サロンボード連携をキューに入れました。数分以内に反映されます。',
  });
});

// Bulk import reservations from CSV data (system_admin, owner)
reservationsRoutes.post('/import', requireRole('system_admin', 'owner'), async (c) => {
  const body = await c.req.json<{
    store_id: string;
    reservations: {
      status: string; // 受付待ち, サロンキャンセル, お客様キャンセル
      hotpepper_id: string; // 予約番号
      staff_name: string; // スタッフ名
      equipment_name?: string; // 設備名称
      visit_date: string; // YYYYMMDD
      start_time: string; // HHMM
      end_time: string; // HHMM
      duration: number; // minutes
      source: string; // 予約経路
      menu_category?: string; // 予約時メニューカテゴリ
      menu_name?: string; // 予約時メニュー
      coupon_name?: string; // HPBクーポン名
      customer_name_kana?: string; // フリガナ
      customer_name: string; // お名前
      customer_phone?: string; // 電話番号
      customer_number?: string; // お客様番号
      amount?: number; // 予約時合計金額
      nomination_type?: string; // 指名区分（指名, フリー etc.）
      memo?: string; // ご要望
    }[];
  }>();

  if (!body.store_id || !body.reservations?.length) {
    return c.json({ error: 'store_id and reservations are required' }, 400);
  }

  const staff = c.get('staff')!;
  const storeId = body.store_id;

  // Staff name mapping (CSV name → staff ID)
  // Normalize: lowercase, remove all spaces (full-width and half-width)
  const normalizeStaffName = (name: string) => name.toLowerCase().replace(/[\s\u3000]/g, '').trim();

  const allStaff = await c.env.DB.prepare(
    `SELECT DISTINCT s.id, s.name, s.nickname, s.salonboard_name
     FROM staff s
     LEFT JOIN staff_stores ss ON s.id = ss.staff_id
     WHERE s.store_id = ? OR ss.store_id = ?`
  ).bind(storeId, storeId).all<{ id: string; name: string; nickname: string | null; salonboard_name: string | null }>();

  const staffMap: Record<string, string> = {};
  for (const s of allStaff.results) {
    // salonboard_name takes priority, then nickname, then name
    if (s.salonboard_name) {
      staffMap[normalizeStaffName(s.salonboard_name)] = s.id;
    }
    if (s.nickname) {
      staffMap[normalizeStaffName(s.nickname)] = s.id;
    }
    staffMap[normalizeStaffName(s.name)] = s.id;
  }

  // Load existing menus for matching
  const existingMenus = await c.env.DB.prepare(
    'SELECT id, name, category, duration, price FROM menus WHERE store_id = ?'
  ).bind(storeId).all<{ id: string; name: string; category: string; duration: number; price: number }>();

  // Normalize menu name: replace \ and / with ¥ for matching
  const normalizeMenuName = (name: string) => name.replace(/[\\\/]/g, '¥').trim();

  const menuByName: Record<string, string> = {};
  const menuByNormalized: Record<string, { id: string; name: string; duration: number; price: number }> = {};
  for (const m of existingMenus.results) {
    menuByName[m.name] = m.id;
    menuByNormalized[normalizeMenuName(m.name)] = m;
  }

  // Create a placeholder menu for reservations without menu info
  let placeholderMenuId = menuByName['（メニュー未設定）'];
  if (!placeholderMenuId) {
    placeholderMenuId = crypto.randomUUID();
    await c.env.DB.prepare(
      `INSERT INTO menus (id, store_id, category, name, duration, price, is_active)
       VALUES (?, ?, '未分類', '（メニュー未設定）', 60, 0, 0)`
    ).bind(placeholderMenuId, storeId).run();
    menuByName['（メニュー未設定）'] = placeholderMenuId;
  }

  // Source mapping
  const sourceMapping: Record<string, string> = {
    'HOT PEPPER Beauty': 'hotpepper',
    'ホットペッパービューティー': 'hotpepper',
    '電話(自社)': 'phone',
    '電話（自社）': 'phone',
    '電話': 'phone',
    'LINE': 'line',
    '次回予約': 'phone',
    'ネイリー': 'web',
    'minimo': 'minimo',
    'Instagram': 'web',
    'SNS': 'web',
    'WEB(自社)': 'web',
    'WEB（自社）': 'web',
    'クーポンサイト': 'web',
    'その他': 'walk-in',
    '友人': 'walk-in',
    '練習モデル': 'walk-in',
    '飛び込み': 'walk-in',
    '紹介': 'walk-in',
  };

  // Status mapping
  const statusMapping: Record<string, string> = {
    '確認待ち': 'pending',
    '受付待ち': 'confirmed',
    '施術中': 'confirmed',
    'お客様キャンセル': 'cancelled',
    'サロンキャンセル': 'cancelled',
    '無断キャンセル': 'noshow',
  };

  // Customer cache: name+phone → customer_id
  const customerCache: Record<string, string> = {};

  // Load existing customers
  const existingCustomers = await c.env.DB.prepare(
    'SELECT id, name, name_kana, phone FROM customers WHERE store_id = ?'
  ).bind(storeId).all<{ id: string; name: string; name_kana: string | null; phone: string | null }>();

  for (const cust of existingCustomers.results) {
    const key = `${cust.name}|${cust.phone || ''}`;
    customerCache[key] = cust.id;
  }

  const results: {
    imported: number;
    skipped: number;
    errors: { row: number; hotpepper_id: string; error: string }[];
    customers_created: number;
    menus_created: number;
    staff_created: number;
  } = {
    imported: 0,
    skipped: 0,
    errors: [],
    customers_created: 0,
    menus_created: 0,
    staff_created: 0,
  };

  for (let i = 0; i < body.reservations.length; i++) {
    const row = body.reservations[i];

    try {
      // Skip if already imported (check by hotpepper_id or minimo_id)
      const isMinimoRow = (sourceMapping[row.source] || 'web') === 'minimo';
      const existing = isMinimoRow
        ? await c.env.DB.prepare('SELECT id FROM reservations WHERE minimo_id = ?').bind(row.hotpepper_id).first()
        : await c.env.DB.prepare('SELECT id FROM reservations WHERE hotpepper_id = ?').bind(row.hotpepper_id).first();

      if (existing) {
        results.skipped++;
        continue;
      }

      // Map staff (normalize name, auto-create if not found)
      const normalizedName = normalizeStaffName(row.staff_name);
      let staffId = staffMap[normalizedName];

      if (!staffId) {
        // Try partial match (CSV name contains DB name or vice versa)
        const partialMatch = Object.entries(staffMap).find(([dbName]) =>
          normalizedName.includes(dbName) || dbName.includes(normalizedName)
        );
        if (partialMatch) {
          staffId = partialMatch[1];
        }
      }

      if (!staffId) {
        // Auto-create staff
        staffId = crypto.randomUUID();
        const displayName = row.staff_name.replace(/\u3000/g, ' ').trim();
        await c.env.DB.prepare(
          `INSERT INTO staff (id, store_id, name, email, password_hash, role, is_active)
           VALUES (?, ?, ?, ?, '', 'staff', 1)`
        ).bind(staffId, storeId, displayName, `csv-${staffId}@placeholder.local`).run();
        staffMap[normalizedName] = staffId;
        results.staff_created++;
      }

      // Find or create customer
      const custName = row.customer_name.replace(/\s+/g, '');
      // CSV phone numbers may be missing leading 0
      const rawPhone = row.customer_phone || '';
      const custPhone = rawPhone && !rawPhone.startsWith('0') ? `0${rawPhone}` : rawPhone;
      const custKey = `${custName}|${custPhone}`;

      let customerId = customerCache[custKey];
      if (!customerId) {
        // Also try matching by name only (for phone bookings without phone numbers)
        if (!custPhone) {
          const nameOnlyMatch = Object.entries(customerCache).find(
            ([key]) => key.startsWith(`${custName}|`)
          );
          if (nameOnlyMatch) {
            customerId = nameOnlyMatch[1];
          }
        }
      }

      if (!customerId) {
        customerId = crypto.randomUUID();
        const nameKana = row.customer_name_kana && row.customer_name_kana !== 'ヨヤクアリ'
          ? row.customer_name_kana.replace(/\s+/g, '')
          : null;
        await c.env.DB.prepare(
          `INSERT INTO customers (id, store_id, name, name_kana, phone)
           VALUES (?, ?, ?, ?, ?)`
        ).bind(customerId, storeId, custName, nameKana, custPhone || null).run();
        customerCache[custKey] = customerId;
        results.customers_created++;
      }

      // Find or create menus (split by ＋ for multiple menus)
      const rawMenuName = row.menu_name || row.coupon_name;
      const menuNames = rawMenuName
        ? rawMenuName.split('＋').map((n: string) => n.trim()).filter(Boolean)
        : [];

      // Split categories by ＋ to match with each menu
      const categories = row.menu_category
        ? row.menu_category.split('＋').map((c: string) => c.trim()).filter(Boolean)
        : [];

      const resolvedMenus: { id: string; name: string; duration: number; price: number }[] = [];

      for (let mi = 0; mi < menuNames.length; mi++) {
        const singleMenuName = menuNames[mi];
        const normalized = normalizeMenuName(singleMenuName);

        // Try exact match first
        let foundMenu = menuByNormalized[normalized];

        // Try partial match if no exact match
        if (!foundMenu) {
          const partialMatch = existingMenus.results.find(m =>
            normalized.includes(normalizeMenuName(m.name)) || normalizeMenuName(m.name).includes(normalized)
          );
          if (partialMatch) {
            foundMenu = partialMatch;
          }
        }

        if (foundMenu) {
          resolvedMenus.push(foundMenu);
        } else {
          // Create menu if not found
          const newMenuId = crypto.randomUUID();
          const category = categories[mi] || categories[categories.length - 1] || '未分類';
          const durationPerMenu = menuNames.length > 1 ? Math.round(row.duration / menuNames.length) : row.duration;
          const couponType = category.includes('新規') ? 'new' : null;
          await c.env.DB.prepare(
            `INSERT INTO menus (id, store_id, category, name, duration, price, is_active, coupon_type)
             VALUES (?, ?, ?, ?, ?, 0, 1, ?)`
          ).bind(newMenuId, storeId, category, singleMenuName, durationPerMenu, couponType).run();
          const newMenu = { id: newMenuId, name: singleMenuName, duration: durationPerMenu, price: 0 };
          menuByName[singleMenuName] = newMenuId;
          menuByNormalized[normalized] = newMenu;
          existingMenus.results.push({ ...newMenu, category });
          resolvedMenus.push(newMenu);
          results.menus_created++;
        }
      }

      // Use first menu as primary menu_id (fallback to placeholder)
      const primaryMenuId = resolvedMenus.length > 0 ? resolvedMenus[0].id : placeholderMenuId;

      // Build datetime strings (YYYYMMDD + HHMM → UTC ISO string)
      // Convert JST to UTC for consistency with other reservation sources
      const d = row.visit_date;
      const dateStr = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;

      const startH = row.start_time.padStart(4, '0');
      const startAt = new Date(`${dateStr}T${startH.slice(0, 2)}:${startH.slice(2, 4)}:00+09:00`).toISOString();

      const endH = row.end_time.padStart(4, '0');
      const endAt = new Date(`${dateStr}T${endH.slice(0, 2)}:${endH.slice(2, 4)}:00+09:00`).toISOString();

      const status = statusMapping[row.status] || 'confirmed';
      const source = sourceMapping[row.source] || 'web';
      const isNominated = row.nomination_type && row.nomination_type !== 'フリー' ? 1 : 0;

      const reservationId = crypto.randomUUID();

      // Determine is_new_customer at creation time
      const hpbCust = customerId
        ? await c.env.DB.prepare('SELECT visit_count FROM customers WHERE id = ?')
            .bind(customerId).first<{ visit_count: number }>()
        : null;
      const hpbIsNew = hpbCust ? (hpbCust.visit_count === 0 ? 1 : 0) : null;

      const hpbId = isMinimoRow ? null : row.hotpepper_id;
      await c.env.DB.prepare(
        `INSERT INTO reservations (id, store_id, customer_id, staff_id, menu_id, start_at, end_at, status, memo, source, hotpepper_id, minimo_id, is_nominated, is_new_customer, salonboard_reserve_id, salonboard_synced, salonboard_synced_staff_id, salonboard_synced_start_at, salonboard_synced_end_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        reservationId,
        storeId,
        customerId,
        staffId,
        primaryMenuId,
        startAt,
        endAt,
        status,
        row.memo || null,
        source,
        hpbId,
        isMinimoRow ? row.hotpepper_id : null,
        isNominated,
        hpbIsNew,
        hpbId,       // salonboard_reserve_id = hotpepper_id (YG ID)
        hpbId ? 1 : 0,  // salonboard_synced = 1 (already exists on Salonboard)
        hpbId ? staffId : null,  // salonboard_synced_staff_id for change detection
        hpbId ? startAt : null,  // salonboard_synced_start_at for time change detection
        hpbId ? endAt : null     // salonboard_synced_end_at for time change detection
      ).run();

      // Insert into reservation_menus junction table
      const menusToInsert = resolvedMenus.length > 0 ? resolvedMenus : [{ id: placeholderMenuId, name: '（メニュー未設定）', duration: 60, price: 0 }];
      for (let j = 0; j < menusToInsert.length; j++) {
        const m = menusToInsert[j];
        await c.env.DB.prepare(
          `INSERT INTO reservation_menus (id, reservation_id, menu_id, menu_name, duration, price, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).bind(crypto.randomUUID(), reservationId, m.id, m.name, m.duration, m.price, j).run();
      }

      await insertReservationLog(c.env.DB, {
        reservationId,
        eventType: 'imported',
        actorType: 'staff',
        actorId: staff.id,
        actorName: staff.name,
        description: 'CSVインポートで作成されました',
        metadata: { source, hotpepper_id: row.hotpepper_id },
      });

      results.imported++;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      results.errors.push({ row: i + 1, hotpepper_id: row.hotpepper_id, error: message });
    }
  }

  return c.json({
    success: true,
    results,
  });
});

// Get reservation activity logs
reservationsRoutes.get('/:id/logs', async (c) => {
  const staff = c.get('staff')!;
  const id = c.req.param('id');

  const reservation = await c.env.DB.prepare(
    'SELECT store_id, staff_id FROM reservations WHERE id = ?'
  ).bind(id).first<{ store_id: string; staff_id: string }>();

  if (!reservation) {
    return c.json({ error: 'Reservation not found' }, 404);
  }

  if (!await hasStoreAccess(c.env.DB, staff, reservation.store_id)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const logs = await c.env.DB.prepare(`
    SELECT * FROM reservation_logs WHERE reservation_id = ? ORDER BY created_at ASC
  `).bind(id).all();

  const results = logs.results.map((log: Record<string, unknown>) => ({
    ...log,
    changes: log.changes ? JSON.parse(log.changes as string) : null,
    metadata: log.metadata ? JSON.parse(log.metadata as string) : null,
  }));

  return c.json({ logs: results });
});

// POST /sb-verify — Mark failed reservations for Salonboard YG ID verification
reservationsRoutes.post('/sb-verify', requireRole('system_admin', 'owner'), async (c) => {
  const body = await c.req.json<{ store_id: string; start_date: string; end_date: string }>();
  const { store_id, start_date, end_date } = body;

  if (!store_id || !start_date || !end_date) {
    return c.json({ error: 'store_id, start_date, end_date required' }, 400);
  }

  // Mark failed reservations (synced = -1) without YG ID as pending verification (synced = 2)
  const result = await c.env.DB.prepare(`
    UPDATE reservations
    SET salonboard_synced = 2
    WHERE store_id = ?
      AND salonboard_synced = -1
      AND salonboard_reserve_id IS NULL
      AND status = 'confirmed'
      AND start_at >= ?
      AND start_at < ?
      AND source != 'hotpepper'
  `).bind(store_id, `${start_date}T00:00:00.000Z`, `${end_date}T23:59:59.999Z`).run();

  return c.json({ success: true, marked: result.meta.changes });
});

// POST /sb-clear-error/:id — SB連携エラーのみクリア（時間変更・スタッフ変更の再試行用）
reservationsRoutes.post('/sb-clear-error/:id', requireRole('system_admin', 'owner', 'manager'), async (c) => {
  const id = c.req.param('id');
  const result = await c.env.DB.prepare(`
    UPDATE reservations
    SET salonboard_sync_error = NULL,
        updated_at = datetime('now')
    WHERE id = ? AND status != 'cancelled'
  `).bind(id).run();
  return c.json({ success: true, updated: result.meta.changes });
});

// POST /sb-retry/:id — SB連携エラーをリセットして再連携キューに戻す
reservationsRoutes.post('/sb-retry/:id', requireRole('system_admin', 'owner', 'manager'), async (c) => {
  const id = c.req.param('id');

  const result = await c.env.DB.prepare(`
    UPDATE reservations
    SET salonboard_synced = 0,
        salonboard_sync_error = NULL,
        updated_at = datetime('now')
    WHERE id = ?
      AND status != 'cancelled'
  `).bind(id).run();

  return c.json({ success: true, updated: result.meta.changes });
});

// POST /sb-verify-single/:id — Mark a single reservation for Salonboard verification
reservationsRoutes.post('/sb-verify-single/:id', requireRole('system_admin', 'owner'), async (c) => {
  const id = c.req.param('id');

  const result = await c.env.DB.prepare(`
    UPDATE reservations
    SET salonboard_synced = 2
    WHERE id = ?
      AND status = 'confirmed'
      AND source != 'hotpepper'
  `).bind(id).run();

  return c.json({ success: true, updated: result.meta.changes });
});
