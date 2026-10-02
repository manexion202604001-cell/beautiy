import { Hono } from 'hono';
import type { Bindings, Variables, Customer, Reservation, Karute, Menu, MenuCategory, BusinessHours, Message } from '../types';
import { customerAuth } from '../middleware/auth';
import { StaffLineNotificationService, getStoreLineAccessToken } from '../services/lineService';
import { isStaffBlocked } from '../services/staffBlockService';
import { insertReservationLog } from '../services/reservationLogService';
import { pushMessage, buildRegistrationWelcomeMessage, searchAndCreateMergeCandidates } from './lineWebhook';
import { isJapaneseHoliday } from '../services/japaneseHolidays';
import { getOrCreateMaster, normalizePhone as normalizePhoneForMatch, sqlNormalizedPhone } from '../services/customerMasterService';
import { findEquipmentConflict } from '../services/equipmentService';
import { signImageRows } from '../utils/imageSign';

// Equipment availability check helper (peak simultaneous usage)
async function checkEquipmentAvailability(
  db: D1Database,
  menuId: string,
  storeId: string,
  startAt: string,
  endAt: string
): Promise<{ available: true } | { available: false; error: string }> {
  const conflict = await findEquipmentConflict(db, [menuId], storeId, startAt, endAt);
  if (conflict) {
    return { available: false, error: `設備「${conflict.equipment_name}」が空いていません` };
  }
  return { available: true };
}

// Check if staff is working on this day/time (business hours check)
async function isStaffWorking(
  db: D1Database,
  staffId: string,
  storeId: string,
  date: string,
  startTime: string,
  endTime: string
): Promise<boolean> {
  const dayOfWeek = new Date(date).getDay();

  // Check staff-specific hours
  const staffHours = await db.prepare(
    'SELECT open_time, close_time, is_closed FROM staff_business_hours WHERE staff_id = ? AND store_id = ? AND day_of_week = ?'
  ).bind(staffId, storeId, dayOfWeek).first<{ open_time: string | null; close_time: string | null; is_closed: number }>();

  if (staffHours) {
    if (staffHours.is_closed) return false;
    if (staffHours.open_time && staffHours.close_time) {
      return startTime >= staffHours.open_time && endTime <= staffHours.close_time;
    }
  }

  // Fallback to store hours
  const storeHours = await db.prepare(
    'SELECT open_time, close_time, is_closed FROM business_hours WHERE store_id = ? AND day_of_week = ?'
  ).bind(storeId, dayOfWeek).first<{ open_time: string | null; close_time: string | null; is_closed: number }>();

  if (!storeHours || storeHours.is_closed) return false;
  if (storeHours.open_time && storeHours.close_time) {
    return startTime >= storeHours.open_time && endTime <= storeHours.close_time;
  }

  return false;
}

// Get max concurrent bookings for a staff member (staff setting → per-day → store default)
async function getMaxConcurrent(
  db: D1Database,
  staffId: string,
  storeId: string,
  _startAt: string
): Promise<number> {
  // For individual staff, use staff-level setting (default 1)
  // business_hours.max_concurrent and stores.max_concurrent are store-level capacity
  const staffSettings = await db.prepare(
    'SELECT max_concurrent FROM staff_reservation_settings WHERE staff_id = ? AND store_id = ?'
  ).bind(staffId, storeId).first<{ max_concurrent: number | null }>();

  return staffSettings?.max_concurrent ?? 1;
}

export const customerRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Apply auth middleware to protected routes
const protectedRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();
protectedRoutes.use('*', customerAuth);

// Public routes (no auth required)

// Get store info
customerRoutes.get('/store/:storeId', async (c) => {
  const storeId = c.req.param('storeId');

  const store = await c.env.DB.prepare(
    'SELECT id, name, address, phone, email, line_liff_id FROM stores WHERE id = ?'
  )
    .bind(storeId)
    .first();

  if (!store) {
    return c.json({ error: 'Store not found' }, 404);
  }

  const hours = await c.env.DB.prepare(
    'SELECT day_of_week, open_time, close_time, is_closed FROM business_hours WHERE store_id = ? ORDER BY day_of_week'
  )
    .bind(storeId)
    .all<BusinessHours>();

  return c.json({ store, business_hours: hours.results });
});

// Get menus (optionally filtered by staff capability)
customerRoutes.get('/menus/:storeId', async (c) => {
  const storeId = c.req.param('storeId');
  const staffId = c.req.query('staff_id');

  let menus;

  if (staffId) {
    // Get only menus explicitly assigned to this staff via menu_staff
    menus = await c.env.DB.prepare(
      `SELECT DISTINCT m.id, m.category, m.name, m.description, m.image_url, m.duration, m.price, m.coupon_type, m.price_tilde
       FROM menus m
       INNER JOIN menu_staff ms ON m.id = ms.menu_id
       WHERE m.store_id = ? AND m.is_active = 1
       AND ms.staff_id = ?
       ORDER BY (CASE WHEN m.coupon_type IS NOT NULL THEN 0 ELSE 1 END), CASE WHEN m.coupon_type IS NOT NULL THEN '' ELSE (CASE WHEN INSTR(m.category, '：') > 0 THEN SUBSTR(m.category, 1, INSTR(m.category, '：') - 1) ELSE m.category END) END, m.sort_order, m.name`
    )
      .bind(storeId, staffId)
      .all<Menu>();
  } else {
    menus = await c.env.DB.prepare(
      `SELECT id, category, name, description, image_url, duration, price, coupon_type, price_tilde FROM menus WHERE store_id = ? AND is_active = 1 ORDER BY (CASE WHEN coupon_type IS NOT NULL THEN 0 ELSE 1 END), CASE WHEN coupon_type IS NOT NULL THEN '' ELSE (CASE WHEN INSTR(category, '：') > 0 THEN SUBSTR(category, 1, INSTR(category, '：') - 1) ELSE category END) END, sort_order, name`
    )
      .bind(storeId)
      .all<Menu>();
  }

  // Get categories for color info
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
  const byCategory: Record<string, Menu[]> = {};
  for (const menu of menus.results) {
    if (!byCategory[menu.category]) {
      byCategory[menu.category] = [];
    }
    byCategory[menu.category].push(menu);
  }

  return c.json({ menus: menus.results, byCategory, categoryColors });
});

// Get staff list for reservation (optionally filtered by menu)
customerRoutes.get('/staff/:storeId', async (c) => {
  const storeId = c.req.param('storeId');
  const menuId = c.req.query('menu_id');

  let staff;

  if (menuId) {
    // Check if menu has specific staff assignments
    const assignmentCount = await c.env.DB.prepare(
      'SELECT COUNT(*) as count FROM menu_staff WHERE menu_id = ?'
    ).bind(menuId).first<{ count: number }>();

    if (assignmentCount && assignmentCount.count > 0) {
      // Return only assigned staff
      staff = await c.env.DB.prepare(
        `SELECT DISTINCT s.id, COALESCE(s.nickname, s.name) as name, s.avatar_url FROM staff s
         JOIN staff_stores ss ON s.id = ss.staff_id
         JOIN menu_staff ms ON s.id = ms.staff_id
         WHERE ss.store_id = ? AND s.is_active = 1 AND ss.is_visible_to_customer = 1
         AND s.role != 'system_admin' AND ms.menu_id = ?
         ORDER BY ss.sort_order, name`
      ).bind(storeId, menuId).all();
    } else {
      // No assignments = all staff can do it
      staff = await c.env.DB.prepare(
        `SELECT DISTINCT s.id, COALESCE(s.nickname, s.name) as name, s.avatar_url FROM staff s
         JOIN staff_stores ss ON s.id = ss.staff_id
         WHERE ss.store_id = ? AND s.is_active = 1 AND ss.is_visible_to_customer = 1 AND s.role != 'system_admin'
         ORDER BY ss.sort_order, name`
      ).bind(storeId).all();
    }
  } else {
    staff = await c.env.DB.prepare(
      `SELECT DISTINCT s.id, COALESCE(s.nickname, s.name) as name, s.avatar_url FROM staff s
       JOIN staff_stores ss ON s.id = ss.staff_id
       WHERE ss.store_id = ? AND s.is_active = 1 AND ss.is_visible_to_customer = 1 AND s.role != 'system_admin'
       ORDER BY ss.sort_order, name`
    ).bind(storeId).all();
  }

  return c.json({ staff: staff.results });
});

