import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../config.js';
import {
  asSystem,
  createCustomer,
  createStaffUser,
  createTenant,
  insertAppointment,
  insertTransaction,
  jst,
  jstDate,
  runJobs,
  type Tenant,
} from '../../test/helpers.js';
import { scrubPii } from './assistant.js';
import { AnthropicError, createAnthropicProvider } from './providers/anthropic.js';
import type { AiTask } from './providers/types.js';
import { computeScore } from './scoring.js';

const DAY = 86_400_000;

async function setStats(t: Tenant, customerId: string, stats: Record<string, unknown>) {
  await asSystem(t.organizationId, (ctx) => ctx.trx.updateTable('customers').set(stats).where('id', '=', customerId).execute());
}

async function countMessages(t: Tenant) {
  return asSystem(t.organizationId, async (ctx) => ({
    messages: (await ctx.trx.selectFrom('messages').select('id').execute()).length,
    deliverJobs: (await ctx.trx.selectFrom('jobs').select('id').where('type', '=', 'message.deliver').execute()).length,
    campaigns: (await ctx.trx.selectFrom('campaigns').select('id').execute()).length,
  }));
}

describe('churn scoring (heuristic-v1)', () => {
  const now = new Date('2026-01-01T03:00:00Z'); // 12:00 JST
  const base = { visitCount: 4, avgCycleDays: 30, totalSales: 40000, noShowCount: 0, nextAppointmentAt: null };
  const ctx = { now, tz: 'Asia/Tokyo', orgMedianCycleDays: 40 };

  it('scores overdue / future-appointment / fresh / first-visit customers', () => {
    const overdue = computeScore({ ...base, lastVisitAt: new Date(now.getTime() - 75 * DAY) }, ctx);
    // r = 75/30 = 2.5 → 1/(1+e^-3) = 0.95257
    expect(overdue).toMatchObject({ churnRisk: 0.9526, level: 'high', predictedNextVisit: '2025-11-17', recommendedAction: '来店周期を45日超過: フォローメッセージ推奨' });
    // avg ticket 10000 × 365/30 × (1 − 0.9526) = 5767
    expect(overdue.expectedLtv12m).toBe(5767);
    expect(overdue.features).toMatchObject({ days_since_last_visit: 75, expected_cycle_days: 30, cycle_source: 'customer', cycle_ratio: 2.5, overdue_days: 45, has_future_appointment: false });

    const booked = computeScore({ ...base, lastVisitAt: new Date(now.getTime() - 75 * DAY), nextAppointmentAt: new Date(now.getTime() + 3 * DAY) }, ctx);
    // dampened ×0.2 → 0.19051
    expect(booked).toMatchObject({ churnRisk: 0.1905, level: 'low', predictedNextVisit: '2026-01-04', recommendedAction: '次回予約あり(2026-01-04): 予約前リマインドのみで可' });

    const fresh = computeScore({ ...base, visitCount: 3, totalSales: 30000, lastVisitAt: new Date(now.getTime() - 10 * DAY) }, ctx);
    // r = 1/3 → 1/(1+e^3.5) = 0.02931
    expect(fresh).toMatchObject({ churnRisk: 0.0293, level: 'low', predictedNextVisit: '2026-01-21', recommendedAction: '来店周期内(周期30日・前回から10日): 対応不要' });
    // 10000 × 365/30 × 0.9707 = 118102
    expect(fresh.expectedLtv12m).toBe(118102);

    const first = computeScore({ ...base, visitCount: 1, avgCycleDays: null, totalSales: 8000, lastVisitAt: new Date(now.getTime() - 70 * DAY) }, ctx);
    // org median 40 days: r = 1.75 → 1/(1+e^-0.75) = 0.67918
    expect(first).toMatchObject({ churnRisk: 0.6792, level: 'medium', recommendedAction: '初回来店から70日経過・再来なし: 2回目来店のフォローメッセージ推奨' });
    expect(first.features.cycle_source).toBe('org_median');

    const noShows = computeScore({ ...base, visitCount: 3, noShowCount: 3, lastVisitAt: new Date(now.getTime() - 10 * DAY) }, ctx);
    expect(noShows.churnRisk).toBe(0.1793); // 0.0293 + 0.05 × 3
    expect(noShows.recommendedAction).toContain('無断キャンセル歴3回');

    const noMedian = computeScore({ ...base, visitCount: 1, avgCycleDays: null, lastVisitAt: new Date(now.getTime() - 60 * DAY) }, { ...ctx, orgMedianCycleDays: null });
    expect(noMedian.features).toMatchObject({ cycle_source: 'default', expected_cycle_days: 60 });
    expect(noMedian.churnRisk).toBe(0.1824); // r = 1 → 1/(1+e^1.5)
  });

  it('recomputes customer_scores via job and lists at-risk customers with visibility rules', async () => {
    const t = await createTenant();
    const now = Date.now();
    const overdue = await createCustomer(t, { lastName: '遅延', firstName: '一' });
    const fresh = await createCustomer(t, { lastName: '最近', firstName: '二' });
    const booked = await createCustomer(t, { lastName: '予約', firstName: '三' });
    const single = await createCustomer(t, { lastName: '初回', firstName: '四' });
    const never = await createCustomer(t, { lastName: '未来店', firstName: '五' });
    await setStats(t, overdue.id, { visit_count: 4, avg_cycle_days: 30, total_sales: 40000, last_visit_at: new Date(now - 75 * DAY - 3600_000) });
    await setStats(t, fresh.id, { visit_count: 3, avg_cycle_days: 30, total_sales: 30000, last_visit_at: new Date(now - 10 * DAY - 3600_000) });
    await setStats(t, booked.id, { visit_count: 4, avg_cycle_days: 30, total_sales: 40000, last_visit_at: new Date(now - 75 * DAY - 3600_000) });
    await setStats(t, single.id, { visit_count: 1, total_sales: 8000, last_visit_at: new Date(now - 50 * DAY - 3600_000) });
    await insertAppointment(t.organizationId, { shopId: t.shopId, customerId: booked.id, startAt: new Date(now + 5 * DAY), status: 'confirmed' });

    const stylist = await createStaffUser(t, 'stylist');
    expect((await stylist.api.post('/v1/ai/scores/recompute')).status).toBe(403); // ops.manage
    const res = await t.owner.post('/v1/ai/scores/recompute');
    expect(res.status).toBe(202);
    expect(res.body.queued).toBe(true);
    await runJobs();

    const scores = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('customer_scores').selectAll().execute());
    const by = new Map(scores.map((s) => [s.customer_id, s]));
    expect(by.has(never.id)).toBe(false);
    expect(by.get(overdue.id)).toMatchObject({ churn_risk: 0.9526, churn_risk_level: 'high', model_version: 'heuristic-v1', recommended_action: '来店周期を45日超過: フォローメッセージ推奨' });
    expect(by.get(fresh.id)).toMatchObject({ churn_risk: 0.0293, churn_risk_level: 'low' });
    expect(by.get(booked.id)).toMatchObject({ churn_risk: 0.1905, churn_risk_level: 'low', predicted_next_visit: jstDate(5) });
    // org median cycle = 30 (three customers with ≥ 2 visits): r = 50/30 → 0.62246
    expect(by.get(single.id)).toMatchObject({ churn_risk: 0.6225, churn_risk_level: 'medium' });
    expect((by.get(single.id)!.features as { cycle_source: string }).cycle_source).toBe('org_median');

    const list = await t.owner.get('/v1/ai/at-risk-customers');
    expect(list.status).toBe(200);
    expect(list.body.items.map((i: { customerId: string }) => i.customerId)).toEqual([overdue.id, single.id]);
    expect(list.body.items[0]).toMatchObject({ customerName: '遅延 一', level: 'high', churnRisk: 0.9526 });
    const high = await t.owner.get('/v1/ai/at-risk-customers', { level: 'high', shopId: t.shopId });
    expect(high.body.items.map((i: { customerId: string }) => i.customerId)).toEqual([overdue.id]);
    const paged = await t.owner.get('/v1/ai/at-risk-customers', { limit: 1 });
    const page2 = await t.owner.get('/v1/ai/at-risk-customers', { limit: 1, cursor: paged.body.nextCursor });
    expect(page2.body.items.map((i: { customerId: string }) => i.customerId)).toEqual([single.id]);

    // a stylist of another shop cannot see these customers
    const shop2 = (await t.owner.post('/v1/shops', { name: '2号店', slug: `ai2-${Date.now()}` })).body;
    const other = await createStaffUser(t, 'stylist', { shopIds: [shop2.id] });
    expect((await other.api.get('/v1/ai/at-risk-customers')).body.items).toEqual([]);
    expect((await stylist.api.get('/v1/ai/at-risk-customers')).body.items).toHaveLength(2);
  });
});

