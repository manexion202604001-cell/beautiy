import type { Tx } from '../db/tenant.js';
import { Errors } from '../lib/errors.js';
import type { Permission } from './permissions.js';

export interface StaffActor {
  kind: 'staff';
  organizationId: string;
  userId: string;
  staffId: string;
  displayName: string;
  roleKey: string;
  permissions: ReadonlySet<string>;
  /** Shops this staff is assigned to (active assignments) */
  shopIds: readonly string[];
  /** true when role grants scope.all_shops */
  allShops: boolean;
}

export interface CustomerActor {
  kind: 'customer';
  organizationId: string;
  customerId: string;
  /** how the customer authenticated: LIFF id token / OTP / access link */
  via: 'line' | 'otp' | 'link';
}

export interface SystemActor {
  kind: 'system';
  organizationId: string;
  label: string;
}

export type Actor = StaffActor | CustomerActor | SystemActor;

export interface RequestMeta {
  requestId?: string;
  traceId?: string;
  ip?: string;
  userAgent?: string;
  /** Currently selected shop (X-Shop-Id header) — UI context only, not an authorization grant */
  currentShopId?: string | null;
}

/** Everything a service needs: who, where (tenant tx), and request metadata */
export interface Ctx<A extends Actor = Actor> {
  actor: A;
  trx: Tx;
  meta: RequestMeta;
}

export function systemActor(organizationId: string, label = 'system'): SystemActor {
  return { kind: 'system', organizationId, label };
}

export function actorId(actor: Actor): string | null {
  return actor.kind === 'staff' ? actor.staffId : actor.kind === 'customer' ? actor.customerId : null;
}

export function actorUserId(actor: Actor): string | null {
  return actor.kind === 'staff' ? actor.userId : null;
}

/** id written to created_by/updated_by columns */
export function auditUserId(actor: Actor): string | null {
  return actor.kind === 'staff' ? actor.staffId : null;
}

export function can(actor: Actor, permission: Permission): boolean {
  if (actor.kind === 'system') return true;
  if (actor.kind === 'customer') return false;
  return actor.permissions.has(permission);
}

export function requirePermission(actor: Actor, ...permissions: Permission[]): void {
  for (const p of permissions) {
    if (!can(actor, p)) throw Errors.forbidden(`権限がありません (${p})`, 'FORBIDDEN', { permission: p });
  }
}

export function requireAnyPermission(actor: Actor, ...permissions: Permission[]): void {
  if (!permissions.some((p) => can(actor, p))) {
    throw Errors.forbidden(`権限がありません (${permissions.join(' | ')})`, 'FORBIDDEN', { permissions });
  }
}

export function requireStaff(actor: Actor): asserts actor is StaffActor {
  if (actor.kind !== 'staff') throw Errors.forbidden('スタッフのみ実行できます');
}

export function hasShopAccess(actor: Actor, shopId: string | null | undefined): boolean {
  if (actor.kind === 'system') return true;
  if (actor.kind === 'customer') return false;
  if (actor.allShops) return true;
  // org-common resources (shop_id NULL) are visible to everyone in the org
  if (!shopId) return true;
  return actor.shopIds.includes(shopId);
}

/** Resource authorization: shop boundary */
export function assertShopAccess(actor: Actor, shopId: string | null | undefined): void {
  if (!hasShopAccess(actor, shopId)) {
    throw Errors.forbidden('この店舗へのアクセス権がありません', 'SHOP_FORBIDDEN', { shopId });
  }
}

/** Shop ids to filter by; null means no restriction */
export function accessibleShopIds(actor: Actor): readonly string[] | null {
  if (actor.kind === 'staff' && !actor.allShops) return actor.shopIds;
  return null;
}
