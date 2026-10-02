import { Hono } from 'hono';
import type { Bindings, Variables } from '../types';
import { rpiApiKeyAuth } from '../middleware/auth';
import { updateSyncStatus } from '../services/salonboardService';
import { insertReservationLog } from '../services/reservationLogService';
import { PushNotificationService } from '../services/pushService';
import { isJapaneseHoliday } from '../services/japaneseHolidays';
import { getOrCreateMaster } from '../services/customerMasterService';

const salonboardRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// All routes require RPi API key
salonboardRoutes.use('*', rpiApiKeyAuth);

/**
 * Build SQL conditions and bind values for staff_id / exclude_staff_ids filters.
 * staff_id: include only this staff's reservations
 * exclude_staff_ids: comma-separated staff IDs to exclude
 */
function buildStaffFilter(c: { req: { query: (k: string) => string | undefined } }): {
  sql: string;
  binds: string[];
} {
  const staffId = c.req.query('staff_id');
  const excludeRaw = c.req.query('exclude_staff_ids');
  let sql = '';
  const binds: string[] = [];

  if (staffId) {
    sql += ' AND r.staff_id = ?';
    binds.push(staffId);
  }

  if (excludeRaw) {
    const excludeIds = excludeRaw.split(',').map((s) => s.trim()).filter(Boolean);
    if (excludeIds.length > 0) {
      const placeholders = excludeIds.map(() => '?').join(', ');
      sql += ` AND (r.staff_id IS NULL OR r.staff_id NOT IN (${placeholders}))`;
      binds.push(...excludeIds);
    }
  }

  return { sql, binds };
}

