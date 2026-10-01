import { sql } from 'kysely';
import { requireAnyPermission, type Ctx } from '../../auth/actor.js';
import { withSystem } from '../../db/tenant.js';
import { enqueue, PermanentJobError, registerJob, type JobContext } from '../../jobs/queue.js';
import { dailyAt, registerPeriodic } from '../../jobs/scheduler.js';
import { audit } from '../../lib/audit.js';
import { decryptJson, encryptJson } from '../../lib/crypto.js';
import { Errors } from '../../lib/errors.js';
import { emit } from '../../lib/events.js';
import { localDate } from '../../lib/time.js';
import { GbpError, gbpAdapterFor, reviewResourceName, starToNumber, type GbpAccount, type GbpCredentials, type GbpReview } from './gbp.js';

/**
 * Google Business Profile integration (FR-07):
 *  - daily import (04:00 JST) per integration account (provider 'google_business'), upsert by external_review_id
 *  - replies written in Salon OS are pushed back with the 'reviews.google_reply' job
 * integration_accounts.config: { accountId, locationId, shopId?, driver?: 'mock'|'live' }
 * integration_accounts.encrypted_credentials: encryptJson({ accessToken, refreshToken, expiresAt, clientId?, clientSecret? })
 */
export const GBP_PROVIDER = 'google_business';
const MAX_PAGES = 20;
const DEGRADE_AFTER_FAILURES = 3;

interface LoadedAccount {
  account: GbpAccount;
  shopId: string;
  config: Record<string, unknown>;
  status: string;
}

async function loadAccount(ctx: Ctx, integrationAccountId: string): Promise<LoadedAccount | null> {
  const row = await ctx.trx
    .selectFrom('integration_accounts')
    .select(['id', 'shop_id', 'provider', 'status', 'config', 'encrypted_credentials'])
    .where('id', '=', integrationAccountId)
    .executeTakeFirst();
  if (!row || row.provider !== GBP_PROVIDER || row.status === 'disabled') return null;
  const config = (row.config ?? {}) as Record<string, unknown>;
  const shopId = row.shop_id ?? (typeof config.shopId === 'string' ? config.shopId : null);
  if (typeof config.accountId !== 'string' || typeof config.locationId !== 'string' || !shopId) {
    throw new PermanentJobError('Google Business Profile連携の設定(accountId/locationId/shopId)が不足しています');
  }
  const credentials = row.encrypted_credentials ? decryptJson<GbpCredentials>(row.encrypted_credentials) : {};
  return { account: { integrationAccountId: row.id, accountId: config.accountId, locationId: config.locationId, credentials }, shopId, config, status: row.status };
}

function persistRefreshedCredentials(jc: JobContext, integrationAccountId: string) {
  return async (creds: GbpCredentials) => {
    await jc.tx((ctx) => ctx.trx.updateTable('integration_accounts').set({ encrypted_credentials: encryptJson(creds) }).where('id', '=', integrationAccountId).execute());
  };
}

async function recordFailure(jc: JobContext, integrationAccountId: string, err: unknown, syncJobId?: string) {
  const message = err instanceof Error ? err.message : String(err);
  await jc.tx(async (ctx) => {
    const acc = await ctx.trx
      .updateTable('integration_accounts')
      .set({ last_error: message.slice(0, 1000), last_error_at: new Date(), consecutive_failures: sql`consecutive_failures + 1` })
      .where('id', '=', integrationAccountId)
      .returning(['consecutive_failures', 'status'])
      .executeTakeFirst();
    if (syncJobId) await ctx.trx.updateTable('sync_jobs').set({ state: 'failed', error: message.slice(0, 1000), finished_at: new Date() }).where('id', '=', syncJobId).execute();
    if (acc && acc.status === 'active' && acc.consecutive_failures >= DEGRADE_AFTER_FAILURES) {
      await ctx.trx.updateTable('integration_accounts').set({ status: 'degraded' }).where('id', '=', integrationAccountId).execute();
      await emit(ctx, { type: 'integration.degraded', aggregateType: 'integration_account', aggregateId: integrationAccountId, payload: { integrationAccountId, provider: GBP_PROVIDER } });
    }
  });
}

function asJobError(err: unknown): Error {
  if (err instanceof GbpError && !err.retryable) return new PermanentJobError(err.message);
  return err instanceof Error ? err : new Error(String(err));
}

