import { sql } from 'kysely';
import { accessibleShopIds, assertShopAccess, requirePermission, type Ctx } from '../../auth/actor.js';
import { config } from '../../config.js';
import { audit } from '../../lib/audit.js';
import { decrypt, encrypt } from '../../lib/crypto.js';
import { Errors } from '../../lib/errors.js';
import { LineApiError, lineGetBotInfo } from './providers/line.js';
import type { CreateLineChannelInput, UpdateLineChannelInput } from './schemas.js';

/**
 * LINE official accounts (要件 23.1: 法人単位 shop_id NULL / 店舗単位 の両対応).
 * Secrets are stored encrypted (AES-256-GCM) and never returned by the API.
 */
const publicColumns = [
  'id',
  'shop_id',
  'channel_id',
  'bot_user_id',
  'name',
  'basic_id',
  'liff_id',
  'login_channel_id',
  'status',
  'webhook_verified_at',
  'created_at',
  'updated_at',
  'encrypted_channel_secret',
  'encrypted_access_token',
] as const;

type ChannelRow = {
  id: string;
  shop_id: string | null;
  channel_id: string;
  bot_user_id: string | null;
  name: string;
  basic_id: string | null;
  liff_id: string | null;
  login_channel_id: string | null;
  status: string;
  webhook_verified_at: Date | null;
  created_at: Date;
  updated_at: Date;
  encrypted_channel_secret: string;
  encrypted_access_token: string;
};

function mask(secret: string): string {
  return secret.length <= 4 ? '****' : `****${secret.slice(-4)}`;
}

function safeDecrypt(v: string): string {
  try {
    return decrypt(v);
  } catch {
    return '';
  }
}

function toApi(row: ChannelRow) {
  const { encrypted_channel_secret, encrypted_access_token, ...rest } = row;
  return {
    ...rest,
    channelSecretMasked: mask(safeDecrypt(encrypted_channel_secret)),
    accessTokenMasked: mask(safeDecrypt(encrypted_access_token)),
    webhookUrl: `${config.API_BASE_URL}/v1/webhooks/line`,
  };
}

async function fetchBotInfo(accessToken: string) {
  try {
    return await lineGetBotInfo(accessToken);
  } catch (err) {
    if (err instanceof LineApiError && !err.retryable) {
      throw Errors.business('LINE_CREDENTIALS_INVALID', 'LINEチャネルの認証に失敗しました。チャネルアクセストークンを確認してください', { status: err.status });
    }
    throw Errors.external('line', 'LINE APIに接続できませんでした。しばらくしてから再試行してください');
  }
}

export async function listLineChannels(ctx: Ctx) {
  requirePermission(ctx.actor, 'integration.manage');
  let q = ctx.trx.selectFrom('line_channels').select(publicColumns);
  const shops = accessibleShopIds(ctx.actor);
  if (shops) q = q.where((eb) => eb.or([eb('shop_id', 'is', null), ...(shops.length ? [eb('shop_id', 'in', shops)] : [])]));
  const rows = await q.orderBy(sql`shop_id IS NOT NULL`).orderBy('created_at').execute();
  return rows.map((r) => toApi(r as ChannelRow));
}

async function loadChannel(ctx: Ctx, id: string) {
  const row = await ctx.trx.selectFrom('line_channels').select(publicColumns).where('id', '=', id).executeTakeFirst();
  if (!row) throw Errors.notFound('LINEチャネル', id);
  assertShopAccess(ctx.actor, row.shop_id);
  return row as ChannelRow;
}

export async function getLineChannel(ctx: Ctx, id: string) {
  requirePermission(ctx.actor, 'integration.manage');
  return toApi(await loadChannel(ctx, id));
}

function requireOrgScopeForOrgChannel(ctx: Ctx, shopId: string | null | undefined) {
  if (shopId) assertShopAccess(ctx.actor, shopId);
  else if (accessibleShopIds(ctx.actor)) throw Errors.forbidden('法人単位のLINEチャネル設定には全店舗権限が必要です');
}

