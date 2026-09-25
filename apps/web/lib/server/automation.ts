// Automated customer messaging (reminders, visit-cycle, review requests, birthdays, dormancy)
// and scheduled broadcast processing. Invoked by app/api/cron and the "今すぐ実行" button.
//
// Never double-sends: every (rule, target) pair claims an AutomationDispatch row whose
// `dedupeKey` is unique before anything is sent. Opt-outs are enforced by sendCustomerMessage.
import type { AutomationRule, Message } from '@salonos/db';
import { renderTemplate, toLocalParts } from '@salonos/core';
import { prisma } from './db';
import { appointmentVars } from './appointment-notify';
import { sendCustomerMessage } from './notify';
import { ACTIVE_APPT_STATUSES, customerVars, executeBroadcast, startBroadcast } from './messaging';

const HOUR = 3600_000;
const DAY = 86400_000;
/** Safety cap per rule per run so one run can't monopolise the worker. */
const MAX_PER_RULE = 500;
/** VISIT_CYCLE only targets customers whose cycle elapsed within this grace window (older → DORMANT's job). */
export const VISIT_CYCLE_WINDOW_DAYS = 30;
/** AFTER_VISIT_REVIEW looks back this far. */
const REVIEW_LOOKBACK_MS = 7 * DAY;

export interface RuleRunResult { ruleId: string; name: string; trigger: string; candidates: number; dispatched: number; sent: number; skipped: number; failed: number; error?: string }
export interface AutomationRunSummary { ranAt: string; rules: RuleRunResult[]; dispatched: number; sent: number; skipped: number; failed: number }

type Outcome = 'dup' | 'none' | Message['status'];

function isUniqueViolation(e: unknown) {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';
}

/** Claim a dedupe key, run the send, attach the message. Releases the claim if the send throws. */
async function dispatchOnce(rule: AutomationRule, customerId: string, dedupeKey: string, send: () => Promise<Message | null>): Promise<Outcome> {
  let claimId: string;
  try {
    claimId = (await prisma.automationDispatch.create({ data: { ruleId: rule.id, customerId, dedupeKey } })).id;
  } catch (e) {
    if (isUniqueViolation(e)) return 'dup';
    throw e;
  }
  try {
    const msg = await send();
    if (!msg) { await prisma.automationDispatch.delete({ where: { id: claimId } }); return 'none'; }
    await prisma.automationDispatch.update({ where: { id: claimId }, data: { messageId: msg.id } });
    return msg.status;
  } catch (e) {
    await prisma.automationDispatch.delete({ where: { id: claimId } }).catch(() => undefined);
    throw e;
  }
}

async function alreadyDispatched(ruleId: string, keys: string[]) {
  if (!keys.length) return new Set<string>();
  const rows = await prisma.automationDispatch.findMany({ where: { ruleId, dedupeKey: { in: keys } }, select: { dedupeKey: true } });
  return new Set(rows.map((r) => r.dedupeKey));
}

async function orgTimezone(orgId: string, shopId: string | null) {
  const shop = shopId
    ? await prisma.shop.findFirst({ where: { id: shopId, organizationId: orgId } })
    : await prisma.shop.findFirst({ where: { organizationId: orgId, active: true }, orderBy: { createdAt: 'asc' } });
  return shop?.timezone ?? 'Asia/Tokyo';
}

const liveCustomer = (orgId: string) => ({ organizationId: orgId, mergedIntoId: null, deletedAt: null });

function ymd(d: Date) { return d.toISOString().slice(0, 10); }

// ── Target selection per trigger ──

interface Target { customerId: string; dedupeKey: string; appointmentId?: string }

