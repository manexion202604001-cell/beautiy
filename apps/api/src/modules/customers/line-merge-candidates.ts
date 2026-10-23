import { sql } from 'kysely';
import { accessibleShopIds, requirePermission, type Ctx } from '../../auth/actor.js';
import { canSeeAllCustomers } from './access.js';

/**
 * 統合候補 (SALOGIC: merge candidates): a customer record that came in through LINE (follow, LINE
 * login / booking, reception inside LINE) next to a record the salon already had for the same
 * person. Staff merge the LINE record into the existing one (統合する) or dismiss the pair (スキップ).
 *
 *  - LINE customer: has a LINE identity that was linked together with the record's creation
 *    (in the same minute; the follow / LINE login / reception creates both at once). A record the
 *    salon already had and that was linked to LINE afterwards (LINE連携 QR, a merge) is an existing
 *    customer, so merged records do not come back as candidates.
 *  - existing customer: any other active record.
 *  - match (one label per pair, in this order): 電話番号一致 (same phone), 名前一致 (same full name
 *    after normalisation), 読み仮名一致 (same reading; a LINE record without フリガナ whose name is
 *    written in kana is compared by its name).
 *  - shop: both records belong to the shop (primary shop or a shop relation). A LINE record that is
 *    not tied to any shop yet (organisation-wide LINE account) is offered to every shop.
 *  - pairs dismissed before (customer_duplicate_dismissals) are not listed.
 * Records that look alike without LINE stay in 名前重複 and the 重複候補 review screen.
 */
export type LineMatchType = 'phone' | 'name' | 'name_kana';

export interface LineMergeCandidate {
  /** `<LINE customer id>:<existing customer id>` */
  id: string;
  match_type: LineMatchType;
  line_customer_id: string;
  line_customer_name: string;
  line_display_name: string | null;
  line_customer_avatar: string | null;
  existing_customer_id: string;
  existing_customer_name: string;
  existing_customer_name_kana: string | null;
  existing_customer_phone: string | null;
  existing_customer_visit_count: number;
  existing_customer_last_visit_at: Date | null;
  existing_customer_staff_name: string | null;
}

/** LINE identity linked together with the record's creation */
const LINE_ORIGIN = sql<boolean>`EXISTS (
  SELECT 1 FROM customer_identities ci
  WHERE ci.customer_id = c.id AND ci.provider = 'line' AND ci.unlinked_at IS NULL
    AND ci.linked_at BETWEEN c.created_at AND c.created_at + interval '1 minute')`;

function visibleSql(ctx: Ctx) {
  if (canSeeAllCustomers(ctx)) return sql<boolean>`true`;
  const shopIds = [...(accessibleShopIds(ctx.actor) ?? [])];
  return sql<boolean>`(c.primary_shop_id = ANY(${shopIds}::uuid[]) OR EXISTS (
    SELECT 1 FROM customer_shop_relations r WHERE r.customer_id = c.id AND r.shop_id = ANY(${shopIds}::uuid[])))`;
}

function inShop(shopId: string | null) {
  if (!shopId) return sql<boolean>`true`;
  return sql<boolean>`(c.primary_shop_id = ${shopId} OR EXISTS (
    SELECT 1 FROM customer_shop_relations r WHERE r.customer_id = c.id AND r.shop_id = ${shopId}))`;
}

function withoutShop() {
  return sql<boolean>`(c.primary_shop_id IS NULL AND NOT EXISTS (SELECT 1 FROM customer_shop_relations r WHERE r.customer_id = c.id))`;
}