// Get available time slots
customerRoutes.get('/available-slots/:storeId', async (c) => {
  const storeId = c.req.param('storeId');
  const date = c.req.query('date'); // YYYY-MM-DD
  const staffId = c.req.query('staff_id');
  const menuId = c.req.query('menu_id');
  const duration = parseInt(c.req.query('duration') || '60');

  if (!date) {
    return c.json({ error: 'Date is required' }, 400);
  }

  // Get business hours for the day - prefer staff-specific hours if staff_id is given
  const dayOfWeek = new Date(date).getDay();

  // Check if this date is a Japanese holiday and if the store uses holiday hours
  const storeHolidayFlag = await c.env.DB.prepare(
    'SELECT holiday_hours_enabled FROM stores WHERE id = ?'
  ).bind(storeId).first<{ holiday_hours_enabled: number }>();
  const holidayHoursEnabled = !!(storeHolidayFlag?.holiday_hours_enabled);
  const dateIsHoliday = isJapaneseHoliday(date);

  let effectiveHours: { open_time: string | null; close_time: string | null; is_closed: number } | null = null;

  // Always check store hours first - store closed days override staff settings
  // If holiday hours are enabled and this is a holiday, use day_of_week=7
  const effectiveDayOfWeek = (holidayHoursEnabled && dateIsHoliday) ? 7 : dayOfWeek;
  const storeHours = await c.env.DB.prepare(
    'SELECT open_time, close_time, is_closed FROM business_hours WHERE store_id = ? AND day_of_week = ?'
  )
    .bind(storeId, effectiveDayOfWeek)
    .first<{ open_time: string | null; close_time: string | null; is_closed: number }>();

  if (!storeHours || storeHours.is_closed) {
    return c.json({ slots: [], closed: true, is_holiday: dateIsHoliday });
  }

  if (staffId) {
    // Try staff-specific hours (store is open, so check staff availability)
    // Note: staff_business_hours only has day_of_week 0-6, not 7 (holiday)
    // When holiday hours are active, staff follows store holiday hours (no staff-specific holiday override)
    if (!holidayHoursEnabled || !dateIsHoliday) {
      effectiveHours = await c.env.DB.prepare(
        'SELECT open_time, close_time, is_closed FROM staff_business_hours WHERE staff_id = ? AND store_id = ? AND day_of_week = ?'
      )
        .bind(staffId, storeId, dayOfWeek)
        .first<{ open_time: string | null; close_time: string | null; is_closed: number }>();
    }
  }

  // Fallback to store hours
  if (!effectiveHours) {
    effectiveHours = storeHours;
  }

  if (effectiveHours.is_closed) {
    return c.json({ slots: [], closed: true });
  }

  // Check store closures (臨時休業日)
  const storeClosure = await c.env.DB.prepare(
    'SELECT id FROM store_closures WHERE store_id = ? AND date = ? LIMIT 1'
  ).bind(storeId, date).first();
  if (storeClosure) {
    return c.json({ slots: [], closed: true });
  }

  // Load staff reservation settings for filtering (staff → per-day → store → hardcoded defaults)
  type BookingSettings = {
    advance_booking_days: number; same_day_cutoff_hours: number; max_concurrent: number;
    booking_cutoff_type: string | null; booking_cutoff_days_before: number | null;
    booking_cutoff_time: string | null; booking_cutoff_same_day_minutes: number | null;
    booking_calc_method: string | null;
  };
  let staffSettings: BookingSettings | null = null;
  if (staffId) {
    staffSettings = await c.env.DB.prepare(
      `SELECT advance_booking_days, same_day_cutoff_hours, max_concurrent,
       booking_cutoff_type, booking_cutoff_days_before, booking_cutoff_time,
       booking_cutoff_same_day_minutes, booking_calc_method
       FROM staff_reservation_settings WHERE staff_id = ? AND store_id = ?`
    )
      .bind(staffId, storeId)
      .first<BookingSettings>();
  }
  const storeSettings = await c.env.DB.prepare(
    `SELECT advance_booking_days, advance_booking_months, same_day_cutoff_hours, max_concurrent,
     booking_cutoff_type, booking_cutoff_days_before, booking_cutoff_time,
     booking_cutoff_same_day_minutes, booking_calc_method
     FROM stores WHERE id = ?`
  )
    .bind(storeId)
    .first<BookingSettings>();

  // Per-day capacity from business_hours (use effectiveDayOfWeek for holidays)
  const dayCapacity = await c.env.DB.prepare(
    'SELECT max_concurrent FROM business_hours WHERE store_id = ? AND day_of_week = ?'
  ).bind(storeId, effectiveDayOfWeek).first<{ max_concurrent: number | null }>();

  const storeAdvanceMonths = (storeSettings as any)?.advance_booking_months ?? 4;
  // For specific staff: use staff-level setting (default 1 per staff)
  // For 指名なし (no staff): use day/store-level capacity
  const maxConcurrent = staffId
    ? (staffSettings?.max_concurrent ?? 1)
    : (dayCapacity?.max_concurrent ?? storeSettings?.max_concurrent ?? 1);
  const cutoffType = staffSettings?.booking_cutoff_type ?? storeSettings?.booking_cutoff_type ?? 'same_day';
  const cutoffDaysBefore = staffSettings?.booking_cutoff_days_before ?? storeSettings?.booking_cutoff_days_before ?? 0;
  const cutoffTime = staffSettings?.booking_cutoff_time ?? storeSettings?.booking_cutoff_time ?? '24:00';
  // Use booking_cutoff_same_day_minutes if set, otherwise fall back to same_day_cutoff_hours * 60
  const cutoffSameDayMinutes = staffSettings?.booking_cutoff_same_day_minutes
    ?? (staffSettings?.same_day_cutoff_hours != null ? staffSettings.same_day_cutoff_hours * 60 : null)
    ?? storeSettings?.booking_cutoff_same_day_minutes
    ?? (storeSettings?.same_day_cutoff_hours != null ? storeSettings.same_day_cutoff_hours * 60 : null)
    ?? 60;
  const calcMethod = staffSettings?.booking_calc_method ?? storeSettings?.booking_calc_method ?? 'calendar';

  // Check advance booking limit (month-based for store, day-based for staff)
  const now = new Date();
  const jstNowForCalc = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const requestedDate = new Date(date + 'T00:00:00+09:00');

  // Store max: last day of (current JST month + N months)
  const jstYear = jstNowForCalc.getUTCFullYear();
  const jstMonth = jstNowForCalc.getUTCMonth();
  const storeMaxDateObj = new Date(Date.UTC(jstYear, jstMonth + storeAdvanceMonths, 0));
  const storeMaxDateStr = `${storeMaxDateObj.getUTCFullYear()}-${String(storeMaxDateObj.getUTCMonth() + 1).padStart(2, '0')}-${String(storeMaxDateObj.getUTCDate()).padStart(2, '0')}`;

  // Staff advance booking limit (days-based, if set)
  let maxBookingDateStr = storeMaxDateStr;
  if (staffSettings?.advance_booking_days) {
    const staffMaxDate = new Date(jstNowForCalc);
    staffMaxDate.setUTCDate(staffMaxDate.getUTCDate() + staffSettings.advance_booking_days);
    const staffMaxStr = `${staffMaxDate.getUTCFullYear()}-${String(staffMaxDate.getUTCMonth() + 1).padStart(2, '0')}-${String(staffMaxDate.getUTCDate()).padStart(2, '0')}`;
    if (staffMaxStr < storeMaxDateStr) {
      maxBookingDateStr = staffMaxStr;
    }
  }

  if (date > maxBookingDateStr) {
    return c.json({ slots: [], advance_limit: true, max_booking_date: maxBookingDateStr });
  }

  // Pre-fetch business day data for cutoff calculation if needed
  let closedDaysSet = new Set<number>();
  let closureDatesSet = new Set<string>();
  if (calcMethod === 'business_days') {
    const bhResult = await c.env.DB.prepare(
      'SELECT day_of_week, is_closed FROM business_hours WHERE store_id = ?'
    ).bind(storeId).all<{ day_of_week: number; is_closed: number }>();
    closedDaysSet = new Set(bhResult.results.filter(h => h.is_closed === 1).map(h => h.day_of_week));

    const rangeStart = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const rangeEnd = new Date(Date.now() + 400 * 86400000).toISOString().slice(0, 10);
    const closuresResult = await c.env.DB.prepare(
      'SELECT date FROM store_closures WHERE store_id = ? AND date >= ? AND date <= ?'
    ).bind(storeId, rangeStart, rangeEnd).all<{ date: string }>();
    closureDatesSet = new Set(closuresResult.results.map(cl => cl.date));
  }

  // Check days-before cutoff (entire date is either open or cutoff)
  if (cutoffType === 'days_before' && cutoffDaysBefore > 0) {
    let cutoffDate: Date;
    if (calcMethod === 'business_days') {
      // Count backward N business days from requested date
      let businessDaysBack = 0;
      const checkDate = new Date(requestedDate);
      while (businessDaysBack < cutoffDaysBefore) {
        checkDate.setUTCDate(checkDate.getUTCDate() - 1);
        const checkStr = checkDate.toISOString().slice(0, 10);
        const dow = checkDate.getUTCDay();
        if (!closedDaysSet.has(dow) && !closureDatesSet.has(checkStr)) {
          businessDaysBack++;
        }
      }
      cutoffDate = checkDate;
    } else {
      cutoffDate = new Date(requestedDate);
      cutoffDate.setUTCDate(cutoffDate.getUTCDate() - cutoffDaysBefore);
    }
    // Apply cutoff time
    const ct = cutoffTime || '24:00';
    const [ctH, ctM] = ct.split(':').map(Number);
    const cutoffDateTime = new Date(cutoffDate);
    if (ctH === 24) {
      cutoffDateTime.setUTCDate(cutoffDateTime.getUTCDate() + 1);
      cutoffDateTime.setUTCHours(0, 0, 0, 0);
    } else {
      cutoffDateTime.setUTCHours(ctH, ctM, 0, 0);
    }
    // cutoffDateTime is in JST (we used +09:00 base), compare with jstNow
    if (jstNowForCalc >= cutoffDateTime) {
      return c.json({ slots: [], cutoff: true });
    }
  }

  // Get existing reservations
  let reservationsQuery = `
    SELECT staff_id, start_at, end_at FROM reservations
    WHERE store_id = ? AND DATE(start_at) = ? AND status NOT IN ('cancelled', 'noshow')
  `;
  const params: string[] = [storeId, date];

  if (staffId) {
    reservationsQuery += ' AND staff_id = ?';
    params.push(staffId);
  }

  const reservations = await c.env.DB.prepare(reservationsQuery)
    .bind(...params)
    .all<{ staff_id: string; start_at: string; end_at: string }>();

  // Fetch required equipment for this menu (for equipment availability check)
  let requiredEquipment: { id: string; name: string; quantity: number }[] = [];
  if (menuId) {
    const eqResult = await c.env.DB.prepare(
      `SELECT e.id, e.name, e.quantity FROM equipment e
       JOIN menu_equipment me ON e.id = me.equipment_id
       WHERE me.menu_id = ? AND e.is_active = 1`
    ).bind(menuId).all<{ id: string; name: string; quantity: number }>();
    requiredEquipment = eqResult.results;
  }

  // Fetch all reservations for equipment check (all staff in the store for the date)
  let allStoreReservations: { id: string; menu_id: string; start_at: string; end_at: string }[] = [];
  if (requiredEquipment.length > 0) {
    const allResResult = await c.env.DB.prepare(
      `SELECT r.id, r.menu_id, r.start_at, r.end_at FROM reservations r
       WHERE r.store_id = ? AND DATE(r.start_at) = ? AND r.status NOT IN ('cancelled', 'noshow')`
    ).bind(storeId, date).all<{ id: string; menu_id: string; start_at: string; end_at: string }>();
    allStoreReservations = allResResult.results;

    // Pre-fetch which equipment each menu uses (for all reservations on that day)
    const menuIdsOnDay = [...new Set(allStoreReservations.map(r => r.menu_id).filter(Boolean))];
    const menuEquipmentMap = new Map<string, string[]>();
    if (menuIdsOnDay.length > 0) {
      const CHUNK = 50;
      for (let i = 0; i < menuIdsOnDay.length; i += CHUNK) {
        const chunk = menuIdsOnDay.slice(i, i + CHUNK);
        const ph = chunk.map(() => '?').join(',');
        const meResult = await c.env.DB.prepare(
          `SELECT menu_id, equipment_id FROM menu_equipment WHERE menu_id IN (${ph})`
        ).bind(...chunk).all<{ menu_id: string; equipment_id: string }>();
        for (const row of meResult.results) {
          if (!menuEquipmentMap.has(row.menu_id)) menuEquipmentMap.set(row.menu_id, []);
          menuEquipmentMap.get(row.menu_id)!.push(row.equipment_id);
        }
      }
    }
    // Attach equipment info to reservations for quick lookup
    (allStoreReservations as (typeof allStoreReservations[0] & { equipment_ids?: string[] })[]).forEach(r => {
      (r as typeof r & { equipment_ids: string[] }).equipment_ids = menuEquipmentMap.get(r.menu_id) || [];
    });
  }

  // Check staff blocks for the day
  let staffBlocks: { is_all_day: number; start_time: string | null; end_time: string | null }[] = [];
  if (staffId) {
    const blocksResult = await c.env.DB.prepare(
      `SELECT is_all_day, start_time, end_time FROM staff_blocks
       WHERE staff_id = ? AND (store_id = ? OR store_id IS NULL) AND date = ?`
    ).bind(staffId, storeId, date).all<{ is_all_day: number; start_time: string | null; end_time: string | null }>();
    staffBlocks = blocksResult.results;

    // If there's an all-day block, return empty slots
    if (staffBlocks.some(b => b.is_all_day === 1)) {
      return c.json({ slots: [], blocked: true });
    }
  }

  // Pre-fetch staff data for availability checks
  // Used for: (1) altStaffMap when specific staff is selected, (2) eligibleStaffMap when 指名なし
  type StaffAvailData = {
    id: string;
    hours: { open_time: string; close_time: string } | null;
    blocks: { is_all_day: number; start_time: string | null; end_time: string | null }[];
    reservations: { start_at: string; end_at: string }[];
    maxConcurrent: number;
  };
  const altStaffMap = new Map<string, StaffAvailData>();
  const eligibleStaffMap = new Map<string, StaffAvailData>();

  if (staffId && menuId) {
    // Get eligible staff for this menu (excluding current staff)
    const menuStaffCount = await c.env.DB.prepare(
      'SELECT COUNT(*) as count FROM menu_staff WHERE menu_id = ?'
    ).bind(menuId).first<{ count: number }>();

    let altQuery: string;
    const altParams: string[] = [storeId];

    if (menuStaffCount && menuStaffCount.count > 0) {
      altQuery = `
        SELECT DISTINCT s.id FROM staff s
        JOIN staff_stores ss ON s.id = ss.staff_id
        JOIN menu_staff ms ON s.id = ms.staff_id
        WHERE ss.store_id = ? AND s.is_active = 1 AND ss.is_visible_to_customer = 1
        AND s.role != 'system_admin' AND ms.menu_id = ? AND s.id != ?
      `;
      altParams.push(menuId, staffId);
    } else {
      altQuery = `
        SELECT DISTINCT s.id FROM staff s
        JOIN staff_stores ss ON s.id = ss.staff_id
        WHERE ss.store_id = ? AND s.is_active = 1 AND ss.is_visible_to_customer = 1
        AND s.role != 'system_admin' AND s.id != ?
      `;
      altParams.push(staffId);
    }

    const altStaff = await c.env.DB.prepare(altQuery).bind(...altParams).all<{ id: string }>();

    for (const alt of altStaff.results) {
      // Get business hours (use effectiveDayOfWeek for holidays)
      let altHours: { open_time: string | null; close_time: string | null; is_closed: number } | null = null;
      if (!holidayHoursEnabled || !dateIsHoliday) {
        altHours = await c.env.DB.prepare(
          'SELECT open_time, close_time, is_closed FROM staff_business_hours WHERE staff_id = ? AND store_id = ? AND day_of_week = ?'
        ).bind(alt.id, storeId, dayOfWeek).first<{ open_time: string | null; close_time: string | null; is_closed: number }>();
      }

      if (!altHours) {
        altHours = await c.env.DB.prepare(
          'SELECT open_time, close_time, is_closed FROM business_hours WHERE store_id = ? AND day_of_week = ?'
        ).bind(storeId, effectiveDayOfWeek).first<{ open_time: string | null; close_time: string | null; is_closed: number }>();
      }

      // Skip if closed
      if (!altHours || altHours.is_closed || !altHours.open_time || !altHours.close_time) continue;

      // Get blocks
      const altBlocks = await c.env.DB.prepare(
        `SELECT is_all_day, start_time, end_time FROM staff_blocks
         WHERE staff_id = ? AND (store_id = ? OR store_id IS NULL) AND date = ?`
      ).bind(alt.id, storeId, date).all<{ is_all_day: number; start_time: string | null; end_time: string | null }>();

      // Skip if all-day block
      if (altBlocks.results.some(b => b.is_all_day === 1)) continue;

      // Get reservations
      const altRes = await c.env.DB.prepare(
        `SELECT start_at, end_at FROM reservations
         WHERE staff_id = ? AND store_id = ? AND DATE(start_at) = ? AND status NOT IN ('cancelled', 'noshow')`
      ).bind(alt.id, storeId, date).all<{ start_at: string; end_at: string }>();

      // Get max concurrent (staff settings → per-day → store default)
      const altSettings = await c.env.DB.prepare(
        'SELECT max_concurrent FROM staff_reservation_settings WHERE staff_id = ? AND store_id = ?'
      ).bind(alt.id, storeId).first<{ max_concurrent: number }>();

      altStaffMap.set(alt.id, {
        id: alt.id,
        hours: { open_time: altHours.open_time!, close_time: altHours.close_time! },
        blocks: altBlocks.results,
        reservations: altRes.results,
        maxConcurrent: altSettings?.max_concurrent ?? 1,
      });
    }
  }

  // Pre-fetch eligible staff data for 指名なし (no staff selected)
  // This ensures available-slots check matches reservation creation logic
  if (!staffId && menuId) {
    const menuStaffCount = await c.env.DB.prepare(
      'SELECT COUNT(*) as count FROM menu_staff WHERE menu_id = ?'
    ).bind(menuId).first<{ count: number }>();

    let eligibleQuery: string;
    const eligibleParams: string[] = [storeId];

    if (menuStaffCount && menuStaffCount.count > 0) {
      eligibleQuery = `
        SELECT DISTINCT s.id FROM staff s
        JOIN staff_stores ss ON s.id = ss.staff_id
        JOIN menu_staff ms ON s.id = ms.staff_id
        WHERE ss.store_id = ? AND s.is_active = 1 AND ss.is_visible_to_customer = 1
        AND s.role != 'system_admin' AND ms.menu_id = ?
      `;
      eligibleParams.push(menuId);
    } else {
      eligibleQuery = `
        SELECT DISTINCT s.id FROM staff s
        JOIN staff_stores ss ON s.id = ss.staff_id
        WHERE ss.store_id = ? AND s.is_active = 1 AND ss.is_visible_to_customer = 1
        AND s.role != 'system_admin'
      `;
    }

    const eligibleStaff = await c.env.DB.prepare(eligibleQuery).bind(...eligibleParams).all<{ id: string }>();

    for (const es of eligibleStaff.results) {
      // Get business hours
      let esHours: { open_time: string | null; close_time: string | null; is_closed: number } | null = null;
      if (!holidayHoursEnabled || !dateIsHoliday) {
        esHours = await c.env.DB.prepare(
          'SELECT open_time, close_time, is_closed FROM staff_business_hours WHERE staff_id = ? AND store_id = ? AND day_of_week = ?'
        ).bind(es.id, storeId, dayOfWeek).first<{ open_time: string | null; close_time: string | null; is_closed: number }>();
      }
      if (!esHours) {
        esHours = await c.env.DB.prepare(
          'SELECT open_time, close_time, is_closed FROM business_hours WHERE store_id = ? AND day_of_week = ?'
        ).bind(storeId, effectiveDayOfWeek).first<{ open_time: string | null; close_time: string | null; is_closed: number }>();
      }
      if (!esHours || esHours.is_closed || !esHours.open_time || !esHours.close_time) continue;

      // Get blocks
      const esBlocks = await c.env.DB.prepare(
        `SELECT is_all_day, start_time, end_time FROM staff_blocks
         WHERE staff_id = ? AND (store_id = ? OR store_id IS NULL) AND date = ?`
      ).bind(es.id, storeId, date).all<{ is_all_day: number; start_time: string | null; end_time: string | null }>();
      if (esBlocks.results.some(b => b.is_all_day === 1)) continue;

      // Get reservations
      const esRes = await c.env.DB.prepare(
        `SELECT start_at, end_at FROM reservations
         WHERE staff_id = ? AND store_id = ? AND DATE(start_at) = ? AND status NOT IN ('cancelled', 'noshow')`
      ).bind(es.id, storeId, date).all<{ start_at: string; end_at: string }>();

      // Get max concurrent
      const esSettings = await c.env.DB.prepare(
        'SELECT max_concurrent FROM staff_reservation_settings WHERE staff_id = ? AND store_id = ?'
      ).bind(es.id, storeId).first<{ max_concurrent: number }>();

      eligibleStaffMap.set(es.id, {
        id: es.id,
        hours: { open_time: esHours.open_time!, close_time: esHours.close_time! },
        blocks: esBlocks.results,
        reservations: esRes.results,
        maxConcurrent: esSettings?.max_concurrent ?? 1,
      });
    }
  }

  // Generate time slots
  const slots: { time: string; available: boolean; available_other_staff?: boolean }[] = [];
  const openTime = effectiveHours.open_time!;
  const closeTime = effectiveHours.close_time!;

  const [openHour, openMin] = openTime.split(':').map(Number);
  const [closeHour, closeMin] = closeTime.split(':').map(Number);

  const startMinutes = openHour * 60 + openMin;
  const endMinutes = closeHour * 60 + closeMin;

  // Use JST for "today" check and same-day cutoff since business hours/slots are in JST
  const jstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const todayStr = jstNow.toISOString().slice(0, 10);
  const isToday = date === todayStr;
  // Same-day cutoff: use new booking_cutoff_same_day_minutes if cutoff type is same_day
  const sameDayCutoffMinutes = cutoffType === 'same_day' ? cutoffSameDayMinutes : 0;
  const nowMinutes = isToday ? jstNow.getUTCHours() * 60 + jstNow.getUTCMinutes() + sameDayCutoffMinutes : 0;

  for (let time = startMinutes; time <= endMinutes - duration; time += 30) {
    // Same-day cutoff check
    if (isToday && time < nowMinutes) {
      continue;
    }

    const hour = Math.floor(time / 60);
    const min = time % 60;
    const timeStr = `${hour.toString().padStart(2, '0')}:${min.toString().padStart(2, '0')}`;
    // Convert JST slot times to UTC ISO strings for correct comparison with DB values (stored in UTC)
    const slotStart = new Date(`${date}T${timeStr}:00+09:00`).toISOString();
    const endHH = Math.floor((time + duration) / 60).toString().padStart(2, '0');
    const endMM = ((time + duration) % 60).toString().padStart(2, '0');
    const slotEnd = new Date(`${date}T${endHH}:${endMM}:00+09:00`).toISOString();

    const slotEndMinutes = time + duration;
    const slotEndTime = `${Math.floor(slotEndMinutes / 60).toString().padStart(2, '0')}:${(slotEndMinutes % 60).toString().padStart(2, '0')}`;

    let isAvailable: boolean;

    if (!staffId && eligibleStaffMap.size > 0) {
      // 指名なし: check if at least one eligible staff can take this slot
      // This matches the logic used in POST /reservations/guest staff assignment
      isAvailable = false;
      for (const [, es] of eligibleStaffMap) {
        // Check hours
        if (!es.hours || timeStr < es.hours.open_time || slotEndTime > es.hours.close_time) continue;

        // Check blocks
        let blocked = false;
        for (const block of es.blocks) {
          if (!block.is_all_day && block.start_time && block.end_time) {
            if (block.start_time < slotEndTime && block.end_time > timeStr) {
              blocked = true;
              break;
            }
          }
        }
        if (blocked) continue;

        // Check reservation overlap
        const overlap = es.reservations.filter(r =>
          slotStart < r.end_at && slotEnd > r.start_at
        );
        if (overlap.length >= es.maxConcurrent) continue;

        isAvailable = true;
        break;
      }

      // Also check store-level capacity
      if (isAvailable) {
        const totalOverlapping = reservations.results.filter(r =>
          slotStart < r.end_at && slotEnd > r.start_at
        );
        if (totalOverlapping.length >= maxConcurrent) {
          isAvailable = false;
        }
      }
    } else {
      // Specific staff selected: original logic
      const overlapping = reservations.results.filter((r) => {
        return (
          (!staffId || r.staff_id === staffId) &&
          (slotStart < r.end_at && slotEnd > r.start_at)
        );
      });

      isAvailable = overlapping.length < maxConcurrent;

      // Staff block check (time-range blocks)
      if (isAvailable && staffBlocks.length > 0) {
        for (const block of staffBlocks) {
          if (!block.is_all_day && block.start_time && block.end_time) {
            if (block.start_time < slotEndTime && block.end_time > timeStr) {
              isAvailable = false;
              break;
            }
          }
        }
      }
    }

    // Equipment availability check
    if (isAvailable && requiredEquipment.length > 0) {
      for (const eq of requiredEquipment) {
        const eqUsage = (allStoreReservations as (typeof allStoreReservations[0] & { equipment_ids: string[] })[])
          .filter(r =>
            r.equipment_ids.includes(eq.id) &&
            r.start_at < slotEnd && r.end_at > slotStart
          ).length;
        if (eqUsage >= eq.quantity) {
          isAvailable = false;
          break;
        }
      }
    }

    // Check if available with other staff when this staff is unavailable
    let availableOtherStaff: boolean | undefined;
    if (!isAvailable && staffId && altStaffMap.size > 0) {
      for (const [, alt] of altStaffMap) {
        // Check hours
        if (!alt.hours || timeStr < alt.hours.open_time || slotEndTime > alt.hours.close_time) continue;

        // Check blocks
        let altBlocked = false;
        for (const block of alt.blocks) {
          if (!block.is_all_day && block.start_time && block.end_time) {
            if (block.start_time < slotEndTime && block.end_time > timeStr) {
              altBlocked = true;
              break;
            }
          }
        }
        if (altBlocked) continue;

        // Check reservation overlap (standard interval overlap)
        const altOverlapping = alt.reservations.filter(r =>
          slotStart < r.end_at && slotEnd > r.start_at
        );
        if (altOverlapping.length >= alt.maxConcurrent) continue;

        // Check equipment (reuse pre-fetched data)
        let eqOk = true;
        if (requiredEquipment.length > 0) {
          for (const eq of requiredEquipment) {
            const eqUsage = (allStoreReservations as (typeof allStoreReservations[0] & { equipment_ids: string[] })[])
              .filter(r =>
                r.equipment_ids.includes(eq.id) &&
                r.start_at < slotEnd && r.end_at > slotStart
              ).length;
            if (eqUsage >= eq.quantity) {
              eqOk = false;
              break;
            }
          }
        }
        if (!eqOk) continue;

        availableOtherStaff = true;
        break;
      }
    }

    slots.push({
      time: timeStr,
      available: isAvailable,
      ...(availableOtherStaff && { available_other_staff: true }),
    });
  }

  return c.json({ slots, open_time: openTime, close_time: closeTime, max_booking_date: maxBookingDateStr, is_holiday: dateIsHoliday || undefined });
});