// GET /pending — Fetch reservations pending Salonboard sync
// Optional query param: store_id (filter by single store)
salonboardRoutes.get('/pending', async (c) => {
  const storeId = c.req.query('store_id');
  const staffFilter = buildStaffFilter(c);

  // Clear stale errors: synced=1, has error, but no actual pending changes
  // (all synced values match current values)
  // Note: do NOT update updated_at to avoid affecting sort order
  await c.env.DB.prepare(`
    UPDATE reservations
    SET salonboard_sync_error = NULL
    WHERE salonboard_synced = 1
      AND salonboard_sync_error IS NOT NULL
      AND start_at = salonboard_synced_start_at
      AND end_at = salonboard_synced_end_at
      AND staff_id = salonboard_synced_staff_id
      AND status != 'cancelled'
  `).run();

  const sql = `
    SELECT
      r.id,
      r.customer_id,
      r.store_id,
      r.start_at,
      r.end_at,
      r.memo,
      c.name as customer_name,
      c.name_kana as customer_name_kana,
      c.phone as customer_phone,
      cm.member_no as member_no,
      s.salonboard_staff_id,
      mc.salonboard_equipment_id,
      COALESCE(
        (SELECT GROUP_CONCAT(rm.menu_name, ', ') FROM reservation_menus rm WHERE rm.reservation_id = r.id),
        m.name
      ) as menu_name,
      r.is_nominated,
      r.salonboard_route,
      r.source
    FROM reservations r
    JOIN customers c ON r.customer_id = c.id
    LEFT JOIN customer_master cm ON cm.id = c.master_id
    LEFT JOIN staff s ON r.staff_id = s.id
    LEFT JOIN menus m ON r.menu_id = m.id
    LEFT JOIN menu_categories mc ON m.store_id = mc.store_id AND m.category = mc.name
    JOIN stores st ON r.store_id = st.id
    WHERE r.salonboard_synced = 0
      AND r.status = 'confirmed'
      AND r.source != 'hotpepper'
      AND st.salonboard_enabled = 1
      AND s.salonboard_staff_id IS NOT NULL
      ${storeId ? 'AND r.store_id = ?' : ''}
      ${staffFilter.sql}
    ORDER BY r.created_at ASC
  `;

  const binds = [...(storeId ? [storeId] : []), ...staffFilter.binds];
  const stmt = binds.length > 0
    ? c.env.DB.prepare(sql).bind(...binds)
    : c.env.DB.prepare(sql);
  const result = await stmt.all();

  // Clamp start_at/end_at to business hours for SB registration
  const reservations = result.results || [];
  const bhCache = new Map<string, { open_time: string; close_time: string } | null>();
  const holidayFlagCache = new Map<string, boolean>();
  const outOfHoursIds = new Set<string>();
  for (const r of reservations as Record<string, unknown>[]) {
    const sid = r.store_id as string;

    // Assign a member number (会員番号) if the customer has none yet, so it can be synced to SB.
    if (!r.member_no && r.customer_id) {
      try {
        const m = await getOrCreateMaster(c.env.DB, {
          customerId: r.customer_id as string,
          phone: (r.customer_phone as string) || null,
          storeId: sid,
        });
        if (m) r.member_no = m.memberNo;
      } catch { /* non-fatal: proceed without member number */ }
    }

    // Member numbers retired by a merge: the customer may already exist in Salonboard under
    // one of these, so the VPS falls back to them when the current number finds no match
    // (and then rewrites SB's お客様番号 to the current one).
    if (r.member_no) {
      try {
        const prev = await c.env.DB.prepare(
          `WITH RECURSIVE chain(id) AS (
             SELECT id FROM customer_master WHERE member_no = ?1
             UNION
             SELECT cm.id FROM customer_master cm JOIN chain ON cm.merged_into = chain.id
           )
           SELECT cm.member_no FROM customer_master cm
           JOIN chain ON cm.id = chain.id
           WHERE cm.member_no <> ?1
           ORDER BY cm.seq DESC`
        ).bind(r.member_no as string).all<{ member_no: string }>();
        const list = (prev.results || []).map((x) => x.member_no);
        if (list.length > 0) r.previous_member_nos = list;
      } catch { /* non-fatal: proceed without aliases */ }
    }

    const startUtc = new Date(r.start_at as string);
    const jstStart = new Date(startUtc.getTime() + 9 * 60 * 60 * 1000);
    const dateStr = `${jstStart.getUTCFullYear()}-${String(jstStart.getUTCMonth()+1).padStart(2,'0')}-${String(jstStart.getUTCDate()).padStart(2,'0')}`;

    // Check holiday hours
    if (!holidayFlagCache.has(sid)) {
      const flag = await c.env.DB.prepare(
        'SELECT holiday_hours_enabled FROM stores WHERE id = ?'
      ).bind(sid).first<{ holiday_hours_enabled: number }>();
      holidayFlagCache.set(sid, !!(flag?.holiday_hours_enabled));
    }
    const holidayEnabled = holidayFlagCache.get(sid)!;
    const dateIsHoliday = isJapaneseHoliday(dateStr);
    const dow = (holidayEnabled && dateIsHoliday) ? 7 : jstStart.getUTCDay();

    const cacheKey = `${sid}_${dow}`;
    if (!bhCache.has(cacheKey)) {
      const bh = await c.env.DB.prepare(
        'SELECT open_time, close_time FROM business_hours WHERE store_id = ? AND day_of_week = ? AND is_closed = 0'
      ).bind(sid, dow).first<{ open_time: string; close_time: string }>();
      bhCache.set(cacheKey, bh || null);
    }
    const bh = bhCache.get(cacheKey);
    if (bh) {
      const startTimeStr = `${String(jstStart.getUTCHours()).padStart(2,'0')}:${String(jstStart.getUTCMinutes()).padStart(2,'0')}`;
      const endUtc = new Date(r.end_at as string);
      const jstEnd = new Date(endUtc.getTime() + 9 * 60 * 60 * 1000);
      const endTimeStr = `${String(jstEnd.getUTCHours()).padStart(2,'0')}:${String(jstEnd.getUTCMinutes()).padStart(2,'0')}`;
      // Out-of-hours reservation: instead of rejecting/clamping, instruct the VPS to
      // widen that day's business hours on SB (salonCalendarSetup) before registering.
      // HHMM values on a 30-minute grid (SB's selects only offer :00/:30 options).
      if (startTimeStr < bh.open_time || endTimeStr > bh.close_time) {
        const toM = (t: string) => parseInt(t.slice(0, 2)) * 60 + parseInt(t.slice(3, 5));
        const toHHMM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}${String(m % 60).padStart(2, '0')}`;
        const floor30 = (t: string) => toHHMM(Math.floor(toM(t) / 30) * 30);
        const ceil30 = (t: string) => toHHMM(Math.min(Math.ceil(toM(t) / 30) * 30, 23 * 60 + 30));
        r.extend_hours = {
          date: dateStr.replace(/-/g, ''),
          open: floor30(startTimeStr < bh.open_time ? startTimeStr : bh.open_time),
          close: ceil30(endTimeStr > bh.close_time ? endTimeStr : bh.close_time),
        };
      }
    }
  }

  return c.json({
    reservations: (reservations as Record<string, unknown>[]).filter((r) => !outOfHoursIds.has(r.id as string)),
  });
});

// PUT /:id/sync-status — Update Salonboard sync status
salonboardRoutes.put('/:id/sync-status', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{
    success: boolean;
    error?: string;
    // Snapshot the worker actually registered on SB (guards against mid-flight edits)
    synced_start_at?: string;
    synced_end_at?: string;
  }>();

  // Verify reservation exists
  const reservation = await c.env.DB.prepare(
    'SELECT id FROM reservations WHERE id = ?'
  ).bind(id).first();

  if (!reservation) {
    return c.json({ error: 'Reservation not found' }, 404);
  }

  await updateSyncStatus(c.env.DB, id, body.success, body.error, body.synced_start_at, body.synced_end_at);

  return c.json({ success: true });
});

// PUT /:id/salonboard-reserve-id — Save Salonboard reservation number (YG format)
salonboardRoutes.put('/:id/salonboard-reserve-id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ salonboard_reserve_id: string }>();

  if (!body.salonboard_reserve_id) {
    return c.json({ error: 'salonboard_reserve_id is required' }, 400);
  }

  const reservation = await c.env.DB.prepare(
    'SELECT id FROM reservations WHERE id = ?'
  ).bind(id).first();

  if (!reservation) {
    return c.json({ error: 'Reservation not found' }, 404);
  }

  await c.env.DB.prepare(
    'UPDATE reservations SET salonboard_reserve_id = ? WHERE id = ?'
  ).bind(body.salonboard_reserve_id, id).run();

  return c.json({ success: true });
});

// GET /pending-cancellations — Fetch reservations pending Salonboard cancellation
// Optional query param: store_id (filter by single store)
salonboardRoutes.get('/pending-cancellations', async (c) => {
  const storeId = c.req.query('store_id');
  const staffFilter = buildStaffFilter(c);

  const sql = `
    SELECT
      r.id,
      r.store_id,
      r.salonboard_reserve_id,
      c.name as customer_name
    FROM reservations r
    JOIN customers c ON r.customer_id = c.id
    JOIN stores st ON r.store_id = st.id
    WHERE r.status = 'cancelled'
      AND r.salonboard_synced = 1
      AND r.salonboard_reserve_id IS NOT NULL
      AND r.salonboard_cancel_synced = 0
      AND st.salonboard_enabled = 1
      ${storeId ? 'AND r.store_id = ?' : ''}
      ${staffFilter.sql}
    ORDER BY r.updated_at ASC
  `;

  const binds = [...(storeId ? [storeId] : []), ...staffFilter.binds];
  const stmt = binds.length > 0
    ? c.env.DB.prepare(sql).bind(...binds)
    : c.env.DB.prepare(sql);
  const result = await stmt.all();

  return c.json({ reservations: result.results || [] });
});

// PUT /:id/cancel-sync-status — Update Salonboard cancellation sync status
salonboardRoutes.put('/:id/cancel-sync-status', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ success: boolean; error?: string }>();

  const reservation = await c.env.DB.prepare(
    'SELECT id, salonboard_sync_error FROM reservations WHERE id = ?'
  ).bind(id).first<{ id: string; salonboard_sync_error: string | null }>();

  if (!reservation) {
    return c.json({ error: 'Reservation not found' }, 404);
  }

  if (body.success) {
    await c.env.DB.prepare(
      "UPDATE reservations SET salonboard_cancel_synced = 1, salonboard_sync_error = NULL WHERE id = ?"
    ).bind(id).run();
  } else {
    // Count previous cancel failures from error message (format: "[cancel:N] error")
    let failCount = 1;
    const prev = reservation.salonboard_sync_error;
    if (prev) {
      const match = prev.match(/^\[cancel:(\d+)\]/);
      if (match) failCount = parseInt(match[1]) + 1;
    }

    const errorMsg = `[cancel:${failCount}] ${body.error || 'Cancel sync failed'}`;

    if (failCount >= 3) {
      // Max retries reached — mark as failed (-1) to stop retrying
      await c.env.DB.prepare(
        "UPDATE reservations SET salonboard_cancel_synced = -1, salonboard_sync_error = ? WHERE id = ?"
      ).bind(errorMsg, id).run();
    } else {
      await c.env.DB.prepare(
        "UPDATE reservations SET salonboard_sync_error = ? WHERE id = ?"
      ).bind(errorMsg, id).run();
    }
  }

  return c.json({ success: true });
});

// GET /pending-time-changes — Fetch reservations with time changes pending Salonboard sync
// Detects when start_at or end_at differs from the last synced values
salonboardRoutes.get('/pending-time-changes', async (c) => {
  const storeId = c.req.query('store_id');
  const staffFilter = buildStaffFilter(c);

  const sql = `
    SELECT
      r.id,
      r.store_id,
      r.start_at,
      r.end_at,
      r.salonboard_reserve_id,
      r.salonboard_synced_start_at,
      r.salonboard_synced_end_at,
      s.salonboard_staff_id
    FROM reservations r
    LEFT JOIN staff s ON r.staff_id = s.id
    JOIN stores st ON r.store_id = st.id
    WHERE r.salonboard_synced = 1
      AND r.salonboard_reserve_id IS NOT NULL
      AND r.salonboard_cancel_synced = 0
      AND r.status != 'cancelled'
      AND st.salonboard_enabled = 1
      AND (r.start_at != r.salonboard_synced_start_at OR r.end_at != r.salonboard_synced_end_at)
      AND r.salonboard_sync_error IS NULL
      ${storeId ? 'AND r.store_id = ?' : ''}
      ${staffFilter.sql}
    ORDER BY r.updated_at ASC
  `;

  const binds = [...(storeId ? [storeId] : []), ...staffFilter.binds];
  const stmt = binds.length > 0
    ? c.env.DB.prepare(sql).bind(...binds)
    : c.env.DB.prepare(sql);
  const result = await stmt.all();

  // Clamp start_at/end_at to business hours for SB time change
  const reservations = result.results || [];
  const bhCache2 = new Map<string, { open_time: string; close_time: string } | null>();
  const holidayFlagCache2 = new Map<string, boolean>();
  const outOfHoursIds2 = new Set<string>();
  for (const r of reservations as Record<string, unknown>[]) {
    const sid = r.store_id as string;
    const startUtc = new Date(r.start_at as string);
    const jstStart = new Date(startUtc.getTime() + 9 * 60 * 60 * 1000);
    const dateStr = `${jstStart.getUTCFullYear()}-${String(jstStart.getUTCMonth()+1).padStart(2,'0')}-${String(jstStart.getUTCDate()).padStart(2,'0')}`;
    // Day-of-week MUST mirror the registration clamp. NOTE: getDay() on a JST-midnight Date returns
    // the PREVIOUS day in a UTC runtime (midnight JST = 15:00 prev-day UTC), which mis-clamped e.g.
    // Saturday (open 10:00) as Friday (open 11:00). Use jstStart.getUTCDay() + holiday handling.
    if (!holidayFlagCache2.has(sid)) {
      const flag = await c.env.DB.prepare(
        'SELECT holiday_hours_enabled FROM stores WHERE id = ?'
      ).bind(sid).first<{ holiday_hours_enabled: number }>();
      holidayFlagCache2.set(sid, !!(flag?.holiday_hours_enabled));
    }
    const dow = (holidayFlagCache2.get(sid)! && isJapaneseHoliday(dateStr)) ? 7 : jstStart.getUTCDay();
    const cacheKey = `${sid}_${dow}`;
    if (!bhCache2.has(cacheKey)) {
      const bh = await c.env.DB.prepare(
        'SELECT open_time, close_time FROM business_hours WHERE store_id = ? AND day_of_week = ? AND is_closed = 0'
      ).bind(sid, dow).first<{ open_time: string; close_time: string }>();
      bhCache2.set(cacheKey, bh || null);
    }
    const bh = bhCache2.get(cacheKey);
    if (bh) {
      const startTimeStr = `${String(jstStart.getUTCHours()).padStart(2,'0')}:${String(jstStart.getUTCMinutes()).padStart(2,'0')}`;
      const endUtc = new Date(r.end_at as string);
      const jstEnd = new Date(endUtc.getTime() + 9 * 60 * 60 * 1000);
      const endTimeStr = `${String(jstEnd.getUTCHours()).padStart(2,'0')}:${String(jstEnd.getUTCMinutes()).padStart(2,'0')}`;
      // Out-of-hours time change: instruct the VPS to widen that day's SB business
      // hours first (same mechanism as registration), instead of erroring/clamping.
      if (startTimeStr < bh.open_time || endTimeStr > bh.close_time) {
        const toM = (t: string) => parseInt(t.slice(0, 2)) * 60 + parseInt(t.slice(3, 5));
        const toHHMM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}${String(m % 60).padStart(2, '0')}`;
        const floor30 = (t: string) => toHHMM(Math.floor(toM(t) / 30) * 30);
        const ceil30 = (t: string) => toHHMM(Math.min(Math.ceil(toM(t) / 30) * 30, 23 * 60 + 30));
        r.extend_hours = {
          date: dateStr.replace(/-/g, ''),
          open: floor30(startTimeStr < bh.open_time ? startTimeStr : bh.open_time),
          close: ceil30(endTimeStr > bh.close_time ? endTimeStr : bh.close_time),
        };
      }
    }
  }

  return c.json({
    reservations: (reservations as Record<string, unknown>[]).filter((r) => !outOfHoursIds2.has(r.id as string)),
  });
});

