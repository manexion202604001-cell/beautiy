import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { booleanQuery, idParam, uuid } from '../../lib/schemas.js';
import * as svc from './service.js';
import {
  createShopSchema,
  createStaffSchema,
  roleSchema,
  transferStaffSchema,
  updateOrganizationSchema,
  updateShopSchema,
  updateRoleSchema,
  updateStaffSchema,
} from './schemas.js';

const plugin: FastifyPluginAsyncZod = async (app) => {
  // ---------- organization
  app.get('/organization', { schema: { tags: ['org'], summary: '自法人情報' } }, (req) => req.tx((ctx) => svc.getOrganization(ctx)));
  app.patch('/organization', { schema: { tags: ['org'], summary: '法人設定更新', body: updateOrganizationSchema } }, (req) =>
    req.tx((ctx) => svc.updateOrganization(ctx, req.body)),
  );

  // ---------- shops
  app.get('/shops', { schema: { tags: ['org'], summary: '店舗一覧(アクセス可能な店舗)' } }, (req) => req.tx((ctx) => svc.listShops(ctx)));
  app.post('/shops', { schema: { tags: ['org'], summary: '店舗作成', body: createShopSchema } }, async (req, reply) => {
    const shop = await req.tx((ctx) => svc.createShop(ctx, req.body));
    return reply.status(201).send(shop);
  });
  app.get('/shops/:id', { schema: { tags: ['org'], summary: '店舗詳細', params: idParam } }, (req) => req.tx((ctx) => svc.getShop(ctx, req.params.id)));
  app.patch('/shops/:id', { schema: { tags: ['org'], summary: '店舗更新', params: idParam, body: updateShopSchema } }, (req) =>
    req.tx((ctx) => svc.updateShop(ctx, req.params.id, req.body)),
  );

  // ---------- staff
  app.get(
    '/staff',
    {
      schema: {
        tags: ['org'],
        summary: 'スタッフ一覧',
        querystring: z.object({ shopId: uuid.optional(), includeInactive: booleanQuery, bookableOnly: booleanQuery }),
      },
    },
    (req) => req.tx((ctx) => svc.listStaff(ctx, req.query)),
  );
  app.post('/staff', { schema: { tags: ['org'], summary: 'スタッフ作成・招待', body: createStaffSchema } }, async (req, reply) => {
    const result = await req.tx((ctx) => svc.createStaff(ctx, req.body));
    return reply.status(201).send(result);
  });
  app.get('/staff/:id', { schema: { tags: ['org'], params: idParam } }, (req) => req.tx((ctx) => svc.getStaff(ctx, req.params.id)));
  app.patch('/staff/:id', { schema: { tags: ['org'], params: idParam, body: updateStaffSchema } }, (req) =>
    req.tx((ctx) => svc.updateStaff(ctx, req.params.id, req.body)),
  );
  app.put('/staff/:id/role', { schema: { tags: ['org'], summary: '権限変更(監査対象)', params: idParam, body: z.object({ roleId: uuid }) } }, (req) =>
    req.tx((ctx) => svc.changeStaffRole(ctx, req.params.id, req.body.roleId)),
  );
  app.put('/staff/:id/shops', { schema: { tags: ['org'], summary: '所属店舗設定', params: idParam, body: z.object({ shopIds: z.array(uuid) }) } }, (req) =>
    req.tx((ctx) => svc.setStaffShops(ctx, req.params.id, req.body.shopIds)),
  );
  app.post('/staff/:id/transfer', { schema: { tags: ['org'], summary: '異動(顧客担当関係の引継ぎ)', params: idParam, body: transferStaffSchema } }, (req) =>
    req.tx((ctx) => svc.transferStaff(ctx, req.params.id, req.body)),
  );

  // ---------- roles
  app.get('/roles', { schema: { tags: ['org'], summary: 'ロール一覧' } }, (req) => req.tx((ctx) => svc.listRoles(ctx)));
  app.get('/permissions', { schema: { tags: ['org'], summary: '権限キー一覧' } }, async () => svc.permissionCatalog());
  app.post('/roles', { schema: { tags: ['org'], summary: 'カスタムロール作成', body: roleSchema } }, async (req, reply) => {
    const role = await req.tx((ctx) => svc.createRole(ctx, req.body));
    return reply.status(201).send(role);
  });
  app.patch(
    '/roles/:id',
    { schema: { tags: ['org'], params: idParam, body: updateRoleSchema } },
    (req) => req.tx((ctx) => svc.updateRole(ctx, req.params.id, req.body)),
  );
  app.delete('/roles/:id', { schema: { tags: ['org'], params: idParam } }, async (req, reply) => {
    await req.tx((ctx) => svc.deleteRole(ctx, req.params.id));
    return reply.status(204).send();
  });
};

export default plugin;
