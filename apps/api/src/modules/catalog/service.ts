import { sql } from 'kysely';
import { assertShopAccess, auditUserId, requirePermission, type Ctx } from '../../auth/actor.js';
import { audit, diff } from '../../lib/audit.js';
import { Errors } from '../../lib/errors.js';
import { percentOf } from '../../lib/money.js';
import type { CreateCouponInput, CreateMenuInput, UpdateCouponInput, UpdateMenuInput } from './schemas.js';

// ================================================================ categories

export async function listCategories(ctx: Ctx, shopId?: string) {
  let q = ctx.trx.selectFrom('menu_categories').select(['id', 'shop_id', 'name', 'sort_order']).where('deleted_at', 'is', null).orderBy('sort_order').orderBy('name');
  if (shopId) q = q.where((eb) => eb.or([eb('shop_id', 'is', null), eb('shop_id', '=', shopId)]));
  return q.execute();
}

export async function createCategory(ctx: Ctx, input: { shopId?: string | null; name: string; sortOrder?: number }) {
  requirePermission(ctx.actor, 'menu.manage');
  if (input.shopId) assertShopAccess(ctx.actor, input.shopId);
  return ctx.trx
    .insertInto('menu_categories')
    .values({ organization_id: ctx.actor.organizationId, shop_id: input.shopId ?? null, name: input.name, sort_order: input.sortOrder ?? 0 })
    .returning(['id', 'shop_id', 'name', 'sort_order'])
    .executeTakeFirstOrThrow();
}

export async function updateCategory(ctx: Ctx, id: string, input: { name?: string; sortOrder?: number }) {
  requirePermission(ctx.actor, 'menu.manage');
  const row = await ctx.trx.updateTable('menu_categories').set({ name: input.name, sort_order: input.sortOrder }).where('id', '=', id).returning(['id', 'shop_id', 'name', 'sort_order']).executeTakeFirst();
  if (!row) throw Errors.notFound('カテゴリ', id);
  return row;
}

export async function deleteCategory(ctx: Ctx, id: string) {
  requirePermission(ctx.actor, 'menu.manage');
  await ctx.trx.updateTable('menus').set({ category_id: null }).where('category_id', '=', id).execute();
  await ctx.trx.updateTable('menu_categories').set({ deleted_at: new Date() }).where('id', '=', id).execute();
}

// ================================================================ menus

export interface EffectiveMenu {
  id: string;
  shopId: string | null;
  categoryId: string | null;
  categoryName: string | null;
  name: string;
  description: string | null;
  durationMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  price: number;
  priceTaxIncluded: boolean;
  taxRateBp: number;
  isPublic: boolean;
  isConsultation: boolean;
  newCustomerOnly: boolean;
  sortOrder: number;
  status: string;
  isOverridden: boolean;
  resourceRequirements: { resourceType: string; offsetMin: number; durationMin: number | null }[];
  staffIds: string[];
}

/**
 * Effective menus for a shop: org-common menus (shop_id NULL) + the shop's own menus,
 * with per-shop overrides (price/duration/availability) applied (要件 FR-09 共通/店舗独自メニュー).
 */