// PUT /:id/time-change-sync-status — Update time change sync status
salonboardRoutes.put('/:id/time-change-sync-status', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ success: boolean; error?: string }>();

  const reservation = await c.env.DB.prepare(
    'SELECT id, salonboard_sync_error FROM reservations WHERE id = ?'
  ).bind(id).first<{ id: string; salonboard_sync_error: string | null }>();

  if (!reservation) {
    return c.json({ error: 'Reservation not found' }, 404);
  }

  if (body.success) {
    // Update synced time values to match current values
    await c.env.DB.prepare(`
      UPDATE reservations
      SET salonboard_synced_start_at = start_at,
          salonboard_synced_end_at = end_at,
          salonboard_sync_error = NULL,
          updated_at = datetime('now')
      WHERE id = ?
    `).bind(id).run();
  } else {
    const errorMsg = body.error || 'Time change sync failed';

    // Record error but keep synced values unchanged so the diff remains visible
    await c.env.DB.prepare(`
      UPDATE reservations
      SET salonboard_sync_error = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).bind(errorMsg, id).run();
  }

  return c.json({ success: true });
});

// GET /pending-staff-changes — Fetch reservations with staff changes pending Salonboard sync
// Detects when staff_id differs from the last synced staff
salonboardRoutes.get('/pending-staff-changes', async (c) => {
  const storeId = c.req.query('store_id');
  const staffFilter = buildStaffFilter(c);

  const sql = `
    SELECT
      r.id,
      r.store_id,
      r.start_at,
      r.end_at,
      r.source,
      r.salonboard_reserve_id,
      r.staff_id,
      r.salonboard_synced_staff_id,
      s.salonboard_staff_id as new_salonboard_staff_id,
      c.name as customer_name,
      c.name_kana as customer_name_kana
    FROM reservations r
    LEFT JOIN staff s ON r.staff_id = s.id
    LEFT JOIN customers c ON r.customer_id = c.id
    JOIN stores st ON r.store_id = st.id
    WHERE r.salonboard_cancel_synced = 0
      AND r.status != 'cancelled'
      AND st.salonboard_enabled = 1
      AND r.staff_id != r.salonboard_synced_staff_id
      AND r.salonboard_synced_staff_id IS NOT NULL
      AND r.salonboard_sync_error IS NULL
      AND (
        (r.salonboard_synced = 1 AND r.salonboard_reserve_id IS NOT NULL)
        OR r.source = 'hotpepper'
      )
      ${storeId ? 'AND r.store_id = ?' : ''}
      ${staffFilter.sql}
    ORDER BY r.updated_at ASC
  `;

  const binds = [...(storeId ? [storeId] : []), ...staffFilter.binds];
  const stmt = binds.length > 0
    ? c.env.DB.prepare(sql).bind(...binds)
    : c.env.DB.prepare(sql);
  const result = await stmt.all();

  return c.json({ reservations: result.results || [] });
});

// PUT /:id/staff-change-sync-status — Update staff change sync status
salonboardRoutes.put('/:id/staff-change-sync-status', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ success: boolean; error?: string }>();

  const reservation = await c.env.DB.prepare(
    'SELECT id, salonboard_sync_error FROM reservations WHERE id = ?'
  ).bind(id).first<{ id: string; salonboard_sync_error: string | null }>();

  if (!reservation) {
    return c.json({ error: 'Reservation not found' }, 404);
  }

  if (body.success) {
    // Update synced staff_id to match current staff_id
    await c.env.DB.prepare(`
      UPDATE reservations
      SET salonboard_synced_staff_id = staff_id,
          salonboard_sync_error = NULL,
          updated_at = datetime('now')
      WHERE id = ?
    `).bind(id).run();
  } else {
    const errorMsg = body.error || 'Staff change sync failed';

    // Record error but keep synced values unchanged so the diff remains visible
    await c.env.DB.prepare(`
      UPDATE reservations
      SET salonboard_sync_error = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).bind(errorMsg, id).run();
  }

  return c.json({ success: true });
});

