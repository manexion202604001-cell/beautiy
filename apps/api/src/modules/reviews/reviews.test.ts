import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encryptJson } from '../../lib/crypto.js';
import { emit } from '../../lib/events.js';
import { api, asSystem, createCustomer, createMenu, createStaffUser, createTenant, jst, makeJobsDue, nextWeekday, runJobs, shopSlug, type Tenant } from '../../test/helpers.js';
import { failMockGbp, mockGbpReplies, setMockGbpReviews } from './gbp.js';

async function setup() {
  const t = await createTenant();
  const stylist = await createStaffUser(t, 'stylist', { displayName: '口コミ担当' });
  const menu = await createMenu(t, { name: 'カット+トリートメント', durationMin: 60, price: 8800 });
  const customer = await createCustomer(t, { lastName: '山田', firstName: '花子', email: 'hanako@example.com', phone: '090-1111-2222' });
  return { t, stylist, menu, customer };
}

let slotDay = 0;
async function appointment(t: Tenant, staffId: string, menuId: string, customerId: string) {
  const date = nextWeekday(3, 3 + 7 * (slotDay++ % 4));
  const res = await t.owner.post('/v1/appointments', { shopId: t.shopId, customerId, staffId, startAt: jst(date, `${10 + (slotDay % 8)}:00`), menuIds: [menuId] });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body as { id: string; version: number };
}

async function completedTransaction(t: Tenant, appointmentId: string | null, customerId: string, total = 8800) {
  return asSystem(t.organizationId, async (ctx) => {
    const tx = await ctx.trx
      .insertInto('transactions')
      .values({ organization_id: t.organizationId, shop_id: t.shopId, appointment_id: appointmentId, customer_id: customerId, status: 'completed', subtotal: total, total, completed_at: new Date() })
      .returning('id')
      .executeTakeFirstOrThrow();
    await emit(ctx, {
      type: 'transaction.completed',
      aggregateType: 'transaction',
      aggregateId: tx.id,
      payload: { transactionId: tx.id, shopId: t.shopId, customerId, appointmentId, total, completedAt: new Date().toISOString() },
    });
    return tx.id;
  });
}

async function requestsOf(t: Tenant, customerId: string) {
  return asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('review_requests').selectAll().where('customer_id', '=', customerId).execute());
}

async function issueAndSubmit(t: Tenant, customerId: string, appointmentId: string, review: Record<string, unknown>) {
  const req = await t.owner.post('/v1/review-requests', { customerId, appointmentId });
  expect(req.status).toBe(201);
  const token = (req.body.url as string).split('/').pop()!;
  const res = await api().post(`/v1/public/reviews/request/${token}`, review);
  expect(res.status).toBe(201);
  return { token, reviewId: res.body.reviewId as string, response: res.body };
}

