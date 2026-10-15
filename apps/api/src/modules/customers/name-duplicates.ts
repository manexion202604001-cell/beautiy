import { randomInt } from 'node:crypto';
import { sql } from 'kysely';
import { accessibleShopIds, requirePermission, type Ctx } from '../../auth/actor.js';
import { audit } from '../../lib/audit.js';
import { Errors } from '../../lib/errors.js';
import { normalizeKana } from '../../lib/normalize.js';
import { assertCustomerAccess, canSeeAllCustomers } from './access.js';
import type { NameDuplicatesInput } from './schemas.js';

/**
 * 名前重複: customers whose full name is identical after normalization (spaces, width, kana).
 * Unlike the duplicate pairs (phone / e-mail / birthday rules) the name alone decides, so the
 * list is for staff to judge: merge two records, mark the group as the same person
 * (shared 会員番号, records stay separate) or dismiss it.
 *
 * A group is listed while
 *  - at least one pair of its members has not been dismissed (customer_duplicate_dismissals), and
 *  - its members are not already all linked under one 会員番号.
 * Staff limited to their shops only see (and count) customers of those shops.
 */

/** SQL condition on alias `c`: customers the actor may see */
function visibleSql(ctx: Ctx) {
  if (canSeeAllCustomers(ctx)) return sql<boolean>`true`;
  const shopIds = [...(accessibleShopIds(ctx.actor) ?? [])];
  return sql<boolean>`(c.primary_shop_id = ANY(${shopIds}::uuid[]) OR EXISTS (
    SELECT 1 FROM customer_shop_relations r WHERE r.customer_id = c.id AND r.shop_id = ANY(${shopIds}::uuid[])))`;
}

const NAME_SQL = sql<string>`normalize_search_text(c.last_name || c.first_name)`;

export interface NameDuplicateCustomer {
  id: string;
  name: string;
  name_kana: string | null;
  phone: string | null;
  store_name: string | null;
  staff_name: string | null;
  visit_count: number;
  member_no: string | null;
}

export async function listNameDuplicates(ctx: Ctx, input: NameDuplicatesInput) {
  requirePermission(ctx.actor, 'customer.merge');
  const visible = visibleSql(ctx);
  const term = input.search ? normalizeKana(input.search) : '';
  const digits = input.search && /^[\d-]{3,}$/.test(input.search.trim()) ? input.search.replace(/\D/g, '') : '';
  const like = (v: string) => `%${v.replace(/[%_\\]/g, '\\$&')}%`;
  const hit = !term
    ? sql<boolean>`true`
    : digits
      ? sql<boolean>`(c.search_text LIKE ${like(term)} OR regexp_replace(c.phone_normalized, '^[+]81', '0') LIKE ${like(digits)})`
      : sql<boolean>`(c.search_text LIKE ${like(term)})`;

  const groups = sql`
    WITH m AS (
      SELECT c.id, ${NAME_SQL} AS nname, c.member_no, ${hit} AS hit
      FROM customers c
      WHERE c.deleted_at IS NULL AND c.status IN ('active','blocked') AND ${visible}
    ), g AS (
      SELECT nname, array_agg(id) AS ids, count(*)::int AS n
      FROM m
      WHERE nname <> ''
      GROUP BY nname
      HAVING count(*) > 1
        AND NOT (count(member_no) = count(*) AND count(DISTINCT member_no) = 1)
        AND bool_or(hit)
    )
    SELECT g.nname, g.n
    FROM g
    WHERE (SELECT count(*) FROM customer_duplicate_dismissals d
            WHERE d.customer_a_id = ANY(g.ids) AND d.customer_b_id = ANY(g.ids)) < g.n * (g.n - 1) / 2`;

  const totalRow = await sql<{ total: number }>`SELECT count(*)::int AS total FROM (${groups}) x`.execute(ctx.trx);
  const total = totalRow.rows[0]?.total ?? 0;
  if (!total) return { groups: [], total: 0 };

  const page = await sql<{ nname: string; n: number }>`
    SELECT x.nname, x.n FROM (${groups}) x ORDER BY x.n DESC, x.nname LIMIT ${input.limit} OFFSET ${input.offset}`.execute(ctx.trx);
  const names = page.rows.map((r) => r.nname);
  if (!names.length) return { groups: [], total };

  // the first record of a group is the one recommended to keep: most visits, has a phone, oldest
  const members = await sql<NameDuplicateCustomer & { nname: string }>`
    SELECT c.id, ${NAME_SQL} AS nname,
      coalesce(nullif(trim(c.last_name || ' ' || c.first_name), ''), trim(c.last_name_kana || ' ' || c.first_name_kana)) AS name,
      nullif(trim(c.last_name_kana || ' ' || c.first_name_kana), '') AS name_kana,
      c.phone, sh.name AS store_name, s.display_name AS staff_name, c.visit_count,
      coalesce(c.member_no, c.customer_number) AS member_no
    FROM customers c
    LEFT JOIN shops sh ON sh.id = c.primary_shop_id
    LEFT JOIN staffs s ON s.id = c.primary_staff_id
    WHERE c.deleted_at IS NULL AND c.status IN ('active','blocked') AND ${visible}
      AND ${NAME_SQL} = ANY(${names}::text[])
    ORDER BY c.visit_count DESC, (c.phone IS NULL), c.created_at, c.id`.execute(ctx.trx);

  return {
    groups: names.map((nname) => ({
      normalized_name: nname,
      customers: members.rows.filter((r) => r.nname === nname).map(({ nname: _n, ...c }) => c),
    })),
    total,
  };
}

