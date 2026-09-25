// Periodic jobs: automation rules, scheduled broadcasts, external booking sync, LINE retry.
// Auth: `Authorization: Bearer ${CRON_SECRET}` is always required. Vercel Cron sends this
// header automatically when CRON_SECRET is set; `x-vercel-cron` alone is never sufficient.
// Vercel Hobby only allows daily crons (see vercel.json) — in production call this endpoint
// every 5–15 minutes from an external scheduler (e.g. GitHub Actions, Cloud Scheduler, cron-job.org).
import { NextRequest, NextResponse } from 'next/server';
import { safeEqual } from '@salonos/core/crypto';
import { env } from '@/lib/server/env';
import { processScheduledBroadcasts, runAutomations } from '@/lib/server/automation';
import { processPendingSyncEvents } from '@/lib/server/sync';
import { retryPendingLineEvents } from '@/lib/server/line';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function authorized(req: NextRequest): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '');
  if (!m) return false;
  let secret: string;
  try { secret = env.cronSecret; } catch { return false; }
  return !!secret && safeEqual(m[1].trim(), secret);
}

async function step<T>(name: string, fn: () => Promise<T>): Promise<{ ok: true; result: T; ms: number } | { ok: false; error: string; ms: number }> {
  const t = Date.now();
  try {
    return { ok: true, result: await fn(), ms: Date.now() - t };
  } catch (e: any) {
    console.error(`[cron] ${name} failed`, e);
    return { ok: false, error: String(e?.message ?? e).slice(0, 500), ms: Date.now() - t };
  }
}

async function run(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const now = new Date();
  const automations = await step('automations', () => runAutomations(now));
  const broadcasts = await step('broadcasts', () => processScheduledBroadcasts(now));
  const sync = await step('sync', () => processPendingSyncEvents(now));
  const lineRetry = await step('lineRetry', () => retryPendingLineEvents(now));
  const ok = automations.ok && broadcasts.ok && sync.ok && lineRetry.ok;
  return NextResponse.json(
    {
      ok, ranAt: now.toISOString(), viaVercelCron: req.headers.has('x-vercel-cron'),
      automations: automations.ok
        ? { ok: true, ms: automations.ms, dispatched: automations.result.dispatched, sent: automations.result.sent, skipped: automations.result.skipped, failed: automations.result.failed, rules: automations.result.rules.length, errors: automations.result.rules.filter((r) => r.error).map((r) => ({ ruleId: r.ruleId, error: r.error })) }
        : automations,
      broadcasts, sync, lineRetry,
    },
    { status: ok ? 200 : 500 },
  );
}

export const GET = run;
export const POST = run;