// GET /pending-menu-changes — Fetch reservations with menu changes pending Salonboard memo update
salonboardRoutes.get('/pending-menu-changes', async (c) => {
  const storeId = c.req.query('store_id');
  const staffFilter = buildStaffFilter(c);

  // Find reservations where synced menu names differ from current reservation_menus
  const sql = `
    SELECT
      r.id,
      r.store_id,
      r.start_at,
      r.end_at,
      r.memo,
      r.salonboard_reserve_id,
      r.salonboard_synced_menu_names,
      GROUP_CONCAT(rm.menu_name, ', ') as current_menu_names
    FROM reservations r
    JOIN reservation_menus rm ON rm.reservation_id = r.id
    JOIN stores st ON r.store_id = st.id
    WHERE r.salonboard_synced = 1
      AND r.salonboard_reserve_id IS NOT NULL
      AND r.salonboard_cancel_synced = 0
      AND r.status != 'cancelled'
      AND st.salonboard_enabled = 1
      AND r.salonboard_sync_error IS NULL
      ${storeId ? 'AND r.store_id = ?' : ''}
      ${staffFilter.sql}
    GROUP BY r.id
    HAVING current_menu_names != COALESCE(r.salonboard_synced_menu_names, '')
    ORDER BY r.updated_at ASC
  `;

  const binds = [...(storeId ? [storeId] : []), ...staffFilter.binds];
  const stmt = binds.length > 0
    ? c.env.DB.prepare(sql).bind(...binds)
    : c.env.DB.prepare(sql);
  const result = await stmt.all();

  return c.json({ reservations: result.results || [] });
});