export async function effectiveMenus(ctx: Ctx, shopId: string, opts: { publicOnly?: boolean; includeInactive?: boolean; menuIds?: string[] } = {}): Promise<EffectiveMenu[]> {
  let q = ctx.trx
    .selectFrom('menus')
    .leftJoin('menu_shop_overrides as o', (j) => j.onRef('o.menu_id', '=', 'menus.id').on('o.shop_id', '=', shopId))
    .leftJoin('menu_categories as c', 'c.id', 'menus.category_id')
    .select([
      'menus.id',
      'menus.shop_id',
      'menus.category_id',
      'c.name as category_name',
      'c.sort_order as category_sort',
      'menus.name',
      'menus.description',
      sql<number>`coalesce(o.duration_min, menus.duration_min)`.as('duration_min'),
      'menus.buffer_before_min',
      'menus.buffer_after_min',
      sql<number>`coalesce(o.price, menus.price)`.as('price'),
      'menus.price_tax_included',
      'menus.tax_rate_bp',
      'menus.is_public',
      'menus.is_consultation',
      'menus.new_customer_only',
      'menus.sort_order',
      'menus.status',
      sql<boolean>`coalesce(o.is_available, true)`.as('is_available'),
      sql<boolean>`o.id IS NOT NULL`.as('is_overridden'),
    ])
    .where('menus.deleted_at', 'is', null)
    .where((eb) => eb.or([eb('menus.shop_id', 'is', null), eb('menus.shop_id', '=', shopId)]))
    .orderBy(sql`coalesce(c.sort_order, 9999)`)
    .orderBy('menus.sort_order')
    .orderBy('menus.name');
  if (!opts.includeInactive) q = q.where('menus.status', '=', 'active').where(sql<boolean>`coalesce(o.is_available, true)`);
  if (opts.publicOnly) q = q.where('menus.is_public', '=', true);
  if (opts.menuIds) q = q.where('menus.id', 'in', opts.menuIds.length ? opts.menuIds : ['00000000-0000-0000-0000-000000000000']);
  const rows = await q.execute();
  const ids = rows.map((r) => r.id);
  const [reqs, staffMenus] = await Promise.all([
    ids.length ? ctx.trx.selectFrom('menu_resource_requirements').select(['menu_id', 'resource_type', 'offset_min', 'duration_min']).where('menu_id', 'in', ids).execute() : [],
    ids.length ? ctx.trx.selectFrom('staff_menus').select(['menu_id', 'staff_id']).where('menu_id', 'in', ids).execute() : [],
  ]);
  return rows.map((r) => ({
    id: r.id,
    shopId: r.shop_id,
    categoryId: r.category_id,
    categoryName: r.category_name,
    name: r.name,
    description: r.description,
    durationMin: r.duration_min,
    bufferBeforeMin: r.buffer_before_min,
    bufferAfterMin: r.buffer_after_min,
    price: r.price,
    priceTaxIncluded: r.price_tax_included,
    taxRateBp: r.tax_rate_bp,
    isPublic: r.is_public,
    isConsultation: r.is_consultation,
    newCustomerOnly: r.new_customer_only,
    sortOrder: r.sort_order,
    status: r.is_available ? r.status : 'unavailable',
    isOverridden: r.is_overridden,
    resourceRequirements: reqs.filter((x) => x.menu_id === r.id).map((x) => ({ resourceType: x.resource_type, offsetMin: x.offset_min, durationMin: x.duration_min })),
    staffIds: staffMenus.filter((x) => x.menu_id === r.id).map((x) => x.staff_id),
  }));
}

/** Staff-specific duration/price (ランク別料金) on top of effective menu values */
export async function menuForStaff(ctx: Ctx, menu: EffectiveMenu, staffId: string | null) {
  if (!staffId) return { durationMin: menu.durationMin, price: menu.price };
  const sm = await ctx.trx.selectFrom('staff_menus').select(['duration_min', 'price']).where('staff_id', '=', staffId).where('menu_id', '=', menu.id).executeTakeFirst();
  return { durationMin: sm?.duration_min ?? menu.durationMin, price: sm?.price ?? menu.price };
}

/** Can this staff perform the menu? (no staff_menus rows for a staff = can do everything) */
export async function staffCanPerform(ctx: Ctx, staffId: string, menuIds: string[]): Promise<boolean> {
  const rows = await ctx.trx.selectFrom('staff_menus').select('menu_id').where('staff_id', '=', staffId).execute();
  if (rows.length === 0) return true;
  const set = new Set(rows.map((r) => r.menu_id));
  return menuIds.every((m) => set.has(m));
}

export async function getMenu(ctx: Ctx, menuId: string) {
  const menu = await ctx.trx.selectFrom('menus').selectAll().where('id', '=', menuId).where('deleted_at', 'is', null).executeTakeFirst();
  if (!menu) throw Errors.notFound('メニュー', menuId);
  const [reqs, staff, overrides] = await Promise.all([
    ctx.trx.selectFrom('menu_resource_requirements').select(['resource_type', 'offset_min', 'duration_min']).where('menu_id', '=', menuId).execute(),
    ctx.trx.selectFrom('staff_menus').select(['staff_id', 'duration_min', 'price']).where('menu_id', '=', menuId).execute(),
    ctx.trx.selectFrom('menu_shop_overrides').select(['shop_id', 'price', 'duration_min', 'is_available']).where('menu_id', '=', menuId).execute(),
  ]);
  return { ...menu, resourceRequirements: reqs, staff, overrides };
}

