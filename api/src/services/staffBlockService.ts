/**
 * スタッフ個人ブロック（個人休み）チェック
 */

export async function isStaffBlocked(
  db: D1Database,
  staffId: string,
  storeId: string | null,
  startAt: string,
  endAt: string
): Promise<boolean> {
  // Extract date and time parts from ISO datetime strings
  const date = startAt.slice(0, 10); // YYYY-MM-DD
  const startTime = startAt.slice(11, 16); // HH:MM
  const endTime = endAt.slice(11, 16); // HH:MM

  let query: string;
  let params: (string | null)[];

  if (storeId) {
    query = `
      SELECT id FROM staff_blocks
      WHERE staff_id = ?
      AND (store_id = ? OR store_id IS NULL)
      AND date = ?
      AND (is_all_day = 1 OR (start_time < ? AND end_time > ?))
      LIMIT 1
    `;
    params = [staffId, storeId, date, endTime, startTime];
  } else {
    // No store context — only check global blocks (store_id IS NULL)
    query = `
      SELECT id FROM staff_blocks
      WHERE staff_id = ?
      AND store_id IS NULL
      AND date = ?
      AND (is_all_day = 1 OR (start_time < ? AND end_time > ?))
      LIMIT 1
    `;
    params = [staffId, date, endTime, startTime];
  }

  const result = await db.prepare(query).bind(...params).first();
  return !!result;
}
