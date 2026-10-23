import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { assertShopAccess, requirePermission } from '../../auth/actor.js';
import { booleanQuery, idParam, uuid } from '../../lib/schemas.js';
import { equipmentRoutes } from './equipment.js';
import { sbImportRoutes } from './sbImport.js';
import * as svc from './service.js';
import {
  createCouponSchema,
  createMenuSchema,
  equipmentAssignmentsSchema,
  menuCategorySchema,
  menuListingSchema,
  menuOverrideSchema,
  reorderSchema,
  resourceSchema,
  staffAssignmentsSchema,
  staffMenuSchema,
  updateCouponSchema,
  updateMenuSchema,
} from './schemas.js';

const tags = ['catalog'];

const plugin: FastifyPluginAsyncZod = async (app) => {
  // categories
  app.get('/menu-categories', { schema: { tags, querystring: z.object({ shopId: uuid.optional() }) } }, (req) => req.tx((ctx) => svc.listCategories(ctx, req.query.shopId)));
  app.post('/menu-categories', { schema: { tags, body: menuCategorySchema } }, async (req, reply) => reply.status(201).send(await req.tx((ctx) => svc.createCategory(ctx, req.body))));
  app.patch('/menu-categories/:id', { schema: { tags, params: idParam, body: menuCategorySchema.omit({ shopId: true }).partial() } }, (req) =>
    req.tx((ctx) => svc.updateCategory(ctx, req.params.id, req.body)),
  );
  app.put('/menu-categories/reorder', { schema: { tags, summary: 'カテゴリの並び順', body: reorderSchema } }, (req) => req.tx((ctx) => svc.reorderCategories(ctx, req.body.items)));
  app.delete('/menu-categories/all', { schema: { tags, summary: '店舗のカテゴリを全削除(メニューはカテゴリなしで残る)', querystring: z.object({ shopId: uuid }) } }, (req) =>
    req.tx((ctx) => svc.deleteAllCategories(ctx, req.query.shopId)),
  );
  app.delete('/menu-categories/:id', { schema: { tags, params: idParam } }, async (req, reply) => {
    await req.tx((ctx) => svc.deleteCategory(ctx, req.params.id));
    return reply.status(204).send();
  });

  // menus
  app.get(
    '/menus',
    {
      schema: {
        tags,
        summary: 'メニュー一覧(店舗指定時は共通+店舗独自、上書き適用済み)',
        querystring: z.object({ shopId: uuid.optional(), includeInactive: booleanQuery }),
      },
    },
    (req) =>
      req.tx(async (ctx) => {
        if (req.query.shopId) {
          assertShopAccess(ctx.actor, req.query.shopId);
          return svc.effectiveMenus(ctx, req.query.shopId, { includeInactive: req.query.includeInactive });
        }
        requirePermission(ctx.actor, 'menu.manage');
        return ctx.trx.selectFrom('menus').selectAll().where('deleted_at', 'is', null).orderBy('shop_id').orderBy('sort_order').execute();
      }),
  );
  app.post('/menus', { schema: { tags, summary: 'メニュー作成', body: createMenuSchema } }, async (req, reply) => reply.status(201).send(await req.tx((ctx) => svc.createMenu(ctx, req.body))));
  app.get('/menus/:id', { schema: { tags, params: idParam } }, (req) => req.tx((ctx) => svc.getMenu(ctx, req.params.id)));
  app.patch('/menus/:id', { schema: { tags, params: idParam, body: updateMenuSchema } }, (req) => req.tx((ctx) => svc.updateMenu(ctx, req.params.id, req.body)));
  app.delete(
    '/menus/:id',
    { schema: { tags, summary: 'メニュー削除(論理削除)。checkUsage=true のとき予約で使用中なら 409 MENU_IN_USE', params: idParam, querystring: z.object({ checkUsage: booleanQuery }) } },
    async (req, reply) => {
      await req.tx((ctx) => svc.deleteMenu(ctx, req.params.id, { checkUsage: req.query.checkUsage }));
      return reply.status(204).send();
    },
  );
  app.put('/menus/reorder', { schema: { tags, summary: 'メニューの並び順', body: reorderSchema } }, (req) => req.tx((ctx) => svc.reorderMenus(ctx, req.body.items)));
  app.put('/menus/staff-assignments', { schema: { tags, summary: '対応スタッフ(メニュー×スタッフ)の一括保存', body: staffAssignmentsSchema } }, (req) =>
    req.tx((ctx) => svc.setStaffAssignments(ctx, req.body)),
  );
  app.put('/menus/equipment-assignments', { schema: { tags, summary: '対応設備(メニュー×設備の種類)の一括保存', body: equipmentAssignmentsSchema } }, (req) =>
    req.tx((ctx) => svc.setEquipmentAssignments(ctx, req.body)),
  );
  app.put('/menus/:id/listing', { schema: { tags, summary: '掲載/非掲載(店舗単位)', params: idParam, body: menuListingSchema } }, (req) =>
    req.tx((ctx) => svc.setMenuListing(ctx, req.params.id, req.body.shopId, req.body.listed)),
  );
  app.put('/menus/:id/shops/:shopId', { schema: { tags, summary: '店舗別上書き(価格/時間/提供可否)', params: z.object({ id: uuid, shopId: uuid }), body: menuOverrideSchema } }, (req) =>
    req.tx((ctx) => svc.setMenuOverride(ctx, req.params.id, req.params.shopId, req.body)),
  );
  app.delete('/menus/:id/shops/:shopId', { schema: { tags, params: z.object({ id: uuid, shopId: uuid }) } }, async (req, reply) => {
    await req.tx((ctx) => svc.deleteMenuOverride(ctx, req.params.id, req.params.shopId));
    return reply.status(204).send();
  });
  app.put('/staff/:id/menus', { schema: { tags, summary: '担当可能メニュー/スタッフ別料金', params: idParam, body: staffMenuSchema } }, (req) =>
    req.tx((ctx) => svc.setStaffMenus(ctx, req.params.id, req.body.menus)),
  );

  // resources
  app.get('/resources', { schema: { tags, summary: '席/設備一覧', querystring: z.object({ shopId: uuid }) } }, (req) => req.tx((ctx) => svc.listResources(ctx, req.query.shopId)));
  app.post('/resources', { schema: { tags, body: resourceSchema } }, async (req, reply) => reply.status(201).send(await req.tx((ctx) => svc.createResource(ctx, req.body))));
  app.patch('/resources/:id', { schema: { tags, params: idParam, body: resourceSchema.omit({ shopId: true }).partial() } }, (req) =>
    req.tx((ctx) => svc.updateResource(ctx, req.params.id, req.body)),
  );
  app.delete('/resources/:id', { schema: { tags, params: idParam } }, async (req, reply) => {
    await req.tx((ctx) => svc.deleteResource(ctx, req.params.id));
    return reply.status(204).send();
  });

  // coupons
  app.get('/coupons', { schema: { tags, querystring: z.object({ shopId: uuid.optional() }) } }, (req) => req.tx((ctx) => svc.listCoupons(ctx, { shopId: req.query.shopId })));
  app.post('/coupons', { schema: { tags, body: createCouponSchema } }, async (req, reply) => reply.status(201).send(await req.tx((ctx) => svc.createCoupon(ctx, req.body))));
  app.patch('/coupons/:id', { schema: { tags, params: idParam, body: updateCouponSchema } }, (req) => req.tx((ctx) => svc.updateCoupon(ctx, req.params.id, req.body)));
  app.delete('/coupons/:id', { schema: { tags, params: idParam } }, async (req, reply) => {
    await req.tx((ctx) => svc.deleteCoupon(ctx, req.params.id));
    return reply.status(204).send();
  });
  app.post(
    '/coupons/evaluate',
    {
      schema: {
        tags,
        summary: 'クーポン適用可否・割引額の試算',
        body: z.object({
          couponId: uuid.optional(),
          code: z.string().optional(),
          shopId: uuid,
          customerId: uuid.nullable().optional(),
          lines: z.array(z.object({ menuId: uuid.nullable().optional(), amount: z.number().int().min(0) })),
        }),
      },
    },
    (req) => req.tx((ctx) => svc.evaluateCoupon(ctx, req.body)),
  );

  // 設備 (name + quantity view over resources; 店舗設定 › 設備)
  await app.register(equipmentRoutes);
  // サロンボードから取込 (menus, coupons, 対応スタッフ / 対応設備, categories, pictures by URL)
  await app.register(sbImportRoutes);
};

export default plugin;
