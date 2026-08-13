/**
 * 決済プロバイダ抽象化レイヤー（マスター要件 §23）。
 * Square 等の実プロバイダは本インターフェースを実装して差し替える。
 * Idempotency-Key による二重課金防止（§41, §79）をインターフェース仕様に含める。
 */
import type { PaymentMethodKind } from '../domain/types'

export type ProviderPaymentStatus = 'pending' | 'captured' | 'refunded' | 'failed'

export interface ProviderPayment {
  providerPaymentId: string
  provider: string
  status: ProviderPaymentStatus
  amount: number
}

export interface PaymentRequest {
  amount: number // 円（整数）
  method: PaymentMethodKind
  description: string
}

export interface PaymentProvider {
  readonly name: string
  /** idempotencyKey が同一なら何度呼んでも同じ決済を返す（二重課金禁止） */
  createPayment(request: PaymentRequest, idempotencyKey: string): Promise<ProviderPayment>
  refundPayment(providerPaymentId: string, amount: number): Promise<ProviderPayment>
  getPayment(providerPaymentId: string): Promise<ProviderPayment | null>
}

/**
 * 手動決済プロバイダ。
 * 現金・金額手入力運用（要件定義書 11章: Phase 1 は金額手入力＋支払方法記録のみ）に対応。
 * 決済端末を通さないため即時 captured として記録する。
 */
export class ManualPaymentProvider implements PaymentProvider {
  readonly name = 'manual'
  private byIdempotencyKey = new Map<string, ProviderPayment>()
  private byId = new Map<string, ProviderPayment>()
  private seq = 0

  async createPayment(request: PaymentRequest, idempotencyKey: string): Promise<ProviderPayment> {
    const existing = this.byIdempotencyKey.get(idempotencyKey)
    if (existing) return existing
    this.seq += 1
    const payment: ProviderPayment = {
      providerPaymentId: `manual-${this.seq}-${idempotencyKey.slice(0, 8)}`,
      provider: this.name,
      status: 'captured',
      amount: request.amount,
    }
    this.byIdempotencyKey.set(idempotencyKey, payment)
    this.byId.set(payment.providerPaymentId, payment)
    return payment
  }

  async refundPayment(providerPaymentId: string, amount: number): Promise<ProviderPayment> {
    const payment = this.byId.get(providerPaymentId)
    if (!payment) throw new Error(`payment not found: ${providerPaymentId}`)
    if (payment.status !== 'captured') {
      throw new Error(`cannot refund payment in status: ${payment.status}`)
    }
    if (amount > payment.amount) {
      throw new Error('refund amount exceeds captured amount')
    }
    const refunded: ProviderPayment = { ...payment, status: 'refunded' }
    this.byId.set(providerPaymentId, refunded)
    return refunded
  }

  async getPayment(providerPaymentId: string): Promise<ProviderPayment | null> {
    return this.byId.get(providerPaymentId) ?? null
  }
}

/**
 * Square プロバイダ（Phase 2）。
 * 認証情報設定後に Square Payments API を実装する。
 * §68: Timeout時は即失敗にせず getPayment でステータスを確定させること。
 */
export class SquarePaymentProvider implements PaymentProvider {
  readonly name = 'square'

  async createPayment(): Promise<ProviderPayment> {
    throw new Error('Square連携は未接続です（Phase 2で資格情報設定後に有効化）')
  }

  async refundPayment(): Promise<ProviderPayment> {
    throw new Error('Square連携は未接続です')
  }

  async getPayment(): Promise<ProviderPayment | null> {
    throw new Error('Square連携は未接続です')
  }
}

/** 現在有効なプロバイダ。Square 接続時にここを差し替える */
export const paymentProvider: PaymentProvider = new ManualPaymentProvider()