// PUT /:id/menu-change-sync-status — Update menu change sync status
salonboardRoutes.put('/:id/menu-change-sync-status', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ success: boolean; error?: string }>();

  const reservation = await c.env.DB.prepare(
    'SELECT id, salonboard_sync_error FROM reservations WHERE id = ?'
  ).bind(id).first<{ id: string; salonboard_sync_error: string | null }>();

  if (!reservation) {
    return c.json({ error: 'Reservation not found' }, 404);
  }

  if (body.success) {
    // Get current menu names and save as synced
    const menus = await c.env.DB.prepare(
      "SELECT GROUP_CONCAT(menu_name, ', ') as names FROM reservation_menus WHERE reservation_id = ?"
    ).bind(id).first<{ names: string }>();

    await c.env.DB.prepare(`
      UPDATE reservations
      SET salonboard_synced_menu_names = ?,
          salonboard_sync_error = NULL,
          updated_at = datetime('now')
      WHERE id = ?
    `).bind(menus?.names || '', id).run();
  } else {
    const errorMsg = body.error || 'Menu change sync failed';

    // Update synced menu names to current values to stop retry loop.
    // Error is recorded in salonboard_sync_error for manual review.
    const menus = await c.env.DB.prepare(
      "SELECT GROUP_CONCAT(menu_name, ', ') as names FROM reservation_menus WHERE reservation_id = ?"
    ).bind(id).first<{ names: string }>();

    await c.env.DB.prepare(`
      UPDATE reservations
      SET salonboard_synced_menu_names = ?,
          salonboard_sync_error = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).bind(menus?.names || '', errorMsg, id).run();
  }

  return c.json({ success: true });
});

// GET /stores — Fetch Salonboard-enabled stores with credentials
// Optional query param: store_id (filter by single store)
salonboardRoutes.get('/stores', async (c) => {
  const storeId = c.req.query('store_id');

  const sql = `
    SELECT id, name, salonboard_id, salonboard_password, salonboard_restart_requested
    FROM stores
    WHERE salonboard_enabled = 1
      AND salonboard_id IS NOT NULL
      AND salonboard_password IS NOT NULL
      ${storeId ? 'AND id = ?' : ''}
  `;

  const stmt = storeId
    ? c.env.DB.prepare(sql).bind(storeId)
    : c.env.DB.prepare(sql);
  const result = await stmt.all();

  return c.json({ stores: result.results || [] });
});

// POST /stores/:id/clear-restart — VPSが再起動完了後にフラグをクリアする
salonboardRoutes.post('/stores/:id/clear-restart', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare(
    "UPDATE stores SET salonboard_restart_requested = 0 WHERE id = ?"
  ).bind(id).run();
  return c.json({ success: true });
});

// POST /verify-request — Mark reservations for YG ID verification
// Body: { store_id, start_date, end_date }
salonboardRoutes.post('/verify-request', async (c) => {
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

// GET /pending-verifications — Fetch reservations pending YG ID verification
salonboardRoutes.get('/pending-verifications', async (c) => {
  const storeId = c.req.query('store_id');
  const staffFilter = buildStaffFilter(c);

  const sql = `
    SELECT
      r.id,
      r.store_id,
      r.start_at,
      r.end_at,
      c.name as customer_name,
      c.phone as customer_phone,
      s.salonboard_staff_id
    FROM reservations r
    LEFT JOIN customers c ON r.customer_id = c.id
    LEFT JOIN staff s ON r.staff_id = s.id
    WHERE r.salonboard_synced = 2
      AND r.status = 'confirmed'
      ${storeId ? 'AND r.store_id = ?' : ''}
      ${staffFilter.sql}
    ORDER BY r.start_at
    LIMIT 50
  `;

  const binds = [...(storeId ? [storeId] : []), ...staffFilter.binds];
  const stmt = binds.length > 0
    ? c.env.DB.prepare(sql).bind(...binds)
    : c.env.DB.prepare(sql);
  const result = await stmt.all();

  return c.json({ reservations: result.results || [] });
});

// PUT /verify-result/:id — Update verification result
salonboardRoutes.put('/verify-result/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ found: boolean; salonboard_reserve_id?: string }>();

  if (body.found && body.salonboard_reserve_id) {
    // Found in Salonboard — mark as synced with YG ID
    await c.env.DB.prepare(`
      UPDATE reservations
      SET salonboard_synced = 1,
          salonboard_reserve_id = ?,
          salonboard_synced_at = datetime('now'),
          salonboard_sync_error = NULL
      WHERE id = ?
    `).bind(body.salonboard_reserve_id, id).run();
  } else {
    // Not found. If this reservation was previously registered successfully
    // (salonboard_synced_at set), assume the verify lookup missed it (name
    // rendering etc.) and KEEP it synced without an id — re-registering would
    // duplicate the SB entry. Only never-registered ones go back to 0.
    const prev = await c.env.DB.prepare(
      'SELECT salonboard_synced_at FROM reservations WHERE id = ?'
    ).bind(id).first<{ salonboard_synced_at: string | null }>();
    if (prev?.salonboard_synced_at) {
      await c.env.DB.prepare(`
        UPDATE reservations
        SET salonboard_synced = 1,
            salonboard_sync_error = 'YG未取得（SB照合で発見できず。登録済みのため再登録はしません）'
        WHERE id = ?
      `).bind(id).run();
    } else {
      await c.env.DB.prepare(`
        UPDATE reservations
        SET salonboard_synced = 0,
            salonboard_sync_error = 'Verification: not found in Salonboard'
        WHERE id = ?
      `).bind(id).run();
    }
  }

  return c.json({ success: true });
});

// GET /pending-hpb-staff-checks — HPBフリー予約のスタッフ確認待ち
salonboardRoutes.get('/pending-hpb-staff-checks', async (c) => {
  const storeId = c.req.query('store_id');
  const staffFilter = buildStaffFilter(c);

  const sql = `
    SELECT
      r.id,
      r.store_id,
      r.hotpepper_id,
      r.start_at,
      r.end_at,
      c.name as customer_name,
      c.name_kana as customer_name_kana,
      s.salonboard_staff_id
    FROM reservations r
    LEFT JOIN customers c ON r.customer_id = c.id
    LEFT JOIN staff s ON r.staff_id = s.id
    WHERE r.hpb_staff_check = 1
      AND r.source = 'hotpepper'
      AND r.status = 'confirmed'
      AND r.created_at < datetime('now', '-1 minutes')
      ${storeId ? 'AND r.store_id = ?' : ''}
      ${staffFilter.sql}
    ORDER BY r.start_at
    LIMIT 50
  `;

  const binds = [...(storeId ? [storeId] : []), ...staffFilter.binds];
  const stmt = binds.length > 0
    ? c.env.DB.prepare(sql).bind(...binds)
    : c.env.DB.prepare(sql);
  const result = await stmt.all();

  return c.json({ reservations: result.results || [] });
});

// PUT /hpb-staff-check-result/:id — HPBフリー予約のスタッフ確認結果
salonboardRoutes.put('/hpb-staff-check-result/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ found: boolean; salonboard_staff_id?: string }>();

  if (body.found && body.salonboard_staff_id) {
    // Salonboardで担当スタッフが見つかった → 同じスタッフに更新
    const reservation = await c.env.DB.prepare(
      'SELECT store_id, staff_id FROM reservations WHERE id = ?'
    ).bind(id).first<{ store_id: string; staff_id: string }>();

    if (!reservation) {
      return c.json({ error: 'Reservation not found' }, 404);
    }

    // salonboard_staff_idからスタッフを検索
    const matchedStaff = await c.env.DB.prepare(
      'SELECT id, name FROM staff WHERE salonboard_staff_id = ? AND (store_id = ? OR id IN (SELECT staff_id FROM staff_stores WHERE store_id = ?))'
    ).bind(body.salonboard_staff_id, reservation.store_id, reservation.store_id)
      .first<{ id: string; name: string }>();

    if (matchedStaff && matchedStaff.id !== reservation.staff_id) {
      // スタッフが異なる場合のみ更新
      await c.env.DB.prepare(`
        UPDATE reservations
        SET staff_id = ?,
            salonboard_synced_staff_id = ?,
            hpb_staff_check = 0,
            updated_at = datetime('now')
        WHERE id = ?
      `).bind(matchedStaff.id, matchedStaff.id, id).run();

      await insertReservationLog(c.env.DB, {
        reservationId: id,
        eventType: 'staff_changed',
        actorType: 'system',
        actorName: 'HPBスタッフ同期',
        description: `HPBフリー予約の担当スタッフを${matchedStaff.name}に同期しました`,
      });
    } else {
      // 同じスタッフ or マッチなし → フラグだけクリア
      await c.env.DB.prepare(
        "UPDATE reservations SET hpb_staff_check = 0, updated_at = datetime('now') WHERE id = ?"
      ).bind(id).run();
    }
  } else {
    // 見つからなかった → フラグクリア（自動割当のまま）
    await c.env.DB.prepare(
      "UPDATE reservations SET hpb_staff_check = 0, updated_at = datetime('now') WHERE id = ?"
    ).bind(id).run();
  }

  return c.json({ success: true });
});

// POST /notify-staff — Internal endpoint for email-worker to trigger push notifications
salonboardRoutes.post('/notify-staff', async (c) => {
  const body = await c.req.json<{
    staff_id: string;
    store_id: string;
    title: string;
    body: string;
    url?: string;
  }>();

  if (!body.staff_id || !body.title || !body.body) {
    return c.json({ error: 'staff_id, title, body required' }, 400);
  }

  if (!c.env.VAPID_PUBLIC_KEY || !c.env.VAPID_PRIVATE_KEY) {
    return c.json({ error: 'VAPID keys not configured' }, 500);
  }

  const result = await PushNotificationService.notifyStaff(
    c.env.DB,
    body.staff_id,
    { title: body.title, body: body.body, url: body.url },
    c.env.VAPID_PUBLIC_KEY,
    c.env.VAPID_PRIVATE_KEY,
  );

  return c.json({ success: true, sent: result.sent, failed: result.failed });
});

// ====== Staff Block (予定ブロック) sync ======

// GET /pending-blocks — Fetch staff blocks pending Salonboard sync
salonboardRoutes.get('/pending-blocks', async (c) => {
  const storeId = c.req.query('store_id');
  const staffFilter = buildStaffFilter(c);

  const sql = `
    SELECT
      b.id,
      b.staff_id,
      b.store_id,
      b.date,
      b.is_all_day,
      b.start_time,
      b.end_time,
      b.reason,
      s.salonboard_staff_id
    FROM staff_blocks b
    LEFT JOIN staff s ON b.staff_id = s.id
    WHERE b.salonboard_synced = 0
      AND s.salonboard_staff_id IS NOT NULL
      AND (
        (b.is_all_day = 0 AND b.start_time IS NOT NULL AND b.end_time IS NOT NULL)
        OR b.is_all_day = 1
      )
      ${storeId ? 'AND b.store_id = ?' : ''}
      ${staffFilter.sql.replace(/r\.staff_id/g, 'b.staff_id')}
    ORDER BY b.date, b.start_time
    LIMIT 50
  `;

  const binds = [...(storeId ? [storeId] : []), ...staffFilter.binds];
  const stmt = binds.length > 0
    ? c.env.DB.prepare(sql).bind(...binds)
    : c.env.DB.prepare(sql);
  const result = await stmt.all();

  return c.json({ blocks: result.results || [] });
});

// PUT /block-sync-status/:id — Update block sync result
salonboardRoutes.put('/block-sync-status/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ success: boolean; error?: string }>();

  if (body.success) {
    // 登録/変更が成功したら、その日時を「SBに登録済みスロット」として記録
    // （次回の変更/削除でSB上の既存予定を特定するのに使う）
    await c.env.DB.prepare(`
      UPDATE staff_blocks
      SET salonboard_synced = 1,
          salonboard_sync_error = NULL,
          salonboard_synced_at = datetime('now'),
          salonboard_synced_date = date,
          salonboard_synced_start_time = start_time,
          updated_at = datetime('now')
      WHERE id = ?
    `).bind(id).run();
  } else {
    await c.env.DB.prepare(`
      UPDATE staff_blocks
      SET salonboard_synced = -1,
          salonboard_sync_error = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).bind(body.error || 'Unknown error', id).run();
  }

  return c.json({ success: true });
});

