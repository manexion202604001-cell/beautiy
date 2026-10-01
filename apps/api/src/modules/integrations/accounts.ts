import { accessibleShopIds, auditUserId, hasShopAccess, requirePermission, type Ctx } from '../../auth/actor.js';
import { config as appConfig } from '../../config.js';
import type { Tx } from '../../db/tenant.js';
import { audit, diff } from '../../lib/audit.js';
import { decryptJson, encryptJson, randomToken } from '../../lib/crypto.js';
import { Errors } from '../../lib/errors.js';
import { getAdapter } from './adapters/registry.js';
import type { AdapterAccount, IntegrationConfig } from './adapters/types.js';
import { integrationConfigSchema, type CreateIntegrationInput, type UpdateIntegrationInput } from './schemas.js';

export const ACCOUNT_COLUMNS = [
  'integration_accounts.id',
  'integration_accounts.organization_id',
  'integration_accounts.shop_id',
  'integration_accounts.provider',
  'integration_accounts.display_name',
  'integration_accounts.status',
  'integration_accounts.config',
  'integration_accounts.encrypted_credentials',
  'integration_accounts.sync_cursor',
  'integration_accounts.last_synced_at',
  'integration_accounts.last_success_at',
  'integration_accounts.last_error',
  'integration_accounts.last_error_at',
  'integration_accounts.consecutive_failures',
  'integration_accounts.created_at',
  'integration_accounts.updated_at',
] as const;

export type AccountRow = {
  id: string;
  organization_id: string;
  shop_id: string | null;
  provider: string;
  display_name: string;
  status: string;
  config: unknown;
  encrypted_credentials: string | null;
  sync_cursor: string | null;
  last_synced_at: Date | null;
  last_success_at: Date | null;
  last_error: string | null;
  last_error_at: Date | null;
  consecutive_failures: number;
  created_at: Date;
  updated_at: Date;
};

export function parseIntegrationConfig(raw: unknown): IntegrationConfig {
  const parsed = integrationConfigSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : integrationConfigSchema.parse({});
}

/** API representation: credentials are never returned */
export function toPublicAccount(row: AccountRow) {
  const { encrypted_credentials, organization_id: _o, ...rest } = row;
  const config = parseIntegrationConfig(row.config);
  const adapter = getAdapter(row.provider);
  const inboundToken = adapter?.inboundEmail ? config.mail?.inboundToken : undefined;
  return {
    ...rest,
    config,
    hasCredentials: !!encrypted_credentials,
    pushMode: adapter?.pushMode ?? 'api',
    webhookUrl: inboundToken
      ? `${appConfig.API_BASE_URL}/v1/webhooks/inbound_email/${inboundToken}`
      : `${appConfig.API_BASE_URL}/v1/webhooks/${row.provider}/${row.id}`,
    inboundEmail: adapter?.inboundEmail ? { webhookUrl: `${appConfig.API_BASE_URL}/v1/webhooks/inbound_email/${inboundToken}` } : null,
  };
}

export function toAdapterAccount(row: AccountRow): AdapterAccount {
  let credentials: Record<string, unknown> = {};
  if (row.encrypted_credentials) {
    try {
      credentials = decryptJson<Record<string, unknown>>(row.encrypted_credentials);
    } catch {
      credentials = {};
    }
  }
  return { id: row.id, organizationId: row.organization_id, shopId: row.shop_id, provider: row.provider, credentials, config: parseIntegrationConfig(row.config) };
}

export async function loadAccountRow(trx: Tx, id: string, opts: { forUpdate?: boolean } = {}): Promise<AccountRow | undefined> {
  let q = trx.selectFrom('integration_accounts').select(ACCOUNT_COLUMNS).where('integration_accounts.id', '=', id);
  if (opts.forUpdate) q = q.forUpdate();
  return q.executeTakeFirst() as Promise<AccountRow | undefined>;
}

/** Staff-facing lookup: 404 when missing or outside the caller's shops (no existence leak) */
export async function getVisibleAccount(ctx: Ctx, id: string, opts: { forUpdate?: boolean } = {}): Promise<AccountRow> {
  const row = await loadAccountRow(ctx.trx, id, opts);
  if (!row || !hasShopAccess(ctx.actor, row.shop_id)) throw Errors.notFound('外部連携', id);
  return row;
}

async function validateMappings(ctx: Ctx, shopId: string | null, cfg: Partial<IntegrationConfig>) {
  const staffIds = [...new Set(Object.values(cfg.staffMap ?? {}))];
  if (staffIds.length) {
    const rows = await ctx.trx.selectFrom('staffs').select('id').where('id', 'in', staffIds).where('deleted_at', 'is', null).execute();
    const missing = staffIds.filter((id) => !rows.some((r) => r.id === id));
    if (missing.length) throw Errors.validation('スタッフ対応表に存在しないスタッフが含まれています', { staffIds: missing });
  }
  const menuIds = [...new Set(Object.values(cfg.menuMap ?? {}))];
  if (menuIds.length) {
    const rows = await ctx.trx.selectFrom('menus').select('id').where('id', 'in', menuIds).where('deleted_at', 'is', null).execute();
    const missing = menuIds.filter((id) => !rows.some((r) => r.id === id));
    if (missing.length) throw Errors.validation('メニュー対応表に存在しないメニューが含まれています', { menuIds: missing });
  }
  void shopId;
}

