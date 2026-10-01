import { sql } from 'kysely';
import { requirePermission, type Ctx } from '../../auth/actor.js';
import { normalizeKana, normalizeName, similarity } from '../../lib/normalize.js';
import { visibleCustomerFilter } from './access.js';

/**
 * 名寄せ (要件 4.1): exact rules and similarity rules are evaluated separately.
 *  exact   (strong):  same normalized phone | same email
 *  similar (weak):    kana/name similarity >= 0.85 AND (same birthday | same phone last 4)
 *                     or identical full name AND same birthday
 * Only "exact" candidates are eligible for auto-merge; everything else requires staff confirmation.
 */
export interface DuplicateCandidate {
  customerId: string;
  displayName: string;
  phone: string | null;
  email: string | null;
  birthday: string | null;
  lastVisitAt: Date | null;
  visitCount: number;
  strength: 'exact' | 'similar';
  score: number;
  reasons: string[];
}

type Row = {
  id: string;
  last_name: string;
  first_name: string;
  last_name_kana: string;
  first_name_kana: string;
  phone_normalized: string | null;
  phone: string | null;
  email: string | null;
  birthday: string | null;
  last_visit_at: Date | null;
  visit_count: number;
};

export function scorePair(a: Row, b: Row): Omit<DuplicateCandidate, 'customerId' | 'displayName' | 'phone' | 'email' | 'birthday' | 'lastVisitAt' | 'visitCount'> | null {
  const reasons: string[] = [];
  if (a.phone_normalized && a.phone_normalized === b.phone_normalized) reasons.push('phone_exact');
  if (a.email && b.email && a.email.toLowerCase() === b.email.toLowerCase()) reasons.push('email_exact');
  if (reasons.length) return { strength: 'exact', score: 1, reasons };

  const kanaA = normalizeKana(a.last_name_kana + a.first_name_kana);
  const kanaB = normalizeKana(b.last_name_kana + b.first_name_kana);
  const nameA = normalizeName(a.last_name + a.first_name);
  const nameB = normalizeName(b.last_name + b.first_name);
  const kanaSim = kanaA && kanaB ? similarity(kanaA, kanaB) : 0;
  const nameSim = nameA && nameB ? similarity(nameA, nameB) : 0;
  const sim = Math.max(kanaSim, nameSim);
  const sameBirthday = !!a.birthday && a.birthday === b.birthday;
  const samePhoneTail = !!a.phone_normalized && !!b.phone_normalized && a.phone_normalized.slice(-4) === b.phone_normalized.slice(-4);

  if (nameA && nameA === nameB && sameBirthday) return { strength: 'similar', score: 0.95, reasons: ['name_exact', 'birthday_exact'] };
  if (sim >= 0.85 && (sameBirthday || samePhoneTail)) {
    return {
      strength: 'similar',
      score: Math.round((sim * 0.7 + (sameBirthday ? 0.2 : 0) + (samePhoneTail ? 0.1 : 0)) * 100) / 100,
      reasons: [kanaSim >= nameSim ? 'kana_similar' : 'name_similar', ...(sameBirthday ? ['birthday_exact'] : []), ...(samePhoneTail ? ['phone_tail'] : [])],
    };
  }
  return null;
}

const cols = [
  'customers.id',
  'customers.last_name',
  'customers.first_name',
  'customers.last_name_kana',
  'customers.first_name_kana',
  'customers.phone_normalized',
  'customers.phone',
  'customers.email',
  'customers.birthday',
  'customers.last_visit_at',
  'customers.visit_count',
] as const;

