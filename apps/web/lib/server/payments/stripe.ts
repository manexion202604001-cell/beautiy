// Stripe adapter (REST via fetch, no SDK). Credentials come from the organization's
// Integration(STRIPE) config (secretKey / webhookSecret) or STRIPE_* env vars. Without a
// secret key the adapter runs in "sandbox" mode and simulates successful provider calls,
// so the product is fully usable in demos; real money only moves when a key is present.
import { randomToken } from '@salonos/core/crypto';
import { getIntegration } from '../integrations';
import { env } from '../env';
import { AppError } from '../errors';

const API = 'https://api.stripe.com/v1';

export interface StripeConfig { secretKey: string; webhookSecret: string; live: boolean; integrationId: string | null }

export async function stripeConfig(orgId: string, shopId?: string | null): Promise<StripeConfig> {
  const it = await getIntegration(orgId, 'STRIPE', shopId).catch(() => null);
  // A PAUSED integration means "no Stripe for this salon": never fall back to the platform's
  // env key (that would charge/refund on a different account). Sandbox mode instead.
  if (it && it.integration.status === 'PAUSED') return { secretKey: '', webhookSecret: '', live: false, integrationId: it.integration.id };
  const secretKey: string = it?.config.secretKey || env.stripe.secretKey || '';
  const webhookSecret: string = it?.config.webhookSecret || env.stripe.webhookSecret || '';
  return { secretKey, webhookSecret, live: !!secretKey, integrationId: it?.integration.id ?? null };
}

/** Flatten nested params into Stripe's form encoding (a[b][c]=v, arrays as a[0][b]). */
export function formEncode(params: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => {
      if (item && typeof item === 'object') out.push(...formEncode(item as Record<string, unknown>, `${key}[${i}]`));
      else out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(item))}`);
    });
    else if (typeof v === 'object') out.push(...formEncode(v as Record<string, unknown>, key));
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out;
}

async function stripeRequest<T = any>(secretKey: string, method: 'GET' | 'POST', path: string, params: Record<string, unknown> = {}, idempotencyKey?: string): Promise<T> {
  const body = formEncode(params).join('&');
  const url = method === 'GET' && body ? `${API}${path}?${body}` : `${API}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Stripe-Version': '2024-06-20',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: method === 'POST' ? body : undefined,
      signal: AbortSignal.timeout(15000),
    });
  } catch (e: any) {
    throw new AppError(`Stripeに接続できませんでした（${e?.message ?? 'network error'}）。時間をおいて再試行してください。`, 'PROVIDER_ERROR', 502);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new AppError(`Stripeエラー: ${json?.error?.message ?? res.status}`, 'PROVIDER_ERROR', 502);
  return json as T;
}

const sandboxId = (prefix: string) => `sandbox_${prefix}_${randomToken(12)}`;

export interface IntentResult { id: string; clientSecret: string | null; status: string; sandbox: boolean }

/** Create a PaymentIntent (JPY; zero-decimal currency). */
export async function createPaymentIntent(orgId: string, input: { amount: number; metadata: Record<string, string>; description?: string; shopId?: string | null; idempotencyKey?: string }): Promise<IntentResult> {
  const cfg = await stripeConfig(orgId, input.shopId);
  if (!cfg.live) return { id: sandboxId('pi'), clientSecret: null, status: 'succeeded', sandbox: true };
  const pi = await stripeRequest(cfg.secretKey, 'POST', '/payment_intents', {
    // org_id lets manual POS references and webhooks verify which salon the payment belongs to.
    amount: input.amount, currency: 'jpy', description: input.description, metadata: { ...input.metadata, org_id: orgId },
    automatic_payment_methods: { enabled: true },
  }, input.idempotencyKey);
  return { id: pi.id, clientSecret: pi.client_secret ?? null, status: pi.status, sandbox: false };
}

export async function retrievePaymentIntent(orgId: string, id: string, shopId?: string | null): Promise<{ id: string; status: string; amount: number; currency: string; metadata: Record<string, string>; sandbox: boolean }> {
  const cfg = await stripeConfig(orgId, shopId);
  if (!cfg.live || id.startsWith('sandbox_')) return { id, status: 'succeeded', amount: -1, currency: 'jpy', metadata: {}, sandbox: true };
  const pi = await stripeRequest(cfg.secretKey, 'GET', `/payment_intents/${encodeURIComponent(id)}`);
  return { id: pi.id, status: pi.status, amount: pi.amount_received ?? pi.amount, currency: pi.currency, metadata: pi.metadata ?? {}, sandbox: false };
}

export interface CheckoutLine { name: string; amount: number; quantity: number }
export interface CheckoutResult { id: string; url: string | null; sandbox: boolean }

/**
 * Hosted Checkout Session. `metadata` is copied onto the PaymentIntent too, so both
 * checkout.session.completed and payment_intent.succeeded carry our reference id.
 */
export async function createCheckoutSession(orgId: string, input: {
  lines: CheckoutLine[]; metadata: Record<string, string>; successUrl: string; cancelUrl: string;
  customerEmail?: string | null; shopId?: string | null; idempotencyKey?: string;
}): Promise<CheckoutResult> {
  const cfg = await stripeConfig(orgId, input.shopId);
  if (!cfg.live) return { id: sandboxId('cs'), url: null, sandbox: true };
  const metadata = { ...input.metadata, org_id: orgId };
  const s = await stripeRequest(cfg.secretKey, 'POST', '/checkout/sessions', {
    mode: 'payment',
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    customer_email: input.customerEmail || undefined,
    metadata,
    payment_intent_data: { metadata },
    line_items: input.lines.map((l) => ({ quantity: l.quantity, price_data: { currency: 'jpy', unit_amount: l.amount, product_data: { name: l.name.slice(0, 250) } } })),
  }, input.idempotencyKey);
  return { id: s.id, url: s.url ?? null, sandbox: false };
}

/** Expire an open Checkout Session so it can no longer be paid (no-op in sandbox). */
export async function expireCheckoutSession(orgId: string, sessionId: string, shopId?: string | null): Promise<{ sandbox: boolean }> {
  const cfg = await stripeConfig(orgId, shopId);
  if (!cfg.live || sessionId.startsWith('sandbox_')) return { sandbox: true };
  await stripeRequest(cfg.secretKey, 'POST', `/checkout/sessions/${encodeURIComponent(sessionId)}/expire`);
  return { sandbox: false };
}

export interface RefundResult { id: string; status: string; sandbox: boolean }

export async function createStripeRefund(orgId: string, input: { paymentIntent: string; amount: number; metadata?: Record<string, string>; shopId?: string | null; idempotencyKey?: string }): Promise<RefundResult> {
  const cfg = await stripeConfig(orgId, input.shopId);
  if (!cfg.live || input.paymentIntent.startsWith('sandbox_')) return { id: sandboxId('re'), status: 'succeeded', sandbox: true };
  const r = await stripeRequest(cfg.secretKey, 'POST', '/refunds', { payment_intent: input.paymentIntent, amount: input.amount, metadata: input.metadata }, input.idempotencyKey);
  if (r.status === 'failed' || r.status === 'canceled') throw new AppError('Stripeで返金に失敗しました', 'PROVIDER_ERROR', 502);
  return { id: r.id, status: r.status, sandbox: false };
}
