import { config } from '../../../config.js';
import { Errors } from '../../../lib/errors.js';
import { createMockProvider } from './mock.js';
import { createStripeProvider } from './stripe.js';
import type { PaymentProviderAdapter } from './types.js';

export type { PaymentProviderAdapter } from './types.js';

let override: PaymentProviderAdapter | null = null;
const cache = new Map<string, PaymentProviderAdapter>();

/** Adapter by provider name (the one stored on a payment row) */
export function providerByName(name: string): PaymentProviderAdapter {
  if (override && override.name === name) return override;
  const cached = cache.get(name);
  if (cached) return cached;
  let adapter: PaymentProviderAdapter;
  if (name === 'mock') adapter = createMockProvider();
  else if (name === 'stripe') {
    if (!config.STRIPE_SECRET_KEY) throw Errors.external('stripe', 'Stripeが設定されていません');
    adapter = createStripeProvider({ secretKey: config.STRIPE_SECRET_KEY });
  } else throw Errors.system(`未対応の決済プロバイダです: ${name}`);
  cache.set(name, adapter);
  return adapter;
}

/** Adapter for new online payments (config.PAYMENT_PROVIDER) */
export function activeProvider(): PaymentProviderAdapter {
  if (override) return override;
  return providerByName(config.PAYMENT_PROVIDER);
}

/** Test hook: force a specific adapter (e.g. Stripe adapter with a fake fetch). null restores config. */
export function setPaymentProviderOverride(adapter: PaymentProviderAdapter | null) {
  override = adapter;
}
