import { sql } from 'kysely';
import { accessibleShopIds, assertShopAccess, can, requireAnyPermission, requirePermission, requireStaff, type Ctx } from '../../auth/actor.js';
import type { Permission } from '../../auth/permissions.js';
import { enqueue, registerJob } from '../../jobs/queue.js';
import { audit } from '../../lib/audit.js';
import { sha256 } from '../../lib/crypto.js';
import { toCsv } from '../../lib/csv.js';
import { Errors } from '../../lib/errors.js';
import { emit } from '../../lib/events.js';
import { decodeCursor, paginate } from '../../lib/pagination.js';
import { storage } from '../../lib/storage.js';
import { addDays, dayBounds, DEFAULT_TZ, formatJst } from '../../lib/time.js';
import { canSeeAllCustomers } from '../customers/access.js';
import type { CreateExportInput } from './schemas.js';

/**
 * データエクスポート (要件 16: 権限・監査必須).
 * POST /exports records the request (with the requester's shop scope snapshot) and queues
 * 'export.generate', which pages through the data, writes a BOM CSV to object storage (files row,
 * purpose 'export'), and audits 'export.csv' with the row count. Downloads are short-lived signed URLs.
 */
export const EXPORT_JOB = 'export.generate';
export const EXPORT_TTL_DAYS = 7;
const PAGE = 1000;
const DOWNLOAD_TTL_SEC = 300;

type Kind = CreateExportInput['kind'];

const KIND_PERMISSION: Record<Kind, Permission> = {
  customers: 'customer.read',
  appointments: 'appointment.read',
  transactions: 'sales.read',
  transaction_items: 'sales.read',
  staff_sales: 'sales.read',
};

const KIND_LABEL: Record<Kind, string> = {
  customers: '顧客',
  appointments: '予約',
  transactions: '売上',
  transaction_items: '売上明細',
  staff_sales: 'スタッフ別売上',
};

interface ExportScope {
  /** null = all shops */
  shopIds: string[] | null;
  allCustomers: boolean;
}

interface StoredParams {
  from?: string;
  to?: string;
  shopId?: string;
  scope: ExportScope;
}

const EXPORT_COLUMNS = ['id', 'kind', 'params', 'status', 'file_id', 'row_count', 'error', 'requested_by', 'created_at', 'completed_at', 'expires_at'] as const;

function publicExport<T extends { params: unknown }>(row: T) {
  const { scope: _s, ...params } = (row.params ?? {}) as StoredParams;
  return { ...row, params };
}

export async function createExport(ctx: Ctx, input: CreateExportInput) {
  requireStaff(ctx.actor);
  requirePermission(ctx.actor, 'export.data', KIND_PERMISSION[input.kind]);
  if (input.params.shopId) assertShopAccess(ctx.actor, input.params.shopId);
  const shops = accessibleShopIds(ctx.actor);
  const scope: ExportScope = { shopIds: shops ? [...shops] : null, allCustomers: canSeeAllCustomers(ctx) };
  const row = await ctx.trx
    .insertInto('data_exports')
    .values({
      organization_id: ctx.actor.organizationId,
      kind: input.kind,
      params: JSON.stringify({ ...input.params, scope } satisfies StoredParams),
      status: 'queued',
      requested_by: ctx.actor.staffId,
    })
    .returning(EXPORT_COLUMNS)
    .executeTakeFirstOrThrow();
  await enqueue(ctx, { type: EXPORT_JOB, payload: { exportId: row.id }, dedupeKey: `export:${row.id}`, maxAttempts: 3 });
  await audit(ctx, { action: 'export.request', resourceType: 'data_export', resourceId: row.id, shopId: input.params.shopId ?? null, metadata: { kind: input.kind, params: input.params } });
  return publicExport(row);
}

