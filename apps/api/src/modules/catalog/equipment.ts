/**
 * 設備 (店舗設定 › 設備): equipment managed as "name + quantity", e.g. シャンプー台 × 3.
 *
 * Storage is the existing `resources` table, where each row is ONE unit and `resource_type`
 * groups the units: an equipment named N with quantity Q is Q rows with resource_type = N.
 * Menus point at equipment through menu_resource_requirements.resource_type, and the booking
 * engine keeps simultaneous use within the number of active units (appointments/availability.ts).
 * Switching an equipment to 無効 sets every unit inactive: its limit is not applied while it is off.
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { assertShopAccess, requirePermission, type Ctx } from '../../auth/actor.js';
import { audit } from '../../lib/audit.js';
import { Errors } from '../../lib/errors.js';
import { booleanQuery, uuid } from '../../lib/schemas.js';

const equipmentName = z.string().trim().min(1, '設備名を入力してください').max(30, '設備名は30文字以内で入力してください');
const equipmentQuantity = z.number().int().min(1, '数量は1以上で入力してください').max(99, '数量は99以下で入力してください');

export const createEquipmentSchema = z.object({ shopId: uuid, name: equipmentName, quantity: equipmentQuantity });
/** PATCH: `name` identifies the equipment; no defaults */
export const updateEquipmentSchema = z.object({
  shopId: uuid,
  name: equipmentName,
  newName: equipmentName.optional(),
  quantity: equipmentQuantity.optional(),
  isActive: z.boolean().optional(),
});

export interface Equipment {
  shopId: string;
  name: string;
  quantity: number;
  isActive: boolean;
}

/** Shop boundary: the actor may use the shop, and the shop belongs to this organization (RLS-scoped lookup) */
async function assertShop(ctx: Ctx, shopId: string) {
  assertShopAccess(ctx.actor, shopId);
  const shop = await ctx.trx.selectFrom('shops').select('id').where('id', '=', shopId).where('deleted_at', 'is', null).executeTakeFirst();
  if (!shop) throw Errors.notFound('店舗', shopId);
}

async function loadUnits(ctx: Ctx, shopId: string, name?: string) {
  let q = ctx.trx
    .selectFrom('resources')
    .select(['id', 'name', 'resource_type', 'sort_order', 'status', 'created_at'])
    .where('shop_id', '=', shopId)
    .where('deleted_at', 'is', null)
    .orderBy('sort_order')
    .orderBy('created_at')
    .orderBy('id');
  if (name !== undefined) q = q.where('resource_type', '=', name);
  return q.execute();
}

export async function listEquipment(ctx: Ctx, shopId: string, opts: { includeInactive?: boolean } = {}): Promise<Equipment[]> {
  await assertShop(ctx, shopId);
  const units = await loadUnits(ctx, shopId);
  const groups = new Map<string, { quantity: number; active: number; first: Date }>();
  for (const u of units) {
    const g = groups.get(u.resource_type) ?? { quantity: 0, active: 0, first: u.created_at };
    g.quantity += 1;
    if (u.status === 'active') g.active += 1;
    if (u.created_at < g.first) g.first = u.created_at;
    groups.set(u.resource_type, g);
  }
  return [...groups.entries()]
    .sort((a, b) => a[1].first.getTime() - b[1].first.getTime() || a[0].localeCompare(b[0], 'ja'))
    .map(([name, g]) => ({ shopId, name, quantity: g.quantity, isActive: g.active > 0 }))
    .filter((e) => opts.includeInactive || e.isActive);
}

async function getEquipment(ctx: Ctx, shopId: string, name: string): Promise<Equipment> {
  const found = (await listEquipment(ctx, shopId, { includeInactive: true })).find((e) => e.name === name);
  if (!found) throw Errors.notFound('設備');
  return found;
}

/** Adds `count` units; `existing` = units the equipment already has (numbers the new unit names) */
async function insertUnits(ctx: Ctx, shopId: string, name: string, existing: number, sortFrom: number, count: number, status: 'active' | 'inactive') {
  if (count <= 0) return;
  await ctx.trx
    .insertInto('resources')
    .values(
      Array.from({ length: count }, (_, i) => ({
        organization_id: ctx.actor.organizationId,
        shop_id: shopId,
        name: `${name} ${existing + i + 1}`,
        resource_type: name,
        sort_order: sortFrom + i,
        status,
      })),
    )
    .execute();
}

export async function createEquipment(ctx: Ctx, input: z.infer<typeof createEquipmentSchema>): Promise<Equipment> {
  requirePermission(ctx.actor, 'menu.manage');
  await assertShop(ctx, input.shopId);
  if ((await loadUnits(ctx, input.shopId, input.name)).length) {
    throw Errors.conflict('EQUIPMENT_EXISTS', '同じ名前の設備が既に登録されています');
  }
  await insertUnits(ctx, input.shopId, input.name, 0, 0, input.quantity, 'active');
  await audit(ctx, { action: 'equipment.create', resourceType: 'equipment', shopId: input.shopId, after: { name: input.name, quantity: input.quantity } });
  return getEquipment(ctx, input.shopId, input.name);
}

/**
 * Menus whose equipment links follow a rename / removal in this shop: the shop's own menus, and
 * organization-wide menus when no other shop has an equipment of that name.
 */
