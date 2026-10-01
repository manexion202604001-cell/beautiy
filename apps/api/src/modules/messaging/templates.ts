import { sql } from 'kysely';
import { accessibleShopIds, assertShopAccess, requireAnyPermission, requirePermission, type Ctx } from '../../auth/actor.js';
import { config } from '../../config.js';
import { audit, diff } from '../../lib/audit.js';
import { Errors } from '../../lib/errors.js';
import { registerOrgSeeder } from '../../lib/org-seeders.js';
import { renderTemplate, templateVariables } from '../../lib/template.js';
import { DEFAULT_TZ, formatJst } from '../../lib/time.js';
import { assertCustomerAccess } from '../customers/access.js';
import { displayName } from '../customers/service.js';
import type { Channel, CreateTemplateInput, UpdateTemplateInput } from './schemas.js';
import { SYSTEM_TEMPLATES } from './system-templates.js';

// ---------------------------------------------------------------- rendering

function lookup(vars: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => (acc && typeof acc === 'object' && key in (acc as object) ? (acc as Record<string, unknown>)[key] : undefined), vars);
}

function present(v: unknown): boolean {
  return !(v === undefined || v === null || v === false || v === '' || (Array.isArray(v) && v.length === 0));
}

/**
 * Render a message template: mustache-like sections ({{#a.b}}…{{/a.b}}, {{^a.b}}…{{/a.b}}, not nested)
 * followed by lib/template variable substitution. Blank-line runs left by empty sections are collapsed.
 */