function visibleExports(ctx: Ctx) {
  requireAnyPermission(ctx.actor, 'export.data', 'audit.read');
  let q = ctx.trx.selectFrom('data_exports').select(EXPORT_COLUMNS);
  // without audit.read staff only see their own exports
  if (!can(ctx.actor, 'audit.read')) q = q.where('requested_by', '=', ctx.actor.kind === 'staff' ? ctx.actor.staffId : '00000000-0000-0000-0000-000000000000');
  return q;
}

export async function listExports(ctx: Ctx, input: { cursor?: string; limit: number }) {
  let q = visibleExports(ctx);
  const cursor = decodeCursor(input.cursor);
  if (cursor) q = q.where(sql`(created_at, id)`, '<', sql`(${cursor.v}::timestamptz, ${cursor.id}::uuid)`);
  const rows = await q.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(input.limit + 1).execute();
  const page = paginate(rows, input.limit, (r) => r.created_at);
  return { ...page, items: page.items.map(publicExport) };
}

export async function getExport(ctx: Ctx, id: string) {
  const row = await visibleExports(ctx).where('id', '=', id).executeTakeFirst();
  if (!row) throw Errors.notFound('エクスポート', id);
  return publicExport(row);
}

export async function downloadExport(ctx: Ctx, id: string) {
  const row = await getExport(ctx, id);
  const isRequester = ctx.actor.kind === 'staff' && row.requested_by === ctx.actor.staffId;
  if (!isRequester && !can(ctx.actor, 'audit.read')) throw Errors.forbidden('このエクスポートをダウンロードする権限がありません');
  if (row.status === 'expired' || (row.expires_at && row.expires_at < new Date())) throw Errors.business('EXPORT_EXPIRED', 'ダウンロード期限を過ぎています。再度エクスポートしてください');
  if (row.status !== 'completed' || !row.file_id) throw Errors.business('EXPORT_NOT_READY', 'エクスポートはまだ完了していません', { status: row.status });
  const file = await ctx.trx.selectFrom('files').select(['object_key', 'status']).where('id', '=', row.file_id).executeTakeFirst();
  if (!file || file.status === 'deleted') throw Errors.business('EXPORT_EXPIRED', 'ファイルは削除済みです');
  const fileName = file.object_key.split('/').pop()!;
  const url = await storage.presignDownload(file.object_key, DOWNLOAD_TTL_SEC, fileName);
  await audit(ctx, { action: 'export.download', resourceType: 'data_export', resourceId: id, metadata: { kind: row.kind, rowCount: row.row_count } });
  return { url, fileName, expiresAt: new Date(Date.now() + DOWNLOAD_TTL_SEC * 1000).toISOString() };
}

// ------------------------------------------------------------------ CSV builders

interface Builder {
  headers: { key: string; label: string }[];
  pages(ctx: Ctx, p: StoredParams, tz: string): AsyncGenerator<Record<string, unknown>[]>;
}

const NIL = '00000000-0000-0000-0000-000000000000';
const shopList = (ids: string[]) => (ids.length ? ids : [NIL]);

function range(p: StoredParams, tz: string): { from?: Date; to?: Date } {
  return { from: p.from ? dayBounds(p.from, tz).start : undefined, to: p.to ? dayBounds(p.to, tz).end : undefined };
}

const fmt = (d: Date | null | undefined, tz: string) => (d ? formatJst(new Date(d), 'yyyy/MM/dd HH:mm', tz) : '');

