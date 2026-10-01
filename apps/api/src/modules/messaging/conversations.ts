import { sql } from 'kysely';
import { assertShopAccess, requirePermission, type Ctx } from '../../auth/actor.js';
import { audit } from '../../lib/audit.js';
import { Errors } from '../../lib/errors.js';
import { decodeCursor, paginate } from '../../lib/pagination.js';
import { assertCustomerAccess, visibleCustomerFilter } from '../customers/access.js';
import { displayName } from '../customers/service.js';
import { enqueueDelivery, queueMessage } from './api.js';
import type { SendMessageInput } from './schemas.js';

/** 1:1 conversations (staff ⇄ customer) and delivery log access */
const messageColumns = [
  'messages.id',
  'messages.shop_id',
  'messages.customer_id',
  'messages.channel',
  'messages.direction',
  'messages.category',
  'messages.message_type',
  'messages.body',
  'messages.template_id',
  'messages.campaign_id',
  'messages.automation_id',
  'messages.appointment_id',
  'messages.status',
  'messages.skip_reason',
  'messages.error',
  'messages.attempts',
  'messages.scheduled_at',
  'messages.sent_at',
  'messages.read_at',
  'messages.sent_by_staff_id',
  'messages.created_at',
  'messages.updated_at',
] as const;

export async function sendMessage(ctx: Ctx, input: SendMessageInput) {
  requirePermission(ctx.actor, 'message.send');
  const customer = await assertCustomerAccess(ctx, input.customerId);
  if (customer.status === 'blocked') throw Errors.business('CUSTOMER_BLOCKED', 'この顧客へのメッセージ送信は停止されています');
  const shopId = input.shopId ?? ctx.meta.currentShopId ?? customer.primary_shop_id ?? null;
  if (shopId) assertShopAccess(ctx.actor, shopId);
  if (input.templateId) {
    const t = await ctx.trx.selectFrom('message_templates').select(['id', 'shop_id', 'status']).where('id', '=', input.templateId).executeTakeFirst();
    if (!t) throw Errors.notFound('テンプレート', input.templateId);
    assertShopAccess(ctx.actor, t.shop_id);
    if (t.status !== 'active') throw Errors.business('TEMPLATE_INACTIVE', 'このテンプレートは無効です');
  }
  const res = await queueMessage(ctx, {
    customerId: input.customerId,
    shopId,
    category: 'conversation',
    body: input.body,
    templateId: input.templateId,
    vars: input.vars,
    channel: input.channel,
    sentByStaffId: ctx.actor.kind === 'staff' ? ctx.actor.staffId : null,
  });
  await audit(ctx, { action: 'message.send', resourceType: 'message', resourceId: res.messageId, shopId, metadata: { customerId: input.customerId, channel: input.channel ?? 'auto' } });
  return getMessageUnchecked(ctx, res.messageId!);
}

async function getMessageUnchecked(ctx: Ctx, id: string) {
  const row = await ctx.trx
    .selectFrom('messages')
    .leftJoin('staffs', 'staffs.id', 'messages.sent_by_staff_id')
    .select([...messageColumns, 'staffs.display_name as sent_by_staff_name'])
    .where('messages.id', '=', id)
    .executeTakeFirst();
  if (!row) throw Errors.notFound('メッセージ', id);
  return row;
}

async function loadAccessibleMessage(ctx: Ctx, id: string) {
  const row = await getMessageUnchecked(ctx, id);
  if (row.customer_id) {
    try {
      await assertCustomerAccess(ctx, row.customer_id, { allowMerged: true });
    } catch {
      throw Errors.notFound('メッセージ', id);
    }
  } else {
    assertShopAccess(ctx.actor, row.shop_id);
  }
  return row;
}

export async function getMessage(ctx: Ctx, id: string) {
  requirePermission(ctx.actor, 'message.read');
  return loadAccessibleMessage(ctx, id);
}

export async function listConversation(ctx: Ctx, input: { customerId: string; direction?: 'inbound' | 'outbound'; cursor?: string; limit: number }) {
  requirePermission(ctx.actor, 'message.read');
  await assertCustomerAccess(ctx, input.customerId, { allowMerged: true });
  let q = ctx.trx
    .selectFrom('messages')
    .leftJoin('staffs', 'staffs.id', 'messages.sent_by_staff_id')
    .select([...messageColumns, 'staffs.display_name as sent_by_staff_name'])
    .where('messages.customer_id', '=', input.customerId);
  if (input.direction) q = q.where('messages.direction', '=', input.direction);
  const cursor = decodeCursor(input.cursor);
  if (cursor) q = q.where(sql<boolean>`(messages.created_at, messages.id) < (${cursor.v}::timestamptz, ${cursor.id}::uuid)`);
  const rows = await q.orderBy('messages.created_at', 'desc').orderBy('messages.id', 'desc').limit(input.limit + 1).execute();
  return paginate(rows, input.limit, (r) => r.created_at);
}