describe('automatic review requests', () => {
  it('creates one delayed request per visit from transaction.completed / appointment.completed', async () => {
    const { t, stylist, menu, customer } = await setup();
    const appt = await appointment(t, stylist.staffId, menu.id, customer.id);
    const txId = await completedTransaction(t, appt.id, customer.id);

    const jobs = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('jobs').selectAll().where('type', '=', 'reviews.auto_request').execute());
    expect(jobs).toHaveLength(1);
    // default delay: 3 hours
    expect(jobs[0]!.run_at.getTime() - Date.now()).toBeGreaterThan(2.9 * 3600_000);
    await runJobs();
    expect(await requestsOf(t, customer.id)).toHaveLength(0); // not due yet

    await makeJobsDue(t.organizationId, 'reviews.auto_request');
    await runJobs();
    const reqs = await requestsOf(t, customer.id);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toMatchObject({ appointment_id: appt.id, transaction_id: txId, staff_id: stylist.staffId });
    // with the messaging module the request message is delivered in the same drain (created → sent on message.sent)
    expect(['created', 'sent']).toContain(reqs[0]!.status);
    expect(reqs[0]!.access_token_id).toBeTruthy();
    const msg = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('messages').selectAll().where('id', '=', reqs[0]!.message_id!).executeTakeFirstOrThrow());
    expect(msg.category).toBe('marketing');
    const payload = msg.payload as { templateKey: string; vars: { review: { url: string }; staff: { name: string } } };
    expect(payload.templateKey).toBe('review_request');
    expect(payload.vars.review.url).toMatch(/\/review\/[\w-]{20,}$/);
    expect(payload.vars.staff.name).toBe('口コミ担当');

    // the appointment being marked completed afterwards does not create a second request
    const done = await t.owner.post(`/v1/appointments/${appt.id}/complete`, {});
    expect(done.status).toBe(200);
    await makeJobsDue(t.organizationId, 'reviews.auto_request');
    await runJobs();
    expect(await requestsOf(t, customer.id)).toHaveLength(1);

    // message.sent marks the request as sent
    await asSystem(t.organizationId, (ctx) =>
      emit(ctx, { type: 'message.sent', aggregateType: 'message', aggregateId: reqs[0]!.message_id!, payload: { messageId: reqs[0]!.message_id!, customerId: customer.id, channel: 'line' } }),
    );
    expect((await requestsOf(t, customer.id))[0]!.status).toBe('sent');
  });

  it('works without POS (appointment.completed) and respects the shop setting', async () => {
    const { t, stylist, menu, customer } = await setup();
    const appt = await appointment(t, stylist.staffId, menu.id, customer.id);
    await t.owner.post(`/v1/appointments/${appt.id}/complete`, {});
    await makeJobsDue(t.organizationId, 'reviews.auto_request');
    await runJobs();
    const reqs = await requestsOf(t, customer.id);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!.transaction_id).toBeNull();

    const other = await createCustomer(t);
    await t.owner.patch(`/v1/shops/${t.shopId}`, { settings: { review: { autoRequest: false } } });
    const appt2 = await appointment(t, stylist.staffId, menu.id, other.id);
    await t.owner.post(`/v1/appointments/${appt2.id}/complete`, {});
    await makeJobsDue(t.organizationId, 'reviews.auto_request');
    await runJobs();
    expect(await requestsOf(t, other.id)).toHaveLength(0);
  });
});

describe('public review submission', () => {
  it('shows the visit, accepts one submission per link and suggests Google for good ratings', async () => {
    const { t, stylist, menu, customer } = await setup();
    await t.owner.patch(`/v1/shops/${t.shopId}`, { settings: { review: { googleReviewUrl: 'https://g.page/r/example/review' } } });
    const appt = await appointment(t, stylist.staffId, menu.id, customer.id);
    const created = await t.owner.post('/v1/review-requests', { customerId: customer.id, appointmentId: appt.id });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('created');
    const token = (created.body.url as string).split('/').pop()!;

    const dup = await t.owner.post('/v1/review-requests', { customerId: customer.id, appointmentId: appt.id });
    expect(dup.status).toBe(409);

    const view = await api().get(`/v1/public/reviews/request/${token}`);
    expect(view.status).toBe(200);
    expect(view.body.staff.displayName).toBe('口コミ担当');
    expect(view.body.visit.menus).toEqual(['カット+トリートメント']);
    expect(JSON.stringify(view.body)).not.toContain('山田');
    const listed = await t.owner.get('/v1/review-requests', { customerId: customer.id });
    expect(listed.body.items[0].status).toBe('opened');

    const bad = await api().post(`/v1/public/reviews/request/${token}`, { rating: 6 });
    expect(bad.status).toBe(400);
    const res = await api().post(`/v1/public/reviews/request/${token}`, { rating: 5, title: '最高', body: '丁寧なカウンセリングでした', reviewerName: 'H.Y', staffRating: 5 });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending');
    expect(res.body.googleReviewUrl).toBe('https://g.page/r/example/review');

    // single use
    expect((await api().post(`/v1/public/reviews/request/${token}`, { rating: 4 })).status).toBe(401);
    expect((await api().get(`/v1/public/reviews/request/${token}`)).status).toBe(401);
    expect((await t.owner.get('/v1/review-requests', { customerId: customer.id })).body.items[0].status).toBe('submitted');

    const events = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('domain_events').selectAll().where('event_type', '=', 'review.submitted').execute());
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ reviewId: res.body.reviewId, staffId: stylist.staffId, rating: 5 });

    // low rating: stored the same way, no Google suggestion
    const appt2 = await appointment(t, stylist.staffId, menu.id, customer.id);
    const low = await issueAndSubmit(t, customer.id, appt2.id, { rating: 3, body: '普通' });
    expect(low.response.googleReviewUrl).toBeNull();
    expect(low.response.status).toBe('pending');

    // invalid token
    expect((await api().get('/v1/public/reviews/request/invalid-token-0123456789')).status).toBe(401);
  });

  it('auto-publishes when the organization opts in', async () => {
    const { t, stylist, menu, customer } = await setup();
    await t.owner.patch('/v1/organization', { settings: { reviews: { autoPublishMinRating: 4 } } });
    const appt = await appointment(t, stylist.staffId, menu.id, customer.id);
    const { response } = await issueAndSubmit(t, customer.id, appt.id, { rating: 4 });
    expect(response.status).toBe('published');
  });
});

