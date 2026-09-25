// Square adapter (REST via fetch, no SDK). Credentials: Integration(SQUARE).config
// { accessToken, locationId, signatureKey, deviceId?, environment?: 'sandbox'|'production' }
// or SQUARE_* env vars. Without an access token the adapter simulates success ("sandbox").
import { randomToken } from '@salonos/core/crypto';
import { getIntegration } from '../integrations';
import { env } from '../env';
import { AppError } from '../errors';

export interface SquareConfig {
  accessToken: string; locationId: string; signatureKey: string; deviceId: string;
  baseUrl: string; live: boolean; integrationId: string | null; webhookKey: string | null;
}

export async function squareConfig(orgId: string, shopId?: string | null): Promise<SquareConfig> {
  const it = await getIntegration(orgId, 'SQUARE', shopId).catch(() => null);
  // PAUSED: no fallback to the platform's env credentials (sandbox instead).
  const paused = !!it && it.integration.status === 'PAUSED';
  const c = (!paused && it?.config) || {};
  const accessToken: string = paused ? '' : c.accessToken || env.square.accessToken || '';
  const environment: string = c.environment || process.env.SQUARE_ENVIRONMENT || 'production';
  return {
    accessToken,
    locationId: c.locationId || process.env.SQUARE_LOCATION_ID || '',
    signatureKey: paused ? '' : c.signatureKey || env.square.signatureKey || '',
    deviceId: c.deviceId || process.env.SQUARE_DEVICE_ID || '',
    baseUrl: environment === 'sandbox' ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com',
    live: !!accessToken,
    integrationId: it?.integration.id ?? null,
    webhookKey: it?.integration.webhookKey ?? null,
  };
}

async function squareRequest<T = any>(cfg: SquareConfig, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${cfg.accessToken}`, 'Content-Type': 'application/json', 'Square-Version': '2024-06-04' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
  } catch (e: any) {
    throw new AppError(`Squareに接続できませんでした（${e?.message ?? 'network error'}）。時間をおいて再試行してください。`, 'PROVIDER_ERROR', 502);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new AppError(`Squareエラー: ${json?.errors?.[0]?.detail ?? res.status}`, 'PROVIDER_ERROR', 502);
  return json as T;
}

const sandboxId = (prefix: string) => `sandbox_sq_${prefix}_${randomToken(12)}`;

/** Reference ids carried through Square: `txn:<transactionId>` or `ord:<orderId>`. */
export const squareRef = (kind: 'transaction' | 'order', id: string) => `${kind === 'order' ? 'ord' : 'txn'}:${id}`;

export interface PaymentLinkResult { id: string; url: string | null; orderId: string | null; sandbox: boolean }

/** Hosted payment link (online checkout). The Square order carries our reference id. */
export async function createSquarePaymentLink(orgId: string, input: {
  name: string; amount: number; referenceId: string; redirectUrl?: string; shopId?: string | null; idempotencyKey?: string;
  lines?: { name: string; amount: number; quantity: number }[];
}): Promise<PaymentLinkResult> {
  const cfg = await squareConfig(orgId, input.shopId);
  if (!cfg.live) return { id: sandboxId('link'), url: null, orderId: null, sandbox: true };
  if (!cfg.locationId) throw new AppError('SquareのロケーションIDが未設定です');
  const lines = input.lines?.length ? input.lines : [{ name: input.name, amount: input.amount, quantity: 1 }];
  const r = await squareRequest(cfg, 'POST', '/v2/online-checkout/payment-links', {
    idempotency_key: input.idempotencyKey ?? randomToken(16),
    order: {
      location_id: cfg.locationId, reference_id: input.referenceId,
      line_items: lines.map((l) => ({ name: l.name.slice(0, 500), quantity: String(l.quantity), base_price_money: { amount: l.amount, currency: 'JPY' } })),
    },
    checkout_options: input.redirectUrl ? { redirect_url: input.redirectUrl } : undefined,
    payment_note: input.referenceId,
  });
  return { id: r.payment_link?.id, url: r.payment_link?.url ?? null, orderId: r.payment_link?.order_id ?? null, sandbox: false };
}

export interface TerminalResult { id: string; status: string; sandbox: boolean }

/** Push an amount to a paired Square Terminal. Completion arrives via webhook (payment.updated). */
export async function createTerminalCheckout(orgId: string, input: { amount: number; referenceId: string; note?: string; shopId?: string | null; idempotencyKey?: string }): Promise<TerminalResult> {
  const cfg = await squareConfig(orgId, input.shopId);
  if (!cfg.live) return { id: sandboxId('term'), status: 'COMPLETED', sandbox: true };
  if (!cfg.deviceId) throw new AppError('Square端末（デバイスID）が未設定です');
  const r = await squareRequest(cfg, 'POST', '/v2/terminals/checkouts', {
    idempotency_key: input.idempotencyKey ?? randomToken(16),
    checkout: { amount_money: { amount: input.amount, currency: 'JPY' }, reference_id: input.referenceId, note: input.note, device_options: { device_id: cfg.deviceId } },
  });
  return { id: r.checkout?.id, status: r.checkout?.status ?? 'PENDING', sandbox: false };
}

/** Cancel a pending Terminal checkout (no-op in sandbox). */
export async function cancelTerminalCheckout(orgId: string, checkoutId: string, shopId?: string | null): Promise<{ sandbox: boolean }> {
  const cfg = await squareConfig(orgId, shopId);
  if (!cfg.live || checkoutId.startsWith('sandbox_')) return { sandbox: true };
  await squareRequest(cfg, 'POST', `/v2/terminals/checkouts/${encodeURIComponent(checkoutId)}/cancel`);
  return { sandbox: false };
}

export async function retrieveSquarePayment(orgId: string, paymentId: string, shopId?: string | null): Promise<{ id: string; status: string; amount: number; referenceId: string | null; sandbox: boolean }> {
  const cfg = await squareConfig(orgId, shopId);
  if (!cfg.live || paymentId.startsWith('sandbox_')) return { id: paymentId, status: 'COMPLETED', amount: -1, referenceId: null, sandbox: true };
  const r = await squareRequest(cfg, 'GET', `/v2/payments/${encodeURIComponent(paymentId)}`);
  return { id: r.payment.id, status: r.payment.status, amount: r.payment.amount_money?.amount ?? 0, referenceId: r.payment.reference_id ?? null, sandbox: false };
}

export async function createSquareRefund(orgId: string, input: { paymentId: string; amount: number; reason?: string; shopId?: string | null; idempotencyKey?: string }): Promise<{ id: string; status: string; sandbox: boolean }> {
  const cfg = await squareConfig(orgId, input.shopId);
  if (!cfg.live || input.paymentId.startsWith('sandbox_')) return { id: sandboxId('refund'), status: 'COMPLETED', sandbox: true };
  const r = await squareRequest(cfg, 'POST', '/v2/refunds', {
    idempotency_key: input.idempotencyKey ?? randomToken(16), payment_id: input.paymentId,
    amount_money: { amount: input.amount, currency: 'JPY' }, reason: input.reason?.slice(0, 190),
  });
  if (r.refund?.status === 'FAILED' || r.refund?.status === 'REJECTED') throw new AppError('Squareで返金に失敗しました', 'PROVIDER_ERROR', 502);
  return { id: r.refund.id, status: r.refund.status, sandbox: false };
}
