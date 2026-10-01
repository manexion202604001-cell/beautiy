import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { assertShopAccess, requirePermission } from '../../auth/actor.js';
import { idParam, uuid } from '../../lib/schemas.js';
import { computeAvailability } from './availability.js';
import * as svc from './service.js';
import { availabilitySchema, createAppointmentSchema, listAppointmentsSchema, transitionSchema, updateAppointmentSchema } from './schemas.js';

const tags = ['appointments'];

const plugin: FastifyPluginAsyncZod = async (app) => {
  app.get('/availability', { schema: { tags, summary: '空き枠計算', querystring: availabilitySchema } }, (req) =>
    req.tx(async (ctx) => {
      requirePermission(ctx.actor, 'appointment.read');
      assertShopAccess(ctx.actor, req.query.shopId);
      return computeAvailability(ctx, req.query);
    }),
  );
  app.get('/appointments', { schema: { tags, summary: '予約一覧(カレンダー)', querystring: listAppointmentsSchema } }, (req) => req.tx((ctx) => svc.listAppointments(ctx, req.query)));
  app.post(
    '/appointments',
    { config: { idempotent: true }, schema: { tags, summary: '予約作成', description: 'Idempotency-Key対応。ダブルブッキングは409 SLOT_UNAVAILABLE / APPOINTMENT_OVERLAP', body: createAppointmentSchema } },
    async (req, reply) => reply.status(201).send(await req.tx((ctx) => svc.createAppointment(ctx, req.body))),
  );
  app.get('/appointments/attention', { schema: { tags, summary: '要対応予約(仮予約承認・無断キャンセル候補)', querystring: z.object({ shopId: uuid }) } }, (req) =>
    req.tx((ctx) => svc.attentionList(ctx, req.query.shopId)),
  );
  app.get('/appointments/:id', { schema: { tags, params: idParam } }, (req) => req.tx((ctx) => svc.getAppointment(ctx, req.params.id)));
  app.patch(
    '/appointments/:id',
    { config: { idempotent: true }, schema: { tags, summary: '予約変更(楽観ロック: version必須)', params: idParam, body: updateAppointmentSchema } },
    (req) => req.tx((ctx) => svc.updateAppointment(ctx, req.params.id, req.body)),
  );
  app.get('/appointments/:id/history', { schema: { tags, summary: '予約変更履歴', params: idParam } }, (req) => req.tx((ctx) => svc.appointmentHistory(ctx, req.params.id)));

  const transitions: [string, Parameters<typeof svc.transitionAppointment>[2], string][] = [
    ['confirm', 'confirmed', '仮予約の確定'],
    ['check-in', 'checked_in', '来店受付'],
    ['start', 'in_service', '施術開始'],
    ['complete', 'completed', '施術完了'],
    ['cancel', 'cancelled', 'キャンセル'],
    ['no-show', 'no_show', '無断キャンセル'],
    ['restore', 'confirmed', 'キャンセル/無断キャンセルの取消'],
  ];
  for (const [path, to, summary] of transitions) {
    app.post(`/appointments/:id/${path}`, { config: { idempotent: true }, schema: { tags, summary, params: idParam, body: transitionSchema.optional() } }, (req) =>
      req.tx((ctx) => svc.transitionAppointment(ctx, req.params.id, to, { version: req.body?.version, reason: req.body?.reason })),
    );
  }
};

export default plugin;