async function targetsFor(rule: AutomationRule, now: Date): Promise<Target[]> {
  const orgId = rule.organizationId;
  const shopFilter = rule.shopId ? { shopId: rule.shopId } : {};
  const customerShopFilter = rule.shopId ? { primaryShopId: rule.shopId } : {};
  const offset = Math.max(0, rule.offsetValue);
  switch (rule.trigger) {
    case 'REMINDER_BEFORE': {
      const appts = await prisma.appointment.findMany({
        where: { organizationId: orgId, ...shopFilter, status: 'CONFIRMED', customerId: { not: null }, startAt: { gt: now, lte: new Date(now.getTime() + offset * HOUR) } },
        select: { id: true, customerId: true }, orderBy: { startAt: 'asc' }, take: MAX_PER_RULE,
      });
      return appts.map((a) => ({ customerId: a.customerId!, appointmentId: a.id, dedupeKey: `${rule.id}:${a.id}` }));
    }
    case 'AFTER_VISIT_REVIEW': {
      const appts = await prisma.appointment.findMany({
        where: {
          organizationId: orgId, ...shopFilter, status: 'COMPLETED', customerId: { not: null },
          endAt: { lte: new Date(now.getTime() - offset * HOUR), gte: new Date(now.getTime() - REVIEW_LOOKBACK_MS) },
        },
        select: { id: true, customerId: true }, orderBy: { endAt: 'asc' }, take: MAX_PER_RULE,
      });
      if (!appts.length) return [];
      const reviewed = new Set((await prisma.review.findMany({ where: { organizationId: orgId, appointmentId: { in: appts.map((a) => a.id) } }, select: { appointmentId: true } })).map((r) => r.appointmentId));
      return appts.filter((a) => !reviewed.has(a.id)).map((a) => ({ customerId: a.customerId!, appointmentId: a.id, dedupeKey: `${rule.id}:${a.id}` }));
    }
    case 'VISIT_CYCLE':
    case 'DORMANT': {
      const cutoff = new Date(now.getTime() - offset * DAY);
      const lastVisitAt = rule.trigger === 'VISIT_CYCLE'
        ? { lte: cutoff, gt: new Date(cutoff.getTime() - VISIT_CYCLE_WINDOW_DAYS * DAY) }
        : { lte: cutoff };
      const customers = await prisma.customer.findMany({
        where: {
          ...liveCustomer(orgId), ...customerShopFilter, lastVisitAt,
          // exclude customers who already have a future active booking
          appointments: { none: { startAt: { gt: now }, status: { in: [...ACTIVE_APPT_STATUSES] } } },
        },
        select: { id: true, lastVisitAt: true }, orderBy: { lastVisitAt: 'desc' }, take: MAX_PER_RULE,
      });
      return customers.map((c) => ({ customerId: c.id, dedupeKey: `${rule.id}:${c.id}:${ymd(c.lastVisitAt!)}` }));
    }
    case 'BIRTHDAY': {
      const tz = await orgTimezone(orgId, rule.shopId);
      const p = toLocalParts(now, tz);
      const mmdd = `-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
      const leap = (p.year % 4 === 0 && p.year % 100 !== 0) || p.year % 400 === 0;
      const days = [mmdd];
      if (mmdd === '-02-28' && !leap) days.push('-02-29'); // Feb-29 birthdays celebrated on Feb-28 in common years
      const customers = await prisma.customer.findMany({
        where: { ...liveCustomer(orgId), ...customerShopFilter, OR: days.map((d) => ({ birthday: { endsWith: d } })) },
        select: { id: true }, take: MAX_PER_RULE,
      });
      return customers.map((c) => ({ customerId: c.id, dedupeKey: `${rule.id}:${c.id}:${p.year}` }));
    }
    default:
      return [];
  }
}

async function runRule(rule: AutomationRule, now: Date): Promise<RuleRunResult> {
  const res: RuleRunResult = { ruleId: rule.id, name: rule.name, trigger: rule.trigger, candidates: 0, dispatched: 0, sent: 0, skipped: 0, failed: 0 };
  const targets = await targetsFor(rule, now);
  res.candidates = targets.length;
  const done = await alreadyDispatched(rule.id, targets.map((t) => t.dedupeKey));
  for (const t of targets) {
    if (done.has(t.dedupeKey)) continue;
    const outcome = await dispatchOnce(rule, t.customerId, t.dedupeKey, async () => {
      let vars: Record<string, string>;
      let shopId: string | null = rule.shopId;
      if (t.appointmentId) {
        const r = await appointmentVars(t.appointmentId);
        if (!r || !r.appointment.customerId) return null;
        vars = r.vars;
        shopId = r.appointment.shopId;
      } else {
        vars = await customerVars(rule.organizationId, t.customerId, rule.shopId, now);
      }
      return sendCustomerMessage({
        orgId: rule.organizationId, shopId, customerId: t.customerId, body: renderTemplate(rule.body, vars),
        channel: rule.channel, appointmentId: t.appointmentId, automationRuleId: rule.id, subject: rule.name,
      });
    });
    if (outcome === 'dup' || outcome === 'none') continue;
    res.dispatched++;
    if (outcome === 'SENT' || outcome === 'DELIVERED') res.sent++;
    else if (outcome === 'FAILED') res.failed++;
    else res.skipped++;
  }
  return res;
}

/**
 * Run all active automation rules (optionally for one org / one rule).
 * Safe to call concurrently and repeatedly: dispatches are deduplicated.
 */
export async function runAutomations(now: Date = new Date(), orgId?: string, opts: { ruleId?: string } = {}): Promise<AutomationRunSummary> {
  const rules = await prisma.automationRule.findMany({
    where: { active: true, ...(orgId ? { organizationId: orgId } : {}), ...(opts.ruleId ? { id: opts.ruleId } : {}) },
    orderBy: { createdAt: 'asc' },
  });
  const summary: AutomationRunSummary = { ranAt: now.toISOString(), rules: [], dispatched: 0, sent: 0, skipped: 0, failed: 0 };
  for (const rule of rules) {
    let r: RuleRunResult;
    try {
      r = await runRule(rule, now);
    } catch (e: any) {
      console.error('[automation]', rule.id, e);
      r = { ruleId: rule.id, name: rule.name, trigger: rule.trigger, candidates: 0, dispatched: 0, sent: 0, skipped: 0, failed: 0, error: String(e?.message ?? e).slice(0, 300) };
    }
    await prisma.automationRule.update({ where: { id: rule.id }, data: { lastRunAt: now } });
    summary.rules.push(r);
    summary.dispatched += r.dispatched; summary.sent += r.sent; summary.skipped += r.skipped; summary.failed += r.failed;
  }
  return summary;
}

/** Stuck SENDING broadcasts (no activity for this long) are resumed by the scheduler. */
const STALE_SENDING_MS = 10 * 60_000;

/**
 * Deliver broadcasts whose scheduledAt has passed, and resume interrupted ones.
 */
export async function processScheduledBroadcasts(now: Date = new Date(), orgId?: string) {
  const due = await prisma.broadcast.findMany({
    where: { status: 'SCHEDULED', scheduledAt: { lte: now }, ...(orgId ? { organizationId: orgId } : {}) },
    orderBy: { scheduledAt: 'asc' }, take: 20,
  });
  const out = { started: 0, resumed: 0, sent: 0, failed: 0, skipped: 0, errors: [] as string[] };
  for (const b of due) {
    try {
      const r = await startBroadcast(b.organizationId, b.id, { fromStatuses: ['SCHEDULED'] });
      if (!r) continue;
      out.started++; out.sent += r.sent; out.failed += r.failed; out.skipped += r.skipped;
    } catch (e: any) {
      out.errors.push(`${b.id}: ${e?.message ?? e}`);
    }
  }
  const sending = await prisma.broadcast.findMany({ where: { status: 'SENDING', ...(orgId ? { organizationId: orgId } : {}) }, take: 20 });
  for (const b of sending) {
    const last = await prisma.message.findFirst({ where: { organizationId: b.organizationId, broadcastId: b.id }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
    const lastActivity = last?.createdAt ?? b.scheduledAt ?? b.createdAt;
    if (now.getTime() - lastActivity.getTime() < STALE_SENDING_MS) continue;
    try {
      const r = await executeBroadcast(b.organizationId, b.id, now);
      out.resumed++; out.sent += r.sent; out.failed += r.failed; out.skipped += r.skipped;
    } catch (e: any) {
      out.errors.push(`${b.id}: ${e?.message ?? e}`);
    }
  }
  return out;
}