describe('sales forecast', () => {
  it('uses the weekday moving average of the last 8 weeks with booked appointments as the floor', async () => {
    const t = await createTenant();
    const tomorrow = jstDate(1);
    const sales = [10000, 12000, 8000, 10000, 14000, 6000, 10000, 10000];
    await asSystem(t.organizationId, (ctx) =>
      ctx.trx
        .insertInto('analytics_daily_shop')
        .values(sales.map((s, i) => ({ organization_id: t.organizationId, shop_id: t.shopId, date: jstDate(1 - 7 * (i + 1)), sales_total: s })))
        .execute(),
    );
    await insertAppointment(t.organizationId, { shopId: t.shopId, startAt: jst(tomorrow, '12:00'), status: 'confirmed', estimatedTotal: 15000 });
    await insertAppointment(t.organizationId, { shopId: t.shopId, startAt: jst(tomorrow, '15:00'), status: 'cancelled', estimatedTotal: 9999 });

    const res = await t.owner.get('/v1/ai/forecast', { shopId: t.shopId, days: 8 });
    expect(res.status).toBe(200);
    expect(res.body.method).toContain('曜日別移動平均');
    expect(res.body.days).toHaveLength(8);
    // mean 10000, population σ = sqrt(40,000,000 / 8) = 2236
    expect(res.body.days[0]).toMatchObject({ date: tomorrow, baseline: 10000, sigma: 2236, bookedAmount: 15000, bookedAppointments: 1, forecast: 15000, lower: 15000, upper: 17236, sampleDays: 8 });
    expect(res.body.days[7]).toMatchObject({ date: jstDate(8), baseline: 10000, sigma: 2236, bookedAmount: 0, forecast: 10000, lower: 7764, upper: 12236 });
    expect(res.body.days[1]).toMatchObject({ baseline: 0, forecast: 0, lower: 0, upper: 0 });
    expect(res.body.total).toEqual({ forecast: 25000, lower: 22764, upper: 29472, booked: 15000 });
    expect(res.body.history.daysWithData).toBe(8);

    const stylist = await createStaffUser(t, 'stylist');
    expect((await stylist.api.get('/v1/ai/forecast', { shopId: t.shopId })).status).toBe(403);
  });
});