describe('moderation, reply and public listing', () => {
  it('moderates, replies, summarizes and only exposes published reviews without PII', async () => {
    const { t, stylist, menu, customer } = await setup();
    const slug = await shopSlug(t);
    const a1 = await appointment(t, stylist.staffId, menu.id, customer.id);
    const a2 = await appointment(t, stylist.staffId, menu.id, customer.id);
    const r1 = await issueAndSubmit(t, customer.id, a1.id, { rating: 5, body: 'また来ます', reviewerName: 'はなこ', staffRating: 4 });
    const r2 = await issueAndSubmit(t, customer.id, a2.id, { rating: 2, body: '待ち時間が長かった' });

    const pending = await t.owner.get('/v1/reviews', { status: 'pending' });
    expect(pending.status).toBe(200);
    expect(pending.body.items).toHaveLength(2);
    expect(pending.body.items[0].customer_name).toBe('山田 花子');

    // stylist: read own reviews only, cannot moderate
    const own = await stylist.api.get('/v1/reviews');
    expect(own.status).toBe(200);
    expect(own.body.items).toHaveLength(2);
    expect((await stylist.api.patch(`/v1/reviews/${r1.reviewId}`, { status: 'published' })).status).toBe(403);
    expect((await stylist.api.post(`/v1/reviews/${r1.reviewId}/reply`, { body: 'x' })).status).toBe(403);

    expect((await t.owner.patch(`/v1/reviews/${r1.reviewId}`, { status: 'published' })).body.status).toBe('published');
    expect((await t.owner.patch(`/v1/reviews/${r2.reviewId}`, { status: 'hidden' })).body.status).toBe('hidden');
    const reply = await t.owner.post(`/v1/reviews/${r1.reviewId}/reply`, { body: 'ご来店ありがとうございました！' });
    expect(reply.status).toBe(200);
    expect(reply.body.reply_body).toBe('ご来店ありがとうございました！');
    expect(reply.body.replied_by).toBe(t.ownerStaffId);

    const summary = await t.owner.get('/v1/reviews/summary', { shopId: t.shopId });
    expect(summary.body).toMatchObject({ count: 1, average: 5, distribution: { '5': 1, '2': 0 }, hiddenCount: 1, pendingCount: 0, staffRatingAverage: 4 });
    const staffSummary = await stylist.api.get('/v1/reviews/summary');
    expect(staffSummary.body.count).toBe(1);

    const pub = await api().get(`/v1/public/shops/${slug}/reviews`);
    expect(pub.status).toBe(200);
    expect(pub.body.items).toHaveLength(1);
    expect(pub.body.items[0]).toMatchObject({ id: r1.reviewId, nickname: 'はなこ', rating: 5, reply_body: 'ご来店ありがとうございました！', staff_name: '口コミ担当' });
    expect(pub.body.summary.count).toBe(1);
    const json = JSON.stringify(pub.body);
    for (const pii of ['山田', 'hanako@example.com', '090', customer.id, 'customer_id']) expect(json).not.toContain(pii);
    expect(json).not.toContain('待ち時間');

    // stylist public profile: whitelisted profile fields, rating summary, published reviews only
    await asSystem(t.organizationId, (ctx) =>
      ctx.trx
        .updateTable('staffs')
        .set({ public_profile: JSON.stringify({ bio: 'ショートが得意です', specialties: ['ショート', 'カラー'], internalNote: '時給2000円' }) })
        .where('id', '=', stylist.staffId)
        .execute(),
    );
    const profile = await api().get(`/v1/public/shops/${slug}/staff/${stylist.staffId}/profile`);
    expect(profile.status).toBe(200);
    expect(profile.body.profile.bio).toBe('ショートが得意です');
    expect(profile.body.profile.internalNote).toBeUndefined();
    expect(profile.body.rating).toMatchObject({ count: 1, average: 5 });
    expect(profile.body.recentReviews.map((r: { id: string }) => r.id)).toEqual([r1.reviewId]);
    expect(JSON.stringify(profile.body)).not.toContain('時給');
    expect((await api().get(`/v1/public/shops/${slug}/staff/${randomUUID()}/profile`)).status).toBe(404);
  });

  it('isolates tenants', async () => {
    const { t, stylist, menu, customer } = await setup();
    const a1 = await appointment(t, stylist.staffId, menu.id, customer.id);
    const r = await issueAndSubmit(t, customer.id, a1.id, { rating: 4 });
    const other = await createTenant('他社サロン');
    expect((await other.owner.patch(`/v1/reviews/${r.reviewId}`, { status: 'published' })).status).toBe(404);
    expect((await other.owner.get('/v1/reviews')).body.items).toHaveLength(0);
    expect((await other.owner.post('/v1/review-requests', { customerId: customer.id })).status).toBe(404);
  });
});

