import { describe, expect, it } from 'vitest';
import { withSystem } from '../../db/tenant.js';
import { enqueue } from '../../jobs/queue.js';
import { asSystem, createCustomer, createTenant, runJobs } from '../../test/helpers.js';
import { applyPoints, expireCustomerPoints } from './points.js';
import { customerRow } from './test-utils.js';

describe('point ledger & expiry', () => {
  it('expires unused earned points FIFO and never twice', async () => {
    const t = await createTenant();
    const c = await createCustomer(t);
    const past = new Date(Date.now() - 86_400_000);
    const future = new Date(Date.now() + 30 * 86_400_000);
    await asSystem(t.organizationId, async (ctx) => {
      await applyPoints(ctx, { customerId: c.id, delta: 1000, reason: 'earn', expiresAt: past });
      await applyPoints(ctx, { customerId: c.id, delta: 200, reason: 'earn', expiresAt: future });
      await applyPoints(ctx, { customerId: c.id, delta: -300, reason: 'redeem' });
      await expect(applyPoints(ctx, { customerId: c.id, delta: -5000, reason: 'redeem' })).rejects.toMatchObject({ code: 'INSUFFICIENT_POINTS' });
      expect(await expireCustomerPoints(ctx, c.id)).toBe(700);
      expect(await expireCustomerPoints(ctx, c.id)).toBe(0);
    });
    const row = await customerRow(t, c.id);
    expect(row.point_balance).toBe(200);
  });

  it('runs as a daily job fanned out per organization', async () => {
    const t = await createTenant();
    const c = await createCustomer(t);
    await asSystem(t.organizationId, async (ctx) => {
      await applyPoints(ctx, { customerId: c.id, delta: 150, reason: 'earn', expiresAt: new Date(Date.now() - 1000) });
    });
    await withSystem((trx) => enqueue(trx, { type: 'pos.expire_points', organizationId: null }));
    await runJobs();
    expect((await customerRow(t, c.id)).point_balance).toBe(0);
    const ledger = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('point_ledger').select(['reason', 'delta', 'balance_after']).where('customer_id', '=', c.id).orderBy('created_at').execute());
    expect(ledger.map((l) => [l.reason, l.delta, l.balance_after])).toEqual([
      ['earn', 150, 150],
      ['expire', -150, 0],
    ]);
  });
});