/** Candidates for one customer (shown on create and on the customer page) */
export async function findDuplicateCandidates(ctx: Ctx, customerId: string): Promise<DuplicateCandidate[]> {
  const me = await ctx.trx.selectFrom('customers').select(cols).where('id', '=', customerId).executeTakeFirst();
  if (!me) return [];
  const kana = normalizeKana(me.last_name_kana + me.first_name_kana);
  const name = normalizeName(me.last_name + me.first_name);
  let q = ctx.trx
    .selectFrom('customers')
    .select(cols)
    .where('customers.id', '!=', customerId)
    .where('customers.deleted_at', 'is', null)
    .where('customers.status', 'in', ['active', 'blocked'])
    .where((eb) =>
      eb.or([
        ...(me.phone_normalized ? [eb('customers.phone_normalized', '=', me.phone_normalized)] : []),
        ...(me.email ? [eb('customers.email', '=', me.email)] : []),
        ...(me.birthday ? [eb('customers.birthday', '=', me.birthday)] : []),
        ...(me.phone_normalized ? [eb(sql`right(customers.phone_normalized, 4)`, '=', me.phone_normalized.slice(-4))] : []),
        ...(kana.length >= 2 ? [eb(sql`similarity(customers.search_text, ${kana})`, '>', 0.3)] : []),
        ...(name.length >= 2 ? [eb(sql`similarity(customers.search_text, ${name})`, '>', 0.3)] : []),
      ]),
    )
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('customer_duplicate_dismissals as d')
            .select(sql`1`.as('x'))
            .where((e2) =>
              e2.or([
                e2.and([e2('d.customer_a_id', '=', customerId), e2('d.customer_b_id', '=', e2.ref('customers.id'))]),
                e2.and([e2('d.customer_b_id', '=', customerId), e2('d.customer_a_id', '=', e2.ref('customers.id'))]),
              ]),
            ),
        ),
      ),
    )
    .limit(200);
  const filter = visibleCustomerFilter(ctx);
  if (filter) q = q.where(filter);
  const rows = await q.execute();
  return rows
    .map((r) => {
      const s = scorePair(me, r);
      return s
        ? {
            customerId: r.id,
            displayName: `${r.last_name} ${r.first_name}`.trim() || `${r.last_name_kana} ${r.first_name_kana}`.trim(),
            phone: r.phone,
            email: r.email,
            birthday: r.birthday,
            lastVisitAt: r.last_visit_at,
            visitCount: r.visit_count,
            ...s,
          }
        : null;
    })
    .filter((x): x is DuplicateCandidate => x !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);
}

/** Organization-wide duplicate pairs for the 名寄せ review screen */
export async function listDuplicatePairs(ctx: Ctx, limit = 100) {
  requirePermission(ctx.actor, 'customer.merge');
  const res = await sql<{ a: string; b: string; rule: string }>`
    WITH c AS (
      SELECT id, phone_normalized, email, birthday,
        normalize_search_text(last_name_kana || first_name_kana) AS kana,
        normalize_search_text(last_name || first_name) AS name
      FROM customers WHERE deleted_at IS NULL AND status IN ('active','blocked')
    )
    SELECT DISTINCT ON (least(x.id, y.id), greatest(x.id, y.id)) least(x.id, y.id) AS a, greatest(x.id, y.id) AS b,
      CASE WHEN x.phone_normalized = y.phone_normalized THEN 'phone_exact'
           WHEN x.email = y.email THEN 'email_exact'
           ELSE 'similar' END AS rule
    FROM c x JOIN c y ON x.id < y.id AND (
      (x.phone_normalized IS NOT NULL AND x.phone_normalized = y.phone_normalized)
      OR (x.email IS NOT NULL AND x.email = y.email)
      OR (x.birthday IS NOT NULL AND x.birthday = y.birthday AND (
            (x.kana <> '' AND similarity(x.kana, y.kana) > 0.4) OR (x.name <> '' AND similarity(x.name, y.name) > 0.4)))
    )
    WHERE NOT EXISTS (SELECT 1 FROM customer_duplicate_dismissals d WHERE d.customer_a_id = least(x.id, y.id) AND d.customer_b_id = greatest(x.id, y.id))
    LIMIT ${limit}`.execute(ctx.trx);
  if (!res.rows.length) return [];
  const ids = [...new Set(res.rows.flatMap((r) => [r.a, r.b]))];
  const customers = await ctx.trx.selectFrom('customers').select(cols).where('id', 'in', ids).execute();
  const byId = new Map(customers.map((c) => [c.id, c]));
  return res.rows
    .map((r) => {
      const a = byId.get(r.a)!;
      const b = byId.get(r.b)!;
      const s = scorePair(a, b);
      return s ? { a, b, ...s } : null;
    })
    .filter((x) => x !== null)
    .sort((x, y) => y!.score - x!.score);
}

export async function dismissDuplicate(ctx: Ctx, a: string, b: string) {
  requirePermission(ctx.actor, 'customer.merge');
  const [x, y] = a < b ? [a, b] : [b, a];
  await ctx.trx
    .insertInto('customer_duplicate_dismissals')
    .values({ organization_id: ctx.actor.organizationId, customer_a_id: x, customer_b_id: y, dismissed_by: ctx.actor.kind === 'staff' ? ctx.actor.staffId : null })
    .onConflict((oc) => oc.doNothing())
    .execute();
}