/** The bot info call (network) happens before the DB transaction in the route */
export async function prepareLineChannelCreate(input: CreateLineChannelInput) {
  if (input.botUserId || !input.verify) return { botUserId: input.botUserId ?? null, basicId: input.basicId ?? null, verified: false };
  const info = await fetchBotInfo(input.accessToken);
  return { botUserId: info.userId, basicId: input.basicId ?? info.basicId ?? null, verified: true };
}

export async function createLineChannel(ctx: Ctx, input: CreateLineChannelInput, verified: { botUserId: string | null; basicId: string | null; verified: boolean }) {
  requirePermission(ctx.actor, 'integration.manage');
  requireOrgScopeForOrgChannel(ctx, input.shopId);
  const existing = await ctx.trx
    .selectFrom('line_channels')
    .select('id')
    .where('status', '!=', 'disabled')
    .where((eb) => (input.shopId ? eb('shop_id', '=', input.shopId) : eb('shop_id', 'is', null)))
    .executeTakeFirst();
  if (existing) {
    throw Errors.conflict('LINE_CHANNEL_EXISTS', input.shopId ? 'この店舗には既にLINEチャネルが設定されています' : '法人共通のLINEチャネルは既に設定されています');
  }
  const row = await ctx.trx
    .insertInto('line_channels')
    .values({
      organization_id: ctx.actor.organizationId,
      shop_id: input.shopId ?? null,
      channel_id: input.channelId,
      bot_user_id: verified.botUserId,
      name: input.name,
      basic_id: verified.basicId,
      liff_id: input.liffId ?? null,
      login_channel_id: input.loginChannelId ?? null,
      encrypted_channel_secret: encrypt(input.channelSecret),
      encrypted_access_token: encrypt(input.accessToken),
      status: 'active',
    })
    .returning(publicColumns)
    .executeTakeFirstOrThrow();
  await audit(ctx, {
    action: 'line_channel.create',
    resourceType: 'line_channel',
    resourceId: row.id,
    shopId: row.shop_id,
    after: { channelId: input.channelId, name: input.name, shopId: input.shopId ?? null, verified: verified.verified },
  });
  return toApi(row as ChannelRow);
}

export async function updateLineChannel(ctx: Ctx, id: string, input: UpdateLineChannelInput) {
  requirePermission(ctx.actor, 'integration.manage');
  const before = await loadChannel(ctx, id);
  requireOrgScopeForOrgChannel(ctx, before.shop_id);
  const row = await ctx.trx
    .updateTable('line_channels')
    .set({
      name: input.name,
      bot_user_id: input.botUserId,
      basic_id: input.basicId,
      liff_id: input.liffId,
      login_channel_id: input.loginChannelId,
      status: input.status,
      encrypted_channel_secret: input.channelSecret ? encrypt(input.channelSecret) : undefined,
      encrypted_access_token: input.accessToken ? encrypt(input.accessToken) : undefined,
    })
    .where('id', '=', id)
    .returning(publicColumns)
    .executeTakeFirstOrThrow();
  const { channelSecret, accessToken, ...visible } = input;
  await audit(ctx, {
    action: 'line_channel.update',
    resourceType: 'line_channel',
    resourceId: id,
    shopId: row.shop_id,
    after: { ...visible, ...(channelSecret ? { channelSecret: '[CHANGED]' } : {}), ...(accessToken ? { accessToken: '[CHANGED]' } : {}) },
  });
  return toApi(row as ChannelRow);
}

/** Channels referenced by message history are disabled instead of deleted */
export async function deleteLineChannel(ctx: Ctx, id: string) {
  requirePermission(ctx.actor, 'integration.manage');
  const before = await loadChannel(ctx, id);
  requireOrgScopeForOrgChannel(ctx, before.shop_id);
  const used = await ctx.trx.selectFrom('messages').select('id').where('line_channel_id', '=', id).limit(1).executeTakeFirst();
  if (used) {
    await ctx.trx.updateTable('line_channels').set({ status: 'disabled' }).where('id', '=', id).execute();
  } else {
    await ctx.trx.deleteFrom('line_channels').where('id', '=', id).execute();
  }
  await audit(ctx, { action: 'line_channel.delete', resourceType: 'line_channel', resourceId: id, shopId: before.shop_id, metadata: { disabledOnly: !!used } });
}

