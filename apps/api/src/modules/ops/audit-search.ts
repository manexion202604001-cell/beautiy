import { sql } from 'kysely';
import { accessibleShopIds, assertShopAccess, requirePermission, type Ctx } from '../../auth/actor.js';
import { audit } from '../../lib/audit.js';
import { decodeCursor, encodeCursor } from '../../lib/pagination.js';
import type { AuditSearchInput } from './schemas.js';

/**
 * 監査ログ検索 (要件 16: 誰がいつ何を閲覧・変更したか). Cursor by id desc.
 * Staff limited to some shops only see entries recorded for those shops.
 * The search itself is audited (audit_log.search) — reading the audit trail is sensitive too.
 */
export async function searchAuditLogs(ctx: Ctx, input: AuditSearchInput) {
  requirePermission(ctx.actor, 'audit.read');
  let q = ctx.trx
    .selectFrom('audit_logs as al')
    .leftJoin('staffs', (j) => j.onRef('staffs.id', '=', 'al.actor_id').on('al.actor_type', '=', 'staff'))
    .leftJoin('shops', 'shops.id', 'al.shop_id')
    .select([
      'al.id',
      'al.created_at',
      'al.actor_type',
      'al.actor_id',
      'al.action',
      'al.resource_type',
      'al.resource_id',
      'al.shop_id',
      'shops.name as shop_name',
      'al.before',
      'al.after',
      'al.metadata',
      sql<string | null>`host(al.ip)`.as('ip'),
      'al.user_agent',
      'al.request_id',
      'al.trace_id',
      sql<string | null>`CASE al.actor_type WHEN 'staff' THEN staffs.display_name WHEN 'system' THEN 'システム' WHEN 'customer' THEN 'お客様' ELSE NULL END`.as('actor_name'),
    ])
    .where('al.organization_id', '=', ctx.actor.organizationId);

  const shops = accessibleShopIds(ctx.actor);
  if (shops) q = q.where('al.shop_id', 'in', shops.length ? [...shops] : ['00000000-0000-0000-0000-000000000000']);
  if (input.shopId) {
    assertShopAccess(ctx.actor, input.shopId);
    q = q.where('al.shop_id', '=', input.shopId);
  }
  if (input.actorId) q = q.where('al.actor_id', '=', input.actorId);
  if (input.action) {
    q = input.action.endsWith('*') ? q.where('al.action', 'like', `${input.action.slice(0, -1).replace(/[%_\\]/g, '\\$&')}%`) : q.where('al.action', '=', input.action);
  }
  if (input.resourceType) q = q.where('al.resource_type', '=', input.resourceType);
  if (input.resourceId) q = q.where('al.resource_id', '=', input.resourceId);
  if (input.from) q = q.where('al.created_at', '>=', new Date(input.from));
  if (input.to) q = q.where('al.created_at', '<', new Date(input.to));
  const cursor = decodeCursor(input.cursor);
  if (cursor) q = q.where('al.id', '<', Number(cursor.id));

  const rows = await q.orderBy('al.id', 'desc').limit(input.limit + 1).execute();
  const hasMore = rows.length > input.limit;
  const items = (hasMore ? rows.slice(0, input.limit) : rows).map((r) => ({ ...r, id: String(r.id) }));
  const last = items[items.length - 1];

  const { cursor: _c, limit: _l, ...filters } = input;
  await audit(ctx, { action: 'audit_log.search', resourceType: 'audit_log', metadata: { filters, resultCount: items.length } });
  return { items, nextCursor: hasMore && last ? encodeCursor(null, last.id) : null };
}
