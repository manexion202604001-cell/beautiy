import { sql } from 'kysely';
import { z } from 'zod';
import {
  auditUserId,
  hasShopAccess,
  requirePermission,
  systemActor,
  type Ctx,
} from '../../auth/actor.js';
import { withSystem, withTenant } from '../../db/tenant.js';
import { registerJob } from '../../jobs/queue.js';
import { everyMinutes, registerPeriodic } from '../../jobs/scheduler.js';
import { audit } from '../../lib/audit.js';
import { hashToken, randomToken } from '../../lib/crypto.js';
import { Errors } from '../../lib/errors.js';
import { isoDateTime, uuid } from '../../lib/schemas.js';
import { sendEmail } from '../../lib/mailer.js';
import { formatJst } from '../../lib/time.js';
import { ACTIVE_STATUSES } from '../appointments/service.js';
import { loadAccountRow, parseIntegrationConfig, type AccountRow } from './accounts.js';
import { PROVIDER_PROFILES } from './mail/parser.js';
import { resolveMappings } from './mail/service.js';
import { enqueuePushJob } from './push.js';

/**
 * 媒体の自動枠止め (sync agent).
 * minimo and SALON BOARD have no API for outsiders, so "block this slot" requests (push.ts →
 * external_slot_blocks, manual) are carried out by a helper running in the salon's own Chrome
 * (infra/chrome-sync-agent), every 10 minutes, with the salon's own logged-in session:
 *   1. POST /v1/agent/plan   — the helper sends the stylists it sees on each medium; Salon OS answers
 *      with the open requests, each with the medium's stylist id, plus the busy times of those stylists
 *      (so a slot is never reopened while another booking still needs it)
 *   2. the helper closes / reopens the slots on the medium
 *   3. POST /v1/agent/report — results per request (what was closed, kept to reopen it later) and
 *      whether each medium is logged in
 * Connectors opt in with config.mail.agentManaged (then no request mails are sent; the watchdog below
 * mails the shop when the helper stops or cannot finish a request).
 */

export const AGENT_PROVIDERS = ['minimo_mail', 'hotpepper_mail'] as const;
type AgentProvider = (typeof AGENT_PROVIDERS)[number];

/** a request older than this is reported to the shop as not carried out */
const STUCK_MIN = 30;
/** without a report for this long the helper counts as stopped */
const STALE_MIN = 30;

// ------------------------------------------------------------------ owner side: issue / list / revoke

export async function listAgents(ctx: Ctx, input: { shopId?: string }) {
  requirePermission(ctx.actor, 'integration.manage');
  let q = ctx.trx
    .selectFrom('sync_agents as a')
    .innerJoin('shops as s', 's.id', 'a.shop_id')
    .select([
      'a.id',
      'a.shop_id',
      's.name as shop_name',
      'a.name',
      'a.created_at',
      'a.last_seen_at',
      'a.last_report',
      'a.alerted_at',
    ])
    .where('a.revoked_at', 'is', null)
    .orderBy('a.created_at');
  if (input.shopId) q = q.where('a.shop_id', '=', input.shopId);
  const rows = await q.execute();
  return { data: rows.filter((r) => hasShopAccess(ctx.actor, r.shop_id)) };
}

