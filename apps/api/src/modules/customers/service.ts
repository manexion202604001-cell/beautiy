import { sql } from 'kysely';
import { assertShopAccess, auditUserId, requirePermission, type Ctx } from '../../auth/actor.js';
import { audit, diff } from '../../lib/audit.js';
import { toCsv } from '../../lib/csv.js';
import { Errors } from '../../lib/errors.js';
import { emit } from '../../lib/events.js';
import { normalizeEmail, normalizeKana, normalizePhone } from '../../lib/normalize.js';
import { decodeCursor, paginate } from '../../lib/pagination.js';
import { assertCustomerAccess, canSeeAllCustomers, visibleCustomerFilter } from './access.js';
import { findDuplicateCandidates } from './duplicates.js';
import type { CreateCustomerInput, SearchCustomersInput, UpdateCustomerInput } from './schemas.js';

export const customerListColumns = [
  'customers.id',
  'customers.customer_number',
  'customers.last_name',
  'customers.first_name',
  'customers.last_name_kana',
  'customers.first_name_kana',
  'customers.gender',
  'customers.birthday',
  'customers.phone',
  'customers.email',
  'customers.primary_shop_id',
  'customers.primary_staff_id',
  'customers.first_visit_at',
  'customers.last_visit_at',
  'customers.visit_count',
  'customers.total_sales',
  'customers.avg_cycle_days',
  'customers.next_appointment_at',
  'customers.point_balance',
  'customers.status',
  'customers.marketing_opt_in',
  'customers.created_at',
] as const;

export function displayName(c: { last_name: string; first_name: string; last_name_kana?: string; first_name_kana?: string }) {
  const name = `${c.last_name} ${c.first_name}`.trim();
  return name || `${c.last_name_kana ?? ''} ${c.first_name_kana ?? ''}`.trim();
}

