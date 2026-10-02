import type { Bindings } from '../types';
import { LineService, getLineUserId, getStoreLineAccessToken } from './lineService';

type ReminderReservation = {
  id: string;
  store_id: string;
  customer_id: string;
  start_at: string;
  menu_name: string;
  staff_name: string;
  reminder_sent_at: string | null;
};

// Format date for display (Japanese style, converting UTC to JST)
function formatDateJP(dateUtc: Date): string {
  // Convert UTC to JST by adding 9 hours
  const dateJst = new Date(dateUtc.getTime() + 9 * 60 * 60 * 1000);
  const month = dateJst.getUTCMonth() + 1;
  const day = dateJst.getUTCDate();
  const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
  const weekday = weekdays[dateJst.getUTCDay()];
  return `${month}月${day}日(${weekday})`;
}

function formatTimeJP(dateUtc: Date): string {
  // Convert UTC to JST by adding 9 hours
  const dateJst = new Date(dateUtc.getTime() + 9 * 60 * 60 * 1000);
  const hours = dateJst.getUTCHours();
  const minutes = String(dateJst.getUTCMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

export async function sendReminders(env: Bindings): Promise<{ sent: number; errors: number }> {
  const now = new Date();
  // Convert to JST (UTC+9)
  const jstOffset = 9 * 60 * 60 * 1000;
  const jstNow = new Date(now.getTime() + jstOffset);

  let sent = 0;
  let errors = 0;

  // Calculate target dates
  const tomorrow = new Date(jstNow);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);

  const dayAfterTomorrow = new Date(tomorrow);
  dayAfterTomorrow.setDate(dayAfterTomorrow.getDate() + 1);

  const oneWeekLater = new Date(jstNow);
  oneWeekLater.setDate(oneWeekLater.getDate() + 7);
  oneWeekLater.setHours(0, 0, 0, 0);

  const oneWeekLaterEnd = new Date(oneWeekLater);
  oneWeekLaterEnd.setDate(oneWeekLaterEnd.getDate() + 1);

  // Format dates for SQL (YYYY-MM-DD)
  const tomorrowStr = tomorrow.toISOString().split('T')[0];
  const dayAfterTomorrowStr = dayAfterTomorrow.toISOString().split('T')[0];
  const oneWeekLaterStr = oneWeekLater.toISOString().split('T')[0];
  const oneWeekLaterEndStr = oneWeekLaterEnd.toISOString().split('T')[0];

  console.log(`[Reminder] Running at ${jstNow.toISOString()}`);
  console.log(`[Reminder] Tomorrow: ${tomorrowStr}, One week later: ${oneWeekLaterStr}`);

  // Query for reservations needing reminders
  // Day before reminder (tomorrow's reservations, not yet reminded)
  const tomorrowReservations = await env.DB.prepare(`
    SELECT
      r.id,
      r.store_id,
      r.customer_id,
      r.start_at,
      r.reminder_sent_at,
      COALESCE(
        (SELECT GROUP_CONCAT(rm.menu_name, '／') FROM reservation_menus rm WHERE rm.reservation_id = r.id ORDER BY rm.sort_order),
        m.name
      ) as menu_name,
      COALESCE(s.nickname, s.name) as staff_name
    FROM reservations r
    LEFT JOIN menus m ON r.menu_id = m.id
    LEFT JOIN staff s ON r.staff_id = s.id
    WHERE r.status IN ('pending', 'confirmed')
      AND date(r.start_at) >= ?
      AND date(r.start_at) < ?
      AND (r.reminder_sent_at IS NULL OR date(r.reminder_sent_at) < date('now', '-6 days'))
  `).bind(tomorrowStr, dayAfterTomorrowStr).all<ReminderReservation>();

  // One week before reminder (only if week_reminder_sent_at is NULL)
  const weekReservations = await env.DB.prepare(`
    SELECT
      r.id,
      r.store_id,
      r.customer_id,
      r.start_at,
      r.reminder_sent_at,
      COALESCE(
        (SELECT GROUP_CONCAT(rm.menu_name, '／') FROM reservation_menus rm WHERE rm.reservation_id = r.id ORDER BY rm.sort_order),
        m.name
      ) as menu_name,
      COALESCE(s.nickname, s.name) as staff_name
    FROM reservations r
    LEFT JOIN menus m ON r.menu_id = m.id
    LEFT JOIN staff s ON r.staff_id = s.id
    WHERE r.status IN ('pending', 'confirmed')
      AND date(r.start_at) >= ?
      AND date(r.start_at) < ?
      AND r.week_reminder_sent_at IS NULL
  `).bind(oneWeekLaterStr, oneWeekLaterEndStr).all<ReminderReservation>();

  console.log(`[Reminder] Found ${tomorrowReservations.results?.length || 0} tomorrow reservations, ${weekReservations.results?.length || 0} week reservations`);

  // Send day-before reminders
  for (const reservation of tomorrowReservations.results || []) {
    try {
      const lineUserId = await getLineUserId(env.DB, reservation.customer_id, reservation.store_id);
      if (!lineUserId) {
        console.log(`[Reminder] No LINE user ID for customer ${reservation.customer_id}`);
        continue;
      }

      const accessToken = await getStoreLineAccessToken(env.DB, reservation.store_id);
      if (!accessToken) {
        console.log(`[Reminder] No LINE access token for store ${reservation.store_id}`);
        continue;
      }

      const lineService = new LineService(accessToken);
      const startAt = new Date(reservation.start_at);

      await lineService.sendReservationReminder(lineUserId, {
        date: formatDateJP(startAt),
        time: formatTimeJP(startAt),
        menuName: reservation.menu_name || '施術',
        staffName: reservation.staff_name || 'スタッフ',
      });

      // Update reminder_sent_at
      await env.DB.prepare(
        "UPDATE reservations SET reminder_sent_at = datetime('now') WHERE id = ?"
      ).bind(reservation.id).run();

      sent++;
      console.log(`[Reminder] Sent day-before reminder for reservation ${reservation.id}`);
    } catch (error) {
      errors++;
      console.error(`[Reminder] Failed to send reminder for ${reservation.id}:`, error);
    }
  }

  // Send one-week-before reminders
  for (const reservation of weekReservations.results || []) {
    try {
      const lineUserId = await getLineUserId(env.DB, reservation.customer_id, reservation.store_id);
      if (!lineUserId) {
        console.log(`[Reminder] No LINE user ID for customer ${reservation.customer_id}`);
        continue;
      }

      const accessToken = await getStoreLineAccessToken(env.DB, reservation.store_id);
      if (!accessToken) {
        console.log(`[Reminder] No LINE access token for store ${reservation.store_id}`);
        continue;
      }

      const lineService = new LineService(accessToken);
      const startAt = new Date(reservation.start_at);

      await lineService.sendReservationReminderWeek(lineUserId, {
        date: formatDateJP(startAt),
        time: formatTimeJP(startAt),
        menuName: reservation.menu_name || '施術',
        staffName: reservation.staff_name || 'スタッフ',
      });

      // Mark week reminder as sent (separate column so day-before reminder still works)
      await env.DB.prepare(
        "UPDATE reservations SET week_reminder_sent_at = datetime('now') WHERE id = ?"
      ).bind(reservation.id).run();

      sent++;
      console.log(`[Reminder] Sent week-before reminder for reservation ${reservation.id}`);
    } catch (error) {
      errors++;
      console.error(`[Reminder] Failed to send week reminder for ${reservation.id}:`, error);
    }
  }

  console.log(`[Reminder] Completed: ${sent} sent, ${errors} errors`);
  return { sent, errors };
}
