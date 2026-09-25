// Shared server helpers for settings actions.
import { ForbiddenError } from '@/lib/server/errors';
import type { StaffContext } from '@/lib/server/session';

export function requireOrgAdmin(ctx: StaffContext) {
  if (ctx.role !== 'OWNER' && ctx.role !== 'DIRECTOR') throw new ForbiddenError('オーナーまたはディレクターのみ操作できます');
}

/** Checkbox value from FormData. */
export const bool = (fd: FormData, k: string) => fd.get(k) === 'on' || fd.get(k) === 'true' || fd.get(k) === '1';

export function maskSecret(v: unknown): string {
  const s = typeof v === 'string' ? v : '';
  if (!s) return '';
  return s.length <= 8 ? '••••••' : `••••••${s.slice(-4)}`;
}