describe('generative assistant (heuristic provider)', () => {
  it('drafts messages as proposed suggestions with minimal PII and never sends anything', async () => {
    const t = await createTenant();
    const stylist = await createStaffUser(t, 'stylist', { displayName: '担当 美香' });
    const c = await createCustomer(t, { lastName: '山田', firstName: '花子', phone: '090-1111-2222', email: 'hanako@example.com', address: '東京都港区1-2-3' });
    await insertTransaction(t.organizationId, { shopId: t.shopId, customerId: c.id, completedAt: new Date(Date.now() - 50 * DAY), items: [{ itemType: 'service', name: 'カット', unitPrice: 5500 }] });
    await setStats(t, c.id, { visit_count: 3, last_visit_at: new Date(Date.now() - 50 * DAY - 3600_000) });

    const res = await stylist.api.post('/v1/ai/message-draft', { customerId: c.id, purpose: 'dormant' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ kind: 'message_draft', subjectType: 'customer', subjectId: c.id, status: 'proposed', provider: 'heuristic', model: null });
    const text: string = res.body.text;
    expect(text.startsWith('花子様')).toBe(true);
    expect(text).toContain('前回のご来店から50日');
    expect(text).toContain('前回のカット');
    expect(text).toContain('担当 美香');
    for (const pii of ['山田', '090-1111-2222', '09011112222', 'hanako', '港区']) {
      expect(text).not.toContain(pii);
      expect(JSON.stringify(res.body.input)).not.toContain(pii);
    }

    const accepted = await stylist.api.post(`/v1/ai/suggestions/${res.body.id}/accept`, { editedText: '花子様 お久しぶりです。' });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ text: '花子様 お久しぶりです。', delivery: 'manual' });
    expect(accepted.body.suggestion).toMatchObject({ status: 'accepted', decidedBy: stylist.staffId });
    const again = await stylist.api.post(`/v1/ai/suggestions/${res.body.id}/accept`);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('SUGGESTION_ALREADY_DECIDED');

    const bday = await stylist.api.post('/v1/ai/message-draft', { customerId: c.id, purpose: 'birthday', tone: 'casual' });
    expect(bday.body.text).toContain('お誕生日おめでとうございます');
    expect(bday.body.text).toContain('また気軽に遊びに来てくださいね！');
    const rejected = await stylist.api.post(`/v1/ai/suggestions/${bday.body.id}/reject`, { reason: '時期が早い' });
    expect(rejected.body.suggestion.status).toBe('rejected');
    expect(rejected.body.text).toBeNull();

    const list = await stylist.api.get('/v1/ai/suggestions', { subjectType: 'customer', subjectId: c.id });
    expect(list.body.items.map((s: { status: string }) => s.status)).toEqual(['rejected', 'accepted']);

    expect(await countMessages(t)).toEqual({ messages: 0, deliverJobs: 0, campaigns: 0 });
    const audits = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('audit_logs').select('action').where('resource_type', '=', 'ai_suggestion').orderBy('created_at').execute());
    expect(audits.map((a) => a.action).sort()).toEqual(['ai.suggestion.accept', 'ai.suggestion.create', 'ai.suggestion.create', 'ai.suggestion.reject']);
  });

  it('drafts review replies and karte summaries with PII scrubbed', async () => {
    const t = await createTenant();
    const c = await createCustomer(t, { lastName: '佐藤', firstName: '美咲' });
    const review = await asSystem(t.organizationId, (ctx) =>
      ctx.trx
        .insertInto('reviews')
        .values({ organization_id: t.organizationId, shop_id: t.shopId, customer_id: c.id, rating: 2, body: '待ち時間が長かったです。連絡は misaki@example.com まで', reviewer_name: '佐藤' })
        .returning('id')
        .executeTakeFirstOrThrow(),
    );
    const reply = await t.owner.post('/v1/ai/review-reply-draft', { reviewId: review.id });
    expect(reply.status).toBe(201);
    expect(reply.body).toMatchObject({ kind: 'review_reply', subjectType: 'review', subjectId: review.id, status: 'proposed' });
    expect(reply.body.text).toContain('大変申し訳ございません');
    expect(reply.body.input.body).toBe('待ち時間が長かったです。連絡は [メール] まで');
    const stylist = await createStaffUser(t, 'stylist');
    expect((await stylist.api.post('/v1/ai/review-reply-draft', { reviewId: review.id })).status).toBe(403); // review.manage

    await asSystem(t.organizationId, (ctx) =>
      ctx.trx
        .insertInto('kartes')
        .values({
          organization_id: t.organizationId,
          shop_id: t.shopId,
          customer_id: c.id,
          staff_id: t.ownerStaffId,
          visit_date: '2026-01-10',
          note: '頭皮が敏感。緊急連絡先 090-1234-5678',
          chemicals: JSON.stringify([{ brand: 'X', name: 'アルカリカラー', ratio: '6%' }]),
          homecare: JSON.stringify({ advice: 'シャンプーは低刺激のものを推奨' }),
        })
        .execute(),
    );
    const summary = await stylist.api.post('/v1/ai/karte-summary', { customerId: c.id });
    expect(summary.status).toBe(201);
    expect(summary.body.kind).toBe('karte_summary');
    expect(summary.body.text).toContain('【美咲様 カルテ要約】');
    expect(summary.body.text).toContain('頭皮が敏感。緊急連絡先 [電話番号]');
    expect(summary.body.text).toContain('薬剤: X アルカリカラー 6%');
    expect(summary.body.text).toContain('シャンプーは低刺激のものを推奨');
    expect(summary.body.text).not.toContain('1234-5678');
  });

  it('scrubs e-mail addresses, phone numbers and postal codes', () => {
    expect(scrubPii('TEL 03-1234-5678 / 09012345678 / +81 90-1234-5678 / a.b@c.jp / 〒105-0011 / 2025-06-12 カラー6%')).toBe(
      'TEL [電話番号] / [電話番号] / [電話番号] / [メール] / [郵便番号] / 2025-06-12 カラー6%',
    );
  });
});

