import { sql } from 'kysely';
import type { Ctx } from '../../auth/actor.js';
import { enqueue } from '../../jobs/queue.js';
import { Errors } from '../../lib/errors.js';
import { allocate } from '../../lib/money.js';
import { dayBounds, localDate } from '../../lib/time.js';
import { loadScheduleData, staffWorkRanges } from '../schedules/calendar.js';

/**
 * Daily aggregation (要件 21: 分析は本番OLTPへの重い直接集計を避け集計テーブルへ).
 * One (shop, local date) is recomputed from the source tables and written idempotently
 * (DELETE + INSERT in the caller's transaction) into analytics_daily_shop / staff / menu / source.
 * Definitions are documented in docs/kpi-definitions.md.
 */

/** Transactions that carry revenue (net of refunds). voided / draft are never counted. */
export const REVENUE_STATUSES = ['completed', 'partially_refunded', 'refunded'] as const;
/** Transactions that count as a visit / 会計件数 (fully refunded = not a visit) */
export const VISIT_STATUSES = ['completed', 'partially_refunded'] as const;
/** Appointment statuses that occupy staff time (booked minutes) */
export const BOOKED_APPT_STATUSES = ['tentative', 'confirmed', 'checked_in', 'in_service', 'completed'] as const;
/** Source label for sales of transactions without an appointment */
export const NO_APPOINTMENT_SOURCE = 'none';

const POSITIVE_LINE_TYPES = new Set(['service', 'nomination_fee', 'product', 'adjustment']);

export interface ShopDayRow {
  sales_total: number;
  service_sales: number;
  product_sales: number;
  discount_total: number;
  tax_total: number;
  refund_total: number;
  transaction_count: number;
  customer_count: number;
  new_customer_count: number;
  repeat_customer_count: number;
  nominated_count: number;
  appointment_count: number;
  cancel_count: number;
  no_show_count: number;
}

export interface StaffDayRow {
  staff_id: string;
  sales_total: number;
  service_sales: number;
  product_sales: number;
  customer_count: number;
  new_customer_count: number;
  nominated_count: number;
  scheduled_minutes: number;
  booked_minutes: number;
}

export interface MenuDayRow {
  menu_id: string;
  count: number;
  sales: number;
}

export interface SourceDayRow {
  source: string;
  appointment_count: number;
  completed_count: number;
  sales: number;
}

export interface DayAggregate {
  shopId: string;
  date: string;
  timezone: string;
  shop: ShopDayRow;
  staff: StaffDayRow[];
  menus: MenuDayRow[];
  sources: SourceDayRow[];
}

export async function loadShopTz(ctx: Ctx, shopId: string): Promise<string> {
  const shop = await ctx.trx.selectFrom('shops').select(['timezone']).where('id', '=', shopId).executeTakeFirst();
  if (!shop) throw Errors.notFound('店舗', shopId);
  return shop.timezone;
}