export async function upsertGoogleReviews(ctx: Ctx, loaded: LoadedAccount, reviews: GbpReview[]) {
  let created = 0;
  let updated = 0;
  let skipped = 0;
  for (const r of reviews) {
    const rating = starToNumber(r.starRating);
    if (!rating || !r.reviewId) {
      skipped++;
      continue;
    }
    const reply = r.reviewReply?.comment ?? null;
    const replyAt = r.reviewReply?.updateTime ? new Date(r.reviewReply.updateTime) : reply ? new Date() : null;
    const row = await ctx.trx
      .insertInto('reviews')
      .values({
        organization_id: ctx.actor.organizationId,
        shop_id: loaded.shopId,
        source: 'google',
        external_review_id: r.reviewId,
        integration_account_id: loaded.account.integrationAccountId,
        rating,
        body: r.comment ?? null,
        reviewer_name: r.reviewer?.isAnonymous ? null : (r.reviewer?.displayName ?? null),
        status: 'published', // already public on Google; staff may hide it in Salon OS
        reply_body: reply,
        replied_at: replyAt,
        reply_synced_at: replyAt,
        posted_at: new Date(r.createTime),
      })
      .onConflict((oc) =>
        oc
          .columns(['organization_id', 'source', 'external_review_id'])
          .where('external_review_id', 'is not', null)
          .doUpdateSet({
            rating: (eb) => eb.ref('excluded.rating'),
            body: (eb) => eb.ref('excluded.body'),
            reviewer_name: (eb) => eb.ref('excluded.reviewer_name'),
            integration_account_id: (eb) => eb.ref('excluded.integration_account_id'),
            // keep a local reply that is still waiting to be pushed; otherwise Google is the source of truth
            reply_body: sql`CASE WHEN excluded.reply_body IS NULL OR (reviews.reply_body IS NOT NULL AND reviews.reply_synced_at IS NULL) THEN reviews.reply_body ELSE excluded.reply_body END`,
            replied_at: sql`CASE WHEN excluded.reply_body IS NULL OR (reviews.reply_body IS NOT NULL AND reviews.reply_synced_at IS NULL) THEN reviews.replied_at ELSE excluded.replied_at END`,
            reply_synced_at: sql`CASE WHEN excluded.reply_body IS NULL OR (reviews.reply_body IS NOT NULL AND reviews.reply_synced_at IS NULL) THEN reviews.reply_synced_at ELSE excluded.reply_synced_at END`,
          }),
      )
      .returning(sql<boolean>`(xmax = 0)`.as('inserted'))
      .executeTakeFirstOrThrow();
    if (row.inserted) created++;
    else updated++;
  }
  return { created, updated, skipped };
}

/** One import run for one account. Network calls happen outside DB transactions. */
export async function importGoogleReviews(jc: JobContext, integrationAccountId: string, triggeredBy = 'schedule') {
  const start = await jc.tx(async (ctx) => {
    const loaded = await loadAccount(ctx, integrationAccountId);
    if (!loaded) return null;
    const job = await ctx.trx
      .insertInto('sync_jobs')
      .values({ organization_id: ctx.actor.organizationId, integration_account_id: integrationAccountId, provider: GBP_PROVIDER, resource: 'reviews', mode: 'full', state: 'running', triggered_by: triggeredBy, started_at: new Date() })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { loaded, syncJobId: job.id };
  });
  if (!start) return null;
  const { loaded, syncJobId } = start;
  loaded.account.onCredentialsRefreshed = persistRefreshedCredentials(jc, integrationAccountId);
  const adapter = gbpAdapterFor(loaded.config);

  const reviews: GbpReview[] = [];
  try {
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await adapter.listReviews(loaded.account, pageToken);
      reviews.push(...res.reviews);
      pageToken = res.nextPageToken;
      if (!pageToken) break;
    }
  } catch (err) {
    await recordFailure(jc, integrationAccountId, err, syncJobId);
    throw asJobError(err);
  }

  return jc.tx(async (ctx) => {
    const stats = await upsertGoogleReviews(ctx, loaded, reviews);
    const now = new Date();
    const acc = await ctx.trx
      .updateTable('integration_accounts')
      .set({ last_synced_at: now, last_success_at: now, consecutive_failures: 0, last_error: null, status: sql`CASE WHEN status = 'degraded' THEN 'active' ELSE status END` })
      .where('id', '=', integrationAccountId)
      .returning('status')
      .executeTakeFirst();
    if (loaded.status === 'degraded' && acc?.status === 'active') {
      await emit(ctx, { type: 'integration.recovered', aggregateType: 'integration_account', aggregateId: integrationAccountId, payload: { integrationAccountId, provider: GBP_PROVIDER } });
    }
    await ctx.trx
      .updateTable('sync_jobs')
      .set({ state: 'succeeded', finished_at: now, stats: JSON.stringify({ fetched: reviews.length, ...stats }) })
      .where('id', '=', syncJobId)
      .execute();
    return { fetched: reviews.length, ...stats };
  });
}

