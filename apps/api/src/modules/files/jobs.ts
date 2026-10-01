import { withSystem } from '../../db/tenant.js';
import { enqueue, registerJob } from '../../jobs/queue.js';
import { dailyAt, registerPeriodic } from '../../jobs/scheduler.js';
import { storage } from '../../lib/storage.js';

/** Pending uploads never completed within this window are discarded */
export const PENDING_FILE_TTL_MS = 24 * 60 * 60 * 1000;

/** Delete the object of a soft-deleted file from storage (retried with backoff on storage errors) */
registerJob<{ fileId: string }>('files.delete_object', async (payload, jc) => {
  await jc.tx(async (ctx) => {
    const file = await ctx.trx.selectFrom('files').select(['object_key', 'status']).where('id', '=', payload.fileId).executeTakeFirst();
    if (!file || file.status !== 'deleted') return;
    await storage.delete(file.object_key);
  });
});

/** Global daily sweep → fan out per organization that has stale pending uploads */
registerJob('files.cleanup_pending', async () => {
  await withSystem(async (trx) => {
    const rows = await trx
      .selectFrom('files')
      .select('organization_id')
      .distinct()
      .where('status', '=', 'pending')
      .where('created_at', '<', new Date(Date.now() - PENDING_FILE_TTL_MS))
      .execute();
    for (const r of rows) {
      await enqueue(trx, { type: 'files.cleanup_pending_org', organizationId: r.organization_id, dedupeKey: `files-cleanup:${r.organization_id}` });
    }
  });
});

registerJob('files.cleanup_pending_org', async (_payload, jc) => {
  const stale = await jc.tx(async (ctx) =>
    ctx.trx
      .updateTable('files')
      .set({ status: 'deleted', deleted_at: new Date() })
      .where('status', '=', 'pending')
      .where('created_at', '<', new Date(Date.now() - PENDING_FILE_TTL_MS))
      .returning(['id', 'object_key'])
      .execute(),
  );
  for (const f of stale) {
    // the client may have PUT the bytes without calling complete
    await storage.delete(f.object_key).catch(() => undefined);
  }
});

registerPeriodic({ name: 'files.cleanup_pending', jobType: 'files.cleanup_pending', bucket: dailyAt(4, 10) });