/** Load the access token for a verification call (permission + shop checks), outside of the network call */
export async function channelTokenForVerify(ctx: Ctx, id: string) {
  requirePermission(ctx.actor, 'integration.manage');
  const row = await loadChannel(ctx, id);
  return decrypt(row.encrypted_access_token);
}

export async function verifyLineChannelCredentials(accessToken: string) {
  return fetchBotInfo(accessToken);
}

export async function recordVerification(ctx: Ctx, id: string, info: { userId: string; basicId?: string }) {
  const row = await ctx.trx
    .updateTable('line_channels')
    .set({ bot_user_id: info.userId, basic_id: info.basicId ?? null, status: 'active' })
    .where('id', '=', id)
    .returning(publicColumns)
    .executeTakeFirstOrThrow();
  await audit(ctx, { action: 'line_channel.verify', resourceType: 'line_channel', resourceId: id, shopId: row.shop_id, metadata: { botUserId: info.userId } });
  return { ok: true as const, botUserId: info.userId, basicId: info.basicId ?? null, channel: toApi(row as ChannelRow) };
}

// ---------------------------------------------------------------- internal lookups (delivery / webhooks / linking)

export interface ActiveChannel {
  id: string;
  shopId: string | null;
  channelId: string;
  loginChannelId: string | null;
  liffId: string | null;
  accessToken: () => string;
}

function toActive(r: { id: string; shop_id: string | null; channel_id: string; login_channel_id: string | null; liff_id: string | null; encrypted_access_token: string }): ActiveChannel {
  return { id: r.id, shopId: r.shop_id, channelId: r.channel_id, loginChannelId: r.login_channel_id, liffId: r.liff_id, accessToken: () => decrypt(r.encrypted_access_token) };
}

/** Shop channel wins over the organization channel */
export async function channelForShop(ctx: Ctx, shopId: string | null): Promise<ActiveChannel | null> {
  const row = await ctx.trx
    .selectFrom('line_channels')
    .select(['id', 'shop_id', 'channel_id', 'login_channel_id', 'liff_id', 'encrypted_access_token'])
    .where('status', '=', 'active')
    .where((eb) => (shopId ? eb.or([eb('shop_id', '=', shopId), eb('shop_id', 'is', null)]) : eb('shop_id', 'is', null)))
    .orderBy(sql`CASE WHEN shop_id IS NULL THEN 1 ELSE 0 END`)
    .limit(1)
    .executeTakeFirst();
  return row ? toActive(row) : null;
}

export async function channelById(ctx: Ctx, id: string): Promise<ActiveChannel | null> {
  const row = await ctx.trx
    .selectFrom('line_channels')
    .select(['id', 'shop_id', 'channel_id', 'login_channel_id', 'liff_id', 'encrypted_access_token', 'status'])
    .where('id', '=', id)
    .executeTakeFirst();
  return row && row.status !== 'disabled' ? toActive(row) : null;
}

/**
 * LINE recipient for a customer: a following identity on an active channel that serves the shop
 * (shop channel preferred, then organization channel; any channel when the message has no shop).
 */
export async function lineRecipientFor(ctx: Ctx, customerId: string, shopId: string | null) {
  const row = await ctx.trx
    .selectFrom('customer_identities as ci')
    .innerJoin('line_channels as lc', (j) => j.onRef('lc.channel_id', '=', 'ci.provider_account_id'))
    .select(['ci.external_id', 'lc.id', 'lc.shop_id', 'lc.channel_id', 'lc.login_channel_id', 'lc.liff_id', 'lc.encrypted_access_token'])
    .where('ci.customer_id', '=', customerId)
    .where('ci.provider', '=', 'line')
    .where('ci.unlinked_at', 'is', null)
    .where('ci.is_following', '=', true)
    .where('lc.status', '=', 'active')
    .where((eb) => (shopId ? eb.or([eb('lc.shop_id', '=', shopId), eb('lc.shop_id', 'is', null)]) : eb.lit(true)))
    .orderBy(sql`CASE WHEN lc.shop_id IS NULL THEN 1 ELSE 0 END`)
    .orderBy('ci.updated_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row ? { userId: row.external_id, channel: toActive(row) } : null;
}
