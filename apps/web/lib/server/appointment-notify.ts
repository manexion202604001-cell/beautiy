// Customer-facing notifications for appointment lifecycle events.
// Uses an org MessageTemplate with the matching category when present, else a default.
import { renderTemplate, toLocalParts, minutesToHHMM, jaWeekday } from '@salonos/core';
import { prisma } from './db';
import { env } from './env';
import { sendCustomerMessage } from './notify';

export type AppointmentEvent = 'BOOKED' | 'REQUESTED' | 'CONFIRMED' | 'CHANGED' | 'CANCELLED' | 'REMINDER';

export const DEFAULT_TEMPLATES: Record<AppointmentEvent, string> = {
  BOOKED: '{{customer_name}}様\n{{shop_name}}のご予約が確定しました。\n日時：{{date}} {{time}}\nメニュー：{{menu}}\n担当：{{staff_name}}\n\n変更・キャンセルはこちら\n{{manage_url}}',
  REQUESTED: '{{customer_name}}様\n{{shop_name}}へのご予約リクエストを受け付けました。サロンからの確定連絡をお待ちください。\n希望日時：{{date}} {{time}}\n{{manage_url}}',
  CONFIRMED: '{{customer_name}}様\nご予約リクエストが確定しました。\n日時：{{date}} {{time}}\n{{manage_url}}',
  CHANGED: '{{customer_name}}様\nご予約内容が変更されました。\n新しい日時：{{date}} {{time}}\n{{manage_url}}',
  CANCELLED: '{{customer_name}}様\n{{date}} {{time}}のご予約をキャンセルしました。またのご来店をお待ちしております。\n{{booking_url}}',
  REMINDER: '{{customer_name}}様\n明日 {{time}} より{{shop_name}}でお待ちしております。\nメニュー：{{menu}}\n変更はこちら：{{manage_url}}',
};

export const TEMPLATE_CATEGORY: Record<AppointmentEvent, string> = {
  BOOKED: 'BOOKING_CONFIRMED', REQUESTED: 'BOOKING_REQUESTED', CONFIRMED: 'BOOKING_CONFIRMED', CHANGED: 'BOOKING_CHANGED', CANCELLED: 'BOOKING_CANCELLED', REMINDER: 'REMINDER',
};

export async function appointmentVars(appointmentId: string) {
  const a = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: { shop: true, customer: true, menus: true, staff: true },
  });
  if (!a) return null;
  const p = toLocalParts(a.startAt, a.shop.timezone);
  const staffMember = a.staffId ? await prisma.membership.findFirst({ where: { organizationId: a.organizationId, userId: a.staffId } }) : null;
  return {
    appointment: a,
    vars: {
      customer_name: a.customer ? `${a.customer.lastName} ${a.customer.firstName}`.trim() : a.guestName ?? 'お客',
      shop_name: a.shop.name,
      staff_name: staffMember?.displayName ?? a.staff?.name ?? '指名なし',
      date: `${p.month}/${p.day}(${jaWeekday(p.weekday)})`,
      time: minutesToHHMM(p.minutes),
      menu: a.menus.map((m) => m.name).join('・') || (a.kind === 'CONSULTATION' ? 'ご相談' : ''),
      manage_url: `${env.appUrl}/booking/${a.manageToken}`,
      booking_url: `${env.appUrl}/book/${a.shop.slug}`,
      review_url: `${env.appUrl}/review/${a.manageToken}`,
    } as Record<string, string>,
  };
}

export async function notifyAppointment(appointmentId: string, event: AppointmentEvent, opts: { automationRuleId?: string } = {}) {
  const r = await appointmentVars(appointmentId);
  if (!r || !r.appointment.customerId) return null;
  const tpl = await prisma.messageTemplate.findFirst({ where: { organizationId: r.appointment.organizationId, category: TEMPLATE_CATEGORY[event] }, orderBy: { createdAt: 'desc' } });
  const body = renderTemplate(tpl?.body ?? DEFAULT_TEMPLATES[event], r.vars);
  try {
    return await sendCustomerMessage({
      orgId: r.appointment.organizationId, shopId: r.appointment.shopId, customerId: r.appointment.customerId,
      body, appointmentId, templateId: tpl?.id, automationRuleId: opts.automationRuleId, subject: `【${r.appointment.shop.name}】ご予約のお知らせ`,
    });
  } catch (e) {
    console.error('[notifyAppointment]', e);
    return null;
  }
}
