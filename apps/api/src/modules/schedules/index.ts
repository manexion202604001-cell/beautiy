import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { hhmm, idParam, isoDate, isoDateTime, uuid } from '../../lib/schemas.js';
import { listStaff } from '../org/service.js';
import * as svc from './service.js';

const tags = ['schedules'];
const shopParam = z.object({ id: uuid });

const plugin: FastifyPluginAsyncZod = async (app) => {
  app.get('/shops/:id/business-hours', { schema: { tags, summary: '営業時間', params: shopParam } }, (req) => req.tx((ctx) => svc.getBusinessHours(ctx, req.params.id)));
  app.put(
    '/shops/:id/business-hours',
    { schema: { tags, summary: '営業時間の一括設定', params: shopParam, body: z.object({ hours: z.array(z.object({ weekday: z.number().int().min(0).max(6), openTime: hhmm, closeTime: hhmm })) }) } },
    (req) => req.tx((ctx) => svc.replaceBusinessHours(ctx, req.params.id, req.body.hours)),
  );
  app.get('/shops/:id/calendar-exceptions', { schema: { tags, summary: '休業日/特別営業', params: shopParam, querystring: z.object({ from: isoDate, to: isoDate }) } }, (req) =>
    req.tx((ctx) => svc.listExceptions(ctx, req.params.id, req.query.from, req.query.to)),
  );
  app.put(
    '/shops/:id/calendar-exceptions/:date',
    {
      schema: {
        tags,
        params: z.object({ id: uuid, date: isoDate }),
        body: z.object({ isClosed: z.boolean(), openTime: hhmm.nullable().optional(), closeTime: hhmm.nullable().optional(), note: z.string().max(200).nullable().optional() }),
      },
    },
    (req) => req.tx((ctx) => svc.upsertException(ctx, req.params.id, req.params.date, req.body)),
  );
  app.delete('/shops/:id/calendar-exceptions/:date', { schema: { tags, params: z.object({ id: uuid, date: isoDate }) } }, async (req, reply) => {
    await req.tx((ctx) => svc.deleteException(ctx, req.params.id, req.params.date));
    return reply.status(204).send();
  });

  app.get('/staff/:id/weekly-schedule', { schema: { tags, summary: 'スタッフ基本勤務パターン', params: idParam, querystring: z.object({ shopId: uuid }) } }, (req) =>
    req.tx((ctx) => svc.getWeeklySchedule(ctx, req.params.id, req.query.shopId)),
  );
  app.put(
    '/staff/:id/weekly-schedule',
    {
      schema: {
        tags,
        params: idParam,
        body: z.object({ shopId: uuid, rows: z.array(z.object({ weekday: z.number().int().min(0).max(6), startTime: hhmm, endTime: hhmm })) }),
      },
    },
    (req) => req.tx((ctx) => svc.replaceWeeklySchedule(ctx, req.params.id, req.body.shopId, req.body.rows)),
  );

  app.get('/shifts', { schema: { tags, summary: 'シフト表', querystring: z.object({ shopId: uuid, from: isoDate, to: isoDate }) } }, (req) =>
    req.tx((ctx) => svc.listShifts(ctx, req.query.shopId, req.query.from, req.query.to)),
  );
  app.put(
    '/shifts',
    {
      schema: {
        tags,
        summary: 'シフト一括登録(スタッフ×日付単位で置換)',
        body: z.object({
          shopId: uuid,
          shifts: z
            .array(
              z.object({
                staffId: uuid,
                date: isoDate,
                shiftType: z.enum(['work', 'off']),
                startTime: hhmm.nullable().optional(),
                endTime: hhmm.nullable().optional(),
                note: z.string().max(200).nullable().optional(),
              }),
            )
            .max(1000),
        }),
      },
    },
    (req) => req.tx((ctx) => svc.upsertShifts(ctx, req.body.shopId, req.body.shifts)),
  );

  app.get('/schedule-blocks', { schema: { tags, querystring: z.object({ shopId: uuid, from: isoDateTime, to: isoDateTime }) } }, (req) =>
    req.tx((ctx) => svc.listBlocks(ctx, req.query.shopId, new Date(req.query.from), new Date(req.query.to))),
  );
  app.post(
    '/schedule-blocks',
    {
      schema: {
        tags,
        summary: '予約ブロック(会議・休憩・設備停止)',
        body: z.object({ shopId: uuid, staffId: uuid.nullable().optional(), resourceId: uuid.nullable().optional(), startAt: isoDateTime, endAt: isoDateTime, reason: z.string().max(200).nullable().optional() }),
      },
    },
    async (req, reply) => reply.status(201).send(await req.tx((ctx) => svc.createBlock(ctx, req.body))),
  );
  app.delete('/schedule-blocks/:id', { schema: { tags, params: idParam } }, async (req, reply) => {
    await req.tx((ctx) => svc.deleteBlock(ctx, req.params.id));
    return reply.status(204).send();
  });

  app.get('/shops/:id/staff-schedule', { schema: { tags, summary: '日別スタッフ稼働時間(算出)', params: shopParam, querystring: z.object({ date: isoDate }) } }, (req) =>
    req.tx(async (ctx) => {
      const staff = await listStaff(ctx, { shopId: req.params.id, bookableOnly: true });
      return svc.dayStaffSchedule(
        ctx,
        req.params.id,
        req.query.date,
        staff.map((s) => s.id),
      );
    }),
  );
};

export default plugin;
