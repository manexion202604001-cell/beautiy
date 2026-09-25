// External booking site adapter contract. Provider payloads are normalized
// into ExternalBooking before any domain write happens.
import { hmacHex, safeEqual } from '../crypto';

export interface ExternalBooking {
  externalId: string;
  /** Monotonic version (e.g. updated_at epoch) to discard stale/out-of-order events. */
  version?: number;
  shopExternalId?: string;
  staffExternalId?: string;
  customer: { name: string; kana?: string; phone?: string; email?: string; externalCustomerId?: string };
  startAt: string; // ISO8601
  endAt: string;
  status: 'confirmed' | 'cancelled';
  menuNames?: string[];
  totalPrice?: number;
  note?: string;
}

export interface NormalizedEvent { eventId: string; type: string; bookings: ExternalBooking[] }

export interface BookingProviderAdapter {
  provider: string;
  label: string;
  /** true when this adapter talks to a real provider API; false for placeholders. */
  live: boolean;
  verifyWebhook(headers: Record<string, string>, rawBody: string, secret: string | undefined): boolean;
  normalizeWebhook(rawBody: string): NormalizedEvent;
  pushBooking?(booking: ExternalBooking, config: Record<string, unknown>): Promise<{ externalId: string }>;
  cancelBooking?(externalId: string, config: Record<string, unknown>): Promise<void>;
  pushAvailability?(fromISO: string, toISO: string, config: Record<string, unknown>): Promise<void>;
}

export class NormalizeError extends Error {}

function req<T>(v: T | undefined | null, name: string): T {
  if (v === undefined || v === null || v === '') throw new NormalizeError(`missing field: ${name}`);
  return v;
}

function asIso(v: unknown, name: string): string {
  const s = String(req(v, name));
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new NormalizeError(`invalid datetime: ${name}`);
  return new Date(t).toISOString();
}

/**
 * Generic JSON contract used by the GENERIC adapter and as the placeholder shape
 * for sites without public APIs (bridged by a partner/RPA relay).
 * Body: { event_id, type, booking: { id, version?, shop_id?, staff_id?, status, start_at, end_at,
 *          customer: { name, kana?, phone?, email?, id? }, menus?: string[], price?, note? } }
 * Signature: X-Salonos-Signature: sha256=<hex HMAC(secret, rawBody)>
 */
export function normalizeGeneric(rawBody: string): NormalizedEvent {
  let j: any;
  try { j = JSON.parse(rawBody); } catch { throw new NormalizeError('invalid JSON'); }
  const b = req(j.booking, 'booking');
  const status = String(b.status ?? 'confirmed').toLowerCase();
  const booking: ExternalBooking = {
    externalId: String(req(b.id, 'booking.id')),
    version: b.version !== undefined ? Number(b.version) : undefined,
    shopExternalId: b.shop_id ? String(b.shop_id) : undefined,
    staffExternalId: b.staff_id ? String(b.staff_id) : undefined,
    customer: {
      name: String(req(b.customer?.name, 'booking.customer.name')),
      kana: b.customer?.kana ? String(b.customer.kana) : undefined,
      phone: b.customer?.phone ? String(b.customer.phone) : undefined,
      email: b.customer?.email ? String(b.customer.email) : undefined,
      externalCustomerId: b.customer?.id ? String(b.customer.id) : undefined,
    },
    startAt: asIso(b.start_at, 'booking.start_at'),
    endAt: asIso(b.end_at, 'booking.end_at'),
    status: status === 'cancelled' || status === 'canceled' ? 'cancelled' : 'confirmed',
    menuNames: Array.isArray(b.menus) ? b.menus.map(String) : undefined,
    totalPrice: b.price !== undefined ? Number(b.price) : undefined,
    note: b.note ? String(b.note) : undefined,
  };
  if (Date.parse(booking.endAt) <= Date.parse(booking.startAt)) throw new NormalizeError('end_at must be after start_at');
  return { eventId: String(req(j.event_id, 'event_id')), type: String(j.type ?? 'booking.upsert'), bookings: [booking] };
}

export function verifyGenericSignature(headers: Record<string, string>, rawBody: string, secret: string | undefined): boolean {
  if (!secret) return false;
  const sig = headers['x-salonos-signature'] ?? '';
  const expected = `sha256=${hmacHex(secret, rawBody)}`;
  return safeEqual(sig, expected);
}

function placeholder(provider: string, label: string): BookingProviderAdapter {
  return {
    provider, label, live: false,
    verifyWebhook: verifyGenericSignature,
    normalizeWebhook: normalizeGeneric,
  };
}

export const BOOKING_ADAPTERS: Record<string, BookingProviderAdapter> = {
  GENERIC: { ...placeholder('GENERIC', '汎用Webhook'), live: true },
  HOTPEPPER: placeholder('HOTPEPPER', 'ホットペッパービューティー（連携プレースホルダ）'),
  MINIMO: placeholder('MINIMO', 'minimo（連携プレースホルダ）'),
  RAKUTEN: placeholder('RAKUTEN', '楽天ビューティ（連携プレースホルダ）'),
  OTHER: placeholder('OTHER', 'その他予約サイト'),
};

export function getBookingAdapter(provider: string): BookingProviderAdapter | null {
  return BOOKING_ADAPTERS[provider.toUpperCase()] ?? null;
}