export async function issueAgent(ctx: Ctx, input: { shopId: string; name: string }) {
  requirePermission(ctx.actor, 'integration.manage');
  if (!hasShopAccess(ctx.actor, input.shopId))
    throw Errors.forbidden('この店舗へのアクセス権がありません', 'SHOP_FORBIDDEN');
  const shop = await ctx.trx
    .selectFrom('shops')
    .select('id')
    .where('id', '=', input.shopId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (!shop) throw Errors.notFound('店舗', input.shopId);
  const token = `sa_${randomToken(24)}`;
  const row = await ctx.trx
    .insertInto('sync_agents')
    .values({
      organization_id: ctx.actor.organizationId,
      shop_id: input.shopId,
      name: input.name,
      token_hash: hashToken(token),
      created_by_staff_id: ctx.actor.kind === 'staff' ? ctx.actor.staffId : null,
    })
    .returning(['id', 'created_at'])
    .executeTakeFirstOrThrow();
  await audit(ctx, {
    action: 'integration.agent_issue',
    resourceType: 'sync_agent',
    resourceId: row.id,
    shopId: input.shopId,
    after: { name: input.name },
  });
  // the token is shown once; only its hash is kept
  return { id: row.id, shopId: input.shopId, name: input.name, token };
}

export async function revokeAgent(ctx: Ctx, id: string) {
  requirePermission(ctx.actor, 'integration.manage');
  const row = await ctx.trx
    .selectFrom('sync_agents')
    .select(['id', 'shop_id'])
    .where('id', '=', id)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  if (!row || !hasShopAccess(ctx.actor, row.shop_id)) throw Errors.notFound('自動枠止め', id);
  await ctx.trx
    .updateTable('sync_agents')
    .set({ revoked_at: new Date() })
    .where('id', '=', id)
    .execute();
  await audit(ctx, {
    action: 'integration.agent_revoke',
    resourceType: 'sync_agent',
    resourceId: id,
    shopId: row.shop_id,
    metadata: { by: auditUserId(ctx.actor) },
  });
}

/**
 * A connector just handed its slot blocking to the helper: ask for every upcoming booking of the
 * shop (bookings copied from the previous system included — they hold slots the medium may still sell).
 */
export async function requestUpcomingBlocks(
  ctx: Ctx,
  account: { id: string; shop_id: string | null },
) {
  if (!account.shop_id) return 0;
  const rows = await ctx.trx
    .selectFrom('appointments')
    .select('id')
    .where('shop_id', '=', account.shop_id)
    .where('status', 'in', [...ACTIVE_STATUSES])
    .where('deleted_at', 'is', null)
    .where('occupied_end_at', '>', new Date())
    .execute();
  const tag = `agent-${Date.now()}`;
  for (const r of rows) await enqueuePushJob(ctx, account.id, r.id, tag);
  return rows.length;
}

// ------------------------------------------------------------------ helper side

export interface AgentRow {
  id: string;
  organization_id: string;
  shop_id: string;
  name: string;
}

export async function authenticateAgent(authorization: string | undefined): Promise<AgentRow> {
  const token = /^Bearer\s+(sa_[A-Za-z0-9_-]{20,100})$/.exec(authorization ?? '')?.[1];
  if (!token)
    throw Errors.unauthenticated('自動枠止めのトークンがありません', 'AGENT_TOKEN_REQUIRED');
  const row = await withSystem((trx) =>
    trx
      .selectFrom('sync_agents')
      .select(['id', 'organization_id', 'shop_id', 'name'])
      .where('token_hash', '=', hashToken(token))
      .where('revoked_at', 'is', null)
      .executeTakeFirst(),
  );
  if (!row)
    throw Errors.unauthenticated(
      '自動枠止めのトークンが無効です（再発行してください）',
      'AGENT_TOKEN_INVALID',
    );
  return row;
}

const mediumStaff = z.object({ id: z.string().min(1).max(100), name: z.string().min(1).max(100) });
export const agentPlanSchema = z.object({
  media: z.partialRecord(
    z.enum(AGENT_PROVIDERS),
    z.object({ staff: z.array(mediumStaff).max(300) }),
  ),
});
export type AgentPlanInput = z.infer<typeof agentPlanSchema>;

export const agentReportSchema = z.object({
  agentVersion: z.string().max(40).optional(),
  status: z
    .partialRecord(
      z.enum(AGENT_PROVIDERS),
      z.object({ ok: z.boolean(), message: z.string().max(300).optional() }),
    )
    .default({}),
  results: z
    .array(
      z.object({
        blockId: uuid,
        /** the request as the helper saw it (it may have changed since) */
        state: z.enum(['action_required', 'remove_required']),
        start: isoDateTime.nullable().optional(),
        end: isoDateTime.nullable().optional(),
        ok: z.boolean(),
        /** what the helper changed on the medium (kept to undo it later) */
        record: z.unknown().optional(),
        error: z.string().max(300).optional(),
      }),
    )
    .max(500)
    .default([]),
});
export type AgentReportInput = z.infer<typeof agentReportSchema>;

const agentCtx = (agent: AgentRow, trx: Ctx['trx']): Ctx => ({
  actor: systemActor(agent.organization_id, `sync-agent:${agent.id}`),
  trx,
  meta: { traceId: `agent:${agent.id}` },
});

async function agentAccounts(
  ctx: Ctx,
  shopId: string,
  providers: readonly string[],
): Promise<AccountRow[]> {
  if (!providers.length) return [];
  const ids = await ctx.trx
    .selectFrom('integration_accounts')
    .select('id')
    .where('shop_id', '=', shopId)
    .where('provider', 'in', [...providers])
    .where('status', '!=', 'disabled')
    .execute();
  const rows = await Promise.all(ids.map((r) => loadAccountRow(ctx.trx, r.id)));
  return rows.filter((r): r is AccountRow => {
    if (!r) return false;
    const cfg = parseIntegrationConfig(r.config);
    return cfg.pushBlocks && !!cfg.mail?.agentManaged;
  });
}

function parseRecord(v: string | null): unknown {
  if (!v || !v.startsWith('{')) return null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

/** JST calendar day of a time */
const jstDay = (d: Date) => formatJst(d, 'yyyy-MM-dd');

export async function agentPlan(agent: AgentRow, input: AgentPlanInput) {
  return withTenant(agent.organization_id, async (trx) => {
    const ctx = agentCtx(agent, trx);
    const shop = await trx
      .selectFrom('shops')
      .select(['id', 'name', 'timezone'])
      .where('id', '=', agent.shop_id)
      .executeTakeFirstOrThrow();
    const accounts = await agentAccounts(ctx, agent.shop_id, Object.keys(input.media));
    const now = new Date();
    const out = [];
    for (const acc of accounts) {
      const provider = acc.provider as AgentProvider;
      // medium stylist → Salon OS staff, with the same name matching as the booking mails
      const toMedium = new Map<string, string>();
      const unmatched: string[] = [];
      for (const s of input.media[provider]?.staff ?? []) {
        const m = await resolveMappings(ctx, acc, { staffName: s.name, menuNames: [] });
        if (m.staff.staffId && !toMedium.has(m.staff.staffId)) toMedium.set(m.staff.staffId, s.id);
        else if (!m.staff.staffId) unmatched.push(s.name);
      }

      const rows = await trx
        .selectFrom('external_slot_blocks as b')
        .innerJoin('appointments as a', 'a.id', 'b.appointment_id')
        .leftJoin('staffs as s', 's.id', 'a.staff_id')
        .select([
          'b.id',
          'b.state',
          'b.block_start_at',
          'b.block_end_at',
          'b.external_block_id',
          'a.staff_id',
          's.display_name as staff_name',
        ])
        .where('b.integration_account_id', '=', acc.id)
        .where('b.manual', '=', true)
        .where('b.state', 'in', ['action_required', 'remove_required'])
        .orderBy('b.block_start_at')
        .limit(300)
        .execute();

      const tasks = [];
      for (const r of rows) {
        const record = parseRecord(r.external_block_id);
        // a slot already over needs nothing on the medium: close the request here
        if (r.block_end_at && r.block_end_at <= now) {
          await trx
            .updateTable('external_slot_blocks')
            .set(
              r.state === 'action_required'
                ? {
                    state: 'pushed',
                    external_block_id: r.external_block_id,
                    done_at: now,
                    last_error: null,
                  }
                : { state: 'removed', external_block_id: null, done_at: now, last_error: null },
            )
            .where('id', '=', r.id)
            .execute();
          continue;
        }
        tasks.push({
          id: r.id,
          state: r.state as 'action_required' | 'remove_required',
          start: r.block_start_at?.toISOString() ?? null,
          end: r.block_end_at?.toISOString() ?? null,
          staffId: r.staff_id,
          staffName: r.staff_name,
          mediumStaffId: r.staff_id ? (toMedium.get(r.staff_id) ?? null) : null,
          record,
        });
      }

      // busy times of the stylists on the days involved: a slot is not reopened while one of them needs it
      const days = new Set<string>();
      for (const t of tasks) {
        if (t.start) days.add(jstDay(new Date(t.start)));
        const rec = t.record as { date?: unknown } | null;
        if (rec && typeof rec.date === 'string') days.add(rec.date);
      }
      const busy: { mediumStaffId: string; start: string; end: string; appointmentId: string }[] =
        [];
      if (days.size && toMedium.size) {
        const sorted = [...days].sort();
        const from = new Date(`${sorted[0]}T00:00:00+09:00`);
        const to = new Date(new Date(`${sorted.at(-1)}T00:00:00+09:00`).getTime() + 24 * 3600_000);
        const appts = await trx
          .selectFrom('appointments')
          .select(['id', 'staff_id', 'occupied_start_at', 'occupied_end_at'])
          .where('shop_id', '=', agent.shop_id)
          .where('staff_id', 'in', [...toMedium.keys()])
          .where('status', 'in', [...ACTIVE_STATUSES])
          .where('deleted_at', 'is', null)
          .where('occupied_start_at', '<', to)
          .where('occupied_end_at', '>', from)
          .execute();
        for (const a of appts) {
          if (!days.has(jstDay(a.occupied_start_at))) continue;
          busy.push({
            mediumStaffId: toMedium.get(a.staff_id!)!,
            start: a.occupied_start_at.toISOString(),
            end: a.occupied_end_at.toISOString(),
            appointmentId: a.id,
          });
        }
      }
      out.push({
        id: acc.id,
        provider,
        displayName: acc.display_name,
        unmatchedStaff: unmatched,
        tasks,
        busy,
      });
    }
    return {
      shop: { id: shop.id, name: shop.name, timezone: shop.timezone },
      now: now.toISOString(),
      accounts: out,
    };
  });
}

export async function agentReport(agent: AgentRow, input: AgentReportInput) {
  return withTenant(agent.organization_id, async (trx) => {
    const now = new Date();
    let done = 0;
    let failed = 0;
    let stale = 0;
    for (const r of input.results) {
      const b = await trx
        .selectFrom('external_slot_blocks as b')
        .innerJoin('integration_accounts as ia', 'ia.id', 'b.integration_account_id')
        .select(['b.id', 'b.state', 'b.block_start_at', 'b.block_end_at', 'ia.shop_id'])
        .where('b.id', '=', r.blockId)
        .forUpdate()
        .executeTakeFirst();
      if (!b || b.shop_id !== agent.shop_id) continue;
      if (!r.ok) {
        failed++;
        if (b.state === r.state) {
          await trx
            .updateTable('external_slot_blocks')
            .set({ last_error: `自動枠止め: ${r.error ?? '失敗しました'}` })
            .where('id', '=', b.id)
            .execute();
        }
        continue;
      }
      const record =
        r.record === undefined || r.record === null
          ? null
          : JSON.stringify(r.record).slice(0, 8000);
      if (r.state === 'remove_required') {
        if (b.state !== 'remove_required') {
          stale++;
          continue;
        }
        await trx
          .updateTable('external_slot_blocks')
          .set({
            state: 'removed',
            external_block_id: null,
            done_at: now,
            done_by: null,
            last_error: null,
          })
          .where('id', '=', b.id)
          .execute();
        done++;
        continue;
      }
      // action_required: done only if the booking has not moved meanwhile; otherwise keep what was
      // closed so the next round reopens it and closes the new times
      const time = (v: string | Date | null | undefined) => (v ? new Date(v).getTime() : null);
      const sameTimes =
        time(b.block_start_at) === time(r.start) && time(b.block_end_at) === time(r.end);
      if (b.state === 'action_required' && sameTimes) {
        await trx
          .updateTable('external_slot_blocks')
          .set({
            state: 'pushed',
            external_block_id: record,
            pushed_at: now,
            done_at: now,
            done_by: null,
            last_error: null,
          })
          .where('id', '=', b.id)
          .execute();
        done++;
      } else {
        // what is closed on the medium now, whatever the request says
        await trx
          .updateTable('external_slot_blocks')
          .set({ external_block_id: record })
          .where('id', '=', b.id)
          .execute();
        stale++;
      }
    }
    const allOk = Object.values(input.status).every((s) => s?.ok);
    await trx
      .updateTable('sync_agents')
      .set({
        last_seen_at: now,
        last_report: JSON.stringify({
          at: now.toISOString(),
          agentVersion: input.agentVersion ?? null,
          status: input.status,
          done,
          failed,
          stale,
          allOk,
        }),
      })
      .where('id', '=', agent.id)
      .execute();
    return { done, failed, stale };
  });
}

// ------------------------------------------------------------------ watchdog: mail the shop when the helper stops

export const AGENT_WATCHDOG_JOB = 'integrations.agent_watchdog';

export async function runAgentWatchdog(now = new Date(), only?: string[]) {
  const agents = await withSystem((trx) => {
    let q = trx
      .selectFrom('sync_agents')
      .select([
        'id',
        'organization_id',
        'shop_id',
        'name',
        'last_seen_at',
        'last_report',
        'alerted_at',
      ])
      .where('revoked_at', 'is', null);
    if (only)
      q = q.where('id', 'in', only.length ? only : ['00000000-0000-0000-0000-000000000000']);
    return q.execute();
  });
  let alerted = 0;
  for (const agent of agents) {
    await withTenant(agent.organization_id, async (trx) => {
      const ctx = agentCtx(agent, trx);
      const accounts = await agentAccounts(ctx, agent.shop_id, AGENT_PROVIDERS);
      if (!accounts.length) return;
      const stuck = await trx
        .selectFrom('external_slot_blocks')
        .select(['integration_account_id', sql<number>`count(*)::int`.as('n')])
        .where(
          'integration_account_id',
          'in',
          accounts.map((a) => a.id),
        )
        .where('manual', '=', true)
        .where('state', 'in', ['action_required', 'remove_required'])
        // notified_at: when the request was (re)opened
        .where('notified_at', '<', new Date(now.getTime() - STUCK_MIN * 60_000))
        .groupBy('integration_account_id')
        .execute();
      const stuckCount = stuck.reduce((sum, r) => sum + r.n, 0);
      const report = (agent.last_report ?? {}) as {
        status?: Record<string, { ok: boolean; message?: string }>;
      };
      const loggedOut = Object.entries(report.status ?? {}).filter(([, s]) => !s.ok);
      const silent =
        !agent.last_seen_at || agent.last_seen_at.getTime() < now.getTime() - STALE_MIN * 60_000;
      const problem = silent || loggedOut.length > 0 || stuckCount > 0;
      if (!problem) {
        if (agent.alerted_at)
          await trx
            .updateTable('sync_agents')
            .set({ alerted_at: null })
            .where('id', '=', agent.id)
            .execute();
        return;
      }
      if (agent.alerted_at) return;
      const shop = await trx
        .selectFrom('shops')
        .select(['name', 'email'])
        .where('id', '=', agent.shop_id)
        .executeTakeFirst();
      const recipients = new Set<string>();
      for (const a of accounts)
        for (const e of parseIntegrationConfig(a.config).mail?.notifyEmails ?? [])
          recipients.add(e);
      if (!recipients.size && shop?.email) recipients.add(shop.email);
      const label = (p: string) => PROVIDER_PROFILES[p]?.label ?? p;
      const lines = [
        `${shop?.name ?? ''} の媒体の自動枠止め（${agent.name}）が止まっています。`,
        '',
        ...(silent
          ? [
              `・${agent.last_seen_at ? `${formatJst(agent.last_seen_at, 'M/d HH:mm')} から` : 'まだ一度も'}動いていません。Chrome が開いているか、Mac がスリープしていないか確認してください。`,
            ]
          : []),
        ...loggedOut.map(
          ([p, s]) =>
            `・${label(p)}: ${s.message ?? 'ログインが切れています'}。Chrome で${label(p)}にログインし直してください。`,
        ),
        ...(stuckCount
          ? [
              `・止められていない枠が ${stuckCount} 件あります。Salon OS の「外部連携 → 媒体の枠止め」で確認してください。`,
            ]
          : []),
        '',
        '直るまでは、媒体の枠を手で止めてください（ダブルブッキングの恐れがあります）。',
      ];
      for (const to of recipients) {
        await sendEmail({
          to,
          subject: `【要対応】媒体の自動枠止めが止まっています（${shop?.name ?? ''}）`,
          text: lines.join('\n'),
        });
      }
      await trx
        .updateTable('sync_agents')
        .set({ alerted_at: now })
        .where('id', '=', agent.id)
        .execute();
      alerted++;
    });
  }
  return alerted;
}

registerJob(AGENT_WATCHDOG_JOB, async () => {
  await runAgentWatchdog();
});
registerPeriodic({
  name: 'integrations.agent_watchdog',
  jobType: AGENT_WATCHDOG_JOB,
  bucket: everyMinutes(10),
});