/** 統合しない: every pair of the group is dismissed, so it reappears only when a new record joins it */
export async function dismissNameDuplicate(ctx: Ctx, normalizedName: string) {
  requirePermission(ctx.actor, 'customer.merge');
  const rows = await sql<{ id: string }>`
    SELECT c.id FROM customers c
    WHERE c.deleted_at IS NULL AND c.status IN ('active','blocked') AND ${visibleSql(ctx)}
      AND ${NAME_SQL} = ${normalizedName}
    ORDER BY c.id LIMIT 200`.execute(ctx.trx);
  const ids = rows.rows.map((r) => r.id);
  if (ids.length < 2) throw Errors.notFound('名前重複の候補', normalizedName);
  const pairs: { organization_id: string; customer_a_id: string; customer_b_id: string; dismissed_by: string | null }[] = [];
  const by = ctx.actor.kind === 'staff' ? ctx.actor.staffId : null;
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) pairs.push({ organization_id: ctx.actor.organizationId, customer_a_id: ids[i]!, customer_b_id: ids[j]!, dismissed_by: by });
  }
  for (let i = 0; i < pairs.length; i += 1000) {
    await ctx.trx
      .insertInto('customer_duplicate_dismissals')
      .values(pairs.slice(i, i + 1000))
      .onConflict((oc) => oc.doNothing())
      .execute();
  }
  await audit(ctx, { action: 'customer.name_duplicate_dismiss', resourceType: 'customer', resourceId: ids[0]!, metadata: { normalizedName, customerIds: ids } });
  return { dismissed: ids.length };
}

async function newMemberNo(ctx: Ctx): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const candidate = `M${String(randomInt(0, 100_000_000)).padStart(8, '0')}`;
    const taken = await ctx.trx
      .selectFrom('customers')
      .select('id')
      .where((eb) => eb.or([eb('member_no', '=', candidate), eb('customer_number', '=', candidate)]))
      .limit(1)
      .executeTakeFirst();
    if (!taken) return candidate;
  }
  throw Errors.business('MEMBER_NO_UNAVAILABLE', '会員番号を発行できませんでした。もう一度お試しください');
}

/**
 * 同一人物としてリンク: the records keep their own reservations, kartes and messages and share one
 * 会員番号. The number is the one already used in the group (a shared number first, then the
 * customer number of the first record that has one); otherwise a new one is issued.
 */
export async function linkMaster(ctx: Ctx, customerIds: string[]) {
  requirePermission(ctx.actor, 'customer.merge');
  const ids = [...new Set(customerIds)];
  if (ids.length < 2) throw Errors.validation('リンクする顧客を2件以上指定してください');
  for (const id of ids) await assertCustomerAccess(ctx, id);
  const rows = await ctx.trx.selectFrom('customers').select(['id', 'member_no', 'customer_number']).where('id', 'in', ids).orderBy('id').forUpdate().execute();
  const ordered = ids.map((id) => rows.find((r) => r.id === id)!);
  const memberNo = ordered.find((r) => r.member_no)?.member_no ?? ordered.find((r) => r.customer_number)?.customer_number ?? (await newMemberNo(ctx));
  await ctx.trx.updateTable('customers').set({ member_no: memberNo }).where('id', 'in', ids).execute();
  await audit(ctx, { action: 'customer.link_master', resourceType: 'customer', resourceId: ids[0]!, metadata: { customerIds: ids, memberNo } });
  return { member_no: memberNo, customerIds: ids };
}

/** Take one record out of its 会員番号 group (a group of one is no longer a link) */
export async function unlinkMaster(ctx: Ctx, customerId: string) {
  requirePermission(ctx.actor, 'customer.merge');
  await assertCustomerAccess(ctx, customerId);
  const me = await ctx.trx.selectFrom('customers').select(['id', 'member_no']).where('id', '=', customerId).forUpdate().executeTakeFirstOrThrow();
  if (!me.member_no) return { unlinked: 0 };
  await ctx.trx.updateTable('customers').set({ member_no: null }).where('id', '=', customerId).execute();
  const rest = await ctx.trx.selectFrom('customers').select('id').where('member_no', '=', me.member_no).where('deleted_at', 'is', null).execute();
  if (rest.length === 1) await ctx.trx.updateTable('customers').set({ member_no: null }).where('id', '=', rest[0]!.id).execute();
  await audit(ctx, { action: 'customer.unlink_master', resourceType: 'customer', resourceId: customerId, metadata: { memberNo: me.member_no } });
  return { unlinked: rest.length === 1 ? 2 : 1 };
}