// Guest reservation (no auth required)
customerRoutes.post('/reservations/guest', async (c) => {
  const body = await c.req.json<{
    store_id: string;
    staff_id?: string;
    menu_id: string;
    menu_ids?: string[];
    start_at: string;
    memo?: string;
    phone: string;
    name: string;
    name_kana?: string;
    is_first_visit?: boolean;
    liff_access_token?: string;
  }>();

  const menuIds = body.menu_ids || [body.menu_id];

  if (!body.store_id || menuIds.length === 0 || !body.start_at || !body.phone || !body.name) {
    return c.json({ error: 'Missing required fields' }, 400);
  }

  // Find or create customer by phone in this store
  let customer = await c.env.DB.prepare(
    'SELECT * FROM customers WHERE store_id = ? AND phone = ? LIMIT 1'
  ).bind(body.store_id, body.phone).first<Customer>();

  if (!customer) {
    const customerId = crypto.randomUUID();
    await c.env.DB.prepare(
      `INSERT INTO customers (id, store_id, name, name_kana, phone, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
    ).bind(customerId, body.store_id, body.name, body.name_kana || null, body.phone).run();
    customer = await c.env.DB.prepare('SELECT * FROM customers WHERE id = ?')
      .bind(customerId).first<Customer>();
  } else {
    // 名前・ふりがなが変更された場合のみ更新
    if (body.name && body.name !== customer.name) {
      await c.env.DB.prepare(
        "UPDATE customers SET name = ?, updated_at = datetime('now') WHERE id = ?"
      ).bind(body.name, customer.id).run();
      customer = await c.env.DB.prepare('SELECT * FROM customers WHERE id = ?')
        .bind(customer.id).first<Customer>() || customer;
    }
    if (body.name_kana && body.name_kana !== customer.name_kana) {
      await c.env.DB.prepare(
        "UPDATE customers SET name_kana = ?, updated_at = datetime('now') WHERE id = ?"
      ).bind(body.name_kana, customer.id).run();
      customer = await c.env.DB.prepare('SELECT * FROM customers WHERE id = ?')
        .bind(customer.id).first<Customer>() || customer;
    }
  }

  if (!customer) {
    return c.json({ error: 'Failed to create customer' }, 500);
  }

  // 店舗跨ぎ会員番号を割り当て（電話一致で既存マスタにリンク / 無ければ新規採番）
  try {
    await getOrCreateMaster(c.env.DB, { customerId: customer.id, phone: customer.phone, storeId: body.store_id });
  } catch (err) {
    console.error('[customer-master] guest reservation assign failed:', err);
  }

  // Link LINE user ID if LIFF access token provided
  if (body.liff_access_token) {
    try {
      const verifyRes = await fetch(
        `https://api.line.me/oauth2/v2.1/verify?access_token=${encodeURIComponent(body.liff_access_token)}`
      );
      if (verifyRes.ok) {
        const verifyData = await verifyRes.json<{ expires_in: number }>();
        if (verifyData.expires_in > 0) {
          const profileRes = await fetch('https://api.line.me/v2/profile', {
            headers: { Authorization: `Bearer ${body.liff_access_token}` },
          });
          if (profileRes.ok) {
            const profile = await profileRes.json<{
              userId: string;
              displayName: string;
              pictureUrl?: string;
            }>();

            // Check if customer_line already exists for this LINE user in this store
            const existingLine = await c.env.DB.prepare(
              `SELECT cl.customer_id FROM customer_line cl
               JOIN customers c ON cl.customer_id = c.id
               WHERE cl.line_user_id = ? AND c.store_id = ?`
            ).bind(profile.userId, body.store_id)
              .first<{ customer_id: string }>();

            if (!existingLine) {
              // Create customer_line — directly link LINE ID to this customer
              await c.env.DB.prepare(
                `INSERT INTO customer_line (id, customer_id, store_id, line_user_id, display_name, picture_url, registration_status, linked_at, updated_at)
                 VALUES (?, ?, (SELECT store_id FROM customers WHERE id = ?), ?, ?, ?, 'completed', datetime('now'), datetime('now'))`
              ).bind(crypto.randomUUID(), customer.id, customer.id, profile.userId, profile.displayName, profile.pictureUrl || null).run();
              console.log('[guest-reservation] Created customer_line for', customer.name, profile.userId);
            } else if (existingLine.customer_id !== customer.id) {
              // LINE user already linked to a different customer — create merge candidate
              await searchAndCreateMergeCandidates(
                c.env.DB, existingLine.customer_id, customer.name, customer.phone,
                body.store_id, profile.displayName,
              );
              console.log('[guest-reservation] Merge candidate created: LINE customer', existingLine.customer_id, '→ guest customer', customer.id);
            }
          }
        }
      }
    } catch (err) {
      console.error('[guest-reservation] LIFF token processing failed:', err);
    }
  }

  // Get menus to calculate total duration
  const menuDataList: { id: string; name: string; duration: number; price: number }[] = [];
  for (const mid of menuIds) {
    const m = await c.env.DB.prepare('SELECT * FROM menus WHERE id = ? AND store_id = ?')
      .bind(mid, body.store_id)
      .first<Menu>();
    if (!m) {
      return c.json({ error: 'Menu not found' }, 404);
    }
    menuDataList.push({ id: m.id, name: m.name, duration: m.duration, price: m.price });
  }

  const totalDuration = menuDataList.reduce((s, m) => s + m.duration, 0);
  const primaryMenuId = menuIds[0];

  // Calculate end time from total duration
  const startDate = new Date(body.start_at);
  const endDate = new Date(startDate.getTime() + totalDuration * 60 * 1000);
  const endAt = endDate.toISOString();

  let staffId = body.staff_id;

  // Auto-assign staff if not specified
  if (!staffId) {
    const menuStaffCount = await c.env.DB.prepare(
      'SELECT COUNT(*) as count FROM menu_staff WHERE menu_id = ?'
    ).bind(primaryMenuId).first<{ count: number }>();

    let eligibleStaffQuery: string;
    const eligibleParams: string[] = [body.store_id];

    if (menuStaffCount && menuStaffCount.count > 0) {
      eligibleStaffQuery = `
        SELECT DISTINCT s.id FROM staff s
        JOIN staff_stores ss ON s.id = ss.staff_id
        JOIN menu_staff ms ON s.id = ms.staff_id
        WHERE ss.store_id = ? AND s.is_active = 1 AND ss.is_visible_to_customer = 1
        AND s.role != 'system_admin' AND ms.menu_id = ?
      `;
      eligibleParams.push(primaryMenuId);
    } else {
      eligibleStaffQuery = `
        SELECT DISTINCT s.id FROM staff s
        JOIN staff_stores ss ON s.id = ss.staff_id
        WHERE ss.store_id = ? AND s.is_active = 1 AND ss.is_visible_to_customer = 1
        AND s.role != 'system_admin'
      `;
    }

    const eligibleStaff = await c.env.DB.prepare(eligibleStaffQuery)
      .bind(...eligibleParams)
      .all<{ id: string }>();

    // Convert UTC to JST for business hours comparison (stored in JST)
    const startJST = new Date(new Date(body.start_at).getTime() + 9 * 60 * 60 * 1000);
    const endJST = new Date(new Date(endAt).getTime() + 9 * 60 * 60 * 1000);
    const date = startJST.toISOString().slice(0, 10);
    const startTime = startJST.toISOString().slice(11, 16);
    const endTime = endJST.toISOString().slice(11, 16);

    for (const staff of eligibleStaff.results) {
      // Check staff business hours
      const working = await isStaffWorking(c.env.DB, staff.id, body.store_id, date, startTime, endTime);
      if (!working) continue;

      // Check staff block
      const blocked = await isStaffBlocked(c.env.DB, staff.id, body.store_id, body.start_at, endAt);
      if (blocked) continue;

      const staffMaxConcurrent = await getMaxConcurrent(c.env.DB, staff.id, body.store_id, body.start_at);
      const overlapCount = await c.env.DB.prepare(
        `SELECT COUNT(*) as count FROM reservations
         WHERE staff_id = ?
         AND status NOT IN ('cancelled', 'noshow')
         AND start_at < ? AND end_at > ?`
      )
        .bind(staff.id, endAt, body.start_at)
        .first<{ count: number }>();

      if (!overlapCount || overlapCount.count < staffMaxConcurrent) {
        staffId = staff.id;
        break;
      }
    }

    if (!staffId) {
      return c.json({ error: 'この時間帯に対応可能なスタッフがいません' }, 400);
    }
  } else {
    // Check staff block for specified staff
    const blocked = await isStaffBlocked(c.env.DB, staffId, body.store_id, body.start_at, endAt);
    if (blocked) {
      return c.json({ error: 'このスタッフはこの時間帯にブロックが設定されています' }, 400);
    }

    const maxConcurrent = await getMaxConcurrent(c.env.DB, staffId, body.store_id, body.start_at);
    const overlapCount = await c.env.DB.prepare(
      `SELECT COUNT(*) as count FROM reservations
       WHERE staff_id = ?
       AND status NOT IN ('cancelled', 'noshow')
       AND start_at < ? AND end_at > ?`
    )
      .bind(staffId, endAt, body.start_at)
      .first<{ count: number }>();

    if (overlapCount && overlapCount.count >= maxConcurrent) {
      return c.json({ error: 'この時間帯はすでに予約が入っています' }, 400);
    }
  }

  // Equipment availability check for all menus
  for (const mid of menuIds) {
    const eqCheck = await checkEquipmentAvailability(c.env.DB, mid, body.store_id, body.start_at, endAt);
    if (!eqCheck.available) {
      return c.json({ error: eqCheck.error }, 409);
    }
  }

  // Build memo with first visit info
  let memo = body.memo || '';
  if (body.is_first_visit === true) {
    memo = memo ? `【初回指名】\n${memo}` : '【初回指名】';
  } else if (body.is_first_visit === false) {
    memo = memo ? `【リピート指名】\n${memo}` : '【リピート指名】';
  }

  const id = crypto.randomUUID();

  // Determine is_new_customer at creation time
  const custCheck = await c.env.DB.prepare('SELECT visit_count FROM customers WHERE id = ?')
    .bind(customer.id).first<{ visit_count: number }>();
  const webIsNew = custCheck ? (custCheck.visit_count === 0 ? 1 : 0) : null;

  // is_nominated: only 1 if customer explicitly specified a staff_id
  const isNominated = (body.staff_id && body.staff_id.trim() !== '') ? 1 : 0;

  await c.env.DB.prepare(
    `INSERT INTO reservations (id, store_id, customer_id, staff_id, menu_id, start_at, end_at, status, memo, source, is_new_customer, is_nominated)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, 'web', ?, ?)`
  )
    .bind(id, body.store_id, customer.id, staffId, primaryMenuId, body.start_at, endAt, memo || null, webIsNew, isNominated)
    .run();

  // Insert into reservation_menus
  for (let i = 0; i < menuDataList.length; i++) {
    const m = menuDataList[i];
    const rmId = crypto.randomUUID();
    await c.env.DB.prepare(
      `INSERT INTO reservation_menus (id, reservation_id, menu_id, menu_name, duration, price, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(rmId, id, m.id, m.name, m.duration, m.price, i).run();
  }

  await insertReservationLog(c.env.DB, {
    reservationId: id,
    eventType: 'created',
    actorType: 'customer',
    actorId: customer.id,
    actorName: customer.name,
    description: 'お客様がWeb予約しました',
    metadata: { source: 'web' },
  });

  const reservation = await c.env.DB.prepare(
    `SELECT r.*, m.name as menu_name, COALESCE(s.nickname, s.name) as staff_name
     FROM reservations r
     LEFT JOIN menus m ON r.menu_id = m.id
     LEFT JOIN staff s ON r.staff_id = s.id
     WHERE r.id = ?`
  )
    .bind(id)
    .first();

  // LINE notification to staff
  try {
    const allMenuNames = menuDataList.map((m: { name: string }) => m.name).join(', ');
    await StaffLineNotificationService.notifyNewReservation(c.env.DB, staffId, body.store_id, {
      customerName: customer!.name,
      menuName: allMenuNames,
      date: new Date(body.start_at),
      source: 'web',
    });
  } catch (error) {
    console.error('Failed to send LINE notification:', error);
  }

  // Web Push notification to staff
  if (c.env.VAPID_PUBLIC_KEY && c.env.VAPID_PRIVATE_KEY) {
    try {
      const { PushNotificationService } = await import('../services/pushService');
      const d = new Date(body.start_at);
      const dateStr = d.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric' });
      const timeStr = d.toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });
      const allMenuNames = menuDataList.map((m: { name: string }) => m.name).join(', ');
      const pushPayload = {
        title: '新しいWeb予約',
        body: `${customer!.name}様 ${dateStr} ${timeStr} ${allMenuNames}`,
        url: `/dashboard?highlight=${id}`,
        tag: `reservation-${id}`,
      };
      if (isNominated && staffId) {
        // 指名あり: 担当スタッフのみ
        await PushNotificationService.notifyStaff(c.env.DB, staffId, pushPayload, c.env.VAPID_PUBLIC_KEY, c.env.VAPID_PRIVATE_KEY);
      } else {
        // 指名なし/フリー: 店舗の有効スタッフ全員へ
        const storeStaff = await c.env.DB.prepare(
          `SELECT s.id FROM staff s JOIN staff_stores ss ON ss.staff_id = s.id WHERE ss.store_id = ? AND s.is_active = 1`
        ).bind(body.store_id).all<{ id: string }>();
        for (const row of (storeStaff.results || [])) {
          await PushNotificationService.notifyStaff(c.env.DB, row.id, pushPayload, c.env.VAPID_PUBLIC_KEY, c.env.VAPID_PRIVATE_KEY);
        }
      }
    } catch (error) {
      console.error('Failed to send reservation push:', error);
    }
  }

  // Search for merge candidates if customer has LINE link
  try {
    const lineInfo = await c.env.DB.prepare(
      'SELECT display_name FROM customer_line WHERE customer_id = ?'
    ).bind(customer!.id).first<{ display_name: string | null }>();
    if (lineInfo) {
      await searchAndCreateMergeCandidates(
        c.env.DB, customer!.id, customer!.name, customer!.phone,
        body.store_id, lineInfo.display_name,
      );
    }
  } catch (err) {
    console.error('[guest-reservation] Failed to search merge candidates:', err);
  }

  return c.json({ reservation }, 201);
});

// Guest message (no auth required) — like guest reservation
// Normalize phone number: +818012345678 → 08012345678, strip hyphens/spaces
function normalizePhone(phone: string): string {
  let p = phone.replace(/[\s\-()]/g, '');
  // +81 → 0
  if (p.startsWith('+81')) p = '0' + p.slice(3);
  // 81 (without +) at start with 10+ digits
  if (p.startsWith('81') && p.length >= 12) p = '0' + p.slice(2);
  return p;
}

customerRoutes.post('/messages/guest', async (c) => {
  const body = await c.req.json<{
    store_id: string;
    staff_id?: string;
    content: string;
    name: string;
    phone: string;
  }>();

  if (!body.store_id || !body.content || !body.name || !body.phone) {
    return c.json({ error: 'Missing required fields' }, 400);
  }

  const normalizedPhone = normalizePhone(body.phone);

  // Find customer by phone (try normalized, original, and +81 variants)
  let customer = await c.env.DB.prepare(
    `SELECT * FROM customers WHERE store_id = ? AND (phone = ? OR phone = ? OR phone = ?) LIMIT 1`
  ).bind(
    body.store_id,
    normalizedPhone,
    body.phone,
    '+81' + normalizedPhone.slice(1)
  ).first<Customer>();

  if (!customer) {
    const customerId = crypto.randomUUID();
    await c.env.DB.prepare(
      `INSERT INTO customers (id, store_id, name, phone, created_at, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`
    ).bind(customerId, body.store_id, body.name, normalizedPhone).run();
    customer = await c.env.DB.prepare('SELECT * FROM customers WHERE id = ?')
      .bind(customerId).first<Customer>();
  } else {
    if (customer.name !== body.name) {
      await c.env.DB.prepare(
        "UPDATE customers SET name = ?, updated_at = datetime('now') WHERE id = ?"
      ).bind(body.name, customer.id).run();
    }
    // Normalize stored phone if it differs
    if (customer.phone && customer.phone !== normalizedPhone && customer.phone.startsWith('+')) {
      await c.env.DB.prepare(
        "UPDATE customers SET phone = ?, updated_at = datetime('now') WHERE id = ?"
      ).bind(normalizedPhone, customer.id).run();
    }
  }

  if (!customer) {
    return c.json({ error: 'Failed to create customer' }, 500);
  }

  // 店舗跨ぎ会員番号を割り当て（電話一致で既存マスタにリンク / 無ければ新規採番）
  try {
    await getOrCreateMaster(c.env.DB, { customerId: customer.id, phone: customer.phone, storeId: body.store_id });
  } catch (err) {
    console.error('[customer-master] guest message assign failed:', err);
  }

  const id = crypto.randomUUID();

  await c.env.DB.prepare(
    `INSERT INTO messages (id, store_id, customer_id, staff_id, direction, message_type, content, source, sent_at)
     VALUES (?, ?, ?, ?, 'incoming', 'text', ?, 'web', datetime('now'))`
  )
    .bind(id, body.store_id, customer.id, body.staff_id || null, body.content)
    .run();

  // Notify staff (Web Push only) — 担当ありは担当へ、担当なし(店舗宛て)は店舗の全スタッフへ
  if (c.env.VAPID_PUBLIC_KEY && c.env.VAPID_PRIVATE_KEY) {
    try {
      const { PushNotificationService } = await import('../services/pushService');
      let result;
      if (body.staff_id) {
        result = await PushNotificationService.notifyStaff(
          c.env.DB, body.staff_id,
          { title: `${body.name}さんからメッセージ`, body: body.content.substring(0, 100), url: '/messages', tag: `message-guest` },
          c.env.VAPID_PUBLIC_KEY, c.env.VAPID_PRIVATE_KEY,
        );
      } else {
        result = await PushNotificationService.notifyStoreOnCustomerMessage(
          c.env.DB, body.store_id, customer.id, body.name, body.content,
          c.env.VAPID_PUBLIC_KEY, c.env.VAPID_PRIVATE_KEY,
        );
      }
      console.log(`[Push] Guest message push result: sent=${result.sent}, failed=${result.failed}`);
    } catch (error) {
      console.error('Failed to send push notification:', error);
    }
  }

  const message = await c.env.DB.prepare(
    `SELECT m.*, COALESCE(s.nickname, s.name) as staff_name, s.avatar_url as staff_avatar
     FROM messages m LEFT JOIN staff s ON m.staff_id = s.id
     WHERE m.id = ?`
  ).bind(id).first();

  const transformed = {
    id: message!.id,
    store_id: message!.store_id,
    customer_id: message!.customer_id,
    staff_id: message!.staff_id,
    sender_type: 'customer',
    content: message!.content,
    is_read: message!.is_read,
    sent_at: message!.sent_at,
    source: message!.source,
    sender: null,
  };

  return c.json({ message: transformed, customer_id: customer.id }, 201);
});

// LIFF guest message (no auth required — uses LIFF access token to identify LINE user)
customerRoutes.post('/messages/liff-guest', async (c) => {
  const body = await c.req.json<{
    store_id: string;
    staff_id?: string;
    content: string;
    liff_access_token: string;
  }>();

  if (!body.store_id || !body.content || !body.liff_access_token) {
    return c.json({ error: 'Missing required fields' }, 400);
  }

  // Verify LIFF access token with LINE
  const verifyRes = await fetch(
    `https://api.line.me/oauth2/v2.1/verify?access_token=${encodeURIComponent(body.liff_access_token)}`
  );
  if (!verifyRes.ok) {
    return c.json({ error: 'Invalid LIFF access token' }, 401);
  }
  const verifyData = await verifyRes.json<{ expires_in: number }>();
  if (verifyData.expires_in <= 0) {
    return c.json({ error: 'LIFF access token expired' }, 401);
  }

  // Get LINE profile
  const profileRes = await fetch('https://api.line.me/v2/profile', {
    headers: { Authorization: `Bearer ${body.liff_access_token}` },
  });
  if (!profileRes.ok) {
    return c.json({ error: 'Failed to get LINE profile' }, 400);
  }
  const profile = await profileRes.json<{
    userId: string;
    displayName: string;
    pictureUrl?: string;
  }>();

  console.log('[liff-guest] LINE profile:', profile.userId, profile.displayName);

  // Check if customer_line exists for this LINE user in this store
  const existingLine = await c.env.DB.prepare(
    `SELECT cl.*, c.id as customer_id, c.name as customer_name, c.store_id
     FROM customer_line cl
     JOIN customers c ON cl.customer_id = c.id
     WHERE cl.line_user_id = ? AND c.store_id = ?`
  ).bind(profile.userId, body.store_id)
    .first<{ customer_id: string; customer_name: string; store_id: string; registration_status: string; line_user_id: string }>();

  let customerId: string;
  let customerName: string;
  let isNewLineUser = false;

  if (existingLine) {
    customerId = existingLine.customer_id;
    customerName = existingLine.customer_name;
    console.log('[liff-guest] Existing customer_line found:', customerId, customerName);
  } else {
    // Create new customer + customer_line
    isNewLineUser = true;
    customerId = crypto.randomUUID();
    customerName = profile.displayName || 'LINE ユーザー';

    await c.env.DB.prepare(
      `INSERT INTO customers (id, store_id, name, auth_method, created_at, updated_at)
       VALUES (?, ?, ?, 'line', datetime('now'), datetime('now'))`
    ).bind(customerId, body.store_id, customerName).run();

    await c.env.DB.prepare(
      `INSERT INTO customer_line (id, customer_id, store_id, line_user_id, display_name, picture_url, registration_status, linked_at, updated_at)
       VALUES (?, ?, (SELECT store_id FROM customers WHERE id = ?), ?, ?, ?, 'pending_name', datetime('now'), datetime('now'))`
    ).bind(crypto.randomUUID(), customerId, customerId, profile.userId, profile.displayName, profile.pictureUrl || null).run();

    console.log('[liff-guest] Created new customer + customer_line:', customerId, customerName);
  }

  // Create message
  const msgId = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO messages (id, store_id, customer_id, staff_id, direction, message_type, content, source, sent_at)
     VALUES (?, ?, ?, ?, 'incoming', 'text', ?, 'web', datetime('now'))`
  ).bind(msgId, body.store_id, customerId, body.staff_id || null, body.content).run();

  // Notify staff (Web Push only) — 担当ありは担当へ、担当なし(店舗宛て)は店舗の全スタッフへ
  if (c.env.VAPID_PUBLIC_KEY && c.env.VAPID_PRIVATE_KEY) {
    try {
      const { PushNotificationService } = await import('../services/pushService');
      let result;
      if (body.staff_id) {
        result = await PushNotificationService.notifyStaff(
          c.env.DB, body.staff_id,
          { title: `${customerName}さんからメッセージ`, body: body.content.substring(0, 100), url: '/messages', tag: `message-${customerId}` },
          c.env.VAPID_PUBLIC_KEY, c.env.VAPID_PRIVATE_KEY,
        );
      } else {
        result = await PushNotificationService.notifyStoreOnCustomerMessage(
          c.env.DB, body.store_id, customerId, customerName, body.content,
          c.env.VAPID_PUBLIC_KEY, c.env.VAPID_PRIVATE_KEY,
        );
      }
      console.log(`[Push] LIFF guest message push result: sent=${result.sent}, failed=${result.failed}`);
    } catch (error) {
      console.error('[liff-guest] Failed to send push notification:', error);
    }
  }

  // Send registration welcome if new user OR registration not yet completed
  const needsRegistration = isNewLineUser || (existingLine && existingLine.registration_status !== 'completed');
  if (needsRegistration) {
    try {
      const store = await c.env.DB.prepare('SELECT name, line_liff_id FROM stores WHERE id = ?')
        .bind(body.store_id).first<{ name: string; line_liff_id: string | null }>();
      const accessToken = await getStoreLineAccessToken(c.env.DB, body.store_id);
      if (accessToken && store) {
        await pushMessage(profile.userId, [buildRegistrationWelcomeMessage(store.name, store.line_liff_id, body.store_id)], accessToken);
        console.log('[liff-guest] Sent registration welcome via LINE push for:', profile.userId);
      }
    } catch (error) {
      console.error('[liff-guest] Failed to send registration message:', error);
    }
  }

  const message = await c.env.DB.prepare(
    `SELECT m.*, COALESCE(s.nickname, s.name) as staff_name, s.avatar_url as staff_avatar
     FROM messages m LEFT JOIN staff s ON m.staff_id = s.id
     WHERE m.id = ?`
  ).bind(msgId).first();

  const transformed = {
    id: message!.id,
    store_id: message!.store_id,
    customer_id: message!.customer_id,
    staff_id: message!.staff_id,
    sender_type: 'customer',
    content: message!.content,
    is_read: message!.is_read,
    sent_at: message!.sent_at,
    source: message!.source,
    sender: null,
  };

  return c.json({ message: transformed, customer_id: customerId }, 201);
});

// LIFF guest message HISTORY — fetch a customer's own conversation by verified LINE identity.
// SECURITY: the customer is resolved ONLY from the LINE-verified userId (obtained by validating the
// LIFF access token against LINE's own servers), never from any client-supplied id. A customer can
// therefore only ever see messages linked to THEIR OWN LINE account at the given store — there is no
// parameter through which another customer's identity could be supplied or spoofed.
customerRoutes.post('/messages/liff-guest-history', async (c) => {
  const body = await c.req.json<{
    store_id: string;
    staff_id?: string;
    liff_access_token: string;
    limit?: number;
  }>();

  if (!body.store_id || !body.liff_access_token) {
    return c.json({ error: 'Missing required fields' }, 400);
  }

  // 1. Verify the LIFF access token with LINE (proves it is a real, unexpired token)
  const verifyRes = await fetch(
    `https://api.line.me/oauth2/v2.1/verify?access_token=${encodeURIComponent(body.liff_access_token)}`
  );
  if (!verifyRes.ok) {
    return c.json({ error: 'Invalid LIFF access token' }, 401);
  }
  const verifyData = await verifyRes.json<{ expires_in: number }>();
  if (verifyData.expires_in <= 0) {
    return c.json({ error: 'LIFF access token expired' }, 401);
  }

  // 2. Get the LINE profile — userId is proven by the token, NOT supplied by the client
  const profileRes = await fetch('https://api.line.me/v2/profile', {
    headers: { Authorization: `Bearer ${body.liff_access_token}` },
  });
  if (!profileRes.ok) {
    return c.json({ error: 'Failed to get LINE profile' }, 400);
  }
  const profile = await profileRes.json<{ userId: string }>();

  // 3. Resolve the customer ONLY from the verified line_user_id + store (un-spoofable)
  const link = await c.env.DB.prepare(
    `SELECT cl.customer_id FROM customer_line cl
     JOIN customers c ON cl.customer_id = c.id
     WHERE cl.line_user_id = ? AND c.store_id = ?`
  ).bind(profile.userId, body.store_id)
    .first<{ customer_id: string }>();

  if (!link) {
    return c.json({ messages: [] }); // no customer linked to this LINE user at this store
  }

  // 4. Return ONLY that customer's messages, scoped to the store (+ optional staff thread)
  const limit = body.limit || 50;
  let query = `SELECT m.*, COALESCE(s.nickname, s.name) as staff_name, s.avatar_url as staff_avatar
     FROM messages m LEFT JOIN staff s ON m.staff_id = s.id
     WHERE m.customer_id = ? AND m.store_id = ?`;
  const bindings: (string | number)[] = [link.customer_id, body.store_id];
  if (body.staff_id) {
    query += ' AND (m.staff_id = ? OR m.staff_id IS NULL)';
    bindings.push(body.staff_id);
  }
  query += ' ORDER BY m.sent_at DESC LIMIT ?';
  bindings.push(limit);

  const result = await c.env.DB.prepare(query).bind(...bindings).all();
  const messages = result.results.map((m: Record<string, unknown>) => ({
    id: m.id,
    store_id: m.store_id,
    customer_id: m.customer_id,
    staff_id: m.staff_id,
    sender_type: m.direction === 'incoming' ? 'customer' : 'store',
    content: m.content,
    is_read: m.is_read,
    sent_at: m.sent_at,
    source: m.source,
    sender: m.staff_id ? { id: m.staff_id, name: m.staff_name, avatar_url: m.staff_avatar } : null,
  }));

  return c.json({ messages: messages.reverse() });
});