async function linkedMenuIds(ctx: Ctx, shopId: string, name: string): Promise<string[]> {
  const elsewhere = await ctx.trx
    .selectFrom('resources')
    .select('id')
    .where('resource_type', '=', name)
    .where('shop_id', '!=', shopId)
    .where('deleted_at', 'is', null)
    .limit(1)
    .executeTakeFirst();
  const rows = await ctx.trx
    .selectFrom('menu_resource_requirements as r')
    .innerJoin('menus as m', 'm.id', 'r.menu_id')
    .select(['m.id', 'm.shop_id'])
    .where('r.resource_type', '=', name)
    .execute();
  return [...new Set(rows.filter((m) => m.shop_id === shopId || (m.shop_id === null && !elsewhere)).map((m) => m.id))];
}

export async function updateEquipment(ctx: Ctx, input: z.infer<typeof updateEquipmentSchema>): Promise<Equipment> {
  requirePermission(ctx.actor, 'menu.manage');
  await assertShop(ctx, input.shopId);
  const before = await getEquipment(ctx, input.shopId, input.name);
  let name = input.name;

  if (input.newName !== undefined && input.newName !== input.name) {
    if ((await loadUnits(ctx, input.shopId, input.newName)).length) {
      throw Errors.conflict('EQUIPMENT_EXISTS', '同じ名前の設備が既に登録されています');
    }
    const menuIds = await linkedMenuIds(ctx, input.shopId, input.name);
    const units = await loadUnits(ctx, input.shopId, input.name);
    for (const u of units) {
      // units created here are named "<設備名> <n>"; keep names staff typed themselves
      const renamed = u.name.startsWith(`${input.name} `) ? `${input.newName}${u.name.slice(input.name.length)}` : u.name;
      await ctx.trx.updateTable('resources').set({ resource_type: input.newName, name: renamed }).where('id', '=', u.id).execute();
    }
    if (menuIds.length) {
      await ctx.trx
        .updateTable('menu_resource_requirements')
        .set({ resource_type: input.newName })
        .where('resource_type', '=', input.name)
        .where('menu_id', 'in', menuIds)
        .execute();
    }
    name = input.newName;
  }

  const isActive = input.isActive ?? before.isActive;
  const units = await loadUnits(ctx, input.shopId, name);
  if (input.quantity !== undefined && input.quantity !== units.length) {
    if (input.quantity > units.length) {
      const nextOrder = units.reduce((m, u) => Math.max(m, u.sort_order + 1), units.length);
      await insertUnits(ctx, input.shopId, name, units.length, nextOrder, input.quantity - units.length, isActive ? 'active' : 'inactive');
    } else {
      // remove from the end; bookings already holding a removed unit keep their record
      const remove = units.slice(input.quantity).map((u) => u.id);
      await ctx.trx.updateTable('resources').set({ deleted_at: new Date(), status: 'inactive' }).where('id', 'in', remove).execute();
    }
  }
  if (input.isActive !== undefined) {
    await ctx.trx
      .updateTable('resources')
      .set({ status: input.isActive ? 'active' : 'inactive' })
      .where('shop_id', '=', input.shopId)
      .where('resource_type', '=', name)
      .where('deleted_at', 'is', null)
      .execute();
  }

  const after = await getEquipment(ctx, input.shopId, name);
  await audit(ctx, {
    action: 'equipment.update',
    resourceType: 'equipment',
    shopId: input.shopId,
    before: { name: before.name, quantity: before.quantity, isActive: before.isActive },
    after: { name: after.name, quantity: after.quantity, isActive: after.isActive },
  });
  return after;
}

export async function deleteEquipment(ctx: Ctx, shopId: string, name: string): Promise<void> {
  requirePermission(ctx.actor, 'menu.manage');
  await assertShop(ctx, shopId);
  const before = await getEquipment(ctx, shopId, name);
  const menuIds = await linkedMenuIds(ctx, shopId, name);
  await ctx.trx
    .updateTable('resources')
    .set({ deleted_at: new Date(), status: 'inactive' })
    .where('shop_id', '=', shopId)
    .where('resource_type', '=', name)
    .where('deleted_at', 'is', null)
    .execute();
  // a menu still asking for an equipment that no longer exists could never be booked
  if (menuIds.length) {
    await ctx.trx.deleteFrom('menu_resource_requirements').where('resource_type', '=', name).where('menu_id', 'in', menuIds).execute();
  }
  await audit(ctx, {
    action: 'equipment.delete',
    resourceType: 'equipment',
    shopId,
    before: { name: before.name, quantity: before.quantity, isActive: before.isActive, unlinkedMenus: menuIds.length },
  });
}

const tags = ['catalog'];

export const equipmentRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/equipment',
    { schema: { tags, summary: '設備一覧(名称・数量)', querystring: z.object({ shopId: uuid, includeInactive: booleanQuery }) } },
    (req) => req.tx((ctx) => listEquipment(ctx, req.query.shopId, { includeInactive: req.query.includeInactive })),
  );
  app.post('/equipment', { schema: { tags, summary: '設備追加', body: createEquipmentSchema } }, async (req, reply) =>
    reply.status(201).send(await req.tx((ctx) => createEquipment(ctx, req.body))),
  );
  app.patch('/equipment', { schema: { tags, summary: '設備の名称・数量・有効/無効を変更', body: updateEquipmentSchema } }, (req) =>
    req.tx((ctx) => updateEquipment(ctx, req.body)),
  );
  app.delete(
    '/equipment',
    { schema: { tags, summary: '設備削除', querystring: z.object({ shopId: uuid, name: equipmentName }) } },
    async (req, reply) => {
      await req.tx((ctx) => deleteEquipment(ctx, req.query.shopId, req.query.name));
      return reply.status(204).send();
    },
  );
};
