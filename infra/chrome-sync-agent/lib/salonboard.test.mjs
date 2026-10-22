// node --test infra/chrome-sync-agent/lib/salonboard.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MEMO,
  TITLE,
  buildSbOps,
  coversPlan,
  createBody,
  findQuery,
  isOurs,
  planFor,
} from './salonboard.js';

const NOW = new Date('2026-10-23T00:00:00+09:00').getTime();
const iso = (s) => new Date(`${s}+09:00`).toISOString();

test('a booking becomes a 予定 on 5-minute steps, in JST', () => {
  assert.deepEqual(planFor('W1', iso('2026-10-24T14:02:00'), iso('2026-10-24T15:13:00')), {
    staffId: 'W1',
    date: '20261024',
    startTime: '1400',
    endTime: '1515',
    execTime: 75,
  });
  assert.deepEqual(
    findQuery(planFor('W1', iso('2026-10-24T09:30:00'), iso('2026-10-24T10:00:00'))),
    { date: '20261024', hour: '09', minute: '30', staffId: 'W1' },
  );
  const body = createBody(planFor('W1', iso('2026-10-24T14:00:00'), iso('2026-10-24T15:00:00')));
  assert.deepEqual(JSON.parse(body.plan), {
    targetId: 'W1',
    shiftId: null,
    title: TITLE,
    memo: JSON.parse(body.plan).memo,
    isAllDay: false,
    date: '20261024',
    startTime: '1400',
    execTime: 60,
    upDate: null,
  });
});

test('add for a new booking, nothing for one already added, skip stylists not on SALON BOARD', () => {
  const plan = planFor('W1', iso('2026-10-24T14:00:00'), iso('2026-10-24T15:00:00'));
  const { ops, results } = buildSbOps(
    {
      tasks: [
        {
          id: 'new',
          state: 'action_required',
          start: iso('2026-10-24T14:00:00'),
          end: iso('2026-10-24T15:00:00'),
          mediumStaffId: 'W1',
        },
        {
          id: 'done',
          state: 'action_required',
          start: iso('2026-10-24T14:00:00'),
          end: iso('2026-10-24T15:00:00'),
          mediumStaffId: 'W1',
          record: plan,
        },
        {
          id: 'nobody',
          state: 'action_required',
          start: iso('2026-10-24T14:00:00'),
          end: iso('2026-10-24T15:00:00'),
          mediumStaffId: null,
          staffName: '清水',
        },
      ],
    },
    NOW,
  );
  assert.deepEqual(
    ops.map((o) => [o.taskId, o.kind]),
    [['new', 'create']],
  );
  assert.deepEqual(results.get('done'), { ok: true, record: plan });
  assert.equal(results.get('nobody').ok, true);
});

test('a moved booking: delete the old 予定, add the new one; a cancelled one: delete only', () => {
  const old = planFor('W1', iso('2026-10-24T14:00:00'), iso('2026-10-24T15:00:00'));
  const { ops } = buildSbOps(
    {
      tasks: [
        {
          id: 'moved',
          state: 'action_required',
          start: iso('2026-10-24T16:00:00'),
          end: iso('2026-10-24T17:00:00'),
          mediumStaffId: 'W1',
          record: old,
        },
        { id: 'cancelled', state: 'remove_required', record: old },
        { id: 'pastCancel', state: 'remove_required', record: { ...old, date: '20261020' } },
      ],
    },
    NOW,
  );
  assert.deepEqual(
    ops.map((o) => [o.taskId, o.kind, o.plan.startTime]),
    [
      ['moved', 'delete', '1400'],
      ['moved', 'create', '1600'],
      ['cancelled', 'delete', '1400'],
    ],
  );
});

test("only Salon OS's own 予定 are recognised", () => {
  const plan = planFor('W1', iso('2026-10-24T14:00:00'), iso('2026-10-24T15:00:00'));
  const found = {
    exists: true,
    title: '予定あり',
    memo: MEMO,
    staffId: 'W1',
    startHour: '14',
    startMinute: '00',
    endHour: '15',
    endMinute: '00',
  };
  assert.equal(isOurs(found, plan), true);
  assert.equal(coversPlan(found, plan), true);
  assert.equal(isOurs({ ...found, memo: '' }, plan), false);
  assert.equal(isOurs({ ...found, staffId: 'W2' }, plan), false);
  assert.equal(coversPlan({ ...found, endHour: '16' }, plan), false);
  assert.equal(isOurs({ exists: false }, plan), false);
});
