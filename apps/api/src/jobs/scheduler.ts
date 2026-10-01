import { sql } from 'kysely';
import { withSystem } from '../db/tenant.js';
import { enqueue } from './queue.js';

/**
 * Periodic task scheduler. Each tick computes a time bucket per task and enqueues exactly one
 * job per bucket cluster-wide (advisory lock + existence check on dedupe_key across all states).
 */
export interface PeriodicTask {
  name: string;
  /** job type to enqueue (global job, organization_id NULL; handler usually fans out per org) */
  jobType: string;
  /** bucket function: returns a stable key for the current period, or null to skip this tick */
  bucket: (now: Date) => string | null;
  payload?: Record<string, unknown>;
}

const tasks: PeriodicTask[] = [];

export function registerPeriodic(task: PeriodicTask) {
  tasks.push(task);
}

export function registeredPeriodicTasks(): readonly PeriodicTask[] {
  return tasks;
}

/** Every N minutes */
export function everyMinutes(n: number) {
  return (now: Date) => String(Math.floor(now.getTime() / (n * 60_000)));
}

/** Once a day at or after the given hour in the timezone (default JST) */
export function dailyAt(hour: number, minute = 0, tz = 'Asia/Tokyo') {
  return (now: Date) => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)!.value;
    const h = Number(get('hour'));
    const m = Number(get('minute'));
    if (h < hour || (h === hour && m < minute)) return null;
    return `${get('year')}-${get('month')}-${get('day')}`;
  };
}

export async function schedulerTick(now = new Date()): Promise<string[]> {
  const enqueued: string[] = [];
  await withSystem(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(727275)`.execute(trx);
    for (const task of tasks) {
      const bucket = task.bucket(now);
      if (!bucket) continue;
      const dedupeKey = `cron:${task.name}:${bucket}`;
      const exists = await trx.selectFrom('jobs').select('id').where('dedupe_key', '=', dedupeKey).executeTakeFirst();
      if (exists) continue;
      await enqueue(trx, { type: task.jobType, payload: task.payload ?? {}, organizationId: null, dedupeKey });
      enqueued.push(task.name);
    }
  });
  return enqueued;
}
