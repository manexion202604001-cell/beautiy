import { describe, expect, it } from 'vitest';
import { withSystem } from '../db/tenant.js';
import { createTenant } from '../test/helpers.js';
import { backoffMs, drainJobs, enqueue, PermanentJobError, registerJob } from './queue.js';
import { dailyAt, everyMinutes, registerPeriodic, schedulerTick } from './scheduler.js';

let calls = 0;
let failuresLeft = 0;
registerJob('test.flaky', async () => {
  calls++;
  if (failuresLeft > 0) {
    failuresLeft--;
    throw new Error('transient');
  }
});
registerJob('test.permanent', async () => {
  throw new PermanentJobError('bad payload');
});
registerJob('test.tenant', async (payload: { marker: string }, jc) => {
  await jc.tx(async (ctx) => {
    await ctx.trx.insertInto('tags').values({ organization_id: ctx.actor.organizationId, name: payload.marker }).execute();
  });
});

async function jobState(id: string) {
  return withSystem((trx) => trx.selectFrom('jobs').select(['state', 'attempts', 'last_error', 'run_at']).where('id', '=', id).executeTakeFirstOrThrow());
}

describe('job queue', () => {
  it('runs tenant jobs inside the organization (RLS context)', async () => {
    const t = await createTenant();
    const id = await withSystem((trx) => enqueue(trx, { type: 'test.tenant', organizationId: t.organizationId, payload: { marker: 'from-job' } }));
    await drainJobs();
    expect((await jobState(id!)).state).toBe('succeeded');
    const tags = await t.owner.get('/v1/tags');
    expect(tags.body.map((x: { name: string }) => x.name)).toContain('from-job');
  });

  it('retries with backoff and moves to DLQ after max attempts', async () => {
    failuresLeft = 1;
    calls = 0;
    const id = await withSystem((trx) => enqueue(trx, { type: 'test.flaky', organizationId: null, maxAttempts: 3 }));
    await drainJobs();
    const s1 = await jobState(id!);
    expect(s1.state).toBe('queued');
    expect(s1.attempts).toBe(1);
    expect(s1.run_at.getTime()).toBeGreaterThan(Date.now());
    await withSystem((trx) => trx.updateTable('jobs').set({ run_at: new Date() }).where('id', '=', id!).execute());
    await drainJobs();
    expect((await jobState(id!)).state).toBe('succeeded');
    expect(calls).toBe(2);

    const dead = await withSystem((trx) => enqueue(trx, { type: 'test.permanent', organizationId: null }));
    await drainJobs();
    const s2 = await jobState(dead!);
    expect(s2.state).toBe('dead');
    expect(s2.last_error).toContain('bad payload');
  });

  it('deduplicates queued jobs by dedupe key', async () => {
    const a = await withSystem((trx) => enqueue(trx, { type: 'test.flaky', organizationId: null, dedupeKey: 'same', runAt: new Date(Date.now() + 60_000) }));
    const b = await withSystem((trx) => enqueue(trx, { type: 'test.flaky', organizationId: null, dedupeKey: 'same' }));
    expect(a).not.toBeNull();
    expect(b).toBeNull();
  });

  it('computes bounded exponential backoff', () => {
    expect(backoffMs(1)).toBeGreaterThanOrEqual(4000);
    expect(backoffMs(1)).toBeLessThanOrEqual(6000);
    expect(backoffMs(30)).toBeLessThanOrEqual(60 * 60 * 1000 * 1.2);
  });
});

describe('scheduler', () => {
  it('enqueues each periodic task once per bucket', async () => {
    registerPeriodic({ name: 'test-every-5', jobType: 'test.flaky', bucket: everyMinutes(5) });
    const now = new Date('2030-01-01T00:01:00Z');
    expect(await schedulerTick(now)).toContain('test-every-5');
    expect(await schedulerTick(new Date('2030-01-01T00:03:00Z'))).not.toContain('test-every-5');
    expect(await schedulerTick(new Date('2030-01-01T00:06:00Z'))).toContain('test-every-5');
  });

  it('dailyAt buckets by local date after the hour', () => {
    const f = dailyAt(3);
    expect(f(new Date('2026-10-01T17:00:00Z'))).toBeNull(); // 02:00 JST
    expect(f(new Date('2026-10-01T18:30:00Z'))).toBe('2026-10-02'); // 03:30 JST
    expect(f(new Date('2026-10-01T16:30:00Z'))).toBeNull(); // 01:30 JST
  });
});
