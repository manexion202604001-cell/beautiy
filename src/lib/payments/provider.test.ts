import { describe, expect, it } from 'vitest'
import { ManualPaymentProvider } from './provider'

describe('PaymentProvider（§23 / §79）', () => {
  it('同一Idempotency Keyでは二重課金されない', async () => {
    const provider = new ManualPaymentProvider()
    const a = await provider.createPayment({ amount: 8800, method: 'cash', description: 'test' }, 'key-1')
    const b = await provider.createPayment({ amount: 8800, method: 'cash', description: 'test' }, 'key-1')
    expect(b.providerPaymentId).toBe(a.providerPaymentId)
    const c = await provider.createPayment({ amount: 8800, method: 'cash', description: 'test' }, 'key-2')
    expect(c.providerPaymentId).not.toBe(a.providerPaymentId)
  })

  it('captured 済み決済のみ返金でき、超過返金は拒否される', async () => {
    const provider = new ManualPaymentProvider()
    const p = await provider.createPayment({ amount: 5000, method: 'credit', description: 'test' }, 'key-r')
    await expect(provider.refundPayment(p.providerPaymentId, 6000)).rejects.toThrow()
    const refunded = await provider.refundPayment(p.providerPaymentId, 5000)
    expect(refunded.status).toBe('refunded')
    // 二重返金は不可
    await expect(provider.refundPayment(p.providerPaymentId, 5000)).rejects.toThrow()
  })

  it('getPayment でプロバイダ側の状態を確認できる（§68 障害時の状態照会）', async () => {
    const provider = new ManualPaymentProvider()
    const p = await provider.createPayment({ amount: 3000, method: 'qr', description: 'test' }, 'key-g')
    const fetched = await provider.getPayment(p.providerPaymentId)
    expect(fetched?.status).toBe('captured')
    expect(await provider.getPayment('unknown')).toBeNull()
  })
})