describe('Google Business Profile', () => {
  it('imports reviews (upsert by external id), pushes replies and records failures', async () => {
    const { t } = await setup();
    const accountId = `acc-${randomUUID().slice(0, 8)}`;
    const integrationAccountId = await asSystem(t.organizationId, async (ctx) => {
      const row = await ctx.trx
        .insertInto('integration_accounts')
        .values({
          organization_id: t.organizationId,
          shop_id: t.shopId,
          provider: 'google_business',
          display_name: 'Googleビジネスプロフィール',
          config: JSON.stringify({ accountId, locationId: 'loc-1', driver: 'mock' }),
          encrypted_credentials: encryptJson({ accessToken: 'ya29.mock', expiresAt: Date.now() + 3600_000 }),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    });
    setMockGbpReviews(accountId, 'loc-1', [
      { reviewId: 'g1', starRating: 'FIVE', comment: '素敵なサロン', createTime: '2026-09-01T01:00:00Z', reviewer: { displayName: 'Google太郎' } },
      { reviewId: 'g2', starRating: 'THREE', comment: '普通', createTime: '2026-09-02T01:00:00Z', reviewer: { isAnonymous: true } },
      { reviewId: 'g3', starRating: 'FOUR', createTime: '2026-09-03T01:00:00Z', reviewReply: { comment: 'Googleで返信済み', updateTime: '2026-09-04T00:00:00Z' } },
    ]);

    const queued = await t.owner.post('/v1/reviews/google/import', {});
    expect(queued.status).toBe(202);
    expect(queued.body.queued).toBe(1);
    await runJobs();
    type Row = { id: string; external_review_id: string; [k: string]: unknown };
    let list = (await t.owner.get('/v1/reviews', { source: 'google' })).body.items as Row[];
    const byExt = (ext: string) => list.find((r) => r.external_review_id === ext)!;
    expect(list).toHaveLength(3);
    const g1 = byExt('g1');
    expect(g1).toMatchObject({ rating: 5, body: '素敵なサロン', reviewer_name: 'Google太郎', status: 'published', shop_id: t.shopId });
    expect(byExt('g2').reviewer_name).toBeNull();
    expect(byExt('g3').reply_body).toBe('Googleで返信済み');

    // hide one locally, change one on Google, add a new one → upsert keeps local moderation
    await t.owner.patch(`/v1/reviews/${byExt('g2').id}`, { status: 'hidden' });
    setMockGbpReviews(accountId, 'loc-1', [
      { reviewId: 'g1', starRating: 'FOUR', comment: '素敵なサロン（追記）', createTime: '2026-09-01T01:00:00Z', reviewer: { displayName: 'Google太郎' } },
      { reviewId: 'g2', starRating: 'THREE', comment: '普通', createTime: '2026-09-02T01:00:00Z' },
      { reviewId: 'g3', starRating: 'FOUR', createTime: '2026-09-03T01:00:00Z' },
      { reviewId: 'g4', starRating: 'ONE', comment: '予約が取りにくい', createTime: '2026-09-05T01:00:00Z' },
    ]);
    await t.owner.post('/v1/reviews/google/import', {});
    await runJobs();
    list = (await t.owner.get('/v1/reviews', { source: 'google' })).body.items;
    expect(list).toHaveLength(4);
    expect(byExt('g1')).toMatchObject({ rating: 4, body: '素敵なサロン（追記）' });
    expect(byExt('g2').status).toBe('hidden');
    expect(byExt('g3').reply_body).toBe('Googleで返信済み');

    const syncJobs = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('sync_jobs').selectAll().where('integration_account_id', '=', integrationAccountId).orderBy('created_at').execute());
    expect(syncJobs.map((s) => s.state)).toEqual(['succeeded', 'succeeded']);
    expect(syncJobs[1]!.stats).toMatchObject({ fetched: 4, created: 1, updated: 3 });

    // reply → pushed to GBP
    const g4 = byExt('g4');
    await t.owner.post(`/v1/reviews/${g4.id}/reply`, { body: 'ご不便をおかけし申し訳ございません。' });
    await runJobs();
    expect(mockGbpReplies.find((r) => r.reviewName === `accounts/${accountId}/locations/loc-1/reviews/g4`)?.comment).toBe('ご不便をおかけし申し訳ございません。');
    const synced = (await t.owner.get('/v1/reviews', { source: 'google', rating: 1 })).body.items[0];
    expect(synced.reply_synced_at).toBeTruthy();
    expect(synced.reply_sync_error).toBeNull();

    // provider failure → recorded on the account, job retried later
    failMockGbp(accountId, 'loc-1', 1);
    await t.owner.post('/v1/reviews/google/import', {});
    await runJobs();
    const acc = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('integration_accounts').selectAll().where('id', '=', integrationAccountId).executeTakeFirstOrThrow());
    expect(acc.consecutive_failures).toBe(1);
    expect(acc.last_error).toContain('mock GBP failure');
    const failedJob = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('jobs').selectAll().where('type', '=', 'reviews.gbp_import').where('state', '=', 'queued').executeTakeFirst());
    expect(failedJob?.attempts).toBe(1);

    // stylists cannot trigger imports
    const stylist = await createStaffUser(t, 'stylist');
    expect((await stylist.api.post('/v1/reviews/google/import', {})).status).toBe(403);
  });
});
