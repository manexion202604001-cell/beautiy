import { Errors } from '../../../lib/errors.js';
import type { PaymentProviderAdapter, ProviderPaymentStatus, ProviderRefundStatus } from './types.js';

/**
 * Stripe adapter over the REST API (no SDK): form-encoded requests to https://api.stripe.com/v1,
 * `Idempotency-Key` on every create so retries never double-charge. The secret key is only ever
 * placed in the Authorization header — never logged or included in error details.
 */
export const STRIPE_API_BASE = 'https://api.stripe.com/v1';

export interface StripeProviderOptions {
  secretKey: string;
  fetchImpl?: typeof fetch;
  apiBase?: string;
  timeoutMs?: number;
}

type FormValue = string | number | boolean | undefined | null | Record<string, string | number | undefined>;

export function formEncode(params: Record<string, FormValue>): string {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) if (sv !== undefined) out.append(`${k}[${sk}]`, String(sv));
    } else out.append(k, String(v));
  }
  return out.toString();
}

export function mapIntentStatus(s: string): ProviderPaymentStatus {
  switch (s) {
    case 'succeeded':
      return 'succeeded';
    case 'processing':
    case 'requires_capture':
      return 'pending';
    case 'canceled':
      return 'cancelled';
    default:
      // requires_payment_method / requires_confirmation / requires_action
      return 'requires_action';
  }
}

export function mapRefundStatus(s: string | undefined): ProviderRefundStatus {
  if (s === 'succeeded') return 'succeeded';
  if (s === 'failed' || s === 'canceled') return 'failed';
  return 'pending';
}

export function createStripeProvider(opts: StripeProviderOptions): PaymentProviderAdapter {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = opts.apiBase ?? STRIPE_API_BASE;

  async function call<T>(path: string, params: Record<string, FormValue>, idempotencyKey?: string): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${opts.secretKey}`,
      'content-type': 'application/x-www-form-urlencoded',
    };
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, { method: 'POST', headers, body: formEncode(params), signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000) });
    } catch (err) {
      throw Errors.external('stripe', '決済サービスに接続できませんでした', { reason: (err as Error).name });
    }
    const text = await res.text();
    let body: any;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!res.ok) {
      const e = body?.error ?? {};
      // only safe, non-secret fields from the provider error
      throw Errors.external('stripe', '決済サービスでエラーが発生しました', {
        status: res.status,
        type: e.type,
        code: e.code,
        declineCode: e.decline_code,
        requestId: res.headers.get('request-id') ?? undefined,
      });
    }
    return body as T;
  }

  return {
    name: 'stripe',
    async createPayment(req) {
      const pi = await call<{ id: string; client_secret: string | null; status: string }>(
        '/payment_intents',
        {
          amount: req.amount,
          currency: req.currency,
          description: req.description,
          'automatic_payment_methods[enabled]': true,
          metadata: req.metadata,
        },
        req.idempotencyKey,
      );
      return { providerPaymentId: pi.id, clientSecret: pi.client_secret ?? null, status: mapIntentStatus(pi.status) };
    },
    async refund(req) {
      const re = await call<{ id: string; status: string }>(
        '/refunds',
        { payment_intent: req.providerPaymentId, amount: req.amount, metadata: { ...(req.metadata ?? {}), ...(req.reason ? { reason_text: req.reason.slice(0, 450) } : {}) } },
        req.idempotencyKey,
      );
      return { providerRefundId: re.id, status: mapRefundStatus(re.status) };
    },
    async cancel(providerPaymentId, idempotencyKey) {
      await call(`/payment_intents/${encodeURIComponent(providerPaymentId)}/cancel`, {}, idempotencyKey);
    },
  };
}