/** Pure computation of one shop-day from source tables (no writes). */
export async function computeDay(ctx: Ctx, shopId: string, date: string, opts: { skipSchedule?: boolean } = {}): Promise<DayAggregate> {
  const tz = await loadShopTz(ctx, shopId);
  const { start, end } = dayBounds(date, tz);

  const txs = await ctx.trx
    .selectFrom('transactions')
    .select(['id', 'customer_id', 'appointment_id', 'status', 'total', 'refunded_total', 'discount_total', 'tax_total', 'is_new_customer', 'completed_at'])
    .where('shop_id', '=', shopId)
    .where('status', 'in', [...REVENUE_STATUSES])
    .where('completed_at', '>=', start)
    .where('completed_at', '<', end)
    .orderBy('completed_at')
    .orderBy('id')
    .execute();
  const txIds = txs.map((t) => t.id);
  const items = txIds.length
    ? await ctx.trx
        .selectFrom('transaction_items')
        .select(['id', 'transaction_id', 'item_type', 'menu_id', 'quantity', 'amount'])
        .where('transaction_id', 'in', txIds)
        .orderBy('sort_order')
        .orderBy('id')
        .execute()
    : [];
  const itemIds = items.map((i) => i.id);
  const allocations = itemIds.length
    ? await ctx.trx
        .selectFrom('transaction_item_staff')
        .select(['transaction_item_id', 'staff_id', 'role', 'share_bp', 'is_nominated', 'allocated_amount'])
        .where('transaction_item_id', 'in', itemIds)
        .orderBy('id')
        .execute()
    : [];
  const apptIds = [...new Set(txs.map((t) => t.appointment_id).filter((x): x is string => !!x))];
  const linkedAppts = apptIds.length
    ? await ctx.trx.selectFrom('appointments').select(['id', 'source', 'is_nominated', 'staff_id']).where('id', 'in', apptIds).execute()
    : [];
  const apptById = new Map(linkedAppts.map((a) => [a.id, a]));

  // first counted visit (org-wide) per customer: decides 新規 when the POS left is_new_customer NULL
  const customerIds = [...new Set(txs.map((t) => t.customer_id).filter((x): x is string => !!x))];
  const firstTx = new Map<string, string>();
  if (customerIds.length) {
    const rows = await ctx.trx
      .selectFrom('transactions')
      .select(['customer_id', 'id'])
      .distinctOn('customer_id')
      .where('customer_id', 'in', customerIds)
      .where('status', 'in', [...VISIT_STATUSES])
      .where('completed_at', 'is not', null)
      .orderBy('customer_id')
      .orderBy('completed_at')
      .orderBy('id')
      .execute();
    for (const r of rows) firstTx.set(r.customer_id!, r.id);
  }

  const itemsByTx = new Map<string, typeof items>();
  for (const it of items) itemsByTx.set(it.transaction_id, [...(itemsByTx.get(it.transaction_id) ?? []), it]);
  const allocByItem = new Map<string, typeof allocations>();
  for (const a of allocations) allocByItem.set(a.transaction_item_id, [...(allocByItem.get(a.transaction_item_id) ?? []), a]);

  const shop: ShopDayRow = {
    sales_total: 0,
    service_sales: 0,
    product_sales: 0,
    discount_total: 0,
    tax_total: 0,
    refund_total: 0,
    transaction_count: 0,
    customer_count: 0,
    new_customer_count: 0,
    repeat_customer_count: 0,
    nominated_count: 0,
    appointment_count: 0,
    cancel_count: 0,
    no_show_count: 0,
  };
  const staff = new Map<string, StaffDayRow & { customers: Set<string>; anon: number; newCustomers: Set<string> }>();
  const staffRow = (staffId: string) => {
    let row = staff.get(staffId);
    if (!row) {
      row = {
        staff_id: staffId,
        sales_total: 0,
        service_sales: 0,
        product_sales: 0,
        customer_count: 0,
        new_customer_count: 0,
        nominated_count: 0,
        scheduled_minutes: 0,
        booked_minutes: 0,
        customers: new Set(),
        anon: 0,
        newCustomers: new Set(),
      };
      staff.set(staffId, row);
    }
    return row;
  };
  const menus = new Map<string, MenuDayRow>();
  const sources = new Map<string, SourceDayRow>();
  const sourceRow = (source: string) => {
    let row = sources.get(source);
    if (!row) {
      row = { source, appointment_count: 0, completed_count: 0, sales: 0 };
      sources.set(source, row);
    }
    return row;
  };

  const visitCustomers = new Set<string>();
  const newCustomers = new Set<string>();
  let anonymousVisits = 0;

  for (const tx of txs) {
    const isVisit = (VISIT_STATUSES as readonly string[]).includes(tx.status);
    const net = tx.total - tx.refunded_total;
    const refundShare = tx.total > 0 ? Math.min(1, tx.refunded_total / tx.total) : 0;
    shop.sales_total += net;
    shop.refund_total += tx.refunded_total;
    shop.tax_total += tx.tax_total - Math.floor(tx.tax_total * refundShare);
    if (isVisit) shop.discount_total += tx.discount_total;

    // allocate the net amount across positive lines (discount/coupon rows and refunds are spread pro rata)
    const lines = (itemsByTx.get(tx.id) ?? []).filter((i) => POSITIVE_LINE_TYPES.has(i.item_type) && i.amount > 0);
    const lineNets = allocate(net, lines.map((l) => l.amount));
    if (lines.length === 0) shop.service_sales += net; // no itemization: treat as service
    const appt = tx.appointment_id ? apptById.get(tx.appointment_id) : undefined;
    const mainStaff = new Set<string>();
    const nominatedStaff = new Set<string>();
    let txNominated = !!appt?.is_nominated;
    if (appt?.is_nominated && appt.staff_id) nominatedStaff.add(appt.staff_id);

    lines.forEach((line, idx) => {
      const lineNet = lineNets[idx]!;
      const isProduct = line.item_type === 'product';
      if (isProduct) shop.product_sales += lineNet;
      else shop.service_sales += lineNet;
      if (line.item_type === 'service' && line.menu_id) {
        const m = menus.get(line.menu_id) ?? { menu_id: line.menu_id, count: 0, sales: 0 };
        m.sales += lineNet;
        if (isVisit) m.count += line.quantity;
        menus.set(line.menu_id, m);
      }
      const allocs = allocByItem.get(line.id) ?? [];
      if (!allocs.length) return;
      const weights = allocs.some((a) => a.share_bp > 0)
        ? allocs.map((a) => a.share_bp)
        : allocs.some((a) => a.allocated_amount > 0)
          ? allocs.map((a) => a.allocated_amount)
          : allocs.map(() => 1);
      const parts = allocate(lineNet, weights);
      allocs.forEach((a, i) => {
        const row = staffRow(a.staff_id);
        row.sales_total += parts[i]!;
        if (isProduct) row.product_sales += parts[i]!;
        else row.service_sales += parts[i]!;
        if (a.role === 'main') mainStaff.add(a.staff_id);
        if (a.is_nominated) {
          txNominated = true;
          nominatedStaff.add(a.staff_id);
        }
      });
    });

    sourceRow(appt?.source ?? NO_APPOINTMENT_SOURCE).sales += net;

    if (!isVisit) continue;
    shop.transaction_count += 1;
    if (txNominated) shop.nominated_count += 1;
    const isNew = !!tx.customer_id && (tx.is_new_customer ?? firstTx.get(tx.customer_id) === tx.id);
    if (tx.customer_id) {
      visitCustomers.add(tx.customer_id);
      if (isNew) newCustomers.add(tx.customer_id);
    } else anonymousVisits += 1;
    for (const staffId of mainStaff) {
      const row = staffRow(staffId);
      if (tx.customer_id) {
        row.customers.add(tx.customer_id);
        if (isNew) row.newCustomers.add(tx.customer_id);
      } else row.anon += 1;
      if (nominatedStaff.has(staffId)) row.nominated_count += 1;
    }
  }
  shop.customer_count = visitCustomers.size + anonymousVisits;
  shop.new_customer_count = newCustomers.size;
  shop.repeat_customer_count = visitCustomers.size - newCustomers.size;

  // appointments starting on this local date
  const appts = await ctx.trx
    .selectFrom('appointments')
    .select(['id', 'staff_id', 'status', 'source', 'start_at', 'end_at'])
    .where('shop_id', '=', shopId)
    .where('deleted_at', 'is', null)
    .where('start_at', '>=', start)
    .where('start_at', '<', end)
    .execute();
  for (const a of appts) {
    shop.appointment_count += 1;
    if (a.status === 'cancelled') shop.cancel_count += 1;
    if (a.status === 'no_show') shop.no_show_count += 1;
    const src = sourceRow(a.source);
    src.appointment_count += 1;
    if (a.status === 'completed') src.completed_count += 1;
    if (a.staff_id && (BOOKED_APPT_STATUSES as readonly string[]).includes(a.status)) {
      staffRow(a.staff_id).booked_minutes += Math.round((a.end_at.getTime() - a.start_at.getTime()) / 60_000);
    }
  }

  // scheduled minutes: bookable staff assigned to this shop on the date + anyone with activity
  if (!opts.skipSchedule) {
    const assigned = await ctx.trx
      .selectFrom('staff_shop_assignments as ssa')
      .innerJoin('staffs', 'staffs.id', 'ssa.staff_id')
      .select('ssa.staff_id')
      .where('ssa.shop_id', '=', shopId)
      .where('ssa.started_on', '<=', date)
      .where((eb) => eb.or([eb('ssa.ended_on', 'is', null), eb('ssa.ended_on', '>=', date)]))
      .where('staffs.is_bookable', '=', true)
      .where('staffs.status', '=', 'active')
      .where('staffs.deleted_at', 'is', null)
      .execute();
    const staffIds = [...new Set([...assigned.map((a) => a.staff_id), ...staff.keys()])];
    if (staffIds.length) {
      const data = await loadScheduleData(ctx, shopId, staffIds, date, date, tz);
      for (const staffId of staffIds) {
        const minutes = staffWorkRanges(data, staffId, date).reduce((s, r) => s + Math.round((r.end.getTime() - r.start.getTime()) / 60_000), 0);
        if (minutes > 0) staffRow(staffId).scheduled_minutes = minutes;
      }
    }
  }

  const staffRows: StaffDayRow[] = [...staff.values()]
    .map(({ customers, anon, newCustomers: nc, ...row }) => ({ ...row, customer_count: customers.size + anon, new_customer_count: nc.size }))
    .filter((r) => r.sales_total !== 0 || r.customer_count || r.scheduled_minutes || r.booked_minutes || r.nominated_count);

  return {
    shopId,
    date,
    timezone: tz,
    shop,
    staff: staffRows,
    menus: [...menus.values()].filter((m) => m.count || m.sales),
    sources: [...sources.values()],
  };
}