describe('Anthropic provider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    (config as { ANTHROPIC_API_KEY?: string }).ANTHROPIC_API_KEY = undefined;
  });

  const task: AiTask = {
    kind: 'message_draft',
    input: { purpose: 'followup', tone: 'polite', customer: { firstName: '花子', visitCount: 2, daysSinceLastVisit: 3, lastVisitDate: '2026-01-01', recentMenus: ['カット'] }, shopName: '本店', staffName: '美香' },
  };

  function okResponse(text: string, model = 'claude-sonnet-5-5') {
    return new Response(JSON.stringify({ id: 'msg_1', model, stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text }], usage: { input_tokens: 10, output_tokens: 5 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  it('sends a Messages API request with the documented headers and body shape', async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => okResponse('花子様\nご来店ありがとうございました。'));
    const provider = createAnthropicProvider({ apiKey: 'sk-test', model: 'claude-sonnet-5-5', fetchImpl: fetchMock as unknown as typeof fetch });
    const result = await provider.generate(task);
    expect(result).toMatchObject({ text: '花子様\nご来店ありがとうございました。', provider: 'anthropic', model: 'claude-sonnet-5-5' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'content-type': 'application/json', 'x-api-key': 'sk-test', 'anthropic-version': '2023-06-01', 'anthropic-beta': 'server-side-fallback-2026-07-01' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ model: 'claude-sonnet-5-5', max_tokens: 8000, output_config: { effort: 'low' }, fallbacks: 'default' });
    expect(body.system).toContain('自動送信されることはありません');
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe('user');
    expect(body.messages[0].content).toContain('「花子様」');
    expect(body).not.toHaveProperty('temperature');

    // models without effort / server-side fallback support get a plain request
    const plainFetch = vi.fn(async (..._args: unknown[]) => okResponse('ok', 'claude-haiku-4-5'));
    await createAnthropicProvider({ apiKey: 'k', model: 'claude-haiku-4-5', fetchImpl: plainFetch as unknown as typeof fetch }).generate(task);
    const [, plainInit] = plainFetch.mock.calls[0] as [string, RequestInit];
    expect(plainInit.headers).not.toHaveProperty('anthropic-beta');
    const plainBody = JSON.parse(plainInit.body as string);
    expect(plainBody).not.toHaveProperty('fallbacks');
    expect(plainBody).not.toHaveProperty('output_config');
  });

  it('raises on refusals and HTTP errors', async () => {
    const refusal = vi.fn(async () => new Response(JSON.stringify({ stop_reason: 'refusal', content: [], stop_details: { type: 'refusal', category: null } }), { status: 200 }));
    await expect(createAnthropicProvider({ apiKey: 'k', model: 'claude-sonnet-5-5', fetchImpl: refusal as unknown as typeof fetch }).generate(task)).rejects.toMatchObject({ type: 'refusal' });
    const overloaded = vi.fn(async () => new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }), { status: 529 }));
    const err = await createAnthropicProvider({ apiKey: 'k', model: 'claude-sonnet-5-5', fetchImpl: overloaded as unknown as typeof fetch })
      .generate(task)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnthropicError);
    expect(err).toMatchObject({ status: 529, type: 'overloaded_error', message: 'Overloaded' });
  });

  it('is used by the endpoints when ANTHROPIC_API_KEY is set, sends no PII, and falls back to templates on failure', async () => {
    const t = await createTenant();
    const c = await createCustomer(t, { lastName: '山田', firstName: '花子', phone: '090-1111-2222', email: 'hanako@example.com', address: '東京都港区1-2-3', birthday: '1990-04-01' });
    (config as { ANTHROPIC_API_KEY?: string }).ANTHROPIC_API_KEY = 'sk-live-test';
    const fetchMock = vi.fn(async (..._args: unknown[]) => okResponse('花子様\nLLMの下書きです。', config.ANTHROPIC_MODEL));
    vi.stubGlobal('fetch', fetchMock);

    const res = await t.owner.post('/v1/ai/message-draft', { customerId: c.id, purpose: 'followup' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ provider: 'anthropic', model: config.ANTHROPIC_MODEL, text: '花子様\nLLMの下書きです。', status: 'proposed' });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sent = init.body as string;
    expect(JSON.parse(sent).model).toBe(config.ANTHROPIC_MODEL);
    expect(sent).toContain('花子');
    for (const pii of ['山田', '090-1111-2222', 'hanako@example.com', '港区', '1990-04-01']) expect(sent).not.toContain(pii);
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('sk-live-test');

    fetchMock.mockImplementation(async () => {
      throw new TypeError('fetch failed');
    });
    const fallback = await t.owner.post('/v1/ai/message-draft', { customerId: c.id, purpose: 'followup' });
    expect(fallback.status).toBe(201);
    expect(fallback.body.provider).toBe('heuristic');
    expect(fallback.body.output.fallbackReason).toContain('anthropic');
    expect(fallback.body.text.startsWith('花子様')).toBe(true);
    expect(await countMessages(t)).toEqual({ messages: 0, deliverJobs: 0, campaigns: 0 });
  });
});