const builders: Record<Kind, Builder> = {
  customers: {
    headers: [
      { key: 'customer_number', label: '顧客番号' },
      { key: 'last_name', label: '姓' },
      { key: 'first_name', label: '名' },
      { key: 'last_name_kana', label: 'セイ' },
      { key: 'first_name_kana', label: 'メイ' },
      { key: 'gender', label: '性別' },
      { key: 'birthday', label: '生年月日' },
      { key: 'phone', label: '電話番号' },
      { key: 'email', label: 'メール' },
      { key: 'postal_code', label: '郵便番号' },
      { key: 'address', label: '住所' },
      { key: 'first_visit', label: '初回来店' },
      { key: 'last_visit', label: '最終来店' },
      { key: 'visit_count', label: '来店回数' },
      { key: 'total_sales', label: '累計売上' },
      { key: 'marketing_opt_in', label: '配信許可' },
      { key: 'registered', label: '登録日時' },
    ],
    async *pages(ctx, p, tz) {
      const { from, to } = range(p, tz);
      let last: string | null = null;
      for (;;) {
        let q = ctx.trx
          .selectFrom('customers')
          .select(['id', 'customer_number', 'last_name', 'first_name', 'last_name_kana', 'first_name_kana', 'gender', 'birthday', 'phone', 'email', 'postal_code', 'address', 'first_visit_at', 'last_visit_at', 'visit_count', 'total_sales', 'marketing_opt_in', 'created_at'])
          .where('deleted_at', 'is', null)
          .where('status', 'in', ['active', 'blocked']);
        const shopFilter = (ids: string[]) =>
          q.where((eb) =>
            eb.or([
              eb('customers.primary_shop_id', 'in', ids),
              eb.exists(eb.selectFrom('customer_shop_relations as csr').select(sql`1`.as('x')).whereRef('csr.customer_id', '=', 'customers.id').where('csr.shop_id', 'in', ids)),
            ]),
          );
        if (!p.scope.allCustomers && p.scope.shopIds) q = shopFilter(shopList(p.scope.shopIds));
        if (p.shopId) q = shopFilter([p.shopId]);
        if (from) q = q.where('created_at', '>=', from);
        if (to) q = q.where('created_at', '<', to);
        if (last) q = q.where('id', '>', last);
        const rows = await q.orderBy('id').limit(PAGE).execute();
        if (!rows.length) return;
        last = rows[rows.length - 1]!.id;
        yield rows.map((r) => ({ ...r, first_visit: fmt(r.first_visit_at, tz), last_visit: fmt(r.last_visit_at, tz), registered: fmt(r.created_at, tz), marketing_opt_in: r.marketing_opt_in ? '可' : '不可' }));
        if (rows.length < PAGE) return;
      }
    },
  },
  appointments: {
    headers: [
      { key: 'booking_reference', label: '予約番号' },
      { key: 'shop_name', label: '店舗' },
      { key: 'start', label: '開始' },
      { key: 'end', label: '終了' },
      { key: 'status', label: 'ステータス' },
      { key: 'source', label: '予約経路' },
      { key: 'staff_name', label: '担当' },
      { key: 'is_nominated', label: '指名' },
      { key: 'customer_name', label: '顧客' },
      { key: 'menus', label: 'メニュー' },
      { key: 'estimated_total', label: '見込金額' },
      { key: 'cancel_reason', label: 'キャンセル理由' },
    ],
    async *pages(ctx, p, tz) {
      const { from, to } = range(p, tz);
      let last: { v: Date; id: string } | null = null;
      for (;;) {
        let q = ctx.trx
          .selectFrom('appointments as a')
          .innerJoin('shops', 'shops.id', 'a.shop_id')
          .leftJoin('staffs', 'staffs.id', 'a.staff_id')
          .leftJoin('customers', 'customers.id', 'a.customer_id')
          .select([
            'a.id',
            'a.booking_reference',
            'shops.name as shop_name',
            'a.start_at',
            'a.end_at',
            'a.status',
            'a.source',
            'staffs.display_name as staff_name',
            'a.is_nominated',
            sql<string>`trim(coalesce(customers.last_name, '') || ' ' || coalesce(customers.first_name, ''))`.as('customer_name'),
            sql<string>`(SELECT string_agg(s.name, ' / ' ORDER BY s.sort_order) FROM appointment_services s WHERE s.appointment_id = a.id)`.as('menus'),
            'a.estimated_total',
            'a.cancel_reason',
          ])
          .where('a.deleted_at', 'is', null);
        if (p.scope.shopIds) q = q.where('a.shop_id', 'in', shopList(p.scope.shopIds));
        if (p.shopId) q = q.where('a.shop_id', '=', p.shopId);
        if (from) q = q.where('a.start_at', '>=', from);
        if (to) q = q.where('a.start_at', '<', to);
        if (last) q = q.where(sql`(a.start_at, a.id)`, '>', sql`(${last.v}::timestamptz, ${last.id}::uuid)`);
        const rows = await q.orderBy('a.start_at').orderBy('a.id').limit(PAGE).execute();
        if (!rows.length) return;
        const tail = rows[rows.length - 1]!;
        last = { v: tail.start_at, id: tail.id };
        yield rows.map((r) => ({ ...r, start: fmt(r.start_at, tz), end: fmt(r.end_at, tz), is_nominated: r.is_nominated ? '指名' : 'フリー' }));
        if (rows.length < PAGE) return;
      }
    },
  },
  transactions: {
    headers: [
      { key: 'transaction_number', label: '伝票番号' },
      { key: 'shop_name', label: '店舗' },
      { key: 'completed', label: '会計日時' },
      { key: 'status', label: 'ステータス' },
      { key: 'customer_name', label: '顧客' },
      { key: 'subtotal', label: '小計(税込)' },
      { key: 'discount_total', label: '値引' },
      { key: 'tax_total', label: '内消費税' },
      { key: 'total', label: '合計(税込)' },
      { key: 'refunded_total', label: '返金額' },
      { key: 'point_used', label: '利用ポイント' },
      { key: 'point_earned', label: '付与ポイント' },
    ],
    async *pages(ctx, p, tz) {
      const { from, to } = range(p, tz);
      let last: { v: Date; id: string } | null = null;
      for (;;) {
        let q = ctx.trx
          .selectFrom('transactions as t')
          .innerJoin('shops', 'shops.id', 't.shop_id')
          .leftJoin('customers', 'customers.id', 't.customer_id')
          .select([
            't.id',
            't.transaction_number',
            'shops.name as shop_name',
            't.completed_at',
            't.status',
            sql<string>`trim(coalesce(customers.last_name, '') || ' ' || coalesce(customers.first_name, ''))`.as('customer_name'),
            't.subtotal',
            't.discount_total',
            't.tax_total',
            't.total',
            't.refunded_total',
            't.point_used',
            't.point_earned',
          ])
          .where('t.status', '!=', 'draft')
          .where('t.completed_at', 'is not', null);
        if (p.scope.shopIds) q = q.where('t.shop_id', 'in', shopList(p.scope.shopIds));
        if (p.shopId) q = q.where('t.shop_id', '=', p.shopId);
        if (from) q = q.where('t.completed_at', '>=', from);
        if (to) q = q.where('t.completed_at', '<', to);
        if (last) q = q.where(sql`(t.completed_at, t.id)`, '>', sql`(${last.v}::timestamptz, ${last.id}::uuid)`);
        const rows = await q.orderBy('t.completed_at').orderBy('t.id').limit(PAGE).execute();
        if (!rows.length) return;
        const tail = rows[rows.length - 1]!;
        last = { v: tail.completed_at!, id: tail.id };
        yield rows.map((r) => ({ ...r, completed: fmt(r.completed_at, tz) }));
        if (rows.length < PAGE) return;
      }
    },
  },
  transaction_items: {
    headers: [
      { key: 'transaction_number', label: '伝票番号' },
      { key: 'shop_name', label: '店舗' },
      { key: 'completed', label: '会計日時' },
      { key: 'item_type', label: '種別' },
      { key: 'name', label: '品目' },
      { key: 'quantity', label: '数量' },
      { key: 'unit_price', label: '単価(税込)' },
      { key: 'line_discount', label: '値引' },
      { key: 'tax_rate', label: '税率(%)' },
      { key: 'amount', label: '金額(税込)' },
      { key: 'tax_amount', label: '内消費税' },
      { key: 'staff_names', label: '担当' },
    ],
    async *pages(ctx, p, tz) {
      const { from, to } = range(p, tz);
      let last: { v: Date; id: string } | null = null;
      for (;;) {
        let q = ctx.trx
          .selectFrom('transaction_items as ti')
          .innerJoin('transactions as t', 't.id', 'ti.transaction_id')
          .innerJoin('shops', 'shops.id', 't.shop_id')
          .select([
            'ti.id',
            't.transaction_number',
            'shops.name as shop_name',
            't.completed_at',
            'ti.item_type',
            'ti.name',
            'ti.quantity',
            'ti.unit_price',
            'ti.line_discount',
            'ti.tax_rate_bp',
            'ti.amount',
            'ti.tax_amount',
            sql<string>`(SELECT string_agg(st.display_name, ' / ') FROM transaction_item_staff tis JOIN staffs st ON st.id = tis.staff_id WHERE tis.transaction_item_id = ti.id)`.as('staff_names'),
          ])
          .where('t.status', '!=', 'draft')
          .where('t.completed_at', 'is not', null);
        if (p.scope.shopIds) q = q.where('t.shop_id', 'in', shopList(p.scope.shopIds));
        if (p.shopId) q = q.where('t.shop_id', '=', p.shopId);
        if (from) q = q.where('t.completed_at', '>=', from);
        if (to) q = q.where('t.completed_at', '<', to);
        if (last) q = q.where(sql`(t.completed_at, ti.id)`, '>', sql`(${last.v}::timestamptz, ${last.id}::uuid)`);
        const rows = await q.orderBy('t.completed_at').orderBy('ti.id').limit(PAGE).execute();
        if (!rows.length) return;
        const tail = rows[rows.length - 1]!;
        last = { v: tail.completed_at!, id: tail.id };
        yield rows.map((r) => ({ ...r, completed: fmt(r.completed_at, tz), tax_rate: r.tax_rate_bp / 100 }));
        if (rows.length < PAGE) return;
      }
    },
  },
  staff_sales: {
    headers: [
      { key: 'staff_name', label: 'スタッフ' },
      { key: 'shop_name', label: '店舗' },
      { key: 'service_sales', label: '技術売上' },
      { key: 'product_sales', label: '店販売上' },
      { key: 'other_sales', label: 'その他' },
      { key: 'total_sales', label: '売上合計(税込)' },
      { key: 'transaction_count', label: '会計件数' },
      { key: 'nominated_count', label: '指名件数' },
    ],
    async *pages(ctx, p, tz) {
      const { from, to } = range(p, tz);
      let q = ctx.trx
        .selectFrom('transaction_item_staff as tis')
        .innerJoin('transaction_items as ti', 'ti.id', 'tis.transaction_item_id')
        .innerJoin('transactions as t', 't.id', 'ti.transaction_id')
        .innerJoin('staffs', 'staffs.id', 'tis.staff_id')
        .innerJoin('shops', 'shops.id', 't.shop_id')
        .select([
          'staffs.display_name as staff_name',
          'shops.name as shop_name',
          sql<number>`coalesce(sum(tis.allocated_amount) FILTER (WHERE ti.item_type IN ('service','nomination_fee')), 0)::int`.as('service_sales'),
          sql<number>`coalesce(sum(tis.allocated_amount) FILTER (WHERE ti.item_type = 'product'), 0)::int`.as('product_sales'),
          sql<number>`coalesce(sum(tis.allocated_amount) FILTER (WHERE ti.item_type NOT IN ('service','nomination_fee','product')), 0)::int`.as('other_sales'),
          sql<number>`coalesce(sum(tis.allocated_amount), 0)::int`.as('total_sales'),
          sql<number>`count(DISTINCT t.id)::int`.as('transaction_count'),
          sql<number>`count(DISTINCT t.id) FILTER (WHERE tis.is_nominated)::int`.as('nominated_count'),
        ])
        .where('t.status', 'in', ['completed', 'partially_refunded'])
        .groupBy(['staffs.id', 'staffs.display_name', 'shops.id', 'shops.name'])
        .orderBy('shops.name')
        .orderBy('staffs.display_name');
      if (p.scope.shopIds) q = q.where('t.shop_id', 'in', shopList(p.scope.shopIds));
      if (p.shopId) q = q.where('t.shop_id', '=', p.shopId);
      if (from) q = q.where('t.completed_at', '>=', from);
      if (to) q = q.where('t.completed_at', '<', to);
      const rows = await q.execute();
      if (rows.length) yield rows;
    },
  },
};

