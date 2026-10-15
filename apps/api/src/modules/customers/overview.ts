import { sql } from 'kysely';
import type { Ctx } from '../../auth/actor.js';
import { assertCustomerAccess } from './access.js';
import { nameSource } from './service.js';

export interface AssignedStaff {
  staff_id: string;
  staff_name: string;
  /** the staff member currently regarded as in charge */
  is_primary: boolean;
  /** completed visits served by this staff member */
  visit_count: number;
}

/**
 * Staff in charge as derived from the reservation history (最近の担当):
 * the staff member of the latest completed reservation with a nomination, otherwise of the latest
 * completed reservation; only staff who are still working here count. The other staff who served
 * the customer follow with their visit counts. Without completed visits the staff member set on
 * the customer record (if any, and still working) is shown.
 */
export async function assignedStaff(ctx: Ctx, customerId: string, primaryStaffId: string | null): Promise<AssignedStaff[]> {
  const rows = await ctx.trx
    .selectFrom('appointments as a')
    .innerJoin('staffs as s', 's.id', 'a.staff_id')
    .select([
      's.id as staff_id',
      's.display_name as staff_name',
      sql<number>`count(*)::int`.as('visit_count'),
      sql<Date>`max(a.start_at)`.as('last_at'),
      sql<Date | null>`max(a.start_at) FILTER (WHERE a.is_nominated)`.as('last_nominated_at'),
    ])
    .where('a.customer_id', '=', customerId)
    .where('a.status', '=', 'completed')
    .where('a.deleted_at', 'is', null)
    .where('s.deleted_at', 'is', null)
    .where('s.status', '=', 'active')
    .groupBy(['s.id', 's.display_name'])
    .execute();
  if (!rows.length) {
    if (!primaryStaffId) return [];
    const s = await ctx.trx
      .selectFrom('staffs')
      .select(['id', 'display_name'])
      .where('id', '=', primaryStaffId)
      .where('deleted_at', 'is', null)
      .where('status', '=', 'active')
      .executeTakeFirst();
    return s ? [{ staff_id: s.id, staff_name: s.display_name, is_primary: true, visit_count: 0 }] : [];
  }
  const time = (d: Date | null) => (d ? new Date(d).getTime() : 0);
  const nominated = rows.filter((r) => r.last_nominated_at).sort((x, y) => time(y.last_nominated_at) - time(x.last_nominated_at))[0];
  const latest = [...rows].sort((x, y) => time(y.last_at) - time(x.last_at))[0]!;
  const primaryId = (nominated ?? latest).staff_id;
  return rows
    .map((r) => ({ staff_id: r.staff_id, staff_name: r.staff_name, is_primary: r.staff_id === primaryId, visit_count: r.visit_count, last_at: time(r.last_at) }))
    .sort((x, y) => Number(y.is_primary) - Number(x.is_primary) || y.last_at - x.last_at)
    .map(({ last_at: _l, ...r }) => r);
}

/**
 * What the customer screen shows beside the profile: the staff in charge derived from the
 * reservation history, the LINE profile, and the other records linked under the same 会員番号.
 */
export async function customerOverview(ctx: Ctx, customerId: string) {
  await assertCustomerAccess(ctx, customerId, { allowMerged: true });
  const c = await ctx.trx
    .selectFrom('customers')
    .select(['id', 'last_name', 'first_name', 'last_name_kana', 'first_name_kana', 'member_no', 'customer_number', 'primary_staff_id'])
    .where('id', '=', customerId)
    .executeTakeFirstOrThrow();
  const [lineIdentities, linked, staff] = await Promise.all([
    ctx.trx
      .selectFrom('customer_identities')
      .select(['display_name', 'profile', 'linked_at'])
      .where('customer_id', '=', customerId)
      .where('provider', '=', 'line')
      .where('unlinked_at', 'is', null)
      .orderBy('linked_at', 'desc')
      .execute(),
    c.member_no
      ? ctx.trx
          .selectFrom('customers')
          .leftJoin('shops', 'shops.id', 'customers.primary_shop_id')
          .leftJoin('staffs', 'staffs.id', 'customers.primary_staff_id')
          .select([
            'customers.id',
            'shops.name as store_name',
            'staffs.display_name as staff_name',
            'customers.visit_count',
            'customers.last_visit_at',
            (eb) =>
              eb
                .selectFrom('appointments')
                .select(sql<Date | null>`max(appointments.start_at)`.as('at'))
                .whereRef('appointments.customer_id', '=', 'customers.id')
                .where('appointments.deleted_at', 'is', null)
                .as('last_reservation_at'),
          ])
          .where('customers.member_no', '=', c.member_no)
          .where('customers.id', '!=', customerId)
          .where('customers.deleted_at', 'is', null)
          .where('customers.status', 'in', ['active', 'blocked'])
          .orderBy('customers.last_visit_at', 'desc')
          .orderBy('customers.id')
          .limit(50)
          .execute()
      : [],
    assignedStaff(ctx, customerId, c.primary_staff_id),
  ]);
  const line = lineIdentities[0];
  const picture = line ? (line.profile as { pictureUrl?: unknown } | null)?.pictureUrl : null;
  return {
    name_source: nameSource(
      c,
      lineIdentities.map((i) => i.display_name),
    ),
    member_no: c.member_no ?? c.customer_number,
    line: line ? { display_name: line.display_name, picture_url: typeof picture === 'string' && /^https:\/\//.test(picture) ? picture : null } : null,
    assigned_staff: staff,
    linked_customers: linked,
  };
}
