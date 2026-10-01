import { withSystem } from '../../db/tenant.js';
import { enqueue, registerJob } from '../../jobs/queue.js';
import { dailyAt, registerPeriodic } from '../../jobs/scheduler.js';
import { scoreOrganization } from './scoring.js';

export const NIGHTLY_SCORES_JOB = 'ai.nightly_scores';
export const SCORE_ORG_JOB = 'ai.score_org';

/** Global nightly job → one scoring job per active organization */
registerJob(NIGHTLY_SCORES_JOB, async () => {
  await withSystem(async (trx) => {
    const orgs = await trx.selectFrom('organizations').select('id').where('deleted_at', 'is', null).where('status', 'in', ['trial', 'active']).execute();
    const stamp = new Date().toISOString().slice(0, 10);
    for (const org of orgs) {
      await enqueue(trx, { type: SCORE_ORG_JOB, organizationId: org.id, dedupeKey: `ai:scores:${org.id}:${stamp}` });
    }
  });
});

registerJob(SCORE_ORG_JOB, async (_payload, jc) => {
  await jc.tx((ctx) => scoreOrganization(ctx));
});

registerPeriodic({ name: 'ai.nightly_scores', jobType: NIGHTLY_SCORES_JOB, bucket: dailyAt(5) });
