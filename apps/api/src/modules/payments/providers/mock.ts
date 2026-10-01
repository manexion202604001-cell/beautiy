import { createHash } from 'node:crypto';
import type { PaymentProviderAdapter } from './types.js';

/**
 * Mock provider for dev/test: deterministic ids derived from the idempotency key (so retries with
 * the same key return the same intent, like Stripe), payments wait for an explicit completion
 * (POST /payments/:id/mock-complete or a simulated webhook), refunds succeed immediately.
 */
function idFor(prefix: string, key: string) {
  return `${prefix}_${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
}

export function createMockProvider(): PaymentProviderAdapter {
  return {
    name: 'mock',
    async createPayment(req) {
      const id = idFor('mock_pi', req.idempotencyKey);
      return { providerPaymentId: id, clientSecret: `${id}_secret`, status: 'requires_action' };
    },
    async refund(req) {
      return { providerRefundId: idFor('mock_re', req.idempotencyKey), status: 'succeeded' };
    },
    async cancel() {
      /* nothing to do */
    },
  };
}
