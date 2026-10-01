import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requirePermission, type Ctx } from '../../auth/actor.js';
import { enqueue } from '../../jobs/queue.js';
import { audit } from '../../lib/audit.js';
import { idParam } from '../../lib/schemas.js';
import { decideSuggestion, karteSummary, listSuggestions, messageDraft, nextActions, reviewReplyDraft } from './assistant.js';
import { assertAiEnabled } from './feature.js';
import { salesForecast } from './forecast.js';
import { SCORE_ORG_JOB } from './jobs.js'; // also registers job handlers + nightly scoring
import { listAtRiskCustomers } from './scoring.js';
import {
  acceptBody,
  atRiskQuery,
  forecastQuery,
  karteSummaryBody,
  listSuggestionsQuery,
  messageDraftBody,
  nextActionsQuery,
  rejectBody,
  reviewReplyDraftBody,
} from './schemas.js';

const tags = ['ai'];

/** Every AI route runs behind the organization-level switch (settings.ai_assist === false → 403) */
function guarded<T>(fn: (ctx: Ctx) => Promise<T>) {
  return async (ctx: Ctx) => {
    await assertAiEnabled(ctx);
    return fn(ctx);
  };
}

const plugin: FastifyPluginAsyncZod = async (app) => {
  app.get('/ai/at-risk-customers', { schema: { tags, summary: '失客リスクの高い顧客(heuristic-v1)', querystring: atRiskQuery } }, (req) =>
    req.tx(guarded((ctx) => listAtRiskCustomers(ctx, req.query))),
  );

  app.post('/ai/scores/recompute', { schema: { tags, summary: '顧客スコアの再計算(運用)' } }, async (req, reply) => {
    const res = await req.tx(
      guarded(async (ctx) => {
        requirePermission(ctx.actor, 'ops.manage');
        const jobId = await enqueue(ctx, { type: SCORE_ORG_JOB, dedupeKey: `ai:scores:${ctx.actor.organizationId}:manual` });
        await audit(ctx, { action: 'ai.scores.recompute', resourceType: 'customer_scores', metadata: { jobId } });
        return { queued: !!jobId, jobId };
      }),
    );
    return reply.status(202).send(res);
  });

  app.get('/ai/forecast', { schema: { tags, summary: '売上予測(曜日別移動平均+予約済み見積)', querystring: forecastQuery } }, (req) =>
    req.tx(guarded((ctx) => salesForecast(ctx, req.query))),
  );

  app.post('/ai/message-draft', { schema: { tags, summary: 'メッセージ下書き生成(送信はしない)', body: messageDraftBody } }, async (req, reply) =>
    reply.status(201).send(await req.tx(guarded((ctx) => messageDraft(ctx, req.body)))),
  );
  app.post('/ai/review-reply-draft', { schema: { tags, summary: '口コミ返信の下書き生成', body: reviewReplyDraftBody } }, async (req, reply) =>
    reply.status(201).send(await req.tx(guarded((ctx) => reviewReplyDraft(ctx, req.body.reviewId)))),
  );
  app.post('/ai/karte-summary', { schema: { tags, summary: 'カルテ・来店履歴の要約(スタッフ向け)', body: karteSummaryBody } }, async (req, reply) =>
    reply.status(201).send(await req.tx(guarded((ctx) => karteSummary(ctx, req.body.customerId)))),
  );

  app.get('/ai/suggestions', { schema: { tags, summary: 'AI提案一覧', querystring: listSuggestionsQuery } }, (req) => req.tx(guarded((ctx) => listSuggestions(ctx, req.query))));
  app.post('/ai/suggestions/:id/accept', { schema: { tags, summary: 'AI提案を承認(本文を返却・自動送信なし)', params: idParam, body: acceptBody.optional() } }, (req) =>
    req.tx(guarded((ctx) => decideSuggestion(ctx, req.params.id, 'accepted', { editedText: req.body?.editedText }))),
  );
  app.post('/ai/suggestions/:id/reject', { schema: { tags, summary: 'AI提案を却下', params: idParam, body: rejectBody.optional() } }, (req) =>
    req.tx(guarded((ctx) => decideSuggestion(ctx, req.params.id, 'rejected', { reason: req.body?.reason }))),
  );

  app.get('/ai/next-actions', { schema: { tags, summary: '本日の推奨CRMアクション', querystring: nextActionsQuery } }, (req) => req.tx(guarded((ctx) => nextActions(ctx, req.query))));
};

export default plugin;