/** Idempotent recompute of one shop-day (DELETE + INSERT inside ctx.trx). */
export async function rebuildDay(ctx: Ctx, shopId: string, date: string): Promise<DayAggregate> {
  // serialize concurrent rebuilds of the same shop-day
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${rebuildDedupeKey(shopId, date)}, 0))`.execute(ctx.trx);
  const agg = await computeDay(ctx, shopId, date);
  const org = ctx.actor.organizationId;
  for (const table of ['analytics_daily_shop', 'analytics_daily_staff', 'analytics_daily_menu', 'analytics_daily_source'] as const) {
    await ctx.trx.deleteFrom(table).where('shop_id', '=', shopId).where('date', '=', date).execute();
  }
  const computed_at = new Date();
  await ctx.trx.insertInto('analytics_daily_shop').values({ organization_id: org, shop_id: shopId, date, computed_at, ...agg.shop }).execute();
  if (agg.staff.length) {
    await ctx.trx
      .insertInto('analytics_daily_staff')
      .values(agg.staff.map((r) => ({ organization_id: org, shop_id: shopId, date, computed_at, ...r })))
      .execute();
  }
  if (agg.menus.length) {
    await ctx.trx
      .insertInto('analytics_daily_menu')
      .values(agg.menus.map((r) => ({ organization_id: org, shop_id: shopId, date, computed_at, ...r })))
      .execute();
  }
  if (agg.sources.length) {
    await ctx.trx
      .insertInto('analytics_daily_source')
      .values(agg.sources.map((r) => ({ organization_id: org, shop_id: shopId, date, computed_at, ...r })))
      .execute();
  }
  return agg;
}

// ---------------------------------------------------------------- scheduling (debounced rebuild jobs)

export const REBUILD_JOB = 'analytics.rebuild_day';

/** Debounce window: bursts of events for the same shop-day collapse into one rebuild */
export const rebuildSettings = { debounceMs: 30_000 };

export function rebuildDedupeKey(shopId: string, date: string) {
  return `analytics:${shopId}:${date}`;
}

/**
 * Enqueue rebuild jobs for shop-days (deduplicated while queued). If a rebuild for the same day
 * is already RUNNING it may have read data before this change committed, so a single follow-up
 * job is queued under a secondary key.
 */
export async function scheduleRebuild(ctx: Ctx, shopId: string, dates: string[], delayMs = rebuildSettings.debounceMs): Promise<number> {
  let queued = 0;
  for (const date of [...new Set(dates)]) {
    const key = rebuildDedupeKey(shopId, date);
    const spec = { type: REBUILD_JOB, payload: { shopId, date }, runAt: new Date(Date.now() + delayMs), maxAttempts: 5 };
    const id = await enqueue(ctx, { ...spec, dedupeKey: key });
    if (id) {
      queued++;
      continue;
    }
    const running = await ctx.trx.selectFrom('jobs').select('id').where('dedupe_key', '=', key).where('state', '=', 'running').executeTakeFirst();
    if (running && (await enqueue(ctx, { ...spec, dedupeKey: `${key}:followup` }))) queued++;
  }
  return queued;
}

/** Schedule rebuilds for the local dates (shop TZ) of the given instants */
export async function scheduleRebuildForInstants(ctx: Ctx, shopId: string, instants: (string | Date | null | undefined)[]): Promise<number> {
  const valid = instants.filter((x): x is string | Date => !!x).map((x) => (x instanceof Date ? x : new Date(x))).filter((d) => !Number.isNaN(d.getTime()));
  if (!valid.length) return 0;
  const tz = await loadShopTz(ctx, shopId);
  return scheduleRebuild(ctx, shopId, valid.map((d) => localDate(d, tz)));
}