// GET /pending-block-changes — Fetch blocks that need time/date change on Salonboard
salonboardRoutes.get('/pending-block-changes', async (c) => {
  const storeId = c.req.query('store_id');
  const staffFilter = buildStaffFilter(c);

  const sql = `
    SELECT
      b.id,
      b.staff_id,
      b.store_id,
      b.date,
      b.is_all_day,
      b.start_time,
      b.end_time,
      b.reason,
      b.salonboard_synced_date,
      b.salonboard_synced_start_time,
      s.salonboard_staff_id
    FROM staff_blocks b
    LEFT JOIN staff s ON b.staff_id = s.id
    WHERE b.salonboard_synced = 3
      AND s.salonboard_staff_id IS NOT NULL
      AND (
        (b.is_all_day = 0 AND b.start_time IS NOT NULL AND b.end_time IS NOT NULL)
        OR b.is_all_day = 1
      )
      ${storeId ? 'AND b.store_id = ?' : ''}
      ${staffFilter.sql.replace(/r\.staff_id/g, 'b.staff_id')}
    ORDER BY b.date, b.start_time
    LIMIT 50
  `;

  const binds = [...(storeId ? [storeId] : []), ...staffFilter.binds];
  const stmt = binds.length > 0
    ? c.env.DB.prepare(sql).bind(...binds)
    : c.env.DB.prepare(sql);
  const result = await stmt.all();

  return c.json({ blocks: result.results || [] });
});