async function replaceMenuRelations(ctx: Ctx, menuId: string, input: Pick<CreateMenuInput, 'resourceRequirements' | 'staffIds'>) {
  if (input.resourceRequirements) {
    await ctx.trx.deleteFrom('menu_resource_requirements').where('menu_id', '=', menuId).execute();
    if (input.resourceRequirements.length) {
      await ctx.trx
        .insertInto('menu_resource_requirements')
        .values(
          input.resourceRequirements.map((r) => ({
            organization_id: ctx.actor.organizationId,
            menu_id: menuId,
            resource_type: r.resourceType,
            offset_min: r.offsetMin ?? 0,
            duration_min: r.durationMin ?? null,
          })),
        )
        .execute();
    }
  }
  if (input.staffIds) {
    const existing = await ctx.trx.selectFrom('staff_menus').select(['staff_id']).where('menu_id', '=', menuId).execute();
    const keep = new Set(input.staffIds);
    const remove = existing.filter((e) => !keep.has(e.staff_id)).map((e) => e.staff_id);
    if (remove.length) await ctx.trx.deleteFrom('staff_menus').where('menu_id', '=', menuId).where('staff_id', 'in', remove).execute();
    const add = input.staffIds.filter((s) => !existing.some((e) => e.staff_id === s));
    if (add.length) {
      await ctx.trx.insertInto('staff_menus').values(add.map((staffId) => ({ staff_id: staffId, menu_id: menuId, organization_id: ctx.actor.organizationId }))).execute();
    }
  }
}

