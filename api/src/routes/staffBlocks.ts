import { Hono } from 'hono';
import type { Bindings, Variables, StaffBlock } from '../types';
import { staffAuth, requireRole } from '../middleware/auth';

export const staffBlocksRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Apply auth middleware
staffBlocksRoutes.use('*', staffAuth);

// List blocks (optional staff_id; when omitted with store_id, returns all staff blocks for that store)
staffBlocksRoutes.get('/', async (c) => {
  const staff = c.get('staff')!;
  const staffIdParam = c.req.query('staff_id');
  const storeId = c.req.query('store_id');
  const dateFrom = c.req.query('date_from');
  const dateTo = c.req.query('date_to');
  const allBlocks = c.req.query('all');

  // system_admin: fetch all blocks across all stores (for system dashboard)
  if (allBlocks === '1' && (staff.role === 'system_admin' || staff.role === 'owner')) {
    let query = `
      SELECT b.*, s.name as staff_name, s.nickname as staff_nickname, st.name as store_name
      FROM staff_blocks b
      LEFT JOIN staff s ON b.staff_id = s.id
      LEFT JOIN stores st ON b.store_id = st.id
      WHERE 1=1
    `;
    const params: (string | number)[] = [];

    if (storeId) {
      query += ' AND b.store_id = ?';
      params.push(storeId);
    }
    if (dateFrom) {
      query += ' AND b.date >= ?';
      params.push(dateFrom);
    }
    if (dateTo) {
      query += ' AND b.date <= ?';
      params.push(dateTo);
    }
    if (c.req.query('sb_failed') === '1') {
      query += ' AND b.salonboard_synced = -1';
    }
    // Nearest dates first so the row cap drops the far future, not the near term
    query += ' ORDER BY b.date ASC, b.start_time ASC LIMIT 1000';

    const result = await c.env.DB.prepare(query)
      .bind(...params)
      .all();

    return c.json({ blocks: result.results });
  }

  // When no staff_id is given but store_id is present → fetch all blocks for the store
  if (!staffIdParam && storeId) {
    // Regular staff can only see their own blocks
    if (staff.role === 'staff') {
      return c.json({ error: 'Forbidden' }, 403);
    }

    let query = 'SELECT * FROM staff_blocks WHERE (store_id = ? OR store_id IS NULL)';
    const params: (string | number)[] = [storeId];

    if (dateFrom) {
      query += ' AND date >= ?';
      params.push(dateFrom);
    }
    if (dateTo) {
      query += ' AND date <= ?';
      params.push(dateTo);
    }
    query += ' ORDER BY date, start_time';

    const result = await c.env.DB.prepare(query)
      .bind(...params)
      .all<StaffBlock>();

    return c.json({ blocks: result.results });
  }

  // Default: fetch blocks for a specific staff
  const staffId = staffIdParam || staff.id;

  // Regular staff can only see their own blocks
  if (staff.role === 'staff' && staffId !== staff.id) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  let query = 'SELECT * FROM staff_blocks WHERE staff_id = ?';
  const params: (string | number)[] = [staffId];

  if (storeId) {
    query += ' AND (store_id = ? OR store_id IS NULL)';
    params.push(storeId);
  }

  if (dateFrom) {
    query += ' AND date >= ?';
    params.push(dateFrom);
  }

  if (dateTo) {
    query += ' AND date <= ?';
    params.push(dateTo);
  }

  query += ' ORDER BY date, start_time';

  const result = await c.env.DB.prepare(query)
    .bind(...params)
    .all<StaffBlock>();

  return c.json({ blocks: result.results });
});