export async function searchCustomers(ctx: Ctx, input: SearchCustomersInput) {
  requirePermission(ctx.actor, 'customer.read');
  if (input.shopId) assertShopAccess(ctx.actor, input.shopId);
  let q = ctx.trx
    .selectFrom('customers')
    .select(customerListColumns)
    .where('customers.deleted_at', 'is', null)
    .where('customers.status', 'in', ['active', 'blocked']);

  const filter = visibleCustomerFilter(ctx);
  if (filter) q = q.where(filter);

  if (input.q) {
    const term = input.q.replace(/[\s　]+/g, '').toLowerCase();
    const phone = normalizePhone(input.q);
    q = q.where((eb) =>
      eb.or([
        eb('customers.search_text', 'like', `%${term.replace(/[%_]/g, '\\$&')}%`),
        ...(phone ? [eb('customers.phone_normalized', '=', phone)] : []),
        ...(term.length >= 3 ? [eb(sql`similarity(customers.search_text, ${term})`, '>', 0.3)] : []),
      ]),
    );
  }
  if (input.tagId) {
    q = q.where((eb) =>
      eb.exists(eb.selectFrom('customer_tags').select(sql`1`.as('x')).whereRef('customer_tags.customer_id', '=', 'customers.id').where('customer_tags.tag_id', '=', input.tagId!)),
    );
  }
  if (input.shopId) {
    const shopId = input.shopId;
    q = q.where((eb) =>
      eb.or([
        eb('customers.primary_shop_id', '=', shopId),
        eb.exists(eb.selectFrom('customer_shop_relations as r').select(sql`1`.as('x')).whereRef('r.customer_id', '=', 'customers.id').where('r.shop_id', '=', shopId)),
      ]),
    );
  }
  if (input.staffId) q = q.where('customers.primary_staff_id', '=', input.staffId);
  if (input.lastVisitBefore) q = q.where('customers.last_visit_at', '<', new Date(input.lastVisitBefore));
  if (input.lastVisitAfter) q = q.where('customers.last_visit_at', '>=', new Date(input.lastVisitAfter));
  if (input.hasFutureAppointment !== undefined) {
    q = input.hasFutureAppointment ? q.where('customers.next_appointment_at', 'is not', null) : q.where('customers.next_appointment_at', 'is', null);
  }
  if (input.birthdayMonth) q = q.where(sql`extract(month from customers.birthday)`, '=', input.birthdayMonth);

  const cursor = decodeCursor(input.cursor);
  type Row = Awaited<ReturnType<typeof q.execute>>[number];
  let sortKey: (r: Row) => string | number | Date | null;
  switch (input.sort) {
    case 'created':
      if (cursor) q = q.where(sql`(customers.created_at, customers.id)`, '<', sql`(${cursor.v}::timestamptz, ${cursor.id}::uuid)`);
      q = q.orderBy('customers.created_at', 'desc').orderBy('customers.id', 'desc');
      sortKey = (r) => r.created_at;
      break;
    case 'name':
      if (cursor) q = q.where(sql`(customers.last_name_kana || customers.first_name_kana, customers.id)`, '>', sql`(${cursor.v}::text, ${cursor.id}::uuid)`);
      q = q.orderBy(sql`customers.last_name_kana || customers.first_name_kana`).orderBy('customers.id');
      sortKey = (r) => r.last_name_kana + r.first_name_kana;
      break;
    case 'total_sales':
      if (cursor) q = q.where(sql`(customers.total_sales, customers.id)`, '<', sql`(${cursor.v}::bigint, ${cursor.id}::uuid)`);
      q = q.orderBy('customers.total_sales', 'desc').orderBy('customers.id', 'desc');
      sortKey = (r) => r.total_sales;
      break;
    default:
      // NULL last visits sort last: coalesce to epoch
      if (cursor) {
        q = q.where(
          sql`(coalesce(customers.last_visit_at, 'epoch'::timestamptz), customers.id)`,
          '<',
          sql`(${cursor.v ?? '1970-01-01T00:00:00Z'}::timestamptz, ${cursor.id}::uuid)`,
        );
      }
      q = q.orderBy(sql`coalesce(customers.last_visit_at, 'epoch'::timestamptz)`, 'desc').orderBy('customers.id', 'desc');
      sortKey = (r) => r.last_visit_at ?? new Date(0);
  }
  const rows = await q.limit(input.limit + 1).execute();
  const page = paginate(rows, input.limit, sortKey);
  const tags = await tagsFor(ctx, page.items.map((r) => r.id));
  return { items: page.items.map((r) => ({ ...r, display_name: displayName(r), tags: tags.get(r.id) ?? [] })), nextCursor: page.nextCursor };
}

async function tagsFor(ctx: Ctx, customerIds: string[]) {
  const map = new Map<string, { id: string; name: string; color: string }[]>();
  if (!customerIds.length) return map;
  const rows = await ctx.trx
    .selectFrom('customer_tags')
    .innerJoin('tags', 'tags.id', 'customer_tags.tag_id')
    .select(['customer_tags.customer_id', 'tags.id', 'tags.name', 'tags.color'])
    .where('customer_tags.customer_id', 'in', customerIds)
    .orderBy('tags.name')
    .execute();
  for (const r of rows) {
    const list = map.get(r.customer_id) ?? [];
    list.push({ id: r.id, name: r.name, color: r.color });
    map.set(r.customer_id, list);
  }
  return map;
}