export async function listLineMergeCandidates(
  ctx: Ctx,
  input: { shopId?: string | null; customerId?: string; limit?: number },
) {
  requirePermission(ctx.actor, 'customer.merge');
  const shopId = input.shopId ?? ctx.meta.currentShopId ?? null;
  const limit = input.limit ?? 100;
  const visible = visibleSql(ctx);
  const onlyCustomer = input.customerId
    ? sql<boolean>`b.id = ${input.customerId}::uuid`
    : sql<boolean>`true`;

  const pairs = sql`
    WITH base AS (
      SELECT c.id, c.phone_normalized,
        normalize_search_text(c.last_name || c.first_name) AS nname,
        normalize_search_text(c.last_name_kana || c.first_name_kana) AS kana,
        ${LINE_ORIGIN} AS from_line,
        ${inShop(shopId)} AS in_shop,
        ${withoutShop()} AS no_shop
      FROM customers c
      WHERE c.deleted_at IS NULL AND c.status IN ('active','blocked') AND ${visible}
        AND (${inShop(shopId)} OR ${withoutShop()})
    ), l AS (
      SELECT b.id, b.phone_normalized, b.nname,
        coalesce(nullif(b.kana, ''), CASE WHEN b.nname ~ '^[ァ-ヶー]+$' THEN b.nname END, '') AS kana
      FROM base b
      WHERE b.from_line AND (b.in_shop OR b.no_shop) AND ${onlyCustomer}
    ), e AS (
      SELECT b.id, b.phone_normalized, b.nname, b.kana FROM base b WHERE NOT b.from_line AND b.in_shop
    ), m AS (
      SELECT l.id AS lid, e.id AS eid, 'phone' AS match_type, 1 AS prio FROM l JOIN e ON l.phone_normalized = e.phone_normalized
      UNION ALL
      SELECT l.id, e.id, 'name', 2 FROM l JOIN e ON l.nname = e.nname WHERE l.nname <> ''
      UNION ALL
      SELECT l.id, e.id, 'name_kana', 3 FROM l JOIN e ON l.kana = e.kana WHERE l.kana <> ''
    )
    SELECT DISTINCT ON (m.lid, m.eid) m.lid, m.eid, m.match_type, m.prio
    FROM m
    WHERE m.lid <> m.eid AND NOT EXISTS (
      SELECT 1 FROM customer_duplicate_dismissals d
      WHERE d.customer_a_id = least(m.lid, m.eid) AND d.customer_b_id = greatest(m.lid, m.eid))
    ORDER BY m.lid, m.eid, m.prio`;

  const total =
    (await sql<{ n: number }>`SELECT count(*)::int AS n FROM (${pairs}) x`.execute(ctx.trx)).rows[0]
      ?.n ?? 0;
  if (!total) return { candidates: [] as LineMergeCandidate[], total: 0 };

  const rows = await sql<{
    lid: string;
    eid: string;
    match_type: LineMatchType;
    line_customer_name: string;
    line_display_name: string | null;
    line_profile: unknown;
    existing_customer_name: string;
    existing_customer_name_kana: string | null;
    existing_customer_phone: string | null;
    existing_customer_visit_count: number;
    existing_customer_last_visit_at: Date | null;
    existing_customer_staff_name: string | null;
  }>`
    SELECT p.lid, p.eid, p.match_type,
      coalesce(nullif(trim(lc.last_name || ' ' || lc.first_name), ''), trim(lc.last_name_kana || ' ' || lc.first_name_kana)) AS line_customer_name,
      li.display_name AS line_display_name, li.profile AS line_profile,
      coalesce(nullif(trim(ec.last_name || ' ' || ec.first_name), ''), trim(ec.last_name_kana || ' ' || ec.first_name_kana)) AS existing_customer_name,
      nullif(trim(ec.last_name_kana || ' ' || ec.first_name_kana), '') AS existing_customer_name_kana,
      ec.phone AS existing_customer_phone, ec.visit_count AS existing_customer_visit_count,
      ec.last_visit_at AS existing_customer_last_visit_at, s.display_name AS existing_customer_staff_name
    FROM (${pairs}) p
    JOIN customers lc ON lc.id = p.lid
    JOIN customers ec ON ec.id = p.eid
    LEFT JOIN staffs s ON s.id = ec.primary_staff_id
    LEFT JOIN LATERAL (
      SELECT ci.display_name, ci.profile FROM customer_identities ci
      WHERE ci.customer_id = lc.id AND ci.provider = 'line' AND ci.unlinked_at IS NULL
      ORDER BY ci.linked_at DESC LIMIT 1
    ) li ON true
    ORDER BY lc.created_at DESC, p.lid, p.prio, ec.visit_count DESC, p.eid
    LIMIT ${limit}`.execute(ctx.trx);

  const candidates: LineMergeCandidate[] = rows.rows.map((r) => {
    const picture = (r.line_profile as { pictureUrl?: unknown } | null)?.pictureUrl;
    return {
      id: `${r.lid}:${r.eid}`,
      match_type: r.match_type,
      line_customer_id: r.lid,
      line_customer_name: r.line_customer_name,
      line_display_name: r.line_display_name,
      line_customer_avatar:
        typeof picture === 'string' && /^https:\/\//.test(picture) ? picture : null,
      existing_customer_id: r.eid,
      existing_customer_name: r.existing_customer_name,
      existing_customer_name_kana: r.existing_customer_name_kana,
      existing_customer_phone: r.existing_customer_phone,
      existing_customer_visit_count: r.existing_customer_visit_count,
      existing_customer_last_visit_at: r.existing_customer_last_visit_at,
      existing_customer_staff_name: r.existing_customer_staff_name,
    };
  });
  return { candidates, total };
}