export async function listIntegrations(ctx: Ctx) {
  requirePermission(ctx.actor, 'integration.manage');
  const shops = accessibleShopIds(ctx.actor);
  let q = ctx.trx.selectFrom('integration_accounts').select(ACCOUNT_COLUMNS).orderBy('integration_accounts.created_at');
  if (shops) q = q.where('integration_accounts.shop_id', 'in', shops.length ? [...shops] : ['00000000-0000-0000-0000-000000000000']);
  const rows = (await q.execute()) as AccountRow[];
  return rows.map(toPublicAccount);
}

export async function getIntegration(ctx: Ctx, id: string) {
  requirePermission(ctx.actor, 'integration.manage');
  return toPublicAccount(await getVisibleAccount(ctx, id));
}

export async function createIntegration(ctx: Ctx, input: CreateIntegrationInput) {
  requirePermission(ctx.actor, 'integration.manage');
  if (!hasShopAccess(ctx.actor, input.shopId)) throw Errors.forbidden('この店舗へのアクセス権がありません', 'SHOP_FORBIDDEN', { shopId: input.shopId });
  if (!getAdapter(input.provider)) throw Errors.validation('未対応の連携先です', { provider: input.provider });
  const shop = await ctx.trx.selectFrom('shops').select('id').where('id', '=', input.shopId).where('deleted_at', 'is', null).executeTakeFirst();
  if (!shop) throw Errors.notFound('店舗', input.shopId);
  await validateMappings(ctx, input.shopId, input.config);
  const dup = await ctx.trx.selectFrom('integration_accounts').select('id').where('provider', '=', input.provider).where('shop_id', '=', input.shopId).executeTakeFirst();
  if (dup) throw Errors.conflict('INTEGRATION_EXISTS', 'この店舗には同じ連携先が既に登録されています', { integrationAccountId: dup.id });
  const config = getAdapter(input.provider)!.inboundEmail
    ? { ...input.config, mail: { ...(input.config.mail ?? {}), inboundToken: input.config.mail?.inboundToken ?? randomToken(24) } }
    : input.config;
  const row = await ctx.trx
    .insertInto('integration_accounts')
    .values({
      organization_id: ctx.actor.organizationId,
      shop_id: input.shopId,
      provider: input.provider,
      display_name: input.displayName,
      encrypted_credentials: input.credentials ? encryptJson(input.credentials) : null,
      config: JSON.stringify(config),
      created_by: auditUserId(ctx.actor),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await audit(ctx, {
    action: 'integration.create',
    resourceType: 'integration_account',
    resourceId: row.id,
    shopId: input.shopId,
    after: { provider: input.provider, displayName: input.displayName, config: input.config, credentials: input.credentials ? '[REDACTED]' : null },
  });
  return toPublicAccount((await loadAccountRow(ctx.trx, row.id))!);
}

export async function updateIntegration(ctx: Ctx, id: string, input: UpdateIntegrationInput) {
  requirePermission(ctx.actor, 'integration.manage');
  const before = await getVisibleAccount(ctx, id, { forUpdate: true });
  const beforeConfig = parseIntegrationConfig(before.config);
  // mail settings merge field-by-field so a partial update never drops the inbound token
  const mergedMail = input.config?.mail ? { ...(beforeConfig.mail ?? {}), ...input.config.mail } : beforeConfig.mail;
  const nextConfig = input.config ? integrationConfigSchema.parse({ ...beforeConfig, ...input.config, mail: mergedMail }) : beforeConfig;
  if (input.config) await validateMappings(ctx, before.shop_id, input.config);
  const patch: Record<string, unknown> = {
    display_name: input.displayName,
    config: input.config ? JSON.stringify(nextConfig) : undefined,
    encrypted_credentials: input.credentials ? encryptJson(input.credentials) : undefined,
  };
  if (input.status === 'disabled') patch.status = 'disabled';
  if (input.status === 'active' && before.status === 'disabled') Object.assign(patch, { status: 'active', consecutive_failures: 0 });
  await ctx.trx.updateTable('integration_accounts').set(patch).where('id', '=', id).execute();
  const after = (await loadAccountRow(ctx.trx, id))!;
  const d = diff(
    { display_name: before.display_name, status: before.status, config: beforeConfig },
    { display_name: after.display_name, status: after.status, config: parseIntegrationConfig(after.config) },
  );
  await audit(ctx, {
    action: 'integration.update',
    resourceType: 'integration_account',
    resourceId: id,
    shopId: before.shop_id,
    before: d.before,
    after: d.after,
    metadata: input.credentials ? { credentialsRotated: true } : {},
  });
  return toPublicAccount(after);
}

export async function disableIntegration(ctx: Ctx, id: string) {
  requirePermission(ctx.actor, 'integration.manage');
  const before = await getVisibleAccount(ctx, id, { forUpdate: true });
  await ctx.trx.updateTable('integration_accounts').set({ status: 'disabled' }).where('id', '=', id).execute();
  await audit(ctx, { action: 'integration.disable', resourceType: 'integration_account', resourceId: id, shopId: before.shop_id, before: { status: before.status }, after: { status: 'disabled' } });
}

export async function testIntegration(ctx: Ctx, id: string) {
  requirePermission(ctx.actor, 'integration.manage');
  const row = await getVisibleAccount(ctx, id);
  const adapter = getAdapter(row.provider);
  if (!adapter) throw Errors.business('ADAPTER_UNAVAILABLE', 'この連携先のアダプタが利用できません');
  let result: { ok: boolean; message?: string; latencyMs?: number };
  try {
    result = await adapter.health(toAdapterAccount(row));
  } catch (err) {
    result = { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  await audit(ctx, { action: 'integration.test', resourceType: 'integration_account', resourceId: id, shopId: row.shop_id, metadata: { ok: result.ok, message: result.message ?? null } });
  return { ...result, checkedAt: new Date().toISOString() };
}