/** Push a staff reply to Google */
export async function pushGoogleReply(jc: JobContext, reviewId: string) {
  const loaded = await jc.tx(async (ctx) => {
    const review = await ctx.trx
      .selectFrom('reviews')
      .select(['id', 'shop_id', 'source', 'external_review_id', 'integration_account_id', 'reply_body', 'reply_synced_at'])
      .where('id', '=', reviewId)
      .executeTakeFirst();
    if (!review || review.source !== 'google' || !review.external_review_id || !review.reply_body || review.reply_synced_at) return null;
    let accountId = review.integration_account_id;
    if (!accountId) {
      const acc = await ctx.trx
        .selectFrom('integration_accounts')
        .select('id')
        .where('provider', '=', GBP_PROVIDER)
        .where((eb) => eb.or([eb('shop_id', '=', review.shop_id), eb(sql`config->>'shopId'`, '=', review.shop_id)]))
        .executeTakeFirst();
      accountId = acc?.id ?? null;
    }
    if (!accountId) throw new PermanentJobError('この店舗のGoogle Business Profile連携が見つかりません');
    const acc = await loadAccount(ctx, accountId);
    if (!acc) throw new PermanentJobError('Google Business Profile連携が無効です');
    return { review, acc };
  });
  if (!loaded) return;
  const { review, acc } = loaded;
  acc.account.onCredentialsRefreshed = persistRefreshedCredentials(jc, acc.account.integrationAccountId);
  try {
    await gbpAdapterFor(acc.config).replyToReview(acc.account, reviewResourceName(acc.account, review.external_review_id!), review.reply_body!);
  } catch (err) {
    await jc.tx((ctx) => ctx.trx.updateTable('reviews').set({ reply_sync_error: (err instanceof Error ? err.message : String(err)).slice(0, 1000) }).where('id', '=', reviewId).execute());
    throw asJobError(err);
  }
  await jc.tx((ctx) =>
    ctx.trx
      .updateTable('reviews')
      .set({ reply_synced_at: new Date(), reply_sync_error: null })
      .where('id', '=', reviewId)
      .where('reply_body', '=', review.reply_body) // a newer edit stays unsynced (and is pushed by its own job)
      .execute(),
  );
}

/** Manual trigger (POST /reviews/google/import) */
export async function requestGoogleImport(ctx: Ctx, integrationAccountId?: string) {
  requireAnyPermission(ctx.actor, 'review.manage', 'integration.manage');
  let q = ctx.trx.selectFrom('integration_accounts').select(['id', 'shop_id']).where('provider', '=', GBP_PROVIDER).where('status', '!=', 'disabled');
  if (integrationAccountId) q = q.where('id', '=', integrationAccountId);
  const accounts = await q.execute();
  if (integrationAccountId && !accounts.length) throw Errors.notFound('Google Business Profile連携', integrationAccountId);
  let queued = 0;
  for (const a of accounts) {
    const id = await enqueue(ctx, { type: 'reviews.gbp_import', payload: { integrationAccountId: a.id, triggeredBy: 'manual' }, dedupeKey: `gbp-import:${a.id}:manual` });
    if (id) queued++;
  }
  await audit(ctx, { action: 'review.google_import', resourceType: 'integration_account', resourceId: integrationAccountId ?? null, metadata: { queued } });
  return { queued, accounts: accounts.length };
}

// ---------------------------------------------------------------- jobs

registerJob<{ integrationAccountId: string; triggeredBy?: string }>('reviews.gbp_import', async (p, jc) => {
  await importGoogleReviews(jc, p.integrationAccountId, p.triggeredBy);
});

registerJob<{ reviewId: string }>('reviews.google_reply', async (p, jc) => {
  await pushGoogleReply(jc, p.reviewId);
});

/** global fan-out: one import job per active Google account */
registerJob('reviews.gbp_import_all', async () => {
  const day = localDate(new Date(), 'Asia/Tokyo');
  await withSystem(async (trx) => {
    const accounts = await trx.selectFrom('integration_accounts').select(['id', 'organization_id']).where('provider', '=', GBP_PROVIDER).where('status', '!=', 'disabled').execute();
    for (const a of accounts) {
      await enqueue(trx, { type: 'reviews.gbp_import', organizationId: a.organization_id, payload: { integrationAccountId: a.id }, dedupeKey: `gbp-import:${a.id}:${day}` });
    }
  });
});

registerPeriodic({ name: 'reviews.gbp_import', jobType: 'reviews.gbp_import_all', bucket: dailyAt(4) });
