import { DateTime } from 'luxon';
import type { Ctx } from '../../auth/actor.js';
import { config } from '../../config.js';
import { issueAccessToken } from '../../lib/access-tokens.js';
import { onEvent, type DomainEvent } from '../../lib/events.js';
import { parseShopSettings, type ShopSettings } from '../../lib/shop-settings.js';
import { DEFAULT_TZ } from '../../lib/time.js';
import { cancelQueuedMessages, queueMessage } from './api.js';
import { clock } from './clock.js';
import { formatStart } from './templates.js';

/**
 * Appointment notifications (FR-02/03: 予約完了/変更/キャンセル/リマインド通知).
 * Subscribers run inside the appointment transaction and only queue messages (outbox).
 * Dedupe keys:
 *   appt:<id>:confirmed | appt:<id>:tentative | appt:<id>:changed:v<version> | appt:<id>:cancelled:v<version>
 *   appt:<id>:reminder:day_before:<startISO> | appt:<id>:reminder:same_day:<startISO>
 */
interface AppointmentEventPayload {
  shopId: string;
  customerId: string | null;
  staffId: string | null;
  startAt: string;
  previousStartAt?: string;
  status?: string;
  source?: string;
  sourceDetail?: Record<string, unknown>;
  from?: string;
  to?: string;
  reason?: string | null;
  cancelledBy?: 'customer' | 'staff' | 'system' | 'external' | null;
}

type Ev = DomainEvent<AppointmentEventPayload>;

async function shopContext(ctx: Ctx, shopId: string): Promise<{ settings: ShopSettings; tz: string }> {
  const shop = await ctx.trx.selectFrom('shops').select(['settings', 'timezone']).where('id', '=', shopId).executeTakeFirst();
  return { settings: parseShopSettings(shop?.settings), tz: shop?.timezone ?? DEFAULT_TZ };
}

/** Booking management link for the customer (same purpose as the public booking flow) */
async function manageUrl(ctx: Ctx, appointmentId: string, customerId: string): Promise<string | null> {
  const a = await ctx.trx.selectFrom('appointments').select(['end_at']).where('id', '=', appointmentId).executeTakeFirst();
  if (!a) return null;
  const ttl = Math.max(3600, Math.round((a.end_at.getTime() - Date.now()) / 1000) + 86_400);
  const { token } = await issueAccessToken(ctx, { purpose: 'booking_manage', resourceType: 'appointment', resourceId: appointmentId, customerId, ttlSec: ttl });
  return `${config.WEB_BASE_URL}/b/manage/${token}`;
}

export const reminderPrefix = (appointmentId: string) => `appt:${appointmentId}:reminder:`;

export function reminderTimes(start: Date, settings: ShopSettings, tz: string) {
  const local = DateTime.fromJSDate(start, { zone: tz });
  const dayBefore = local.minus({ days: 1 }).set({ hour: settings.reminders.dayBeforeHour, minute: 0, second: 0, millisecond: 0 }).toJSDate();
  const sameDay = settings.reminders.sameDayHoursBefore > 0 ? new Date(start.getTime() - settings.reminders.sameDayHoursBefore * 3_600_000) : null;
  return { dayBefore, sameDay };
}

async function scheduleReminders(ctx: Ctx, appointmentId: string, p: AppointmentEventPayload, shop: { settings: ShopSettings }, tz: string, url: string | null) {
  if (!shop.settings.reminders.enabled || !p.customerId) return;
  const start = new Date(p.startAt);
  const now = clock.now();
  if (start <= now) return;
  const { dayBefore, sameDay } = reminderTimes(start, shop.settings, tz);
  const vars = url ? { appointment: { manageUrl: url } } : {};
  if (dayBefore > now) {
    await queueMessage(ctx, {
      customerId: p.customerId,
      shopId: p.shopId,
      category: 'transactional',
      templateKey: 'reminder_day_before',
      appointmentId,
      scheduledAt: dayBefore,
      vars,
      dedupeKey: `${reminderPrefix(appointmentId)}day_before:${start.toISOString()}`,
    });
  }
  if (sameDay && sameDay > now) {
    await queueMessage(ctx, {
      customerId: p.customerId,
      shopId: p.shopId,
      category: 'transactional',
      templateKey: 'reminder_same_day',
      appointmentId,
      scheduledAt: sameDay,
      dedupeKey: `${reminderPrefix(appointmentId)}same_day:${start.toISOString()}`,
    });
  }
}

async function appointmentVersion(ctx: Ctx, id: string) {
  const a = await ctx.trx.selectFrom('appointments').select(['version', 'status']).where('id', '=', id).executeTakeFirst();
  return a ?? { version: 0, status: 'unknown' };
}

