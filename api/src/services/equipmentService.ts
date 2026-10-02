// Equipment availability check shared between staff and customer reservation flows.
//
// A reservation for a given set of menus consumes 1 unit of each equipment the
// menus are linked to, for the whole duration of the reservation. Capacity is
// `equipment.quantity` (台数). The check must reject a new reservation only when,
// at some instant inside the new reservation's window, the number of *simultaneous*
// existing reservations using that equipment already equals the capacity.
//
// Important: we count PEAK simultaneous usage, not the number of reservations that
// merely overlap the window. A reservation ending at 17:00 and another starting at
// 17:00 reuse the same physical unit and must not be double-counted.

export interface EquipmentConflict {
  equipment_id: string;
  equipment_name: string;
  quantity: number;
  in_use: number; // peak simultaneous existing usage within the new window
}

// Returns the first equipment that would exceed capacity if a reservation for the
// given menus occupied [startAt, endAt), or null if everything fits.
export async function findEquipmentConflict(
  db: D1Database,
  menuIds: string[],
  storeId: string,
  startAt: string,
  endAt: string,
  excludeReservationId?: string
): Promise<EquipmentConflict | null> {
  // Gather required equipment across all selected menus, deduped by equipment id
  // (the new reservation consumes 1 unit even if several of its menus need it).
  const equipmentMap = new Map<string, { id: string; name: string; quantity: number }>();
  for (const mid of menuIds) {
    const required = await db.prepare(
      `SELECT e.id, e.name, e.quantity FROM equipment e
       JOIN menu_equipment me ON e.id = me.equipment_id
       WHERE me.menu_id = ? AND e.is_active = 1`
    ).bind(mid).all<{ id: string; name: string; quantity: number }>();
    for (const eq of required.results) equipmentMap.set(eq.id, eq);
  }

  const windowStart = new Date(startAt).getTime();
  const windowEnd = new Date(endAt).getTime();

  for (const eq of equipmentMap.values()) {
    // Existing reservations using this equipment that overlap the new window.
    // Treat intervals as half-open [start, end): a reservation ending exactly at
    // the new start does not overlap (consistent with start_at < end / end_at > start).
    const params: unknown[] = [eq.id, endAt, startAt, storeId];
    let sql = `SELECT DISTINCT r.id, r.start_at, r.end_at FROM reservations r
       JOIN menu_equipment me2 ON r.menu_id = me2.menu_id
       WHERE me2.equipment_id = ?
       AND r.start_at < ? AND r.end_at > ?
       AND r.status NOT IN ('cancelled', 'noshow')
       AND r.store_id = ?`;
    if (excludeReservationId) {
      sql += ' AND r.id != ?';
      params.push(excludeReservationId);
    }
    const overlaps = await db.prepare(sql).bind(...params).all<{ id: string; start_at: string; end_at: string }>();

    const intervals = overlaps.results.map((r) => ({
      start: new Date(r.start_at).getTime(),
      end: new Date(r.end_at).getTime(),
    }));

    // Peak simultaneous usage within [windowStart, windowEnd). Concurrency only
    // rises at an interval start, so it suffices to evaluate at windowStart and at
    // each interval start that falls strictly inside the window.
    const candidatePoints = [windowStart];
    for (const iv of intervals) {
      if (iv.start > windowStart && iv.start < windowEnd) candidatePoints.push(iv.start);
    }
    let peak = 0;
    for (const p of candidatePoints) {
      let count = 0;
      for (const iv of intervals) {
        if (iv.start <= p && p < iv.end) count++;
      }
      if (count > peak) peak = count;
    }

    // The new reservation adds 1 unit across its whole window, so it fits only if
    // peak existing usage + 1 <= quantity.
    if (peak + 1 > eq.quantity) {
      return {
        equipment_id: eq.id,
        equipment_name: eq.name,
        quantity: eq.quantity,
        in_use: peak,
      };
    }
  }

  return null;
}
