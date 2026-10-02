// Salonboard sync status helpers (registration itself is performed by the store VPS workers)

export async function updateSyncStatus(
  db: D1Database,
  reservationId: string,
  success: boolean,
  errorMessage?: string,
  // The start/end actually registered on Salonboard (the snapshot the VPS worker
  // fetched from /pending). If the reservation was edited AFTER the worker grabbed it
  // but BEFORE this callback, stamping the CURRENT start_at would wrongly claim SB holds
  // the new time — blinding the time-change detector (start_at == synced_start_at). Stamp
  // the registered snapshot instead so the pending change is still detected. Falls back to
  // the current row values when the worker doesn't report them (older worker builds).
  registeredStartAt?: string,
  registeredEndAt?: string
): Promise<void> {
  if (success) {
    // Get current menu names for menu-change detection
    const menus = await db.prepare(
      "SELECT GROUP_CONCAT(menu_name, ', ') as names FROM reservation_menus WHERE reservation_id = ?"
    ).bind(reservationId).first<{ names: string | null }>();

    // Save synced time/staff/menu values for change detection
    await db.prepare(`
      UPDATE reservations
      SET salonboard_synced = 1,
          salonboard_synced_at = datetime('now'),
          salonboard_sync_error = NULL,
          salonboard_synced_start_at = COALESCE(?, start_at),
          salonboard_synced_end_at = COALESCE(?, end_at),
          salonboard_synced_staff_id = staff_id,
          salonboard_synced_menu_names = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).bind(registeredStartAt ?? null, registeredEndAt ?? null, menus?.names || '', reservationId).run();
  } else {
    await db.prepare(`
      UPDATE reservations
      SET salonboard_synced = -1,
          salonboard_synced_at = datetime('now'),
          salonboard_sync_error = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).bind(errorMessage || 'Unknown error', reservationId).run();
  }
}

export async function isSalonboardEnabled(
  db: D1Database,
  storeId: string
): Promise<boolean> {
  const store = await db.prepare(
    'SELECT salonboard_enabled FROM stores WHERE id = ?'
  ).bind(storeId).first<{ salonboard_enabled: number }>();

  return store?.salonboard_enabled === 1;
}
