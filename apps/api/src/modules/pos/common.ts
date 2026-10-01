import { DateTime } from 'luxon';
import type { Ctx } from '../../auth/actor.js';
import { Errors } from '../../lib/errors.js';
import { parseShopSettings, type ShopSettings } from '../../lib/shop-settings.js';

/**
 * Gapless counter (transaction / receipt numbers). The row lock taken by the upsert is held until
 * the surrounding transaction commits, so concurrent completions serialize, and a rollback
 * releases the number again — no gaps, no duplicates.
 */
export async function nextCounter(ctx: Ctx, scope: string): Promise<number> {
  const row = await ctx.trx
    .insertInto('counters')
    .values({ organization_id: ctx.actor.organizationId, scope, value: 1 })
    .onConflict((oc) => oc.columns(['organization_id', 'scope']).doUpdateSet((eb) => ({ value: eb('counters.value', '+', 1) })))
    .returning('value')
    .executeTakeFirstOrThrow();
  return Number(row.value);
}

export function formatNumber(prefix: string, year: string, n: number) {
  return `${prefix}${year}-${String(n).padStart(6, '0')}`;
}

export function localYear(instant: Date, tz: string): string {
  return String(DateTime.fromJSDate(instant, { zone: tz }).year);
}

export interface PosShop {
  id: string;
  name: string;
  timezone: string;
  phone: string | null;
  postal_code: string | null;
  prefecture: string | null;
  city: string | null;
  address_line: string | null;
  settings: ShopSettings;
}

export async function loadPosShop(ctx: Ctx, shopId: string): Promise<PosShop> {
  const s = await ctx.trx
    .selectFrom('shops')
    .select(['id', 'name', 'timezone', 'phone', 'postal_code', 'prefecture', 'city', 'address_line', 'settings'])
    .where('id', '=', shopId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (!s) throw Errors.notFound('店舗', shopId);
  return { ...s, settings: parseShopSettings(s.settings) };
}

export async function findOpenSession(ctx: Ctx, shopId: string) {
  return (await ctx.trx.selectFrom('register_sessions').selectAll().where('shop_id', '=', shopId).where('status', '=', 'open').executeTakeFirst()) ?? null;
}

export const METHOD_LABELS: Record<string, string> = {
  cash: '現金',
  card: 'クレジットカード',
  emoney: '電子マネー',
  qr: 'QR決済',
  custom: '店舗独自決済',
  point: 'ポイント',
  online: 'オンライン決済',
};

/** statuses that count as a sale */
export const SOLD_STATUSES = ['completed', 'partially_refunded', 'refunded'] as const;
/** payment statuses that captured money */
export const CAPTURED = ['succeeded', 'partially_refunded', 'refunded'] as const;