/** Build the CSV for an export by paging through the data (one consistent tenant transaction) */
export async function buildExportCsv(ctx: Ctx, kind: Kind, params: StoredParams): Promise<{ body: Buffer; rowCount: number }> {
  const org = await ctx.trx.selectFrom('organizations').select('timezone').where('id', '=', ctx.actor.organizationId).executeTakeFirst();
  const tz = org?.timezone ?? DEFAULT_TZ;
  const builder = builders[kind];
  const chunks: string[] = [toCsv(builder.headers, [], true)];
  let rowCount = 0;
  for await (const rows of builder.pages(ctx, params, tz)) {
    const csv = toCsv(builder.headers, rows, false);
    chunks.push(csv.slice(csv.indexOf('\r\n') + 2)); // drop the repeated header line
    rowCount += rows.length;
  }
  return { body: Buffer.from(chunks.join(''), 'utf8'), rowCount };
}

registerJob<{ exportId: string }>(EXPORT_JOB, async (p, jc) => {
  const exp = await jc.tx((ctx) => ctx.trx.selectFrom('data_exports').select(EXPORT_COLUMNS).where('id', '=', p.exportId).executeTakeFirst());
  if (!exp || exp.status === 'completed' || exp.status === 'expired') return;
  await jc.tx((ctx) => ctx.trx.updateTable('data_exports').set({ status: 'running', error: null }).where('id', '=', exp.id).execute());
  const params = exp.params as unknown as StoredParams;
  const kind = exp.kind as Kind;
  try {
    const { body, rowCount } = await jc.tx((ctx) => buildExportCsv(ctx, kind, params));
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const objectKey = `${jc.organizationId}/exports/${exp.id}/${kind}-${stamp}.csv`;
    const contentType = 'text/csv; charset=utf-8';
    await storage.put(objectKey, body, contentType);
    await jc.tx(async (ctx) => {
      const file = await ctx.trx
        .insertInto('files')
        .values({
          organization_id: ctx.actor.organizationId,
          object_key: objectKey,
          purpose: 'export',
          content_type: contentType,
          size_bytes: body.length,
          checksum_sha256: sha256(body),
          status: 'uploaded',
          uploaded_by: exp.requested_by,
          uploaded_at: new Date(),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const now = new Date();
      await ctx.trx
        .updateTable('data_exports')
        .set({ status: 'completed', file_id: file.id, row_count: rowCount, completed_at: now, expires_at: addDays(now, EXPORT_TTL_DAYS), error: null })
        .where('id', '=', exp.id)
        .execute();
      const { scope, ...filters } = params;
      await audit(ctx, {
        action: 'export.csv',
        resourceType: 'data_export',
        resourceId: exp.id,
        shopId: params.shopId ?? null,
        metadata: { kind, kindLabel: KIND_LABEL[kind], rowCount, requestedBy: exp.requested_by, filters, scope: scope?.shopIds ? 'shops' : 'all', fileId: file.id },
      });
      await emit(ctx, { type: 'export.completed', aggregateType: 'data_export', aggregateId: exp.id, payload: { exportId: exp.id, kind, rowCount, requestedBy: exp.requested_by } });
    });
  } catch (err) {
    const final = jc.job.attempts >= jc.job.max_attempts;
    await jc.tx((ctx) =>
      ctx.trx
        .updateTable('data_exports')
        .set({ status: final ? 'failed' : 'queued', error: (err instanceof Error ? err.message : String(err)).slice(0, 2000) })
        .where('id', '=', exp.id)
        .execute(),
    );
    throw err;
  }
});
