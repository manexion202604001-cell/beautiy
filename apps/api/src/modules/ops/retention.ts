import { sql } from 'kysely';
import { systemActor } from '../../auth/actor.js';
import { withSystem } from '../../db/tenant.js';
import { registerJob } from '../../jobs/queue.js';
import { dailyAt, registerPeriodic } from '../../jobs/scheduler.js';
import { audit } from '../../lib/audit.js';
import { storage } from '../../lib/storage.js';
import { addDays } from '../../lib/time.js';

/**
 * 保持期間・クリーンアップ (要件 16: 論理削除と保持期間). Daily at 03:00 JST.
 * Payments, transactions and audit logs are intentionally untouched (法令/契約要件で別管理).
 */
export const RETENTION_JOB = 'ops.retention';
export const DEFAULT_CUSTOMER_RETENTION_DAYS = 365;
const ANONYMIZE_BATCH = 500;

export interface RetentionStats {
  idempotencyKeys: number;
  jobs: number;
  otpChallenges: number;
  webhookEvents: number;
  exportsExpired: number;
  customersAnonymized: number;
}

function retentionDays(settings: unknown): number {
  const v = (settings as { retentionDays?: unknown } | null)?.retentionDays;
  return typeof v === 'number' && Number.isFinite(v) && v >= 30 ? Math.floor(v) : DEFAULT_CUSTOMER_RETENTION_DAYS;
}

export async function runRetention(now = new Date()): Promise<RetentionStats> {
  const stats: RetentionStats = { idempotencyKeys: 0, jobs: 0, otpChallenges: 0, webhookEvents: 0, exportsExpired: 0, customersAnonymized: 0 };

  await withSystem(async (trx) => {
    const idem = await trx.deleteFrom('idempotency_keys').where('expires_at', '<', now).executeTakeFirst();
    stats.idempotencyKeys = Number(idem.numDeletedRows);
    const jobs = await trx
      .deleteFrom('jobs')
      .where('state', 'in', ['succeeded', 'cancelled'])
      .where(sql<Date>`coalesce(finished_at, created_at)`, '<', addDays(now, -14))
      .executeTakeFirst();
    stats.jobs = Number(jobs.numDeletedRows);
    const otp = await trx
      .deleteFrom('otp_challenges')
      .where('created_at', '<', addDays(now, -7))
      .where((eb) => eb.or([eb('consumed_at', 'is not', null), eb('expires_at', '<', now)]))
      .executeTakeFirst();
    stats.otpChallenges = Number(otp.numDeletedRows);
    const hooks = await trx.deleteFrom('webhook_events').where('status', 'in', ['processed', 'ignored']).where('received_at', '<', addDays(now, -90)).executeTakeFirst();
    stats.webhookEvents = Number(hooks.numDeletedRows);
  });

  // expired export files: delete the object, then mark file + export
  const expired = await withSystem((trx) =>
    trx
      .selectFrom('data_exports')
      .leftJoin('files', 'files.id', 'data_exports.file_id')
      .select(['data_exports.id', 'data_exports.organization_id', 'data_exports.file_id', 'files.object_key'])
      .where('data_exports.status', '=', 'completed')
      .where('data_exports.expires_at', '<', now)
      .limit(1000)
      .execute(),
  );
  for (const e of expired) {
    if (e.object_key) {
      try {
        await storage.delete(e.object_key);
      } catch {
        continue; // retry tomorrow
      }
    }
    await withSystem(async (trx) => {
      if (e.file_id) await trx.updateTable('files').set({ status: 'deleted', deleted_at: now }).where('id', '=', e.file_id).execute();
      await trx.updateTable('data_exports').set({ status: 'expired' }).where('id', '=', e.id).execute();
    });
    stats.exportsExpired++;
  }

  // anonymize customers soft-deleted longer than the org's retention period (row + aggregates stay)
  const orgs = await withSystem((trx) => trx.selectFrom('organizations').select(['id', 'settings']).execute());
  for (const org of orgs) {
    const days = retentionDays(org.settings);
    const n = await withSystem(async (trx) => {
      const rows = await trx
        .selectFrom('customers')
        .select('id')
        .where('organization_id', '=', org.id)
        .where('deleted_at', '<', addDays(now, -days))
        .where(sql<boolean>`NOT (attributes ? 'anonymizedAt')`)
        .limit(ANONYMIZE_BATCH)
        .execute();
      if (!rows.length) return 0;
      const ids = rows.map((r) => r.id);
      await trx
        .updateTable('customers')
        .set({
          customer_number: null,
          last_name: '削除済み',
          first_name: '',
          last_name_kana: '',
          first_name_kana: '',
          gender: null,
          birthday: null,
          phone: null,
          phone_normalized: null,
          email: null,
          postal_code: null,
          address: null,
          occupation: null,
          marketing_opt_in: false,
          attributes: JSON.stringify({ anonymizedAt: now.toISOString() }),
        })
        .where('id', 'in', ids)
        .execute();
      await trx.deleteFrom('customer_identities').where('customer_id', 'in', ids).execute();
      await trx.deleteFrom('customer_memos').where('customer_id', 'in', ids).execute();
      await audit(
        { actor: systemActor(org.id, 'retention'), trx, meta: {} },
        { action: 'customer.anonymize', resourceType: 'customer', metadata: { count: ids.length, retentionDays: days, customerIds: ids } },
      );
      return ids.length;
    });
    stats.customersAnonymized += n;
  }
  return stats;
}

registerJob(RETENTION_JOB, async () => {
  await runRetention();
});

registerPeriodic({ name: 'ops.retention', jobType: RETENTION_JOB, bucket: dailyAt(3) });