describe('next best actions, feature switch and tenant isolation', () => {
  it('suggests churn follow-ups, second-visit follow-ups and birthday messages', async () => {
    const t = await createTenant();
    const now = Date.now();
    const month = jstDate(0).slice(5, 7);
    const risky = await createCustomer(t, { lastName: '休眠', firstName: '一' });
    const second = await createCustomer(t, { lastName: '初回', firstName: '二' });
    const secondBooked = await createCustomer(t, { lastName: '初回予約済', firstName: '三' });
    const bday = await createCustomer(t, { lastName: '誕生', firstName: '四', birthday: `1990-${month}-15` });
    await setStats(t, risky.id, { visit_count: 5, avg_cycle_days: 30, total_sales: 50000, last_visit_at: new Date(now - 90 * DAY) });
    for (const id of [second.id, secondBooked.id]) await setStats(t, id, { visit_count: 1, total_sales: 6000, first_visit_at: new Date(now - 30 * DAY), last_visit_at: new Date(now - 30 * DAY) });
    await insertAppointment(t.organizationId, { shopId: t.shopId, customerId: secondBooked.id, startAt: new Date(now + 2 * DAY) });
    await t.owner.post('/v1/ai/scores/recompute');
    await runJobs();

    const res = await t.owner.get('/v1/ai/next-actions', { shopId: t.shopId });
    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({ churnRisk: 1, secondVisit: 1, birthday: 1 });
    expect(res.body.items.map((i: { type: string; customerId: string; suggestedPurpose: string }) => [i.type, i.customerId, i.suggestedPurpose])).toEqual([
      ['churn_risk', risky.id, 'dormant'],
      ['second_visit', second.id, 'followup'],
      ['birthday', bday.id, 'birthday'],
    ]);
    expect(res.body.items[0].reason).toBe('来店周期を60日超過: フォローメッセージ推奨');
    expect(res.body.items[1].reason).toBe('初回来店から30日・次回予約なし: 2回目来店のフォロー推奨');
    expect(res.body.items[2].reason).toBe(`今月お誕生日(${Number(month)}月15日): お祝いメッセージ推奨`);
    expect(await countMessages(t)).toEqual({ messages: 0, deliverJobs: 0, campaigns: 0 });
  });

  it('honours organizations.settings.ai_assist = false', async () => {
    const t = await createTenant();
    const c = await createCustomer(t);
    await t.owner.patch('/v1/organization', { settings: { ai_assist: false } });
    const res = await t.owner.post('/v1/ai/message-draft', { customerId: c.id, purpose: 'followup' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('AI_DISABLED');
    expect((await t.owner.get('/v1/ai/next-actions')).status).toBe(403);
    expect((await t.owner.get('/v1/ai/forecast', { shopId: t.shopId })).status).toBe(403);
    await t.owner.patch('/v1/organization', { settings: { ai_assist: true } });
    expect((await t.owner.post('/v1/ai/message-draft', { customerId: c.id, purpose: 'followup' })).status).toBe(201);
  });

  it('isolates tenants', async () => {
    const a = await createTenant();
    const b = await createTenant();
    const c = await createCustomer(a);
    await setStats(a, c.id, { visit_count: 1, last_visit_at: new Date(Date.now() - 200 * DAY) });
    const draft = await a.owner.post('/v1/ai/message-draft', { customerId: c.id, purpose: 'dormant' });
    await a.owner.post('/v1/ai/scores/recompute');
    await runJobs();
    expect((await b.owner.post(`/v1/ai/suggestions/${draft.body.id}/accept`)).status).toBe(404);
    expect((await b.owner.post('/v1/ai/message-draft', { customerId: c.id, purpose: 'dormant' })).status).toBe(404);
    expect((await b.owner.get('/v1/ai/suggestions', { subjectType: 'customer', subjectId: c.id })).status).toBe(404);
    expect((await b.owner.get('/v1/ai/at-risk-customers')).body.items).toEqual([]);
    expect((await b.owner.get('/v1/ai/forecast', { shopId: a.shopId })).status).toBe(404);
    expect((await a.owner.get('/v1/ai/at-risk-customers')).body.items.map((i: { customerId: string }) => i.customerId)).toEqual([c.id]);
  });
});