// LIFF registration — update customer name/phone and complete registration
customerRoutes.post('/register/liff', async (c) => {
  const body = await c.req.json<{
    store_id: string;
    liff_access_token: string;
    name: string;
    phone?: string;
    type: 'returning' | 'new';
  }>();

  if (!body.store_id || !body.liff_access_token || !body.name?.trim()) {
    return c.json({ error: 'Missing required fields' }, 400);
  }

  // Verify LIFF access token with LINE
  const verifyRes = await fetch(
    `https://api.line.me/oauth2/v2.1/verify?access_token=${encodeURIComponent(body.liff_access_token)}`
  );
  if (!verifyRes.ok) {
    return c.json({ error: 'Invalid LIFF access token' }, 401);
  }

  // Get LINE profile
  const profileRes = await fetch('https://api.line.me/v2/profile', {
    headers: { Authorization: `Bearer ${body.liff_access_token}` },
  });
  if (!profileRes.ok) {
    return c.json({ error: 'Failed to get LINE profile' }, 401);
  }
  const profile = await profileRes.json<{ userId: string; displayName: string; pictureUrl?: string }>();

  // Find customer_line + customer
  const existing = await c.env.DB.prepare(
    `SELECT cl.*, c.id as customer_id, c.name as customer_name, c.store_id
     FROM customer_line cl JOIN customers c ON cl.customer_id = c.id
     WHERE cl.line_user_id = ? AND c.store_id = ?`
  ).bind(profile.userId, body.store_id).first<{
    customer_id: string;
    customer_name: string;
    store_id: string;
    registration_status: string;
    display_name: string | null;
  }>();

  let customerId: string;

  if (existing) {
    customerId = existing.customer_id;
  } else {
    // Create customer + customer_line if not exists
    customerId = crypto.randomUUID();
    await c.env.DB.prepare(
      `INSERT INTO customers (id, store_id, name, created_at, updated_at)
       VALUES (?, ?, ?, datetime('now'), datetime('now'))`
    ).bind(customerId, body.store_id, body.name.trim()).run();
    await c.env.DB.prepare(
      `INSERT INTO customer_line (id, customer_id, store_id, line_user_id, display_name, picture_url, registration_status)
       VALUES (?, ?, (SELECT store_id FROM customers WHERE id = ?), ?, ?, ?, 'pending_name')`
    ).bind(crypto.randomUUID(), customerId, customerId, profile.userId, profile.displayName, profile.pictureUrl || null).run();
  }

  // Update customer name and phone
  if (body.phone?.trim()) {
    await c.env.DB.prepare(
      "UPDATE customers SET name = ?, phone = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(body.name.trim(), body.phone.trim(), customerId).run();
  } else {
    await c.env.DB.prepare(
      "UPDATE customers SET name = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(body.name.trim(), customerId).run();
  }

  // Mark registration as completed
  await c.env.DB.prepare(
    "UPDATE customer_line SET registration_status = 'completed' WHERE customer_id = ? AND store_id = ?"
  ).bind(customerId, body.store_id).run();

  // Search for merge candidates (for all registration types)
  try {
    const lineDisplayName = existing?.display_name || profile.displayName || null;
    await searchAndCreateMergeCandidates(
      c.env.DB, customerId, body.name.trim(), body.phone?.trim() || null,
      body.store_id, lineDisplayName,
    );
  } catch (err) {
    console.error('[register/liff] Failed to search merge candidates:', err);
  }

  // Send LINE push confirmation
  try {
    const accessToken = await getStoreLineAccessToken(c.env.DB, body.store_id);
    if (accessToken) {
      await pushMessage(profile.userId, [
        { type: 'text', text: 'ご登録ありがとうございます！\nスタッフが確認してご連絡いたします。' },
      ], accessToken);
    }
  } catch (err) {
    console.error('[register/liff] Failed to send confirmation:', err);
  }

  return c.json({ success: true, customer_id: customerId });
});

// Protected routes

// Create reservation
protectedRoutes.post('/reservations', async (c) => {
  const customer = c.get('customer')!;
  const body = await c.req.json<{
    store_id?: string;
    staff_id?: string;
    menu_id: string;
    menu_ids?: string[];
    start_at: string;
    memo?: string;
    phone?: string;
    name?: string;
    name_kana?: string;
    is_first_visit?: boolean;
  }>();

  const menuIds = body.menu_ids || [body.menu_id];
  // Use store_id from request body (e.g. when browsing a different store) or fall back to customer's registered store
  const storeId = body.store_id || customer.store_id;

  if (menuIds.length === 0 || !body.start_at) {
    return c.json({ error: 'Missing required fields' }, 400);
  }

  // Get menus to calculate total duration
  const menuDataList: { id: string; name: string; duration: number; price: number }[] = [];
  for (const mid of menuIds) {
    const m = await c.env.DB.prepare('SELECT * FROM menus WHERE id = ? AND store_id = ?')
      .bind(mid, storeId)
      .first<Menu>();
    if (!m) {
      return c.json({ error: 'Menu not found' }, 404);
    }
    menuDataList.push({ id: m.id, name: m.name, duration: m.duration, price: m.price });
  }

  const totalDuration = menuDataList.reduce((s, m) => s + m.duration, 0);
  const primaryMenuId = menuIds[0];

  // Calculate end time from total duration
  const startDate = new Date(body.start_at);
  const endDate = new Date(startDate.getTime() + totalDuration * 60 * 1000);
  const endAt = endDate.toISOString();

  let staffId = body.staff_id;

  // Auto-assign staff if not specified (指名なし)
  if (!staffId) {
    // Get eligible staff for this menu
    const menuStaffCount = await c.env.DB.prepare(
      'SELECT COUNT(*) as count FROM menu_staff WHERE menu_id = ?'
    ).bind(primaryMenuId).first<{ count: number }>();

    let eligibleStaffQuery: string;
    const eligibleParams: string[] = [storeId];

    if (menuStaffCount && menuStaffCount.count > 0) {
      eligibleStaffQuery = `
        SELECT DISTINCT s.id FROM staff s
        JOIN staff_stores ss ON s.id = ss.staff_id
        JOIN menu_staff ms ON s.id = ms.staff_id
        WHERE ss.store_id = ? AND s.is_active = 1 AND ss.is_visible_to_customer = 1
        AND s.role != 'system_admin' AND ms.menu_id = ?
      `;
      eligibleParams.push(primaryMenuId);
    } else {
      eligibleStaffQuery = `
        SELECT DISTINCT s.id FROM staff s
        JOIN staff_stores ss ON s.id = ss.staff_id
        WHERE ss.store_id = ? AND s.is_active = 1 AND ss.is_visible_to_customer = 1
        AND s.role != 'system_admin'
      `;
    }

    const eligibleStaff = await c.env.DB.prepare(eligibleStaffQuery)
      .bind(...eligibleParams)
      .all<{ id: string }>();

    // Convert UTC to JST for business hours comparison (stored in JST)
    const startJST = new Date(new Date(body.start_at).getTime() + 9 * 60 * 60 * 1000);
    const endJST = new Date(new Date(endAt).getTime() + 9 * 60 * 60 * 1000);
    const pDate = startJST.toISOString().slice(0, 10);
    const pStartTime = startJST.toISOString().slice(11, 16);
    const pEndTime = endJST.toISOString().slice(11, 16);

    for (const staff of eligibleStaff.results) {
      // Check staff business hours
      const working = await isStaffWorking(c.env.DB, staff.id, storeId, pDate, pStartTime, pEndTime);
      if (!working) continue;

      // Check staff block
      const blocked = await isStaffBlocked(c.env.DB, staff.id, storeId, body.start_at, endAt);
      if (blocked) continue;

      const staffMaxConcurrent = await getMaxConcurrent(c.env.DB, staff.id, storeId, body.start_at);
      const overlapCount = await c.env.DB.prepare(
        `SELECT COUNT(*) as count FROM reservations
         WHERE staff_id = ?
         AND status NOT IN ('cancelled', 'noshow')
         AND start_at < ? AND end_at > ?`
      )
        .bind(staff.id, endAt, body.start_at)
        .first<{ count: number }>();

      if (!overlapCount || overlapCount.count < staffMaxConcurrent) {
        staffId = staff.id;
        break;
      }
    }

    if (!staffId) {
      return c.json({ error: 'この時間帯に対応可能なスタッフがいません' }, 400);
    }
  } else {
    // Check staff block for specified staff
    const blocked = await isStaffBlocked(c.env.DB, staffId, storeId, body.start_at, endAt);
    if (blocked) {
      return c.json({ error: 'このスタッフはこの時間帯にブロックが設定されています' }, 400);
    }

    const maxConcurrent = await getMaxConcurrent(c.env.DB, staffId, storeId, body.start_at);
    const overlapCount = await c.env.DB.prepare(
      `SELECT COUNT(*) as count FROM reservations
       WHERE staff_id = ?
       AND status NOT IN ('cancelled', 'noshow')
       AND start_at < ? AND end_at > ?`
    )
      .bind(staffId, endAt, body.start_at)
      .first<{ count: number }>();

    if (overlapCount && overlapCount.count >= maxConcurrent) {
      return c.json({ error: 'この時間帯はすでに予約が入っています' }, 400);
    }
  }

  // Equipment availability check for all menus
  for (const mid of menuIds) {
    const eqCheck = await checkEquipmentAvailability(c.env.DB, mid, storeId, body.start_at, endAt);
    if (!eqCheck.available) {
      return c.json({ error: eqCheck.error }, 409);
    }
  }

  // Build memo with first visit info
  let memo = body.memo || '';
  if (body.is_first_visit === true) {
    memo = memo ? `【初回指名】\n${memo}` : '【初回指名】';
  } else if (body.is_first_visit === false) {
    memo = memo ? `【リピート指名】\n${memo}` : '【リピート指名】';
  }

  // Update customer phone if provided
  if (body.phone) {
    await c.env.DB.prepare(
      "UPDATE customers SET phone = ?, updated_at = datetime('now') WHERE id = ?"
    )
      .bind(body.phone, customer.id)
      .run();
  }

  // Update customer name if changed
  console.log(`[name-update] body.name=${body.name}, customer.name=${customer.name}, match=${body.name === customer.name}`);
  if (body.name && body.name !== customer.name) {
    console.log(`[name-update] Updating customer ${customer.id} name: ${customer.name} -> ${body.name}`);
    await c.env.DB.prepare(
      "UPDATE customers SET name = ?, updated_at = datetime('now') WHERE id = ?"
    )
      .bind(body.name, customer.id)
      .run();
  }

  // ふりがなが変更された場合のみ更新
  if (body.name_kana && body.name_kana !== customer.name_kana) {
    await c.env.DB.prepare(
      "UPDATE customers SET name_kana = ?, updated_at = datetime('now') WHERE id = ?"
    )
      .bind(body.name_kana, customer.id)
      .run();
  }

  const id = crypto.randomUUID();

  // Determine is_new_customer at creation time
  const custCheck2 = await c.env.DB.prepare('SELECT visit_count FROM customers WHERE id = ?')
    .bind(customer.id).first<{ visit_count: number }>();
  const webIsNew2 = custCheck2 ? (custCheck2.visit_count === 0 ? 1 : 0) : null;

  const isNominated2 = (body.staff_id && body.staff_id.trim() !== '') ? 1 : 0;

  await c.env.DB.prepare(
    `INSERT INTO reservations (id, store_id, customer_id, staff_id, menu_id, start_at, end_at, status, memo, source, is_new_customer, is_nominated)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, 'web', ?, ?)`
  )
    .bind(id, storeId, customer.id, staffId, primaryMenuId, body.start_at, endAt, memo || null, webIsNew2, isNominated2)
    .run();

  // Insert into reservation_menus
  for (let i = 0; i < menuDataList.length; i++) {
    const m = menuDataList[i];
    const rmId = crypto.randomUUID();
    await c.env.DB.prepare(
      `INSERT INTO reservation_menus (id, reservation_id, menu_id, menu_name, duration, price, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(rmId, id, m.id, m.name, m.duration, m.price, i).run();
  }

  await insertReservationLog(c.env.DB, {
    reservationId: id,
    eventType: 'created',
    actorType: 'customer',
    actorId: customer.id,
    actorName: customer.name,
    description: 'ゲスト予約が作成されました',
    metadata: { source: 'web' },
  });

  // Search for merge candidates if customer has LINE link
  try {
    const lineInfo = await c.env.DB.prepare(
      'SELECT display_name FROM customer_line WHERE customer_id = ?'
    ).bind(customer.id).first<{ display_name: string | null }>();
    if (lineInfo) {
      const updatedCust = await c.env.DB.prepare('SELECT name, phone FROM customers WHERE id = ?')
        .bind(customer.id).first<{ name: string; phone: string | null }>();
      if (updatedCust) {
        await searchAndCreateMergeCandidates(
          c.env.DB, customer.id, updatedCust.name, updatedCust.phone,
          storeId, lineInfo.display_name,
        );
      }
    }
  } catch (err) {
    console.error('[customer/reservations] Failed to search merge candidates:', err);
  }

  const reservation = await c.env.DB.prepare(
    `SELECT r.*, m.name as menu_name, COALESCE(s.nickname, s.name) as staff_name
     FROM reservations r
     LEFT JOIN menus m ON r.menu_id = m.id
     LEFT JOIN staff s ON r.staff_id = s.id
     WHERE r.id = ?`
  )
    .bind(id)
    .first();

  // LINE notification to staff
  try {
    const allMenuNames = menuDataList.map((m: { name: string }) => m.name).join(', ');
    await StaffLineNotificationService.notifyNewReservation(c.env.DB, staffId, storeId, {
      customerName: customer.name,
      menuName: allMenuNames,
      date: new Date(body.start_at),
      source: 'web',
    });
  } catch (error) {
    console.error('Failed to send LINE notification:', error);
  }

  // Web Push notification to staff
  if (c.env.VAPID_PUBLIC_KEY && c.env.VAPID_PRIVATE_KEY) {
    try {
      const { PushNotificationService } = await import('../services/pushService');
      const d = new Date(body.start_at);
      const dateStr = d.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric' });
      const timeStr = d.toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });
      const allMenuNames = menuDataList.map((m: { name: string }) => m.name).join(', ');
      const pushPayload = {
        title: '新しいWeb予約',
        body: `${customer.name}様 ${dateStr} ${timeStr} ${allMenuNames}`,
        url: `/dashboard?highlight=${id}`,
        tag: `reservation-${id}`,
      };
      const isNominated = (reservation as unknown as { is_nominated?: number } | null)?.is_nominated === 1;
      if (isNominated && staffId) {
        // 指名あり: 担当スタッフのみ
        await PushNotificationService.notifyStaff(c.env.DB, staffId, pushPayload, c.env.VAPID_PUBLIC_KEY, c.env.VAPID_PRIVATE_KEY);
      } else {
        // 指名なし/フリー: 店舗の有効スタッフ全員へ
        const storeStaff = await c.env.DB.prepare(
          `SELECT s.id FROM staff s JOIN staff_stores ss ON ss.staff_id = s.id WHERE ss.store_id = ? AND s.is_active = 1`
        ).bind(storeId).all<{ id: string }>();
        for (const row of (storeStaff.results || [])) {
          await PushNotificationService.notifyStaff(c.env.DB, row.id, pushPayload, c.env.VAPID_PUBLIC_KEY, c.env.VAPID_PRIVATE_KEY);
        }
      }
    } catch (error) {
      console.error('Failed to send reservation push:', error);
    }
  }

  return c.json({ reservation }, 201);
});

// Get my reservations
protectedRoutes.get('/reservations', async (c) => {
  const customer = c.get('customer')!;
  const status = c.req.query('status');
  const upcoming = c.req.query('upcoming') === 'true';

  let query = `
    SELECT r.*, m.name as menu_name, m.price, COALESCE(s.nickname, s.name) as staff_name, s.is_active as staff_is_active
    FROM reservations r
    LEFT JOIN menus m ON r.menu_id = m.id
    LEFT JOIN staff s ON r.staff_id = s.id
    WHERE r.customer_id = ?
  `;
  const params: (string | number)[] = [customer.id];

  if (status) {
    query += ' AND r.status = ?';
    params.push(status);
  }

  if (upcoming) {
    query += " AND r.start_at >= datetime('now') AND r.status IN ('pending', 'confirmed')";
  }

  query += ' ORDER BY r.start_at DESC';

  const result = await c.env.DB.prepare(query)
    .bind(...params)
    .all();

  // Fetch reservation_menus for each reservation
  const reservations = result.results as Record<string, unknown>[];
  if (reservations.length > 0) {
    const ids = reservations.map(r => r.id as string);
    const placeholders = ids.map(() => '?').join(',');
    const menusResult = await c.env.DB.prepare(
      `SELECT reservation_id, menu_name, price, duration FROM reservation_menus WHERE reservation_id IN (${placeholders}) ORDER BY sort_order`
    ).bind(...ids).all();

    const menusByReservation = new Map<string, { menu_name: string; price: number; duration: number }[]>();
    for (const rm of menusResult.results as { reservation_id: string; menu_name: string; price: number; duration: number }[]) {
      if (!menusByReservation.has(rm.reservation_id)) {
        menusByReservation.set(rm.reservation_id, []);
      }
      menusByReservation.get(rm.reservation_id)!.push(rm);
    }

    for (const r of reservations) {
      const menus = menusByReservation.get(r.id as string);
      if (menus && menus.length > 0) {
        (r as Record<string, unknown>).reservation_menus = menus;
        // Override menu_name with reservation_menus names if available
        (r as Record<string, unknown>).menu_name = menus.map(m => m.menu_name).join(' / ');
      }
    }
  }

  return c.json({ reservations });
});

// Cancel reservation
protectedRoutes.put('/reservations/:id/cancel', async (c) => {
  const customer = c.get('customer')!;
  const id = c.req.param('id');

  const reservation = await c.env.DB.prepare(
    'SELECT * FROM reservations WHERE id = ? AND customer_id = ?'
  )
    .bind(id, customer.id)
    .first<Reservation>();

  if (!reservation) {
    return c.json({ error: 'Reservation not found' }, 404);
  }

  if (!['pending', 'confirmed'].includes(reservation.status)) {
    return c.json({ error: 'Cannot cancel this reservation' }, 400);
  }

  await c.env.DB.prepare(
    "UPDATE reservations SET status = 'cancelled', cancel_reason = 'Cancelled by customer', updated_at = datetime('now') WHERE id = ?"
  )
    .bind(id)
    .run();

  await insertReservationLog(c.env.DB, {
    reservationId: id,
    eventType: 'cancelled',
    actorType: 'customer',
    actorId: customer.id,
    actorName: customer.name,
    description: 'お客様が予約をキャンセルしました',
  });

  return c.json({ success: true });
});

// Get visit history
protectedRoutes.get('/history', async (c) => {
  const customer = c.get('customer')!;

  const result = await c.env.DB.prepare(
    `SELECT r.*, m.name as menu_name, m.price, COALESCE(s.nickname, s.name) as staff_name,
            k.id as karute_id, k.is_shared_to_customer
     FROM reservations r
     LEFT JOIN menus m ON r.menu_id = m.id
     LEFT JOIN staff s ON r.staff_id = s.id
     LEFT JOIN karutes k ON k.reservation_id = r.id
     WHERE r.customer_id = ? AND r.status = 'completed'
     ORDER BY r.start_at DESC`
  )
    .bind(customer.id)
    .all();

  return c.json({ history: result.results });
});

// Get karute detail (only if shared) — photos only
protectedRoutes.get('/karutes/:id', async (c) => {
  const customer = c.get('customer')!;
  const id = c.req.param('id');

  const karute = await c.env.DB.prepare(
    `SELECT k.id, k.visit_date, k.is_shared_to_customer, k.shared_at,
            COALESCE(s.nickname, s.name) as staff_name
     FROM karutes k
     LEFT JOIN staff s ON k.staff_id = s.id
     WHERE k.id = ? AND k.customer_id = ? AND k.is_shared_to_customer = 1`
  )
    .bind(id, customer.id)
    .first();

  if (!karute) {
    return c.json({ error: 'Karute not found or not shared' }, 404);
  }

  // Get images only
  const images = await c.env.DB.prepare(
    'SELECT id, image_url, image_type, caption FROM karute_images WHERE karute_id = ? ORDER BY sort_order'
  )
    .bind(id)
    .all<{ id: string; image_url: string; image_type: string; caption: string | null }>();

  const signedImages = await signImageRows(images.results, c.env.JWT_SECRET);
  return c.json({ karute, images: signedImages });
});

// Get counseling sheet
protectedRoutes.get('/counseling-sheet', async (c) => {
  const customer = c.get('customer')!;
  const storeId = c.req.query('store_id') || customer.store_id;

  const sheet = await c.env.DB.prepare(
    'SELECT * FROM counseling_sheets WHERE customer_id = ? AND store_id = ?'
  )
    .bind(customer.id, storeId)
    .first();

  return c.json({
    counseling_sheet: sheet
      ? { ...sheet, data: JSON.parse(sheet.data as string) }
      : null,
  });
});

// Save counseling sheet
protectedRoutes.put('/counseling-sheet', async (c) => {
  const customer = c.get('customer')!;
  const storeId = c.req.query('store_id') || customer.store_id;
  const { data } = await c.req.json<{ data: Record<string, unknown> }>();

  if (!data) {
    return c.json({ error: 'data is required' }, 400);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];

  await c.env.DB.prepare(
    `INSERT INTO counseling_sheets (id, store_id, customer_id, data, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(store_id, customer_id)
     DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
  )
    .bind(id, storeId, customer.id, JSON.stringify(data), now, now)
    .run();

  const sheet = await c.env.DB.prepare(
    'SELECT * FROM counseling_sheets WHERE customer_id = ? AND store_id = ?'
  )
    .bind(customer.id, storeId)
    .first();

  return c.json({
    counseling_sheet: sheet
      ? { ...sheet, data: JSON.parse(sheet.data as string) }
      : null,
  });
});

// Get messages (optionally filtered by staff_id and store_id)
protectedRoutes.get('/messages', async (c) => {
  const customer = c.get('customer')!;
  const limit = parseInt(c.req.query('limit') || '50');
  const staffId = c.req.query('staff_id');
  const storeId = c.req.query('store_id');

  let query = `SELECT m.*, COALESCE(s.nickname, s.name) as staff_name, s.avatar_url as staff_avatar
     FROM messages m
     LEFT JOIN staff s ON m.staff_id = s.id
     WHERE m.customer_id = ?`;
  const bindings: (string | number)[] = [customer.id];

  const effectiveStoreId = storeId || customer.store_id;
  query += ' AND m.store_id = ?';
  bindings.push(effectiveStoreId);

  if (staffId) {
    query += ' AND (m.staff_id = ? OR m.staff_id IS NULL)';
    bindings.push(staffId);
  }

  query += ' ORDER BY m.sent_at DESC LIMIT ?';
  bindings.push(limit);

  const result = await c.env.DB.prepare(query).bind(...bindings).all();

  // Transform direction to sender_type for frontend compatibility
  const messages = result.results.map((m: Record<string, unknown>) => ({
    id: m.id,
    store_id: m.store_id,
    customer_id: m.customer_id,
    staff_id: m.staff_id,
    sender_type: m.direction === 'incoming' ? 'customer' : 'store',
    content: m.content,
    is_read: m.is_read,
    sent_at: m.sent_at,
    source: m.source,
    sender: m.staff_id ? { id: m.staff_id, name: m.staff_name, avatar_url: m.staff_avatar } : null,
  }));

  return c.json({ messages: messages.reverse() });
});

// Send message
protectedRoutes.post('/messages', async (c) => {
  const customer = c.get('customer')!;
  const body = await c.req.json<{ content: string; staff_id?: string; store_id?: string }>();

  if (!body.content) {
    return c.json({ error: 'Content is required' }, 400);
  }

  // Use store_id from request if provided, otherwise fall back to customer's store
  const effectiveStoreId = body.store_id || customer.store_id;

  const id = crypto.randomUUID();

  await c.env.DB.prepare(
    `INSERT INTO messages (id, store_id, customer_id, staff_id, direction, message_type, content, source, sent_at)
     VALUES (?, ?, ?, ?, 'incoming', 'text', ?, 'web', datetime('now'))`
  )
    .bind(id, effectiveStoreId, customer.id, body.staff_id || null, body.content)
    .run();

  // Notify staff (Web Push only — LINE push removed to save message quota)
  // 担当ありは担当へ、担当なし(店舗宛て)は店舗の全スタッフへ
  if (c.env.VAPID_PUBLIC_KEY && c.env.VAPID_PRIVATE_KEY) {
    try {
      const { PushNotificationService } = await import('../services/pushService');
      let result;
      if (body.staff_id) {
        result = await PushNotificationService.notifyStaff(
          c.env.DB, body.staff_id,
          { title: `${customer.name}さんからメッセージ`, body: body.content.substring(0, 100), url: '/messages', tag: `message-${customer.id}` },
          c.env.VAPID_PUBLIC_KEY, c.env.VAPID_PRIVATE_KEY,
        );
      } else {
        result = await PushNotificationService.notifyStoreOnCustomerMessage(
          c.env.DB, effectiveStoreId, customer.id, customer.name, body.content,
          c.env.VAPID_PUBLIC_KEY, c.env.VAPID_PRIVATE_KEY,
        );
      }
      console.log(`[Push] Customer message push result: sent=${result.sent}, failed=${result.failed}`);
    } catch (error) {
      console.error('Failed to send push notification:', error);
    }
  }

  const message = await c.env.DB.prepare(
    `SELECT m.*, COALESCE(s.nickname, s.name) as staff_name, s.avatar_url as staff_avatar
     FROM messages m LEFT JOIN staff s ON m.staff_id = s.id
     WHERE m.id = ?`
  ).bind(id).first();

  const transformed = {
    id: message!.id,
    store_id: message!.store_id,
    customer_id: message!.customer_id,
    staff_id: message!.staff_id,
    sender_type: 'customer',
    content: message!.content,
    is_read: message!.is_read,
    sent_at: message!.sent_at,
    source: message!.source,
    sender: null,
  };

  // Check if customer needs LINE registration flow (first message from web app)
  console.log('[customer/messages] Checking registration for customer:', customer.id);
  try {
    const regStatus = await c.env.DB.prepare(
      'SELECT cl.registration_status, cl.line_user_id FROM customer_line cl WHERE cl.customer_id = ? AND cl.store_id = ?'
    ).bind(customer.id, customer.store_id).first<{ registration_status: string; line_user_id: string }>();

    console.log('[customer/messages] regStatus:', JSON.stringify(regStatus));

    if (regStatus && regStatus.registration_status !== 'completed' && regStatus.line_user_id) {
      const store = await c.env.DB.prepare('SELECT name, line_liff_id FROM stores WHERE id = ?')
        .bind(customer.store_id).first<{ name: string; line_liff_id: string | null }>();
      const accessToken = await getStoreLineAccessToken(c.env.DB, customer.store_id);
      console.log('[customer/messages] store:', store?.name, 'hasAccessToken:', !!accessToken);
      if (accessToken && store) {
        await pushMessage(regStatus.line_user_id, [buildRegistrationWelcomeMessage(store.name, store.line_liff_id, customer.store_id)], accessToken);
        console.log('[customer/messages] Sent registration welcome via LINE push for customer:', customer.id);
      }
    }
  } catch (error) {
    console.error('[customer/messages] Failed to send registration message:', error);
  }

  return c.json({ message: transformed }, 201);
});

// Mark messages as read
protectedRoutes.post('/messages/read', async (c) => {
  const customer = c.get('customer')!;

  await c.env.DB.prepare(
    `UPDATE messages SET is_read = 1
     WHERE customer_id = ? AND direction = 'outgoing' AND is_read = 0`
  )
    .bind(customer.id)
    .run();

  return c.json({ success: true });
});

// Update profile
protectedRoutes.put('/profile', async (c) => {
  const customer = c.get('customer')!;
  const body = await c.req.json<{
    name?: string;
    name_kana?: string;
    phone?: string;
    gender?: Customer['gender'];
    birthday?: string;
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
  if (body.gender !== undefined) {
    updates.push('gender = ?');
    values.push(body.gender || null);
  }
  if (body.birthday !== undefined) {
    updates.push('birthday = ?');
    values.push(body.birthday || null);
  }

  if (updates.length === 0) {
    return c.json({ error: 'No updates provided' }, 400);
  }

  updates.push("updated_at = datetime('now')");
  values.push(customer.id);

  await c.env.DB.prepare(`UPDATE customers SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();

  // Mark LINE registration as completed if name was updated
  if (body.name) {
    await c.env.DB.prepare(
      "UPDATE customer_line SET registration_status = 'completed', updated_at = datetime('now') WHERE customer_id = ? AND store_id = ? AND registration_status != 'completed'"
    ).bind(customer.id, customer.store_id).run();
  }

  const updated = await c.env.DB.prepare('SELECT * FROM customers WHERE id = ?')
    .bind(customer.id)
    .first<Customer>();

  return c.json({
    customer: {
      id: updated!.id,
      name: updated!.name,
      name_kana: updated!.name_kana,
      email: updated!.email,
      phone: updated!.phone,
      gender: updated!.gender,
      birthday: updated!.birthday,
    },
  });
});

// 事前連携（切替前のQR用・同意書なし）: 名前/カナ/電話 + LIFFトークンで
// LINEユーザーIDと既存顧客を紐づける。電話が同一店舗で1件に一致すれば即連携、
// それ以外は新規顧客を作成して統合候補に回す（スタッフ確認で紐づけ）。
customerRoutes.post('/prelink', async (c) => {
  const body = await c.req.json<{
    store_id: string;
    liff_access_token: string;
    name: string;
    name_kana?: string;
    phone: string;
  }>();
  if (!body.store_id || !body.liff_access_token || !body.name?.trim() || !body.phone?.trim()) {
    return c.json({ error: '必須項目が不足しています' }, 400);
  }
  const store = await c.env.DB.prepare('SELECT id FROM stores WHERE id = ?').bind(body.store_id).first();
  if (!store) return c.json({ error: 'Store not found' }, 404);

  // Verify LIFF token and get LINE profile
  const verifyRes = await fetch(
    `https://api.line.me/oauth2/v2.1/verify?access_token=${encodeURIComponent(body.liff_access_token)}`
  );
  if (!verifyRes.ok) return c.json({ error: 'LINE認証に失敗しました' }, 401);
  const verifyData = await verifyRes.json<{ expires_in: number }>();
  if (verifyData.expires_in <= 0) return c.json({ error: 'LINE認証の有効期限が切れています' }, 401);
  const profileRes = await fetch('https://api.line.me/v2/profile', {
    headers: { Authorization: `Bearer ${body.liff_access_token}` },
  });
  if (!profileRes.ok) return c.json({ error: 'LINEプロフィールを取得できませんでした' }, 401);
  const profile = await profileRes.json<{ userId: string; displayName: string; pictureUrl?: string }>();

  const name = body.name.trim();
  const kana = body.name_kana?.trim() || null;
  const phone = body.phone.trim();

  // Already linked? (line_user_id is globally unique)
  const existingLine = await c.env.DB.prepare(
    'SELECT customer_id FROM customer_line WHERE line_user_id = ?'
  ).bind(profile.userId).first<{ customer_id: string }>();
  if (existingLine) {
    return c.json({ status: 'already_linked' });
  }

  // Exact phone match in THIS store (normalized: hyphens/spaces/+81 ignored),
  // not yet LINE-linked for this store
  const matches = await c.env.DB.prepare(
    `SELECT c.id FROM customers c
     WHERE c.store_id = ?1 AND ${sqlNormalizedPhone('c.phone')} = ?2
       AND NOT EXISTS (SELECT 1 FROM customer_line cl WHERE cl.customer_id = c.id AND cl.store_id = ?1)`
  ).bind(body.store_id, normalizePhoneForMatch(phone)).all<{ id: string }>();

  if (matches.results.length === 1) {
    const customerId = matches.results[0].id;
    await c.env.DB.prepare(
      `INSERT INTO customer_line (id, customer_id, store_id, line_user_id, display_name, picture_url, registration_status, linked_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'completed', datetime('now'), datetime('now'))`
    ).bind(crypto.randomUUID(), customerId, body.store_id, profile.userId, profile.displayName, profile.pictureUrl || null).run();
    // Fill kana if the imported record lacks it
    if (kana) {
      await c.env.DB.prepare(
        "UPDATE customers SET name_kana = COALESCE(NULLIF(name_kana, ''), ?), updated_at = datetime('now') WHERE id = ?"
      ).bind(kana, customerId).run();
    }
    try {
      await getOrCreateMaster(c.env.DB, { customerId, phone, storeId: body.store_id });
    } catch { /* non-fatal */ }
    console.log('[prelink] Linked LINE to existing customer:', customerId, name);
    return c.json({ status: 'linked' });
  }

  // 0 or multiple matches — create a new customer and let staff confirm via merge candidates
  const customerId = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO customers (id, store_id, name, name_kana, phone, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  ).bind(customerId, body.store_id, name, kana, phone).run();
  await c.env.DB.prepare(
    `INSERT INTO customer_line (id, customer_id, store_id, line_user_id, display_name, picture_url, registration_status, linked_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'completed', datetime('now'), datetime('now'))`
  ).bind(crypto.randomUUID(), customerId, body.store_id, profile.userId, profile.displayName, profile.pictureUrl || null).run();
  try {
    await getOrCreateMaster(c.env.DB, { customerId, phone, storeId: body.store_id });
  } catch { /* non-fatal */ }
  try {
    await searchAndCreateMergeCandidates(c.env.DB, customerId, name, phone, body.store_id, profile.displayName || null);
  } catch (err) {
    console.error('[prelink] merge candidate search failed:', err);
  }
  console.log('[prelink] Created customer + LINE link, pending staff confirm:', customerId, name);
  return c.json({ status: 'pending_confirm' });
});

// Mount protected routes
customerRoutes.route('/', protectedRoutes);
