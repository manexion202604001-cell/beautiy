// SALON BOARD: which 予定 to add / delete for Salon OS block requests.
// Pure functions (no Chrome APIs) so they can be tested with `node --test`.
//
// A 予定 (staff schedule entry) stops HOT PEPPER Beauty from taking bookings for that stylist at
// that time (SALON BOARD says so on its 予定 screen). The schedule screen adds one by dragging the
// 予定 button: POST /KLP/schedule/salonSchedule/updateStaffShift/ with the 予定 as JSON. One is looked
// up / deleted on its edit page: GET /KLP/set/scheduleChange/?date&hour&minute&staffId (the 予定
// that starts then) and POST that form to …/scheduleChange/doDelete.
// SALON BOARD titles every 予定 added this way 「予定あり」 (checked 2026-10-23), but keeps its memo:
// Salon OS's 予定 are recognised by their memo, so the salon's own 予定 (休日, 予定あり …) are never touched.

export const TITLE = 'Salon OS予約';
export const MEMO = 'Salon OS の予約で自動登録（Salon OS で取消すと自動で消えます）';

const JST_MS = 9 * 3600_000;
const STEP_MS = 5 * 60_000;

/** JST date "YYYYMMDD" and time "HHMM" of an instant */
export function sbDateTime(ms) {
  const d = new Date(ms + JST_MS).toISOString();
  return { date: d.slice(0, 10).replace(/-/g, ''), time: d.slice(11, 13) + d.slice(14, 16) };
}

/** the 予定 for a booking: start rounded down and end rounded up to SALON BOARD's 5-minute steps */
export function planFor(staffId, startIso, endIso) {
  const start = Math.floor(new Date(startIso).getTime() / STEP_MS) * STEP_MS;
  const end = Math.ceil(new Date(endIso).getTime() / STEP_MS) * STEP_MS;
  const s = sbDateTime(start);
  return {
    staffId,
    date: s.date,
    startTime: s.time,
    endTime: sbDateTime(end).time,
    execTime: Math.round((end - start) / 60_000),
  };
}

const same = (a, b) =>
  !!a &&
  !!b &&
  a.staffId === b.staffId &&
  a.date === b.date &&
  a.startTime === b.startTime &&
  a.execTime === b.execTime;

/** a 予定 is in the past once its day is over (JST) */
const pastDay = (date, now) => date < sbDateTime(now).date;

/**
 * Turn the block requests of a plan into operations: delete what Salon OS added earlier (cancelled
 * or moved bookings), then add the 予定 still needed. Returns { ops, results }: results holds the
 * requests settled without touching SALON BOARD.
 */
export function buildSbOps(account, now = Date.now()) {
  const ops = [];
  const results = new Map();
  for (const t of account.tasks) {
    const rec =
      t.record && typeof t.record === 'object' && typeof t.record.staffId === 'string'
        ? t.record
        : null;
    const want =
      t.state === 'action_required' && t.mediumStaffId && t.start && t.end
        ? planFor(t.mediumStaffId, t.start, t.end)
        : null;
    if (rec && !same(rec, want) && !pastDay(rec.date, now))
      ops.push({ taskId: t.id, kind: 'delete', plan: rec });
    if (t.state !== 'action_required') continue;
    if (!t.start || !t.end) {
      results.set(t.id, { ok: false, error: '予約の時間が分かりません' });
      continue;
    }
    if (!want) {
      results.set(t.id, {
        ok: true,
        record: { skipped: `サロンボードに「${t.staffName ?? '指名なし'}」がいません` },
      });
      continue;
    }
    if (same(rec, want)) {
      results.set(t.id, { ok: true, record: rec });
      continue;
    }
    ops.push({ taskId: t.id, kind: 'create', plan: want });
  }
  return { ops, results };
}

/** request fields for updateStaffShift (as the schedule screen sends them) */
export function createBody(plan) {
  return {
    previousPlan: '',
    plan: JSON.stringify({
      targetId: plan.staffId,
      shiftId: null,
      title: TITLE,
      memo: MEMO,
      isAllDay: false,
      date: plan.date,
      startTime: plan.startTime,
      execTime: plan.execTime,
      upDate: null,
    }),
    suppressWarnings: 'false',
  };
}

/** query of the 予定 edit page for the 予定 starting at plan.startTime */
export function findQuery(plan) {
  return {
    date: plan.date,
    hour: plan.startTime.slice(0, 2),
    minute: plan.startTime.slice(2),
    staffId: plan.staffId,
  };
}

const hhmm = (h, m) => String(h).padStart(2, '0') + String(m).padStart(2, '0');

/** is the 予定 found on the edit page one Salon OS added (its memo), for this stylist and start? */
export function isOurs(found, plan) {
  return (
    !!found?.exists &&
    found.memo === MEMO &&
    found.staffId === plan.staffId &&
    hhmm(found.startHour, found.startMinute) === plan.startTime
  );
}

/** …and does it cover exactly the planned time? (checked right after adding it) */
export function coversPlan(found, plan) {
  return isOurs(found, plan) && hhmm(found.endHour, found.endMinute) === plan.endTime;
}