onEvent<AppointmentEventPayload>('appointment.created', async (ctx, e: Ev) => {
  const p = e.payload;
  if (!p.customerId || !['confirmed', 'tentative'].includes(p.status ?? '')) return;
  // reservations brought over from the previous system: the customer already has a confirmation;
  // reminders only when the import asked for them (the old system may still be sending its own)
  const imported = p.source === 'import';
  if (imported && !(p.sourceDetail as { sendReminders?: boolean } | undefined)?.sendReminders) return;
  const shop = await shopContext(ctx, p.shopId);
  const url = await manageUrl(ctx, e.aggregateId, p.customerId);
  if (shop.settings.reminders.confirmation && !imported) {
    const tentative = p.status === 'tentative';
    await queueMessage(ctx, {
      customerId: p.customerId,
      shopId: p.shopId,
      category: 'transactional',
      templateKey: tentative ? 'booking_tentative' : 'booking_confirmed',
      appointmentId: e.aggregateId,
      vars: url ? { appointment: { manageUrl: url } } : {},
      dedupeKey: `appt:${e.aggregateId}:${tentative ? 'tentative' : 'confirmed'}`,
    });
  }
  if (p.status === 'confirmed') await scheduleReminders(ctx, e.aggregateId, p, shop, shop.tz, url);
});

onEvent<AppointmentEventPayload>('appointment.confirmed', async (ctx, e: Ev) => {
  const p = e.payload;
  if (!p.customerId || p.from !== 'tentative') return;
  const shop = await shopContext(ctx, p.shopId);
  const url = await manageUrl(ctx, e.aggregateId, p.customerId);
  if (shop.settings.reminders.confirmation) {
    await queueMessage(ctx, {
      customerId: p.customerId,
      shopId: p.shopId,
      category: 'transactional',
      templateKey: 'booking_confirmed',
      appointmentId: e.aggregateId,
      vars: url ? { appointment: { manageUrl: url } } : {},
      dedupeKey: `appt:${e.aggregateId}:confirmed`,
    });
  }
  await scheduleReminders(ctx, e.aggregateId, p, shop, shop.tz, url);
});

onEvent<AppointmentEventPayload>('appointment.rescheduled', async (ctx, e: Ev) => {
  const p = e.payload;
  await cancelQueuedMessages(ctx, { dedupeKeyPrefix: reminderPrefix(e.aggregateId) });
  if (!p.customerId) return;
  const shop = await shopContext(ctx, p.shopId);
  const { version, status } = await appointmentVersion(ctx, e.aggregateId);
  const url = await manageUrl(ctx, e.aggregateId, p.customerId);
  const startChanged = p.previousStartAt && p.previousStartAt !== p.startAt;
  if (shop.settings.reminders.confirmation) {
    await queueMessage(ctx, {
      customerId: p.customerId,
      shopId: p.shopId,
      category: 'transactional',
      templateKey: 'booking_changed',
      appointmentId: e.aggregateId,
      vars: {
        appointment: {
          ...(url ? { manageUrl: url } : {}),
          ...(startChanged ? { previousStart: formatStart(new Date(p.previousStartAt!), shop.tz) } : {}),
        },
      },
      dedupeKey: `appt:${e.aggregateId}:changed:v${version}`,
    });
  }
  if (status === 'confirmed' || status === 'checked_in') await scheduleReminders(ctx, e.aggregateId, p, shop, shop.tz, url);
});

onEvent<AppointmentEventPayload>('appointment.cancelled', async (ctx, e: Ev) => {
  const p = e.payload;
  // reminders and any not-yet-sent notification for this appointment
  await cancelQueuedMessages(ctx, { appointmentId: e.aggregateId });
  if (!p.customerId) return;
  const shop = await shopContext(ctx, p.shopId);
  if (!shop.settings.reminders.confirmation) return;
  const { version } = await appointmentVersion(ctx, e.aggregateId);
  // cancelled by the customer → confirmation of their cancellation; by staff/system/external → notification
  await queueMessage(ctx, {
    customerId: p.customerId,
    shopId: p.shopId,
    category: 'transactional',
    templateKey: 'booking_cancelled',
    appointmentId: e.aggregateId,
    vars: { cancel: { byCustomer: p.cancelledBy === 'customer', by: p.cancelledBy ?? 'staff' } },
    dedupeKey: `appt:${e.aggregateId}:cancelled:v${version}`,
  });
});

for (const type of ['appointment.no_show', 'appointment.completed']) {
  onEvent<AppointmentEventPayload>(type, async (ctx, e: Ev) => {
    await cancelQueuedMessages(ctx, { dedupeKeyPrefix: reminderPrefix(e.aggregateId) });
  });
}

onEvent<AppointmentEventPayload>('appointment.restored', async (ctx, e: Ev) => {
  const p = e.payload;
  if (!p.customerId) return;
  const shop = await shopContext(ctx, p.shopId);
  await scheduleReminders(ctx, e.aggregateId, p, shop, shop.tz, null);
});
