import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import {
  accessibleShopIds,
  assertShopAccess,
  auditUserId,
  requirePermission,
  systemActor,
  type Ctx,
} from '../../auth/actor.js';
import { invalidateActorCache } from '../../auth/load-actor.js';
import { ALL_PERMISSIONS, PERMISSIONS, SYSTEM_ROLES, systemRolePermissions, type Permission } from '../../auth/permissions.js';
import { withTenant } from '../../db/tenant.js';
import { audit, diff } from '../../lib/audit.js';
import { hashPassword, signPayload } from '../../lib/crypto.js';
import { Errors } from '../../lib/errors.js';
import { emit } from '../../lib/events.js';
import { runOrgSeeders } from '../../lib/org-seeders.js';
import { mergeShopSettings, parseShopSettings } from '../../lib/shop-settings.js';
import { config } from '../../config.js';
import type {
  CreateShopInput,
  CreateStaffInput,
  SignupInput,
  TransferStaffInput,
  UpdateOrganizationInput,
  UpdateShopInput,
  UpdateStaffInput,
} from './schemas.js';

// ---------------------------------------------------------------- organization

/**
 * Onboarding: create organization + first shop + owner user/staff + system roles + seed data.
 * Runs in a tenant transaction for the new organization id (RLS satisfied by construction).
 */