export async function createMenu(ctx: Ctx, input: CreateMenuInput) {
  requirePermission(ctx.actor, 'menu.manage');
  if (input.shopId) assertShopAccess(ctx.actor, input.shopId);
  else if (ctx.actor.kind === 'staff' && !ctx.actor.allShops) throw Errors.forbidden('共通メニューの作成には全店舗権限が必要です');
  const row = await ctx.trx
    .insertInto('menus')
    .values({
      organization_id: ctx.actor.organizationId,
      shop_id: input.shopId ?? null,
      category_id: input.categoryId ?? null,
      name: input.name,
      description: input.description ?? null,
      duration_min: input.durationMin,
      buffer_before_min: input.bufferBeforeMin ?? 0,
      buffer_after_min: input.bufferAfterMin ?? 0,
      price: input.price,
      price_tax_included: input.priceTaxIncluded ?? true,
      tax_rate_bp: input.taxRateBp ?? 1000,
      is_public: input.isPublic ?? true,
      is_consultation: input.isConsultation ?? false,
      new_customer_only: input.newCustomerOnly ?? false,
      sort_order: input.sortOrder ?? 0,
      created_by: auditUserId(ctx.actor),
      trace_id: ctx.meta.traceId ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await replaceMenuRelations(ctx, row.id, input);
  await audit(ctx, { action: 'menu.create', resourceType: 'menu', resourceId: row.id, shopId: input.shopId ?? null, after: input });
  return getMenu(ctx, row.id);
}

export async function updateMenu(ctx: Ctx, menuId: string, input: UpdateMenuInput) {
  requirePermission(ctx.actor, 'menu.manage');
  const before = await getMenu(ctx, menuId);
  if (before.shop_id) assertShopAccess(ctx.actor, before.shop_id);
  else if (ctx.actor.kind === 'staff' && !ctx.actor.allShops) throw Errors.forbidden('共通メニューの編集には全店舗権限が必要です（店舗別上書きを使用してください）');
  await ctx.trx
    .updateTable('menus')
    .set({
      category_id: input.categoryId,
      name: input.name,
      description: input.description,
      duration_min: input.durationMin,
      buffer_before_min: input.bufferBeforeMin,
      buffer_after_min: input.bufferAfterMin,
      price: input.price,
      price_tax_included: input.priceTaxIncluded,
      tax_rate_bp: input.taxRateBp,
      is_public: input.isPublic,
      is_consultation: input.isConsultation,
      new_customer_only: input.newCustomerOnly,
      sort_order: input.sortOrder,
      status: input.status,
      updated_by: auditUserId(ctx.actor),
      trace_id: ctx.meta.traceId ?? null,
    })
    .where('id', '=', menuId)
    .execute();
  await replaceMenuRelations(ctx, menuId, input);
  const after = await getMenu(ctx, menuId);
  await audit(ctx, { action: 'menu.update', resourceType: 'menu', resourceId: menuId, ...diff(before as never, after as never) });
  return after;
}

export async function deleteMenu(ctx: Ctx, menuId: string) {
  requirePermission(ctx.actor, 'menu.manage');
  const menu = await getMenu(ctx, menuId);
  if (menu.shop_id) assertShopAccess(ctx.actor, menu.shop_id);
  await ctx.trx.updateTable('menus').set({ deleted_at: new Date(), status: 'inactive' }).where('id', '=', menuId).execute();
  await audit(ctx, { action: 'menu.delete', resourceType: 'menu', resourceId: menuId });
}

export async function setMenuOverride(ctx: Ctx, menuId: string, shopId: string, input: { price?: number | null; durationMin?: number | null; isAvailable?: boolean }) {
  requirePermission(ctx.actor, 'menu.manage');
  assertShopAccess(ctx.actor, shopId);
  const menu = await getMenu(ctx, menuId);
  if (menu.shop_id && menu.shop_id !== shopId) throw Errors.validation('他店舗の独自メニューは上書きできません');
  const row = await ctx.trx
    .insertInto('menu_shop_overrides')
    .values({
      organization_id: ctx.actor.organizationId,
      menu_id: menuId,
      shop_id: shopId,
      price: input.price ?? null,
      duration_min: input.durationMin ?? null,
      is_available: input.isAvailable ?? true,
    })
    .onConflict((oc) => oc.columns(['menu_id', 'shop_id']).doUpdateSet({ price: input.price ?? null, duration_min: input.durationMin ?? null, is_available: input.isAvailable ?? true }))
    .returning(['menu_id', 'shop_id', 'price', 'duration_min', 'is_available'])
    .executeTakeFirstOrThrow();
  await audit(ctx, { action: 'menu.override', resourceType: 'menu', resourceId: menuId, shopId, after: input });
  return row;
}

export async function deleteMenuOverride(ctx: Ctx, menuId: string, shopId: string) {
  requirePermission(ctx.actor, 'menu.manage');
  assertShopAccess(ctx.actor, shopId);
  await ctx.trx.deleteFrom('menu_shop_overrides').where('menu_id', '=', menuId).where('shop_id', '=', shopId).execute();
}

export async function setStaffMenus(ctx: Ctx, staffId: string, menus: { menuId: string; durationMin?: number | null; price?: number | null }[]) {
  requirePermission(ctx.actor, 'menu.manage');
  await ctx.trx.deleteFrom('staff_menus').where('staff_id', '=', staffId).execute();
  if (menus.length) {
    await ctx.trx
      .insertInto('staff_menus')
      .values(menus.map((m) => ({ staff_id: staffId, menu_id: m.menuId, organization_id: ctx.actor.organizationId, duration_min: m.durationMin ?? null, price: m.price ?? null })))
      .execute();
  }
  await audit(ctx, { action: 'staff.menus_update', resourceType: 'staff', resourceId: staffId, after: menus });
  return ctx.trx.selectFrom('staff_menus').select(['menu_id', 'duration_min', 'price']).where('staff_id', '=', staffId).execute();
}

// ================================================================ resources

export async function listResources(ctx: Ctx, shopId: string) {
  assertShopAccess(ctx.actor, shopId);
  return ctx.trx
    .selectFrom('resources')
    .select(['id', 'shop_id', 'name', 'resource_type', 'sort_order', 'status'])
    .where('shop_id', '=', shopId)
    .where('deleted_at', 'is', null)
    .orderBy('resource_type')
    .orderBy('sort_order')
    .execute();
}

export async function createResource(ctx: Ctx, input: { shopId: string; name: string; resourceType: string; sortOrder?: number }) {
  requirePermission(ctx.actor, 'menu.manage');
  assertShopAccess(ctx.actor, input.shopId);
  return ctx.trx
    .insertInto('resources')
    .values({ organization_id: ctx.actor.organizationId, shop_id: input.shopId, name: input.name, resource_type: input.resourceType, sort_order: input.sortOrder ?? 0 })
    .returning(['id', 'shop_id', 'name', 'resource_type', 'sort_order', 'status'])
    .executeTakeFirstOrThrow();
}

export async function updateResource(ctx: Ctx, id: string, input: { name?: string; resourceType?: string; sortOrder?: number; status?: 'active' | 'inactive' }) {
  requirePermission(ctx.actor, 'menu.manage');
  const r = await ctx.trx.selectFrom('resources').select('shop_id').where('id', '=', id).executeTakeFirst();
  if (!r) throw Errors.notFound('設備', id);
  assertShopAccess(ctx.actor, r.shop_id);
  return ctx.trx
    .updateTable('resources')
    .set({ name: input.name, resource_type: input.resourceType, sort_order: input.sortOrder, status: input.status })
    .where('id', '=', id)
    .returning(['id', 'shop_id', 'name', 'resource_type', 'sort_order', 'status'])
    .executeTakeFirstOrThrow();
}

export async function deleteResource(ctx: Ctx, id: string) {
  requirePermission(ctx.actor, 'menu.manage');
  const r = await ctx.trx.selectFrom('resources').select('shop_id').where('id', '=', id).executeTakeFirst();
  if (!r) throw Errors.notFound('設備', id);
  assertShopAccess(ctx.actor, r.shop_id);
  await ctx.trx.updateTable('resources').set({ deleted_at: new Date(), status: 'inactive' }).where('id', '=', id).execute();
}

// ================================================================ coupons

const couponCols = [
  'id',
  'shop_id',
  'code',
  'name',
  'description',
  'discount_type',
  'discount_value',
  'applicable_menu_ids',
  'min_amount',
  'valid_from',
  'valid_until',
  'usage_limit',
  'per_customer_limit',
  'new_customer_only',
  'is_public',
  'status',
  'created_at',
] as const;

export async function listCoupons(ctx: Ctx, filter: { shopId?: string; publicOnly?: boolean; activeAt?: Date } = {}) {
  let q = ctx.trx.selectFrom('coupons').select(couponCols).where('deleted_at', 'is', null).orderBy('created_at', 'desc');
  if (filter.shopId) q = q.where((eb) => eb.or([eb('shop_id', 'is', null), eb('shop_id', '=', filter.shopId!)]));
  if (filter.publicOnly) q = q.where('is_public', '=', true).where('status', '=', 'active');
  if (filter.activeAt) {
    const at = filter.activeAt;
    q = q
      .where((eb) => eb.or([eb('valid_from', 'is', null), eb('valid_from', '<=', at)]))
      .where((eb) => eb.or([eb('valid_until', 'is', null), eb('valid_until', '>', at)]));
  }
  return q.execute();
}

export async function createCoupon(ctx: Ctx, input: CreateCouponInput) {
  requirePermission(ctx.actor, 'menu.manage');
  if (input.shopId) assertShopAccess(ctx.actor, input.shopId);
  const row = await ctx.trx
    .insertInto('coupons')
    .values({
      organization_id: ctx.actor.organizationId,
      shop_id: input.shopId ?? null,
      code: input.code ?? null,
      name: input.name,
      description: input.description ?? null,
      discount_type: input.discountType,
      discount_value: input.discountValue,
      applicable_menu_ids: input.applicableMenuIds ?? [],
      min_amount: input.minAmount ?? 0,
      valid_from: input.validFrom ? new Date(input.validFrom) : null,
      valid_until: input.validUntil ? new Date(input.validUntil) : null,
      usage_limit: input.usageLimit ?? null,
      per_customer_limit: input.perCustomerLimit ?? null,
      new_customer_only: input.newCustomerOnly ?? false,
      is_public: input.isPublic ?? true,
    })
    .returning(couponCols)
    .executeTakeFirstOrThrow();
  await audit(ctx, { action: 'coupon.create', resourceType: 'coupon', resourceId: row.id, after: input });
  return row;
}

export async function updateCoupon(ctx: Ctx, id: string, input: UpdateCouponInput) {
  requirePermission(ctx.actor, 'menu.manage');
  const row = await ctx.trx
    .updateTable('coupons')
    .set({
      code: input.code,
      name: input.name,
      description: input.description,
      discount_type: input.discountType,
      discount_value: input.discountValue,
      applicable_menu_ids: input.applicableMenuIds,
      min_amount: input.minAmount,
      valid_from: input.validFrom === undefined ? undefined : input.validFrom ? new Date(input.validFrom) : null,
      valid_until: input.validUntil === undefined ? undefined : input.validUntil ? new Date(input.validUntil) : null,
      usage_limit: input.usageLimit,
      per_customer_limit: input.perCustomerLimit,
      new_customer_only: input.newCustomerOnly,
      is_public: input.isPublic,
      status: input.status,
    })
    .where('id', '=', id)
    .where('deleted_at', 'is', null)
    .returning(couponCols)
    .executeTakeFirst();
  if (!row) throw Errors.notFound('クーポン', id);
  await audit(ctx, { action: 'coupon.update', resourceType: 'coupon', resourceId: id, after: input });
  return row;
}

export async function deleteCoupon(ctx: Ctx, id: string) {
  requirePermission(ctx.actor, 'menu.manage');
  await ctx.trx.updateTable('coupons').set({ deleted_at: new Date(), status: 'inactive' }).where('id', '=', id).execute();
}

export interface CouponEvaluation {
  couponId: string;
  name: string;
  valid: boolean;
  reason?: string;
  discountAmount: number;
}

/**
 * Validate a coupon for a booking/checkout and compute the discount (税込).
 *  amount:      fixed yen off
 *  percent:     % off applicable lines
 *  fixed_price: applicable lines are charged discount_value in total
 */
export async function evaluateCoupon(
  ctx: Ctx,
  input: {
    couponId?: string;
    code?: string;
    shopId: string;
    customerId?: string | null;
    lines: { menuId?: string | null; amount: number }[];
    at?: Date;
    excludeAppointmentId?: string;
    excludeTransactionId?: string;
  },
): Promise<CouponEvaluation> {
  let q = ctx.trx.selectFrom('coupons').selectAll().where('deleted_at', 'is', null);
  if (input.couponId) q = q.where('id', '=', input.couponId);
  else if (input.code) q = q.where('code', '=', input.code);
  else throw Errors.validation('couponIdまたはcodeが必要です');
  const c = await q.executeTakeFirst();
  if (!c) throw Errors.notFound('クーポン');
  const at = input.at ?? new Date();
  const fail = (reason: string): CouponEvaluation => ({ couponId: c.id, name: c.name, valid: false, reason, discountAmount: 0 });

  if (c.status !== 'active') return fail('無効なクーポンです');
  if (c.shop_id && c.shop_id !== input.shopId) return fail('この店舗では利用できません');
  if (c.valid_from && c.valid_from > at) return fail('利用開始前です');
  if (c.valid_until && c.valid_until <= at) return fail('有効期限切れです');

  const applicable = c.applicable_menu_ids.length ? input.lines.filter((l) => l.menuId && c.applicable_menu_ids.includes(l.menuId)) : input.lines;
  const base = applicable.reduce((s, l) => s + l.amount, 0);
  if (applicable.length === 0) return fail('対象メニューが含まれていません');
  if (base < c.min_amount) return fail(`${c.min_amount}円以上で利用できます`);

  if (c.usage_limit !== null || c.per_customer_limit !== null || c.new_customer_only) {
    const usedBase = ctx.trx
      .selectFrom('coupon_redemptions')
      .where('coupon_id', '=', c.id)
      .where('status', '!=', 'released')
      .$if(!!input.excludeAppointmentId, (qb) => qb.where((eb) => eb.or([eb('appointment_id', 'is', null), eb('appointment_id', '!=', input.excludeAppointmentId!)])))
      .$if(!!input.excludeTransactionId, (qb) => qb.where((eb) => eb.or([eb('transaction_id', 'is', null), eb('transaction_id', '!=', input.excludeTransactionId!)])));
    if (c.usage_limit !== null) {
      const used = await usedBase.select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow();
      if (used.n >= c.usage_limit) return fail('利用上限に達しました');
    }
    if (input.customerId) {
      if (c.per_customer_limit !== null) {
        const used = await usedBase.where('customer_id', '=', input.customerId).select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow();
        if (used.n >= c.per_customer_limit) return fail('お一人様の利用上限に達しました');
      }
      if (c.new_customer_only) {
        const cust = await ctx.trx.selectFrom('customers').select('visit_count').where('id', '=', input.customerId).executeTakeFirst();
        if (cust && cust.visit_count > 0) return fail('新規のお客様限定です');
      }
    }
  }

  let discount = 0;
  if (c.discount_type === 'amount') discount = Math.min(c.discount_value, base);
  else if (c.discount_type === 'percent') discount = percentOf(base, c.discount_value);
  else discount = Math.max(0, base - c.discount_value);
  return { couponId: c.id, name: c.name, valid: true, discountAmount: discount };
}