// Create block
staffBlocksRoutes.post('/', async (c) => {
  const staff = c.get('staff')!;
  const body = await c.req.json<{
    staff_id?: string;
    store_id?: string | null;
    date: string;
    is_all_day?: boolean;
    start_time?: string;
    end_time?: string;
    reason?: string;
  }>();

  const targetStaffId = body.staff_id || staff.id;

  // Regular staff can only create their own blocks
  if (staff.role === 'staff' && targetStaffId !== staff.id) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  if (!body.date) {
    return c.json({ error: '日付は必須です' }, 400);
  }

  const isAllDay = body.is_all_day !== false; // default true

  if (!isAllDay && (!body.start_time || !body.end_time)) {
    return c.json({ error: '時間帯ブロックの場合、開始時間と終了時間は必須です' }, 400);
  }

  if (!isAllDay && body.start_time! >= body.end_time!) {
    return c.json({ error: '終了時間は開始時間より後に設定してください' }, 400);
  }

  const id = crypto.randomUUID();
  const storeId = body.store_id === undefined ? null : body.store_id;

  await c.env.DB.prepare(
    `INSERT INTO staff_blocks (id, staff_id, store_id, date, is_all_day, start_time, end_time, reason, salonboard_synced)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      targetStaffId,
      storeId,
      body.date,
      isAllDay ? 1 : 0,
      isAllDay ? null : body.start_time!,
      isAllDay ? null : body.end_time!,
      body.reason || null,
      isAllDay ? 1 : 0  // all-dayはSB連携不要(=1扱い), time blockは連携待ち(=0)
    )
    .run();

  const block = await c.env.DB.prepare('SELECT * FROM staff_blocks WHERE id = ?')
    .bind(id)
    .first<StaffBlock>();

  return c.json({ block }, 201);
});

// Sync all-day blocks for a month (bulk add/remove)
staffBlocksRoutes.put('/sync', async (c) => {
  const staff = c.get('staff')!;
  const body = await c.req.json<{
    staff_id?: string;
    store_id?: string;
    month: string; // "2026-03"
    dates: string[]; // ["2026-03-05", "2026-03-12"]
  }>();

  const targetStaffId = body.staff_id || staff.id;

  if (staff.role === 'staff' && targetStaffId !== staff.id) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  if (!body.month || !/^\d{4}-\d{2}$/.test(body.month)) {
    return c.json({ error: 'month は YYYY-MM 形式で指定してください' }, 400);
  }

  const dateFrom = `${body.month}-01`;
  const [y, m] = body.month.split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  const dateTo = `${body.month}-${String(lastDay).padStart(2, '0')}`;

  const storeId = body.store_id || null;

  // Get existing all-day blocks for this month
  let query = 'SELECT * FROM staff_blocks WHERE staff_id = ? AND is_all_day = 1 AND date >= ? AND date <= ?';
  const params: (string | number | null)[] = [targetStaffId, dateFrom, dateTo];

  if (storeId) {
    query += ' AND (store_id = ? OR store_id IS NULL)';
    params.push(storeId);
  }

  const existing = await c.env.DB.prepare(query).bind(...params).all<StaffBlock>();
  const existingDates = new Set(existing.results.map((b) => b.date));
  const requestedDates = new Set(body.dates || []);

  const statements: D1PreparedStatement[] = [];

  // Add new dates
  for (const date of requestedDates) {
    if (!existingDates.has(date)) {
      const id = crypto.randomUUID();
      statements.push(
        c.env.DB.prepare(
          `INSERT INTO staff_blocks (id, staff_id, store_id, date, is_all_day, start_time, end_time, reason)
           VALUES (?, ?, ?, ?, 1, NULL, NULL, NULL)`
        ).bind(id, targetStaffId, storeId, date)
      );
    }
  }

  // Remove deselected dates
  for (const block of existing.results) {
    if (!requestedDates.has(block.date)) {
      statements.push(
        c.env.DB.prepare('DELETE FROM staff_blocks WHERE id = ?').bind(block.id)
      );
    }
  }

  if (statements.length > 0) {
    await c.env.DB.batch(statements);
  }

  // Return updated blocks for the month (filtered by store)
  let returnQuery = 'SELECT * FROM staff_blocks WHERE staff_id = ? AND date >= ? AND date <= ?';
  const returnParams: (string | number | null)[] = [targetStaffId, dateFrom, dateTo];
  if (storeId) {
    returnQuery += ' AND (store_id = ? OR store_id IS NULL)';
    returnParams.push(storeId);
  }
  returnQuery += ' ORDER BY date, start_time';
  const result = await c.env.DB.prepare(returnQuery).bind(...returnParams).all<StaffBlock>();

  return c.json({ blocks: result.results });
});

// Update block
staffBlocksRoutes.put('/:id', async (c) => {
  const staff = c.get('staff')!;
  const id = c.req.param('id');

  const block = await c.env.DB.prepare('SELECT * FROM staff_blocks WHERE id = ?')
    .bind(id)
    .first<StaffBlock>();

  if (!block) {
    return c.json({ error: 'ブロックが見つかりません' }, 404);
  }

  // Regular staff can only edit their own blocks
  if (staff.role === 'staff' && block.staff_id !== staff.id) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const body = await c.req.json<{
    date?: string;
    store_id?: string | null;
    is_all_day?: boolean;
    start_time?: string | null;
    end_time?: string | null;
    reason?: string | null;
  }>();

  const updates: string[] = [];
  const values: (string | number | null)[] = [];

  if (body.date !== undefined) {
    updates.push('date = ?');
    values.push(body.date);
  }
  if (body.store_id !== undefined) {
    updates.push('store_id = ?');
    values.push(body.store_id);
  }
  if (body.is_all_day !== undefined) {
    updates.push('is_all_day = ?');
    values.push(body.is_all_day ? 1 : 0);
    if (body.is_all_day) {
      updates.push('start_time = NULL');
      updates.push('end_time = NULL');
    }
  }
  if (body.start_time !== undefined) {
    updates.push('start_time = ?');
    values.push(body.start_time);
  }
  if (body.end_time !== undefined) {
    updates.push('end_time = ?');
    values.push(body.end_time);
  }
  if (body.reason !== undefined) {
    updates.push('reason = ?');
    values.push(body.reason);
  }

  if (updates.length === 0) {
    return c.json({ error: 'No updates provided' }, 400);
  }

  // If time/date/all-day changed on a synced block, mark for SB change sync
  const timeOrDateChanged = body.date !== undefined || body.start_time !== undefined || body.end_time !== undefined || body.is_all_day !== undefined;
  if (timeOrDateChanged && block.salonboard_synced === 1) {
    updates.push('salonboard_synced = 3');
  }

  updates.push("updated_at = datetime('now')");
  values.push(id);

  await c.env.DB.prepare(`UPDATE staff_blocks SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();

  const updated = await c.env.DB.prepare('SELECT * FROM staff_blocks WHERE id = ?')
    .bind(id)
    .first<StaffBlock>();

  return c.json({ block: updated });
});

// Delete block
staffBlocksRoutes.delete('/:id', async (c) => {
  const staff = c.get('staff')!;
  const id = c.req.param('id');

  const block = await c.env.DB.prepare('SELECT * FROM staff_blocks WHERE id = ?')
    .bind(id)
    .first<StaffBlock>();

  if (!block) {
    return c.json({ error: 'ブロックが見つかりません' }, 404);
  }

  // Regular staff can only delete their own blocks
  if (staff.role === 'staff' && block.staff_id !== staff.id) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  // If synced to Salonboard, mark for SB deletion instead of immediate delete
  if (block.salonboard_synced === 1) {
    await c.env.DB.prepare(
      "UPDATE staff_blocks SET salonboard_synced = 4, updated_at = datetime('now') WHERE id = ?"
    ).bind(id).run();
  } else {
    await c.env.DB.prepare('DELETE FROM staff_blocks WHERE id = ?').bind(id).run();
  }

  return c.json({ success: true });
});