// GET /pending-block-deletions — Fetch blocks deleted locally that need Salonboard deletion
salonboardRoutes.get('/pending-block-deletions', async (c) => {
  const storeId = c.req.query('store_id');
  const staffFilter = buildStaffFilter(c);

  const sql = `
    SELECT
      b.id,
      b.staff_id,
      b.store_id,
      b.date,
      b.is_all_day,
      b.start_time,
      b.end_time,
      b.reason,
      b.salonboard_synced_date,
      b.salonboard_synced_start_time,
      s.salonboard_staff_id
    FROM staff_blocks b
    LEFT JOIN staff s ON b.staff_id = s.id
    WHERE b.salonboard_synced = 4
      AND s.salonboard_staff_id IS NOT NULL
      ${storeId ? 'AND b.store_id = ?' : ''}
      ${staffFilter.sql.replace(/r\.staff_id/g, 'b.staff_id')}
    ORDER BY b.date, b.start_time
    LIMIT 50
  `;

  const binds = [...(storeId ? [storeId] : []), ...staffFilter.binds];
  const stmt = binds.length > 0
    ? c.env.DB.prepare(sql).bind(...binds)
    : c.env.DB.prepare(sql);
  const result = await stmt.all();

  return c.json({ blocks: result.results || [] });
});

