// minimo SALON TOOL: which すぐ予約 cells to close / reopen for Salon OS block requests.
// Pure functions (no Chrome APIs) so they can be tested with `node --test`.
//
// The SALON TOOL schedule (GET /api/v1/salontool/schedule?date=YYYY-MM-DD) lists, per stylist, the
// 30-minute cells open for すぐ予約 as "YYYY-MM-DD HH:MM:00" (JST). Saving
// (POST /api/v1/salontool/schedule {date, entries:[{rima_user_id, quick_reservation:[…]}]}) sends the
// whole day for every stylist, like the 変更を保存 button. A cell left out becomes 予約リクエストのみ:
// customers can still ask, but nothing is booked without the salon's approval — no double booking.

const CELL_MS = 30 * 60_000;
const JST_MS = 9 * 3600_000;

/** "YYYY-MM-DD" of an instant in JST */
export function jstDate(iso) {
  return new Date(new Date(iso).getTime() + JST_MS).toISOString().slice(0, 10);
}

/** start instant of a cell string "YYYY-MM-DD HH:MM:00" (JST) */
export function cellStart(cell) {
  return new Date(`${cell.slice(0, 10)}T${cell.slice(11, 19)}+09:00`).getTime();
}

function cellOf(ms) {
  const d = new Date(ms + JST_MS).toISOString();
  return `${d.slice(0, 10)} ${d.slice(11, 19)}`;
}

/** every cell that overlaps [start, end) */
export function cellsOverlapping(startIso, endIso) {
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  const out = [];
  for (let c = Math.floor(start / CELL_MS) * CELL_MS; c < end; c += CELL_MS) out.push(cellOf(c));
  return out;
}

const overlaps = (cell, b) => {
  const s = cellStart(cell);
  return s < new Date(b.end).getTime() && s + CELL_MS > new Date(b.start).getTime();
};

/**
 * Turn the block requests of a plan into per-day operations.
 * Returns { ops, results }: results holds requests settled without touching minimo.
 */
export function buildOps(account, now = Date.now()) {
  const ops = [];
  const results = new Map();
  for (const t of account.tasks) {
    const rec = t.record && typeof t.record === 'object' ? t.record : null;
    // what this request closed earlier (cancelled, or moved): reopen it, never cells in the past
    if (
      rec &&
      typeof rec.date === 'string' &&
      typeof rec.staff === 'string' &&
      Array.isArray(rec.cells)
    ) {
      const cells = rec.cells.filter((c) => typeof c === 'string' && cellStart(c) > now);
      if (cells.length)
        ops.push({ taskId: t.id, kind: 'reopen', date: rec.date, staff: rec.staff, cells });
    }
    if (t.state !== 'action_required') continue;
    if (!t.start || !t.end) {
      results.set(t.id, { ok: false, error: '予約の時間が分かりません' });
      continue;
    }
    if (!t.mediumStaffId) {
      // the stylist is not on minimo (names minimo shows that match no one are reported separately)
      results.set(t.id, {
        ok: true,
        record: { skipped: `minimo に「${t.staffName ?? '指名なし'}」がいません` },
      });
      continue;
    }
    ops.push({
      taskId: t.id,
      kind: 'close',
      date: jstDate(t.start),
      staff: t.mediumStaffId,
      cells: cellsOverlapping(t.start, t.end),
    });
  }
  return { ops, results };
}

/**
 * Apply one day's operations to that day's cells (Map stylist id → Set of open cells), in place.
 * Reopens first (only cells no booking still needs), then closes. Fills op.done with the cells it
 * actually changed. Returns whether anything changed.
 */
export function applyDay(open, ops, busy) {
  let changed = false;
  const closing = new Set(
    ops.filter((o) => o.kind === 'close').flatMap((o) => o.cells.map((c) => `${o.staff}|${c}`)),
  );
  for (const op of ops.filter((o) => o.kind === 'reopen')) {
    op.done = [];
    const cells = open.get(op.staff);
    if (!cells) continue;
    for (const c of op.cells) {
      if (cells.has(c) || closing.has(`${op.staff}|${c}`)) continue;
      if (busy.some((b) => b.mediumStaffId === op.staff && overlaps(c, b))) continue;
      cells.add(c);
      op.done.push(c);
      changed = true;
    }
  }
  for (const op of ops.filter((o) => o.kind === 'close')) {
    op.done = [];
    const cells = open.get(op.staff);
    if (!cells) continue;
    for (const c of op.cells) {
      if (!cells.has(c)) continue;
      cells.delete(c);
      op.done.push(c);
      changed = true;
    }
  }
  return changed;
}

/** request body for POST /api/v1/salontool/schedule: every stylist of the day, as the screen sends it */
export function scheduleBody(date, entries, open) {
  return {
    date,
    entries: entries.map((e) => ({
      rima_user_id: e.staff.rima_user_id,
      quick_reservation: [...(open.get(e.staff.rima_user_id) ?? [])].sort(),
    })),
  };
}

/** Map stylist id → Set of open cells, from the GET response */
export function openCells(entries) {
  return new Map(entries.map((e) => [e.staff.rima_user_id, new Set(e.schedule ?? [])]));
}

/** the stylists of the salon as minimo shows them */
export function staffOf(entries) {
  return entries.map((e) => ({ id: e.staff.rima_user_id, name: e.staff.name }));
}