/** Latest message per customer + unread inbound count (LINE inbox) */
export async function inbox(ctx: Ctx, input: { shopId?: string; unreadOnly?: boolean; cursor?: string; limit: number }) {
  requirePermission(ctx.actor, 'message.read');
  if (input.shopId) assertShopAccess(ctx.actor, input.shopId);
  let latest = ctx.trx
    .selectFrom('messages')
    .innerJoin('customers', 'customers.id', 'messages.customer_id')
    .distinctOn('messages.customer_id')
    .select(['messages.id', 'messages.customer_id', 'messages.created_at', 'messages.body', 'messages.direction', 'messages.channel', 'messages.status', 'messages.message_type'])
    .where('customers.deleted_at', 'is', null)
    // conversation view: inbound + 1:1 replies (+ anything inbound-adjacent), not bulk marketing
    .where((eb) => eb.or([eb('messages.direction', '=', 'inbound'), eb('messages.category', '=', 'conversation')]));
  const filter = visibleCustomerFilter(ctx);
  if (filter) latest = latest.where(filter);
  if (input.shopId) latest = latest.where((eb) => eb.or([eb('messages.shop_id', '=', input.shopId!), eb('messages.shop_id', 'is', null)]));
  latest = latest.orderBy('messages.customer_id').orderBy('messages.created_at', 'desc').orderBy('messages.id', 'desc');

  let q = ctx.trx
    .selectFrom(latest.as('l'))
    .innerJoin('customers as c', 'c.id', 'l.customer_id')
    .select([
      'l.id',
      'l.customer_id',
      'l.created_at',
      'l.body',
      'l.direction',
      'l.channel',
      'l.status',
      'l.message_type',
      'c.last_name',
      'c.first_name',
      'c.last_name_kana',
      'c.first_name_kana',
      (eb) =>
        eb
          .selectFrom('messages as u')
          .select(sql<number>`count(*)::int`.as('n'))
          .whereRef('u.customer_id', '=', 'l.customer_id')
          .where('u.direction', '=', 'inbound')
          .where('u.status', '=', 'received')
          .as('unread_count'),
    ]);
  if (input.unreadOnly) {
    q = q.where((eb) =>
      eb.exists(eb.selectFrom('messages as u2').select(sql`1`.as('x')).whereRef('u2.customer_id', '=', 'l.customer_id').where('u2.direction', '=', 'inbound').where('u2.status', '=', 'received')),
    );
  }
  const cursor = decodeCursor(input.cursor);
  if (cursor) q = q.where(sql<boolean>`(l.created_at, l.id) < (${cursor.v}::timestamptz, ${cursor.id}::uuid)`);
  const rows = await q.orderBy('l.created_at', 'desc').orderBy('l.id', 'desc').limit(input.limit + 1).execute();
  const page = paginate(rows, input.limit, (r) => r.created_at);
  return {
    items: page.items.map(({ last_name, first_name, last_name_kana, first_name_kana, ...r }) => ({
      ...r,
      unread_count: Number(r.unread_count ?? 0),
      customer_name: displayName({ last_name, first_name, last_name_kana, first_name_kana }),
    })),
    nextCursor: page.nextCursor,
  };
}

/** Mark an inbound message (and older unread inbound messages of the same customer) as read */
export async function markRead(ctx: Ctx, id: string) {
  requirePermission(ctx.actor, 'message.read');
  const msg = await loadAccessibleMessage(ctx, id);
  if (msg.direction !== 'inbound') throw Errors.business('NOT_INBOUND', '受信メッセージのみ既読にできます');
  const res = await ctx.trx
    .updateTable('messages')
    .set({ status: 'read', read_at: new Date() })
    .where('customer_id', '=', msg.customer_id)
    .where('direction', '=', 'inbound')
    .where('status', '=', 'received')
    // compare in SQL: JS Dates lose the microseconds of timestamptz
    .where('created_at', '<=', (eb) => eb.selectFrom('messages as m2').select('m2.created_at').where('m2.id', '=', id))
    .executeTakeFirst();
  return { ok: true as const, updated: Number(res.numUpdatedRows) };
}

/** Manual resend of a failed message (FR-03 失敗再送) */
export async function retryMessage(ctx: Ctx, id: string) {
  requirePermission(ctx.actor, 'message.send');
  const msg = await loadAccessibleMessage(ctx, id);
  if (msg.direction !== 'outbound' || msg.status !== 'failed') throw Errors.business('NOT_RETRYABLE', '送信失敗のメッセージのみ再送できます', { status: msg.status });
  await ctx.trx.updateTable('messages').set({ status: 'queued', error: null, scheduled_at: null, next_attempt_at: null }).where('id', '=', id).execute();
  await enqueueDelivery(ctx, id, undefined, `:retry:${Date.now()}`);
  await audit(ctx, { action: 'message.retry', resourceType: 'message', resourceId: id, shopId: msg.shop_id });
  return getMessageUnchecked(ctx, id);
}