// DELETE /block-delete-complete/:id — Remove block after Salonboard deletion confirmed
salonboardRoutes.delete('/block-delete-complete/:id', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare('DELETE FROM staff_blocks WHERE id = ?').bind(id).run();
  return c.json({ success: true });
});

// GET /pending-member-no-updates — Customer numbers to rewrite in Salonboard after a merge.
// Store-scoped only (no staff filter): this edits the store's customer record, not a booking.
salonboardRoutes.get('/pending-member-no-updates', async (c) => {
  const storeId = c.req.query('store_id');
  const sql = `
    SELECT id, store_id, customer_id, customer_name, old_member_no, new_member_no
    FROM sb_member_no_updates
    WHERE status = 0
      ${storeId ? 'AND store_id = ?' : ''}
    ORDER BY created_at ASC
    LIMIT 20
  `;
  const stmt = storeId ? c.env.DB.prepare(sql).bind(storeId) : c.env.DB.prepare(sql);
  const result = await stmt.all();
  return c.json({ updates: result.results || [] });
});

// POST /member-no-update-result — VPS reports the outcome of a customer-number rewrite.
// not_found is treated as done: the merge side simply had no SB customer under that number.
salonboardRoutes.post('/member-no-update-result', async (c) => {
  const body = await c.req.json<{ id: string; success: boolean; not_found?: boolean; error?: string }>();
  if (!body.id) return c.json({ error: 'id is required' }, 400);

  if (body.success || body.not_found) {
    await c.env.DB.prepare(
      "UPDATE sb_member_no_updates SET status = 1, error = ?, synced_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
    ).bind(body.not_found ? 'SB該当顧客なし（対応不要）' : null, body.id).run();
  } else {
    await c.env.DB.prepare(
      "UPDATE sb_member_no_updates SET status = -1, error = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(body.error || 'unknown error', body.id).run();
  }
  return c.json({ success: true });
});

export { salonboardRoutes };
