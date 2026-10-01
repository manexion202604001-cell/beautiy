import { actorId, actorUserId, type Ctx } from '../auth/actor.js';

export interface AuditEntry {
  action: string; // e.g. customer.view, customer.update, export.csv, role.change, sales.view
  resourceType: string;
  resourceId?: string | null;
  shopId?: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
}

/** Fields never written to audit before/after snapshots */
const REDACT = new Set(['password_hash', 'encrypted_credentials', 'encrypted_channel_secret', 'encrypted_access_token', 'code_hash', 'token_hash', 'refresh_token_hash', 'client_secret']);

function redact(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value ?? null;
  if (Array.isArray(value)) return value.map(redact);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACT.has(k) ? '[REDACTED]' : v instanceof Date ? v.toISOString() : v;
  }
  return out;
}

/** Only keep changed keys for update diffs */
export function diff(before: Record<string, unknown>, after: Record<string, unknown>) {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === 'updated_at' || key === 'version') continue;
    const bv = before[key] instanceof Date ? (before[key] as Date).toISOString() : before[key];
    const av = after[key] instanceof Date ? (after[key] as Date).toISOString() : after[key];
    if (JSON.stringify(bv) !== JSON.stringify(av)) {
      b[key] = bv;
      a[key] = av;
    }
  }
  return { before: b, after: a };
}

/** Write an audit log row inside the caller's transaction (atomic with the change it records) */
export async function audit(ctx: Ctx, entry: AuditEntry): Promise<void> {
  const actorType = ctx.actor.kind === 'staff' ? 'staff' : ctx.actor.kind === 'customer' ? 'customer' : 'system';
  await ctx.trx
    .insertInto('audit_logs')
    .values({
      organization_id: ctx.actor.organizationId,
      actor_type: actorType,
      actor_id: actorId(ctx.actor),
      actor_user_id: actorUserId(ctx.actor),
      action: entry.action,
      resource_type: entry.resourceType,
      resource_id: entry.resourceId ?? null,
      shop_id: entry.shopId ?? null,
      before: entry.before === undefined ? null : JSON.stringify(redact(entry.before)),
      after: entry.after === undefined ? null : JSON.stringify(redact(entry.after)),
      metadata: JSON.stringify(entry.metadata ?? {}),
      ip: ctx.meta.ip ?? null,
      user_agent: ctx.meta.userAgent ?? null,
      request_id: ctx.meta.requestId ?? null,
      trace_id: ctx.meta.traceId ?? null,
    })
    .execute();
}