export function renderMessage(template: string, vars: Record<string, unknown>): string {
  const withSections = template.replace(/\{\{([#^])\s*([\w.]+)\s*\}\}([\s\S]*?)\{\{\/\s*\2\s*\}\}/g, (_, kind: string, path: string, inner: string) => {
    const show = present(lookup(vars, path));
    return (kind === '#' ? show : !show) ? inner : '';
  });
  return renderTemplate(withSections, vars)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Shallow-per-namespace merge: {customer:{name}} + {customer:{nick}} keeps both */
export function mergeVars(base: Record<string, unknown>, extra: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(extra ?? {})) {
    const b = out[k];
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && b && typeof b === 'object' && !Array.isArray(b) ? { ...(b as object), ...(v as object) } : v;
  }
  return out;
}

// ---------------------------------------------------------------- seed

export async function seedSystemTemplates(ctx: Ctx) {
  const rows = SYSTEM_TEMPLATES.flatMap((t) => [
    { key: t.key, name: t.name, category: t.category, channel: 'line', subject: null, body: t.line, status: t.status ?? 'active' },
    { key: t.key, name: t.name, category: t.category, channel: 'email', subject: t.email.subject, body: t.email.body, status: t.status ?? 'active' },
  ]);
  await ctx.trx
    .insertInto('message_templates')
    .values(rows.map((r) => ({ ...r, organization_id: ctx.actor.organizationId, shop_id: null })))
    .onConflict((oc) => oc.doNothing())
    .execute();
}

registerOrgSeeder('messaging.system_templates', (ctx) => seedSystemTemplates(ctx), 200);

// ---------------------------------------------------------------- resolution

export interface TemplateRow {
  id: string;
  shop_id: string | null;
  key: string | null;
  name: string;
  channel: string;
  category: string;
  subject: string | null;
  body: string;
  payload: unknown;
  status: string;
}

const templateColumns = ['id', 'shop_id', 'key', 'name', 'channel', 'category', 'subject', 'body', 'payload', 'status'] as const;

/**
 * Most specific template for a key: exact channel before LINE copy (SMS reuses LINE text),
 * shop override before organization default. Inactive rows are returned (caller decides = disabled).
 */
export async function resolveTemplateByKey(ctx: Ctx, key: string, channel: Channel, shopId: string | null): Promise<TemplateRow | null> {
  const row = await ctx.trx
    .selectFrom('message_templates')
    .select(templateColumns)
    .where('key', '=', key)
    .where('channel', 'in', [...new Set([channel, 'line'])])
    .where((eb) => (shopId ? eb.or([eb('shop_id', '=', shopId), eb('shop_id', 'is', null)]) : eb('shop_id', 'is', null)))
    .orderBy(sql`CASE WHEN channel = ${channel} THEN 0 ELSE 1 END`)
    .orderBy(sql`CASE WHEN shop_id IS NULL THEN 1 ELSE 0 END`)
    .limit(1)
    .executeTakeFirst();
  return (row as TemplateRow | undefined) ?? null;
}

export async function getTemplateRow(ctx: Ctx, id: string): Promise<TemplateRow | null> {
  const row = await ctx.trx.selectFrom('message_templates').select(templateColumns).where('id', '=', id).executeTakeFirst();
  return (row as TemplateRow | undefined) ?? null;
}

// ---------------------------------------------------------------- variables

export interface ShopInfo {
  id: string;
  name: string;
  phone: string | null;
  timezone: string;
  slug: string;
  publicBookingEnabled: boolean;
  settings: unknown;
}

export async function loadShop(ctx: Ctx, shopId: string | null | undefined): Promise<ShopInfo | null> {
  if (!shopId) return null;
  const s = await ctx.trx
    .selectFrom('shops')
    .select(['id', 'name', 'phone', 'timezone', 'slug', 'public_booking_enabled', 'settings'])
    .where('id', '=', shopId)
    .executeTakeFirst();
  return s ? { id: s.id, name: s.name, phone: s.phone, timezone: s.timezone, slug: s.slug, publicBookingEnabled: s.public_booking_enabled, settings: s.settings } : null;
}

export async function orgTimezone(ctx: Ctx): Promise<string> {
  const o = await ctx.trx.selectFrom('organizations').select(['timezone', 'name']).where('id', '=', ctx.actor.organizationId).executeTakeFirst();
  return o?.timezone ?? DEFAULT_TZ;
}

export interface CustomerForVars {
  last_name: string;
  first_name: string;
  last_name_kana: string;
  first_name_kana: string;
}

export function customerVars(c: CustomerForVars) {
  return { name: displayName(c) || 'お客', lastName: c.last_name || c.last_name_kana, firstName: c.first_name || c.first_name_kana };
}

export function shopVars(shop: ShopInfo | null, orgName?: string) {
  if (!shop) return { name: orgName ?? '', phone: '', bookingUrl: '' };
  return { name: shop.name, phone: shop.phone ?? '', bookingUrl: shop.publicBookingEnabled ? `${config.WEB_BASE_URL}/s/${shop.slug}` : '' };
}

const START_FMT = 'M月d日(EEE) H:mm';

export async function appointmentVars(ctx: Ctx, appointmentId: string, tz: string) {
  const a = await ctx.trx
    .selectFrom('appointments')
    .leftJoin('staffs', 'staffs.id', 'appointments.staff_id')
    .select(['appointments.id', 'appointments.start_at', 'appointments.end_at', 'appointments.booking_reference', 'appointments.is_nominated', 'appointments.status', 'staffs.display_name as staff_name'])
    .where('appointments.id', '=', appointmentId)
    .executeTakeFirst();
  if (!a) return null;
  const services = await ctx.trx.selectFrom('appointment_services').select('name').where('appointment_id', '=', appointmentId).orderBy('sort_order').execute();
  return {
    start: formatJst(a.start_at, START_FMT, tz),
    date: formatJst(a.start_at, 'M月d日(EEE)', tz),
    time: formatJst(a.start_at, 'H:mm', tz),
    end: formatJst(a.end_at, 'H:mm', tz),
    menus: services.map((s) => s.name).join('、'),
    staff: a.staff_name ? (a.is_nominated ? `${a.staff_name}（指名）` : a.staff_name) : '指名なし',
    reference: a.booking_reference,
    status: a.status,
  };
}

export function formatStart(d: Date, tz: string) {
  return formatJst(d, START_FMT, tz);
}

// ---------------------------------------------------------------- CRUD

function toApi(t: TemplateRow & { created_at?: Date; updated_at?: Date }) {
  return { ...t, isSystem: !!t.key, variables: templateVariables(`${t.subject ?? ''}\n${t.body}`) };
}

export async function listTemplates(ctx: Ctx, input: { shopId?: string; channel?: string; key?: string; category?: string; status?: string }) {
  requireAnyPermission(ctx.actor, 'template.manage', 'message.send', 'campaign.manage');
  if (input.shopId) assertShopAccess(ctx.actor, input.shopId);
  let q = ctx.trx.selectFrom('message_templates').select([...templateColumns, 'created_at', 'updated_at']);
  const shops = accessibleShopIds(ctx.actor);
  if (input.shopId) q = q.where((eb) => eb.or([eb('shop_id', '=', input.shopId!), eb('shop_id', 'is', null)]));
  else if (shops) q = q.where((eb) => eb.or([eb('shop_id', 'is', null), ...(shops.length ? [eb('shop_id', 'in', shops)] : [])]));
  if (input.channel) q = q.where('channel', '=', input.channel);
  if (input.key) q = q.where('key', '=', input.key);
  if (input.category) q = q.where('category', '=', input.category);
  if (input.status) q = q.where('status', '=', input.status);
  const rows = await q.orderBy(sql`key IS NULL`).orderBy('key').orderBy('name').orderBy('channel').execute();
  return rows.map((r) => toApi(r as TemplateRow));
}

async function loadTemplateForWrite(ctx: Ctx, id: string) {
  const t = await ctx.trx.selectFrom('message_templates').selectAll().where('id', '=', id).executeTakeFirst();
  if (!t) throw Errors.notFound('テンプレート', id);
  assertShopAccess(ctx.actor, t.shop_id);
  return t;
}

export async function getTemplate(ctx: Ctx, id: string) {
  requireAnyPermission(ctx.actor, 'template.manage', 'message.send', 'campaign.manage');
  const t = await loadTemplateForWrite(ctx, id);
  return toApi(t as TemplateRow);
}

export async function createTemplate(ctx: Ctx, input: CreateTemplateInput) {
  requirePermission(ctx.actor, 'template.manage');
  if (input.shopId) assertShopAccess(ctx.actor, input.shopId);
  else if (accessibleShopIds(ctx.actor)) throw Errors.forbidden('法人共通テンプレートの作成には全店舗権限が必要です');
  if (input.channel === 'email' && !input.subject) throw Errors.validation('メールテンプレートには件名が必要です');
  const row = await ctx.trx
    .insertInto('message_templates')
    .values({
      organization_id: ctx.actor.organizationId,
      shop_id: input.shopId ?? null,
      key: input.key ?? null,
      name: input.name,
      channel: input.channel,
      category: input.category,
      subject: input.subject ?? null,
      body: input.body,
      payload: input.payload ? JSON.stringify(input.payload) : null,
      status: input.status,
    })
    .returning([...templateColumns, 'created_at', 'updated_at'])
    .executeTakeFirstOrThrow();
  await audit(ctx, { action: 'message_template.create', resourceType: 'message_template', resourceId: row.id, shopId: row.shop_id, after: input });
  return toApi(row as TemplateRow);
}

export async function updateTemplate(ctx: Ctx, id: string, input: UpdateTemplateInput) {
  requirePermission(ctx.actor, 'template.manage');
  const before = await loadTemplateForWrite(ctx, id);
  if (!before.shop_id && accessibleShopIds(ctx.actor)) throw Errors.forbidden('法人共通テンプレートの変更には全店舗権限が必要です');
  const row = await ctx.trx
    .updateTable('message_templates')
    .set({
      name: input.name,
      category: input.category,
      subject: input.subject,
      body: input.body,
      payload: input.payload === undefined ? undefined : input.payload ? JSON.stringify(input.payload) : null,
      status: input.status,
    })
    .where('id', '=', id)
    .returning([...templateColumns, 'created_at', 'updated_at'])
    .executeTakeFirstOrThrow();
  await audit(ctx, { action: 'message_template.update', resourceType: 'message_template', resourceId: id, shopId: row.shop_id, ...diff(before, row) });
  return toApi(row as TemplateRow);
}

export async function deleteTemplate(ctx: Ctx, id: string) {
  requirePermission(ctx.actor, 'template.manage');
  const t = await loadTemplateForWrite(ctx, id);
  if (t.key && !t.shop_id) throw Errors.business('SYSTEM_TEMPLATE', 'システムテンプレートは削除できません（無効化してください）');
  const used = await ctx.trx
    .selectFrom('campaigns')
    .select('id')
    .where('template_id', '=', id)
    .where('status', 'in', ['draft', 'scheduled', 'running'])
    .unionAll(ctx.trx.selectFrom('automations').select('id').where('template_id', '=', id).where('is_active', '=', true))
    .executeTakeFirst();
  if (used) throw Errors.business('TEMPLATE_IN_USE', '配信予定のキャンペーン/自動配信で使用中のため削除できません');
  // historical messages keep their rendered body; detach the reference
  await ctx.trx.updateTable('messages').set({ template_id: null }).where('template_id', '=', id).execute();
  await ctx.trx.updateTable('campaigns').set({ template_id: null }).where('template_id', '=', id).execute();
  await ctx.trx.updateTable('automations').set({ template_id: null }).where('template_id', '=', id).execute();
  await ctx.trx.deleteFrom('message_templates').where('id', '=', id).execute();
  await audit(ctx, { action: 'message_template.delete', resourceType: 'message_template', resourceId: id, shopId: t.shop_id, before: t });
}

/** Sample variables for previews (real customer/shop data when given and accessible) */
export async function previewTemplate(
  ctx: Ctx,
  input: { templateId?: string; body?: string; subject?: string | null; customerId?: string; shopId?: string; vars?: Record<string, unknown> },
) {
  requireAnyPermission(ctx.actor, 'template.manage', 'message.send', 'campaign.manage');
  let body = input.body ?? '';
  let subject = input.subject ?? null;
  let shopId = input.shopId ?? ctx.meta.currentShopId ?? (ctx.actor.kind === 'staff' ? (ctx.actor.shopIds[0] ?? null) : null);
  if (input.templateId) {
    const t = await loadTemplateForWrite(ctx, input.templateId);
    body = input.body ?? t.body;
    subject = input.subject ?? t.subject;
    shopId = input.shopId ?? t.shop_id ?? shopId;
  }
  if (shopId) assertShopAccess(ctx.actor, shopId);
  const shop = await loadShop(ctx, shopId);
  const tz = shop?.timezone ?? (await orgTimezone(ctx));
  let customer: Record<string, unknown> = { name: '山田 花子', lastName: '山田', firstName: '花子' };
  if (input.customerId) {
    await assertCustomerAccess(ctx, input.customerId);
    const c = await ctx.trx.selectFrom('customers').select(['last_name', 'first_name', 'last_name_kana', 'first_name_kana']).where('id', '=', input.customerId).executeTakeFirstOrThrow();
    customer = customerVars(c);
  }
  const sampleStart = new Date(Date.now() + 86_400_000);
  sampleStart.setUTCMinutes(0, 0, 0);
  const vars = mergeVars(
    {
      customer,
      shop: shop ? shopVars(shop) : { name: 'サンプルサロン', phone: '03-0000-0000', bookingUrl: `${config.WEB_BASE_URL}/s/sample` },
      appointment: {
        start: formatStart(sampleStart, tz),
        date: formatJst(sampleStart, 'M月d日(EEE)', tz),
        time: formatJst(sampleStart, 'H:mm', tz),
        menus: 'カット、カラー',
        staff: '佐藤（指名）',
        reference: 'ABCD2345',
        manageUrl: `${config.WEB_BASE_URL}/b/manage/sample`,
        previousStart: formatStart(new Date(sampleStart.getTime() - 86_400_000), tz),
      },
      cancel: { reason: '', byCustomer: true },
      review: { url: `${config.WEB_BASE_URL}/r/sample` },
      unsubscribeUrl: `${config.WEB_BASE_URL}/unsubscribe?token=sample`,
    },
    input.vars,
  );
  const variables = templateVariables(`${subject ?? ''}\n${body}`);
  return {
    subject: subject ? renderMessage(subject, vars) : null,
    body: renderMessage(body, vars),
    variables,
    unknownVariables: variables.filter((v) => lookup(vars, v) === undefined),
  };
}