export async function getCustomer(ctx: Ctx, customerId: string, opts: { audit?: boolean } = { audit: true }) {
  await assertCustomerAccess(ctx, customerId, { allowMerged: true });
  const c = await ctx.trx.selectFrom('customers').selectAll().where('id', '=', customerId).executeTakeFirstOrThrow();
  const [tags, identities, relations, score] = await Promise.all([
    tagsFor(ctx, [customerId]),
    ctx.trx
      .selectFrom('customer_identities')
      .select(['id', 'provider', 'provider_account_id', 'external_id', 'display_name', 'is_following', 'linked_at'])
      .where('customer_id', '=', customerId)
      .where('unlinked_at', 'is', null)
      .execute(),
    ctx.trx
      .selectFrom('customer_shop_relations')
      .leftJoin('staffs', 'staffs.id', 'customer_shop_relations.staff_id')
      .select([
        'customer_shop_relations.id',
        'customer_shop_relations.shop_id',
        'customer_shop_relations.staff_id',
        'staffs.display_name as staff_name',
        'customer_shop_relations.relation_type',
        'customer_shop_relations.started_at',
      ])
      .where('customer_shop_relations.customer_id', '=', customerId)
      .where('customer_shop_relations.ended_at', 'is', null)
      .execute(),
    ctx.trx.selectFrom('customer_scores').selectAll().where('customer_id', '=', customerId).executeTakeFirst(),
  ]);
  if (opts.audit) {
    await audit(ctx, { action: 'customer.view', resourceType: 'customer', resourceId: customerId, shopId: ctx.meta.currentShopId ?? null });
  }
  const { search_text: _s, phone_normalized: _p, ...rest } = c;
  return {
    ...rest,
    display_name: displayName(c),
    tags: tags.get(customerId) ?? [],
    identities: identities.map((i) => ({ ...i, external_id: i.provider === 'line' ? maskId(i.external_id) : i.external_id })),
    relations,
    score: score ?? null,
  };
}

function maskId(id: string) {
  return id.length > 8 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id;
}

function resolvePrimaryShop(ctx: Ctx, requested: string | null | undefined): string | null {
  if (requested) {
    assertShopAccess(ctx.actor, requested);
    return requested;
  }
  if (ctx.meta.currentShopId) return ctx.meta.currentShopId;
  if (ctx.actor.kind === 'staff' && ctx.actor.shopIds.length) return ctx.actor.shopIds[0]!;
  return null;
}

