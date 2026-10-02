import { Context, Next } from 'hono';
import type { Bindings, Variables, Staff } from '../types';

// Check if staff has access to a store (own store, staff_stores link, or system_admin)
export async function hasStoreAccess(db: D1Database, staff: Staff, storeId: string): Promise<boolean> {
  if (staff.role === 'system_admin') return true;
  if (staff.store_id === storeId) return true;
  const link = await db.prepare(
    'SELECT 1 FROM staff_stores WHERE staff_id = ? AND store_id = ?'
  ).bind(staff.id, storeId).first();
  return !!link;
}

// Warn-only monitor: logs requests where an authenticated staff queries a store
// they are not linked to. Does NOT block — used to observe real traffic before
// enforcing store-level access control.
export async function storeAccessMonitor(
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
  next: Next
) {
  await next();

  try {
    const staff = c.get('staff');
    if (!staff) return; // customer/public/API-key routes

    const storeId = c.req.query('store_id') || c.req.param('storeId');
    if (!storeId || storeId === staff.store_id) return;

    const allowed = await hasStoreAccess(c.env.DB, staff, storeId);
    if (!allowed) {
      console.warn(
        `[store-access] would-deny: staff=${staff.id} (${staff.name}, role=${staff.role}, store=${staff.store_id}) ` +
        `requested store=${storeId} ${c.req.method} ${c.req.path}`
      );
    }
  } catch (e) {
    console.error('[store-access] monitor error:', e instanceof Error ? e.message : String(e));
  }
}
