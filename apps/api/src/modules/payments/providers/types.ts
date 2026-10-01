/**
 * Payment provider adapter (FR-05). The payments module talks to Stripe / mock only through this
 * interface so providers can be swapped by config.PAYMENT_PROVIDER.
 */
export type ProviderPaymentStatus = 'requires_action' | 'pending' | 'succeeded' | 'failed' | 'cancelled';
export type ProviderRefundStatus = 'pending' | 'succeeded' | 'failed';

export interface CreatePaymentRequest {
  /** integer JPY */
  amount: number;
  currency: 'jpy';
  /** forwarded as the provider Idempotency-Key (already tenant-scoped by the caller) */
  idempotencyKey: string;
  description?: string;
  metadata: Record<string, string>;
}

export interface CreatePaymentResult {
  providerPaymentId: string;
  clientSecret: string | null;
  status: ProviderPaymentStatus;
}

export interface RefundRequest {
  providerPaymentId: string;
  amount: number;
  idempotencyKey: string;
  reason?: string;
  metadata?: Record<string, string>;
}

export interface RefundResult {
  providerRefundId: string;
  status: ProviderRefundStatus;
}

export interface PaymentProviderAdapter {
  readonly name: 'mock' | 'stripe';
  createPayment(req: CreatePaymentRequest): Promise<CreatePaymentResult>;
  refund(req: RefundRequest): Promise<RefundResult>;
  /** cancel an unpaid payment intent (best effort) */
  cancel(providerPaymentId: string, idempotencyKey: string): Promise<void>;
}