export async function createCustomer(ctx: Ctx, input: CreateCustomerInput) {
  requirePermission(ctx.actor, 'customer.write');
  const primaryShopId = resolvePrimaryShop(ctx, input.primaryShopId);
  const row = await ctx.trx
    .insertInto('customers')
    .values({
      organization_id: ctx.actor.organizationId,
      customer_number: input.customerNumber ?? null,
      last_name: input.lastName.trim(),
      first_name: input.firstName.trim(),
      last_name_kana: input.lastNameKana.trim(),
      first_name_kana: input.firstNameKana.trim(),
      gender: input.gender ?? null,
      birthday: input.birthday ?? null,
      phone: input.phone ?? null,
      phone_normalized: normalizePhone(input.phone),
      email: normalizeEmail(input.email),
      postal_code: input.postalCode ?? null,
      address: input.address ?? null,
      occupation: input.occupation ?? null,
      acquisition_source: input.acquisitionSource ?? null,
      primary_shop_id: primaryShopId,
      primary_staff_id: input.primaryStaffId ?? null,
      marketing_opt_in: input.marketingOptIn ?? true,
      attributes: JSON.stringify(input.attributes ?? {}),
      created_by: auditUserId(ctx.actor),
      trace_id: ctx.meta.traceId ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  if (primaryShopId && input.primaryStaffId) {
    await setPrimaryStaffRelation(ctx, row.id, primaryShopId, input.primaryStaffId);
  }
  if (input.tagIds?.length) await setCustomerTags(ctx, row.id, input.tagIds, { skipAudit: true });

  await audit(ctx, { action: 'customer.create', resourceType: 'customer', resourceId: row.id, shopId: primaryShopId, after: input });
  await emit(ctx, { type: 'customer.created', aggregateType: 'customer', aggregateId: row.id, payload: { shopId: primaryShopId } });
  const duplicates = await findDuplicateCandidates(ctx, row.id);
  return { customer: await getCustomer(ctx, row.id, { audit: false }), duplicateCandidates: duplicates };
}

export async function setPrimaryStaffRelation(ctx: Ctx, customerId: string, shopId: string, staffId: string | null) {
  await ctx.trx
    .updateTable('customer_shop_relations')
    .set({ ended_at: new Date(), end_reason: 'reassigned' })
    .where('customer_id', '=', customerId)
    .where('shop_id', '=', shopId)
    .where('relation_type', '=', 'primary_staff')
    .where('ended_at', 'is', null)
    .where((eb) => (staffId ? eb('staff_id', '!=', staffId) : eb.lit(true)))
    .execute();
  if (staffId) {
    await ctx.trx
      .insertInto('customer_shop_relations')
      .values({ organization_id: ctx.actor.organizationId, customer_id: customerId, shop_id: shopId, staff_id: staffId, relation_type: 'primary_staff' })
      .onConflict((oc) => oc.doNothing())
      .execute();
  }
}

/** Record that a customer visited a shop (shop relation used for visibility) */
export async function ensureVisitedRelation(ctx: Ctx, customerId: string, shopId: string) {
  const exists = await ctx.trx
    .selectFrom('customer_shop_relations')
    .select('id')
    .where('customer_id', '=', customerId)
    .where('shop_id', '=', shopId)
    .where('relation_type', '=', 'visited')
    .where('ended_at', 'is', null)
    .executeTakeFirst();
  if (!exists) {
    await ctx.trx
      .insertInto('customer_shop_relations')
      .values({ organization_id: ctx.actor.organizationId, customer_id: customerId, shop_id: shopId, relation_type: 'visited' })
      .onConflict((oc) => oc.doNothing())
      .execute();
  }
}

export async function updateCustomer(ctx: Ctx, customerId: string, input: UpdateCustomerInput) {
  requirePermission(ctx.actor, 'customer.write');
  await assertCustomerAccess(ctx, customerId);
  const before = await ctx.trx.selectFrom('customers').selectAll().where('id', '=', customerId).executeTakeFirstOrThrow();
  if (input.primaryShopId) assertShopAccess(ctx.actor, input.primaryShopId);
  await ctx.trx
    .updateTable('customers')
    .set({
      customer_number: input.customerNumber,
      last_name: input.lastName?.trim(),
      first_name: input.firstName?.trim(),
      last_name_kana: input.lastNameKana?.trim(),
      first_name_kana: input.firstNameKana?.trim(),
      gender: input.gender,
      birthday: input.birthday,
      phone: input.phone,
      phone_normalized: input.phone !== undefined ? normalizePhone(input.phone) : undefined,
      email: input.email !== undefined ? normalizeEmail(input.email) : undefined,
      postal_code: input.postalCode,
      address: input.address,
      occupation: input.occupation,
      acquisition_source: input.acquisitionSource,
      primary_shop_id: input.primaryShopId,
      primary_staff_id: input.primaryStaffId,
      marketing_opt_in: input.marketingOptIn,
      status: input.status,
      attributes: input.attributes ? JSON.stringify({ ...(before.attributes as object), ...input.attributes }) : undefined,
      updated_by: auditUserId(ctx.actor),
      trace_id: ctx.meta.traceId ?? null,
    })
    .where('id', '=', customerId)
    .execute();
  const shopForRelation = input.primaryShopId ?? before.primary_shop_id;
  if (input.primaryStaffId !== undefined && shopForRelation) {
    await setPrimaryStaffRelation(ctx, customerId, shopForRelation, input.primaryStaffId);
  }
  if (input.tagIds) await setCustomerTags(ctx, customerId, input.tagIds, { skipAudit: true });
  const after = await ctx.trx.selectFrom('customers').selectAll().where('id', '=', customerId).executeTakeFirstOrThrow();
  await audit(ctx, { action: 'customer.update', resourceType: 'customer', resourceId: customerId, ...diff(before, after) });
  await emit(ctx, { type: 'customer.updated', aggregateType: 'customer', aggregateId: customerId, payload: {} });
  return getCustomer(ctx, customerId, { audit: false });
}

/** Logical delete with PII scrubbing of free-text fields kept for statistics (要件 16: 論理削除と保持期間) */
export async function deleteCustomer(ctx: Ctx, customerId: string) {
  requirePermission(ctx.actor, 'customer.delete');
  await assertCustomerAccess(ctx, customerId, { allowMerged: true });
  await ctx.trx
    .updateTable('customers')
    .set({ deleted_at: new Date(), status: 'deleted', updated_by: auditUserId(ctx.actor) })
    .where('id', '=', customerId)
    .execute();
  await audit(ctx, { action: 'customer.delete', resourceType: 'customer', resourceId: customerId });
  await emit(ctx, { type: 'customer.deleted', aggregateType: 'customer', aggregateId: customerId, payload: {} });
}

// ---------------------------------------------------------------- tags

export async function listTags(ctx: Ctx) {
  requirePermission(ctx.actor, 'customer.read');
  return ctx.trx
    .selectFrom('tags')
    .leftJoin('customer_tags', 'customer_tags.tag_id', 'tags.id')
    .select(['tags.id', 'tags.name', 'tags.color', sql<number>`count(customer_tags.customer_id)::int`.as('customer_count')])
    .groupBy('tags.id')
    .orderBy('tags.name')
    .execute();
}

export async function createTag(ctx: Ctx, input: { name: string; color?: string }) {
  requirePermission(ctx.actor, 'customer.write');
  return ctx.trx
    .insertInto('tags')
    .values({ organization_id: ctx.actor.organizationId, name: input.name, color: input.color ?? '#64748b' })
    .returning(['id', 'name', 'color'])
    .executeTakeFirstOrThrow();
}

export async function updateTag(ctx: Ctx, tagId: string, input: { name?: string; color?: string }) {
  requirePermission(ctx.actor, 'customer.write');
  const row = await ctx.trx.updateTable('tags').set(input).where('id', '=', tagId).returning(['id', 'name', 'color']).executeTakeFirst();
  if (!row) throw Errors.notFound('タグ', tagId);
  return row;
}

export async function deleteTag(ctx: Ctx, tagId: string) {
  requirePermission(ctx.actor, 'customer.write');
  await ctx.trx.deleteFrom('tags').where('id', '=', tagId).execute();
}

export async function setCustomerTags(ctx: Ctx, customerId: string, tagIds: string[], opts: { skipAudit?: boolean } = {}) {
  requirePermission(ctx.actor, 'customer.write');
  await assertCustomerAccess(ctx, customerId);
  await ctx.trx.deleteFrom('customer_tags').where('customer_id', '=', customerId).execute();
  if (tagIds.length) {
    await ctx.trx
      .insertInto('customer_tags')
      .values([...new Set(tagIds)].map((tagId) => ({ customer_id: customerId, tag_id: tagId, organization_id: ctx.actor.organizationId })))
      .execute();
  }
  if (!opts.skipAudit) await audit(ctx, { action: 'customer.tags_update', resourceType: 'customer', resourceId: customerId, after: { tagIds } });
  return (await tagsFor(ctx, [customerId])).get(customerId) ?? [];
}

// ---------------------------------------------------------------- memos

export async function listMemos(ctx: Ctx, customerId: string) {
  await assertCustomerAccess(ctx, customerId, { allowMerged: true });
  const staffId = ctx.actor.kind === 'staff' ? ctx.actor.staffId : null;
  return ctx.trx
    .selectFrom('customer_memos')
    .innerJoin('staffs', 'staffs.id', 'customer_memos.staff_id')
    .select([
      'customer_memos.id',
      'customer_memos.body',
      'customer_memos.visibility',
      'customer_memos.pinned',
      'customer_memos.staff_id',
      'staffs.display_name as staff_name',
      'customer_memos.created_at',
      'customer_memos.updated_at',
    ])
    .where('customer_memos.customer_id', '=', customerId)
    .where('customer_memos.deleted_at', 'is', null)
    // private memos are visible ONLY to their author — not even to owners (要件 2.1)
    .where((eb) => eb.or([eb('customer_memos.visibility', '=', 'shared'), eb('customer_memos.staff_id', '=', staffId ?? '00000000-0000-0000-0000-000000000000')]))
    .orderBy('customer_memos.pinned', 'desc')
    .orderBy('customer_memos.created_at', 'desc')
    .execute();
}

export async function createMemo(ctx: Ctx, customerId: string, input: { body: string; visibility: 'shared' | 'private'; pinned?: boolean }) {
  requirePermission(ctx.actor, 'customer.write');
  if (ctx.actor.kind !== 'staff') throw Errors.forbidden();
  await assertCustomerAccess(ctx, customerId);
  const row = await ctx.trx
    .insertInto('customer_memos')
    .values({ organization_id: ctx.actor.organizationId, customer_id: customerId, staff_id: ctx.actor.staffId, body: input.body, visibility: input.visibility, pinned: input.pinned ?? false })
    .returning(['id', 'body', 'visibility', 'pinned', 'staff_id', 'created_at'])
    .executeTakeFirstOrThrow();
  return row;
}

export async function updateMemo(ctx: Ctx, memoId: string, input: Partial<{ body: string; visibility: 'shared' | 'private'; pinned: boolean }>) {
  if (ctx.actor.kind !== 'staff') throw Errors.forbidden();
  const memo = await ctx.trx.selectFrom('customer_memos').select(['id', 'staff_id', 'customer_id']).where('id', '=', memoId).where('deleted_at', 'is', null).executeTakeFirst();
  if (!memo) throw Errors.notFound('メモ', memoId);
  if (memo.staff_id !== ctx.actor.staffId) throw Errors.forbidden('他のスタッフのメモは編集できません');
  return ctx.trx.updateTable('customer_memos').set(input).where('id', '=', memoId).returning(['id', 'body', 'visibility', 'pinned', 'staff_id', 'created_at', 'updated_at']).executeTakeFirstOrThrow();
}

export async function deleteMemo(ctx: Ctx, memoId: string) {
  if (ctx.actor.kind !== 'staff') throw Errors.forbidden();
  const memo = await ctx.trx.selectFrom('customer_memos').select(['id', 'staff_id']).where('id', '=', memoId).executeTakeFirst();
  if (!memo) throw Errors.notFound('メモ', memoId);
  if (memo.staff_id !== ctx.actor.staffId) throw Errors.forbidden('他のスタッフのメモは削除できません');
  await ctx.trx.updateTable('customer_memos').set({ deleted_at: new Date() }).where('id', '=', memoId).execute();
}

// ---------------------------------------------------------------- history / timeline

export async function customerVisits(ctx: Ctx, customerId: string, limit = 50) {
  await assertCustomerAccess(ctx, customerId, { allowMerged: true });
  const appts = await ctx.trx
    .selectFrom('appointments')
    .leftJoin('staffs', 'staffs.id', 'appointments.staff_id')
    .leftJoin('shops', 'shops.id', 'appointments.shop_id')
    .select([
      'appointments.id',
      'appointments.shop_id',
      'shops.name as shop_name',
      'appointments.staff_id',
      'staffs.display_name as staff_name',
      'appointments.is_nominated',
      'appointments.start_at',
      'appointments.end_at',
      'appointments.status',
      'appointments.source',
      'appointments.estimated_total',
    ])
    .where('appointments.customer_id', '=', customerId)
    .where('appointments.deleted_at', 'is', null)
    .orderBy('appointments.start_at', 'desc')
    .limit(limit)
    .execute();
  const ids = appts.map((a) => a.id);
  const [services, txs] = await Promise.all([
    ids.length ? ctx.trx.selectFrom('appointment_services').select(['appointment_id', 'name', 'price', 'duration_min']).where('appointment_id', 'in', ids).orderBy('sort_order').execute() : [],
    ids.length
      ? ctx.trx.selectFrom('transactions').select(['id', 'appointment_id', 'total', 'status', 'completed_at']).where('appointment_id', 'in', ids).where('status', '!=', 'voided').execute()
      : [],
  ]);
  return appts.map((a) => ({
    ...a,
    services: services.filter((s) => s.appointment_id === a.id).map(({ appointment_id: _a, ...s }) => s),
    transaction: txs.find((t) => t.appointment_id === a.id) ?? null,
  }));
}

/** Unified customer timeline (appointments, kartes, transactions, messages, reviews, forms) */
export async function customerTimeline(ctx: Ctx, customerId: string, limit = 100) {
  await assertCustomerAccess(ctx, customerId, { allowMerged: true });
  const res = await sql<{ kind: string; id: string; at: Date; summary: string; ref: unknown }>`
    (SELECT 'appointment' AS kind, id, start_at AS at, status AS summary, jsonb_build_object('shopId', shop_id, 'staffId', staff_id, 'source', source) AS ref
       FROM appointments WHERE customer_id = ${customerId} AND deleted_at IS NULL)
    UNION ALL
    (SELECT 'transaction', id, coalesce(completed_at, created_at), status || ':' || total::text, jsonb_build_object('total', total, 'shopId', shop_id)
       FROM transactions WHERE customer_id = ${customerId} AND status <> 'draft')
    UNION ALL
    (SELECT 'karte', id, created_at, coalesce(left(note, 80), ''), jsonb_build_object('staffId', staff_id, 'visitDate', visit_date)
       FROM kartes WHERE customer_id = ${customerId} AND deleted_at IS NULL)
    UNION ALL
    (SELECT 'message', id, created_at, direction || ':' || coalesce(left(body, 80), message_type), jsonb_build_object('channel', channel, 'status', status, 'category', category)
       FROM messages WHERE customer_id = ${customerId})
    UNION ALL
    (SELECT 'review', id, posted_at, rating::text || '★ ' || coalesce(left(body, 80), ''), jsonb_build_object('status', status, 'source', source)
       FROM reviews WHERE customer_id = ${customerId})
    UNION ALL
    (SELECT 'form', id, created_at, status, jsonb_build_object('templateId', template_id)
       FROM form_responses WHERE customer_id = ${customerId})
    ORDER BY at DESC
    LIMIT ${limit}`.execute(ctx.trx);
  return res.rows;
}

// ---------------------------------------------------------------- identities

export async function unlinkIdentity(ctx: Ctx, customerId: string, identityId: string) {
  requirePermission(ctx.actor, 'customer.write');
  await assertCustomerAccess(ctx, customerId);
  const res = await ctx.trx
    .updateTable('customer_identities')
    .set({ unlinked_at: new Date() })
    .where('id', '=', identityId)
    .where('customer_id', '=', customerId)
    .executeTakeFirst();
  if (Number(res.numUpdatedRows) === 0) throw Errors.notFound('外部ID連携', identityId);
  await audit(ctx, { action: 'customer.identity_unlink', resourceType: 'customer', resourceId: customerId, metadata: { identityId } });
}

// ---------------------------------------------------------------- export

export async function exportCustomersCsv(ctx: Ctx, input: SearchCustomersInput) {
  requirePermission(ctx.actor, 'customer.read', 'export.data');
  const rows: Record<string, unknown>[] = [];
  let cursor: string | undefined;
  do {
    const page = await searchCustomers(ctx, { ...input, limit: 200, cursor });
    rows.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor && rows.length < 100_000);
  await audit(ctx, {
    action: 'export.csv',
    resourceType: 'customer',
    metadata: { kind: 'customers', rowCount: rows.length, filter: input, scope: canSeeAllCustomers(ctx) ? 'all' : 'shops' },
  });
  return toCsv(
    [
      { key: 'customer_number', label: '顧客番号' },
      { key: 'last_name', label: '姓' },
      { key: 'first_name', label: '名' },
      { key: 'last_name_kana', label: 'セイ' },
      { key: 'first_name_kana', label: 'メイ' },
      { key: 'gender', label: '性別' },
      { key: 'birthday', label: '生年月日' },
      { key: 'phone', label: '電話番号' },
      { key: 'email', label: 'メール' },
      { key: 'first_visit_at', label: '初回来店' },
      { key: 'last_visit_at', label: '最終来店' },
      { key: 'visit_count', label: '来店回数' },
      { key: 'total_sales', label: '累計売上' },
      { key: 'avg_cycle_days', label: '平均来店周期(日)' },
      { key: 'point_balance', label: 'ポイント' },
      { key: 'marketing_opt_in', label: '配信許可' },
      { key: 'tagNames', label: 'タグ' },
    ],
    rows.map((r) => ({ ...r, tagNames: ((r.tags as { name: string }[]) ?? []).map((t) => t.name).join('|') })),
  );
}