export async function signup(input: SignupInput) {
  const organizationId = randomUUID();
  return withTenant(organizationId, async (trx) => {
    const existingUser = await trx.selectFrom('users').select(['id', 'password_hash']).where('email', '=', input.email).executeTakeFirst();
    if (existingUser) throw Errors.conflict('EMAIL_TAKEN', 'このメールアドレスは既に登録されています');

    await trx
      .insertInto('organizations')
      .values({
        id: organizationId,
        name: input.organizationName,
        slug: input.organizationSlug,
        plan: input.plan ?? 'standard',
        status: 'trial',
        timezone: input.timezone ?? 'Asia/Tokyo',
      })
      .execute();

    const ctx: Ctx = { actor: systemActor(organizationId, 'signup'), trx, meta: {} };
    const roleIds = await seedSystemRoles(ctx, organizationId);

    const shop = await trx
      .insertInto('shops')
      .values({
        organization_id: organizationId,
        name: input.shopName,
        slug: input.shopSlug,
        timezone: input.timezone ?? 'Asia/Tokyo',
        phone: input.phone ?? null,
        settings: JSON.stringify(parseShopSettings({})),
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await seedDefaultBusinessHours(ctx, shop.id);

    const user = await trx
      .insertInto('users')
      .values({ email: input.email, password_hash: await hashPassword(input.password), display_name: input.ownerName })
      .returning('id')
      .executeTakeFirstOrThrow();

    const staff = await trx
      .insertInto('staffs')
      .values({
        organization_id: organizationId,
        user_id: user.id,
        role_id: roleIds.get('owner')!,
        display_name: input.ownerName,
        email: input.email,
        employment_type: 'owner',
        title: 'オーナー',
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await trx
      .insertInto('staff_shop_assignments')
      .values({ organization_id: organizationId, staff_id: staff.id, shop_id: shop.id, is_primary: true })
      .execute();

    await runOrgSeeders(ctx, { organizationId, shopId: shop.id, ownerStaffId: staff.id });
    await audit(ctx, { action: 'organization.create', resourceType: 'organization', resourceId: organizationId, after: { name: input.organizationName } });
    await emit(ctx, { type: 'organization.created', aggregateType: 'organization', aggregateId: organizationId, payload: { shopId: shop.id } });

    return { organizationId, shopId: shop.id, userId: user.id, staffId: staff.id };
  });
}

export async function seedSystemRoles(ctx: Ctx, organizationId: string): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const def of SYSTEM_ROLES) {
    const role = await ctx.trx
      .insertInto('roles')
      .values({ organization_id: organizationId, key: def.key, name: def.name, description: def.description, is_system: true })
      .returning('id')
      .executeTakeFirstOrThrow();
    ids.set(def.key, role.id);
    const perms = systemRolePermissions(def);
    if (perms.length) {
      await ctx.trx
        .insertInto('role_permissions')
        .values(perms.map((p) => ({ role_id: role.id, organization_id: organizationId, permission_key: p })))
        .execute();
    }
  }
  return ids;
}

async function seedDefaultBusinessHours(ctx: Ctx, shopId: string) {
  // Default: 10:00-20:00, closed on Tuesday (美容室の定休日として一般的)
  const rows = [0, 1, 3, 4, 5, 6].map((weekday) => ({
    organization_id: ctx.actor.organizationId,
    shop_id: shopId,
    weekday,
    open_time: '10:00',
    close_time: '20:00',
  }));
  await ctx.trx.insertInto('shop_business_hours').values(rows).execute();
}

export async function getOrganization(ctx: Ctx) {
  return ctx.trx
    .selectFrom('organizations')
    .select(['id', 'name', 'slug', 'plan', 'status', 'currency', 'timezone', 'invoice_registration_number', 'settings', 'created_at'])
    .where('id', '=', ctx.actor.organizationId)
    .executeTakeFirstOrThrow();
}

export async function updateOrganization(ctx: Ctx, input: UpdateOrganizationInput) {
  requirePermission(ctx.actor, 'org.manage');
  const before = await getOrganization(ctx);
  const after = await ctx.trx
    .updateTable('organizations')
    .set({
      name: input.name,
      timezone: input.timezone,
      invoice_registration_number: input.invoiceRegistrationNumber,
      settings: input.settings ? JSON.stringify({ ...(before.settings as object), ...input.settings }) : undefined,
    })
    .where('id', '=', ctx.actor.organizationId)
    .returning(['id', 'name', 'slug', 'plan', 'status', 'currency', 'timezone', 'invoice_registration_number', 'settings', 'created_at'])
    .executeTakeFirstOrThrow();
  await audit(ctx, { action: 'organization.update', resourceType: 'organization', resourceId: after.id, ...diff(before, after) });
  return after;
}

// ---------------------------------------------------------------- shops

const shopColumns = [
  'id',
  'name',
  'slug',
  'timezone',
  'phone',
  'email',
  'postal_code',
  'prefecture',
  'city',
  'address_line',
  'description',
  'status',
  'public_booking_enabled',
  'settings',
  'created_at',
  'updated_at',
] as const;

export async function listShops(ctx: Ctx) {
  const ids = accessibleShopIds(ctx.actor);
  let q = ctx.trx.selectFrom('shops').select(shopColumns).where('deleted_at', 'is', null).orderBy('created_at');
  if (ids) q = q.where('id', 'in', ids.length ? [...ids] : ['00000000-0000-0000-0000-000000000000']);
  const rows = await q.execute();
  return rows.map((s) => ({ ...s, settings: parseShopSettings(s.settings) }));
}

export async function getShop(ctx: Ctx, shopId: string) {
  assertShopAccess(ctx.actor, shopId);
  const shop = await ctx.trx.selectFrom('shops').select(shopColumns).where('id', '=', shopId).where('deleted_at', 'is', null).executeTakeFirst();
  if (!shop) throw Errors.notFound('店舗', shopId);
  return { ...shop, settings: parseShopSettings(shop.settings) };
}

export async function createShop(ctx: Ctx, input: CreateShopInput) {
  requirePermission(ctx.actor, 'shop.manage');
  const shop = await ctx.trx
    .insertInto('shops')
    .values({
      organization_id: ctx.actor.organizationId,
      name: input.name,
      slug: input.slug,
      timezone: input.timezone ?? 'Asia/Tokyo',
      phone: input.phone ?? null,
      email: input.email ?? null,
      postal_code: input.postalCode ?? null,
      prefecture: input.prefecture ?? null,
      city: input.city ?? null,
      address_line: input.addressLine ?? null,
      description: input.description ?? null,
      settings: JSON.stringify(mergeShopSettings({}, input.settings ?? {})),
      created_by: auditUserId(ctx.actor),
      trace_id: ctx.meta.traceId ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await seedDefaultBusinessHours(ctx, shop.id);
  // creator gets access to the new shop
  if (ctx.actor.kind === 'staff') {
    await ctx.trx
      .insertInto('staff_shop_assignments')
      .values({ organization_id: ctx.actor.organizationId, staff_id: ctx.actor.staffId, shop_id: shop.id })
      .onConflict((oc) => oc.doNothing())
      .execute();
    invalidateActorCache(ctx.actor.staffId);
  }
  await audit(ctx, { action: 'shop.create', resourceType: 'shop', resourceId: shop.id, shopId: shop.id, after: input });
  await emit(ctx, { type: 'shop.created', aggregateType: 'shop', aggregateId: shop.id, payload: {} });
  return getShopUnchecked(ctx, shop.id);
}

async function getShopUnchecked(ctx: Ctx, shopId: string) {
  const shop = await ctx.trx.selectFrom('shops').select(shopColumns).where('id', '=', shopId).executeTakeFirstOrThrow();
  return { ...shop, settings: parseShopSettings(shop.settings) };
}

export async function updateShop(ctx: Ctx, shopId: string, input: UpdateShopInput) {
  requirePermission(ctx.actor, 'shop.manage');
  const before = await getShop(ctx, shopId);
  await ctx.trx
    .updateTable('shops')
    .set({
      name: input.name,
      slug: input.slug,
      timezone: input.timezone,
      phone: input.phone,
      email: input.email,
      postal_code: input.postalCode,
      prefecture: input.prefecture,
      city: input.city,
      address_line: input.addressLine,
      description: input.description,
      status: input.status,
      public_booking_enabled: input.publicBookingEnabled,
      settings: input.settings ? JSON.stringify(mergeShopSettings(before.settings, input.settings)) : undefined,
      updated_by: auditUserId(ctx.actor),
      trace_id: ctx.meta.traceId ?? null,
    })
    .where('id', '=', shopId)
    .execute();
  const after = await getShopUnchecked(ctx, shopId);
  await audit(ctx, { action: 'shop.update', resourceType: 'shop', resourceId: shopId, shopId, ...diff(before, after) });
  return after;
}

// ---------------------------------------------------------------- staff

const staffColumns = [
  'staffs.id',
  'staffs.user_id',
  'staffs.role_id',
  'staffs.display_name',
  'staffs.display_name_kana',
  'staffs.email',
  'staffs.phone',
  'staffs.employment_type',
  'staffs.title',
  'staffs.color',
  'staffs.is_bookable',
  'staffs.nomination_fee',
  'staffs.public_profile',
  'staffs.public_slug',
  'staffs.sort_order',
  'staffs.status',
  'staffs.hired_on',
  'staffs.retired_on',
  'staffs.created_at',
] as const;

async function attachStaffRelations<T extends { id: string; role_id: string }>(ctx: Ctx, rows: T[]) {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [assignments, roles] = await Promise.all([
    ctx.trx
      .selectFrom('staff_shop_assignments')
      .select(['staff_id', 'shop_id', 'is_primary', 'started_on'])
      .where('staff_id', 'in', ids)
      .where('ended_on', 'is', null)
      .execute(),
    ctx.trx.selectFrom('roles').select(['id', 'key', 'name']).where('id', 'in', [...new Set(rows.map((r) => r.role_id))]).execute(),
  ]);
  return rows.map((r) => ({
    ...r,
    role: roles.find((x) => x.id === r.role_id) ?? null,
    shops: assignments.filter((a) => a.staff_id === r.id).map(({ staff_id: _s, ...a }) => a),
  }));
}

export async function listStaff(ctx: Ctx, filter: { shopId?: string; includeInactive?: boolean; bookableOnly?: boolean }) {
  requirePermission(ctx.actor, 'staff.read');
  if (filter.shopId) assertShopAccess(ctx.actor, filter.shopId);
  let q = ctx.trx
    .selectFrom('staffs')
    .select(staffColumns)
    .where('staffs.deleted_at', 'is', null)
    .orderBy('staffs.sort_order')
    .orderBy('staffs.created_at');
  if (!filter.includeInactive) q = q.where('staffs.status', 'in', ['active', 'invited']);
  // bookable = can actually take bookings: active (not merely invited) and flagged bookable
  if (filter.bookableOnly) q = q.where('staffs.is_bookable', '=', true).where('staffs.status', '=', 'active');
  const shopIds = filter.shopId ? [filter.shopId] : accessibleShopIds(ctx.actor);
  if (shopIds) {
    q = q.where((eb) =>
      eb.exists(
        eb
          .selectFrom('staff_shop_assignments')
          .select(sql`1`.as('x'))
          .whereRef('staff_shop_assignments.staff_id', '=', 'staffs.id')
          .where('staff_shop_assignments.ended_on', 'is', null)
          .where('staff_shop_assignments.shop_id', 'in', shopIds.length ? [...shopIds] : ['00000000-0000-0000-0000-000000000000']),
      ),
    );
  }
  return attachStaffRelations(ctx, await q.execute());
}

export async function getStaff(ctx: Ctx, staffId: string) {
  requirePermission(ctx.actor, 'staff.read');
  const row = await ctx.trx.selectFrom('staffs').select(staffColumns).where('staffs.id', '=', staffId).where('staffs.deleted_at', 'is', null).executeTakeFirst();
  if (!row) throw Errors.notFound('スタッフ', staffId);
  const [withRel] = await attachStaffRelations(ctx, [row]);
  return withRel!;
}

export async function createStaff(ctx: Ctx, input: CreateStaffInput) {
  requirePermission(ctx.actor, 'staff.manage');
  for (const shopId of input.shopIds) assertShopAccess(ctx.actor, shopId);
  const role = await ctx.trx.selectFrom('roles').select(['id', 'key']).where('id', '=', input.roleId).executeTakeFirst();
  if (!role) throw Errors.validation('ロールが存在しません');
  if (role.key === 'owner') requirePermission(ctx.actor, 'role.manage');

  let userId: string | null = null;
  let inviteUrl: string | null = null;
  if (input.email) {
    const existing = await ctx.trx.selectFrom('users').select('id').where('email', '=', input.email).executeTakeFirst();
    if (existing) {
      userId = existing.id;
    } else {
      const user = await ctx.trx
        .insertInto('users')
        .values({
          email: input.email,
          display_name: input.displayName,
          password_hash: input.initialPassword ? await hashPassword(input.initialPassword) : null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      userId = user.id;
    }
  }

  const staff = await ctx.trx
    .insertInto('staffs')
    .values({
      organization_id: ctx.actor.organizationId,
      user_id: userId,
      role_id: input.roleId,
      display_name: input.displayName,
      display_name_kana: input.displayNameKana ?? null,
      email: input.email ?? null,
      phone: input.phone ?? null,
      employment_type: input.employmentType ?? 'full_time',
      title: input.title ?? null,
      color: input.color ?? '#7c3aed',
      is_bookable: input.isBookable ?? true,
      nomination_fee: input.nominationFee ?? 0,
      public_profile: JSON.stringify(input.publicProfile ?? {}),
      public_slug: input.publicSlug ?? null,
      sort_order: input.sortOrder ?? 0,
      status: userId && !input.initialPassword ? 'invited' : 'active',
      hired_on: input.hiredOn ?? null,
      created_by: auditUserId(ctx.actor),
      trace_id: ctx.meta.traceId ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  if (input.shopIds.length) {
    await ctx.trx
      .insertInto('staff_shop_assignments')
      .values(input.shopIds.map((shopId, i) => ({ organization_id: ctx.actor.organizationId, staff_id: staff.id, shop_id: shopId, is_primary: i === 0 })))
      .execute();
  }

  if (userId && !input.initialPassword) {
    const token = signPayload({ typ: 'invite', uid: userId, org: ctx.actor.organizationId, stf: staff.id }, 7 * 24 * 3600);
    inviteUrl = `${config.WEB_BASE_URL}/invite/${token}`;
  }

  await audit(ctx, { action: 'staff.create', resourceType: 'staff', resourceId: staff.id, after: { ...input, initialPassword: undefined } });
  await emit(ctx, { type: 'staff.created', aggregateType: 'staff', aggregateId: staff.id, payload: { shopIds: input.shopIds } });
  return { staff: await getStaff(ctx, staff.id), inviteUrl };
}

export type StaffDetail = Awaited<ReturnType<typeof getStaff>>;

export async function updateStaff(ctx: Ctx, staffId: string, input: UpdateStaffInput): Promise<StaffDetail> {
  const isSelf = ctx.actor.kind === 'staff' && ctx.actor.staffId === staffId;
  // staff may edit their own public profile; everything else needs staff.manage
  const selfEditableOnly = Object.keys(input).every((k) => ['publicProfile', 'displayNameKana', 'phone', 'color'].includes(k));
  if (!(isSelf && selfEditableOnly)) requirePermission(ctx.actor, 'staff.manage');
  const before = await getStaff(ctx, staffId);
  if (input.roleId && input.roleId !== before.role_id) {
    return changeRoleThenUpdate(ctx, staffId, input);
  }
  await ctx.trx
    .updateTable('staffs')
    .set({
      display_name: input.displayName,
      display_name_kana: input.displayNameKana,
      email: input.email,
      phone: input.phone,
      employment_type: input.employmentType,
      title: input.title,
      color: input.color,
      is_bookable: input.isBookable,
      nomination_fee: input.nominationFee,
      public_profile: input.publicProfile ? JSON.stringify({ ...(before.public_profile as object), ...input.publicProfile }) : undefined,
      public_slug: input.publicSlug,
      sort_order: input.sortOrder,
      status: input.status,
      hired_on: input.hiredOn,
      retired_on: input.retiredOn,
      updated_by: auditUserId(ctx.actor),
      trace_id: ctx.meta.traceId ?? null,
    })
    .where('id', '=', staffId)
    .execute();
  invalidateActorCache(staffId);
  const after = await getStaff(ctx, staffId);
  await audit(ctx, { action: 'staff.update', resourceType: 'staff', resourceId: staffId, ...diff(before as never, after as never) });
  return after;
}

async function changeRoleThenUpdate(ctx: Ctx, staffId: string, input: UpdateStaffInput): Promise<StaffDetail> {
  await changeStaffRole(ctx, staffId, input.roleId!);
  const { roleId: _r, ...rest } = input;
  return Object.keys(rest).length ? updateStaff(ctx, staffId, rest) : getStaff(ctx, staffId);
}

/** 権限変更 — always audited (要件 2.1) */
export async function changeStaffRole(ctx: Ctx, staffId: string, roleId: string) {
  requirePermission(ctx.actor, 'role.manage');
  const before = await getStaff(ctx, staffId);
  const role = await ctx.trx.selectFrom('roles').select(['id', 'key', 'name']).where('id', '=', roleId).executeTakeFirst();
  if (!role) throw Errors.validation('ロールが存在しません');
  if (before.role?.key === 'owner' && role.key !== 'owner') {
    const owners = await ctx.trx
      .selectFrom('staffs')
      .innerJoin('roles', 'roles.id', 'staffs.role_id')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('roles.key', '=', 'owner')
      .where('staffs.status', '=', 'active')
      .where('staffs.deleted_at', 'is', null)
      .executeTakeFirstOrThrow();
    if (owners.n <= 1) throw Errors.business('LAST_OWNER', '最後のオーナーの権限は変更できません');
  }
  await ctx.trx.updateTable('staffs').set({ role_id: roleId, updated_by: auditUserId(ctx.actor) }).where('id', '=', staffId).execute();
  invalidateActorCache(staffId);
  await audit(ctx, {
    action: 'role.change',
    resourceType: 'staff',
    resourceId: staffId,
    before: { role: before.role },
    after: { role },
  });
  return getStaff(ctx, staffId);
}

/**
 * 異動 (staff transfer between shops) with customer-relationship policy (要件 FR-09).
 *  keep:      customers keep this staff as primary (staff now works at the new shop)
 *  reassign:  primary_staff relations at the old shop move to reassignToStaffId
 *  unassign:  primary_staff relations at the old shop are ended (shop keeps the customers)
 */
export async function transferStaff(ctx: Ctx, staffId: string, input: TransferStaffInput) {
  requirePermission(ctx.actor, 'staff.manage');
  assertShopAccess(ctx.actor, input.fromShopId);
  assertShopAccess(ctx.actor, input.toShopId);
  if (input.fromShopId === input.toShopId) throw Errors.validation('異動元と異動先が同じです');
  await getStaff(ctx, staffId);
  const today = new Date().toISOString().slice(0, 10);

  const ended = await ctx.trx
    .updateTable('staff_shop_assignments')
    .set({ ended_on: input.effectiveDate ?? today })
    .where('staff_id', '=', staffId)
    .where('shop_id', '=', input.fromShopId)
    .where('ended_on', 'is', null)
    .executeTakeFirst();
  if (Number(ended.numUpdatedRows) === 0) throw Errors.business('NOT_ASSIGNED', 'スタッフは異動元店舗に所属していません');

  await ctx.trx
    .insertInto('staff_shop_assignments')
    .values({ organization_id: ctx.actor.organizationId, staff_id: staffId, shop_id: input.toShopId, is_primary: true, started_on: input.effectiveDate ?? today })
    .onConflict((oc) => oc.doNothing())
    .execute();

  let affectedCustomers = 0;
  if (input.customerPolicy !== 'keep') {
    if (input.customerPolicy === 'reassign' && !input.reassignToStaffId) throw Errors.validation('reassignToStaffIdが必要です');
    const relations = await ctx.trx
      .updateTable('customer_shop_relations')
      .set({ ended_at: new Date(), end_reason: 'transfer' })
      .where('staff_id', '=', staffId)
      .where('shop_id', '=', input.fromShopId)
      .where('relation_type', '=', 'primary_staff')
      .where('ended_at', 'is', null)
      .returning(['customer_id'])
      .execute();
    affectedCustomers = relations.length;
    if (input.customerPolicy === 'reassign' && relations.length) {
      await ctx.trx
        .insertInto('customer_shop_relations')
        .values(
          relations.map((r) => ({
            organization_id: ctx.actor.organizationId,
            customer_id: r.customer_id,
            shop_id: input.fromShopId,
            staff_id: input.reassignToStaffId!,
            relation_type: 'primary_staff',
          })),
        )
        .onConflict((oc) => oc.doNothing())
        .execute();
      await ctx.trx
        .updateTable('customers')
        .set({ primary_staff_id: input.reassignToStaffId! })
        .where('id', 'in', relations.map((r) => r.customer_id))
        .where('primary_staff_id', '=', staffId)
        .execute();
    } else if (relations.length) {
      await ctx.trx
        .updateTable('customers')
        .set({ primary_staff_id: null })
        .where('id', 'in', relations.map((r) => r.customer_id))
        .where('primary_staff_id', '=', staffId)
        .execute();
    }
  }
  invalidateActorCache(staffId);
  await audit(ctx, { action: 'staff.transfer', resourceType: 'staff', resourceId: staffId, after: { ...input, affectedCustomers } });
  await emit(ctx, { type: 'staff.transferred', aggregateType: 'staff', aggregateId: staffId, payload: { ...input, affectedCustomers } });
  return { staff: await getStaff(ctx, staffId), affectedCustomers };
}

export async function setStaffShops(ctx: Ctx, staffId: string, shopIds: string[]) {
  requirePermission(ctx.actor, 'staff.manage');
  for (const s of shopIds) assertShopAccess(ctx.actor, s);
  const current = await ctx.trx.selectFrom('staff_shop_assignments').select(['id', 'shop_id']).where('staff_id', '=', staffId).where('ended_on', 'is', null).execute();
  const today = new Date().toISOString().slice(0, 10);
  const toEnd = current.filter((c) => !shopIds.includes(c.shop_id));
  for (const c of toEnd) assertShopAccess(ctx.actor, c.shop_id);
  if (toEnd.length) await ctx.trx.updateTable('staff_shop_assignments').set({ ended_on: today }).where('id', 'in', toEnd.map((c) => c.id)).execute();
  const toAdd = shopIds.filter((s) => !current.some((c) => c.shop_id === s));
  if (toAdd.length) {
    await ctx.trx
      .insertInto('staff_shop_assignments')
      .values(toAdd.map((shopId) => ({ organization_id: ctx.actor.organizationId, staff_id: staffId, shop_id: shopId })))
      .execute();
  }
  invalidateActorCache(staffId);
  await audit(ctx, { action: 'staff.shops_update', resourceType: 'staff', resourceId: staffId, before: current.map((c) => c.shop_id), after: shopIds });
  return getStaff(ctx, staffId);
}

// ---------------------------------------------------------------- roles

export async function listRoles(ctx: Ctx) {
  requirePermission(ctx.actor, 'staff.read');
  const roles = await ctx.trx
    .selectFrom('roles')
    .select(['id', 'key', 'name', 'description', 'is_system'])
    .where('organization_id', '=', ctx.actor.organizationId)
    .orderBy('is_system', 'desc')
    .orderBy('created_at')
    .execute();
  const perms = roles.length
    ? await ctx.trx.selectFrom('role_permissions').select(['role_id', 'permission_key']).where('role_id', 'in', roles.map((r) => r.id)).execute()
    : [];
  return roles.map((r) => ({ ...r, permissions: perms.filter((p) => p.role_id === r.id).map((p) => p.permission_key) }));
}

export function permissionCatalog() {
  return Object.entries(PERMISSIONS).map(([key, label]) => ({ key, label }));
}

export async function createRole(ctx: Ctx, input: { key: string; name: string; description?: string; permissions: string[] }) {
  requirePermission(ctx.actor, 'role.manage');
  assertValidPermissions(input.permissions);
  const role = await ctx.trx
    .insertInto('roles')
    .values({ organization_id: ctx.actor.organizationId, key: input.key, name: input.name, description: input.description ?? null })
    .returning('id')
    .executeTakeFirstOrThrow();
  if (input.permissions.length) {
    await ctx.trx
      .insertInto('role_permissions')
      .values(input.permissions.map((p) => ({ role_id: role.id, organization_id: ctx.actor.organizationId, permission_key: p })))
      .execute();
  }
  await audit(ctx, { action: 'role.create', resourceType: 'role', resourceId: role.id, after: input });
  return (await listRoles(ctx)).find((r) => r.id === role.id)!;
}

function assertValidPermissions(perms: string[]) {
  const invalid = perms.filter((p) => !ALL_PERMISSIONS.includes(p as Permission));
  if (invalid.length) throw Errors.validation('不明な権限キーがあります', { invalid });
}

export async function updateRole(ctx: Ctx, roleId: string, input: { name?: string; description?: string; permissions?: string[] }) {
  requirePermission(ctx.actor, 'role.manage');
  const role = (await listRoles(ctx)).find((r) => r.id === roleId);
  if (!role) throw Errors.notFound('ロール', roleId);
  if (role.key === 'owner' && input.permissions) throw Errors.business('OWNER_ROLE_IMMUTABLE', 'オーナーロールの権限は変更できません');
  await ctx.trx.updateTable('roles').set({ name: input.name, description: input.description }).where('id', '=', roleId).execute();
  if (input.permissions) {
    assertValidPermissions(input.permissions);
    await ctx.trx.deleteFrom('role_permissions').where('role_id', '=', roleId).execute();
    if (input.permissions.length) {
      await ctx.trx
        .insertInto('role_permissions')
        .values(input.permissions.map((p) => ({ role_id: roleId, organization_id: ctx.actor.organizationId, permission_key: p })))
        .execute();
    }
    invalidateActorCache();
  }
  const after = (await listRoles(ctx)).find((r) => r.id === roleId)!;
  await audit(ctx, { action: 'role.permissions_change', resourceType: 'role', resourceId: roleId, before: role, after });
  return after;
}

export async function deleteRole(ctx: Ctx, roleId: string) {
  requirePermission(ctx.actor, 'role.manage');
  const role = await ctx.trx.selectFrom('roles').select(['id', 'is_system']).where('id', '=', roleId).where('organization_id', '=', ctx.actor.organizationId).executeTakeFirst();
  if (!role) throw Errors.notFound('ロール', roleId);
  if (role.is_system) throw Errors.business('SYSTEM_ROLE', 'システムロールは削除できません');
  const inUse = await ctx.trx.selectFrom('staffs').select('id').where('role_id', '=', roleId).where('deleted_at', 'is', null).executeTakeFirst();
  if (inUse) throw Errors.business('ROLE_IN_USE', '使用中のロールは削除できません');
  await ctx.trx.deleteFrom('roles').where('id', '=', roleId).execute();
  await audit(ctx, { action: 'role.delete', resourceType: 'role', resourceId: roleId });
}
