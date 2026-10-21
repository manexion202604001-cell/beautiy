// node --test infra/chrome-sync-agent/lib/minimo.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyDay, buildOps, cellsOverlapping, jstDate, scheduleBody } from './minimo.js';

const NOW = new Date('2026-10-22T00:00:00+09:00').getTime();
const iso = (s) => new Date(`${s}+09:00`).toISOString();

test('cells covering a booking, in JST', () => {
  assert.deepEqual(cellsOverlapping(iso('2026-10-23T14:30:00'), iso('2026-10-23T15:45:00')), [
    '2026-10-23 14:30:00',
    '2026-10-23 15:00:00',
    '2026-10-23 15:30:00',
  ]);
  assert.deepEqual(cellsOverlapping(iso('2026-10-23T14:10:00'), iso('2026-10-23T14:40:00')), [
    '2026-10-23 14:00:00',
    '2026-10-23 14:30:00',
  ]);
  assert.equal(jstDate(iso('2026-10-24T00:30:00')), '2026-10-24');
});

test('closes only open cells and records exactly those', () => {
  const account = {
    unmatchedStaff: [],
    tasks: [
      {
        id: 't1',
        state: 'action_required',
        start: iso('2026-10-23T14:00:00'),
        end: iso('2026-10-23T15:00:00'),
        mediumStaffId: 'r1',
      },
    ],
  };
  const { ops, results } = buildOps(account, NOW);
  assert.equal(results.size, 0);
  const open = new Map([
    ['r1', new Set(['2026-10-23 13:30:00', '2026-10-23 14:30:00'])],
    ['r2', new Set(['2026-10-23 14:00:00'])],
  ]);
  assert.equal(applyDay(open, ops, []), true);
  assert.deepEqual(ops[0].done, ['2026-10-23 14:30:00']);
  assert.deepEqual([...open.get('r1')], ['2026-10-23 13:30:00']);
  // the other stylist is untouched and still sent
  const body = scheduleBody(
    '2026-10-23',
    [{ staff: { rima_user_id: 'r1' } }, { staff: { rima_user_id: 'r2' } }],
    open,
  );
  assert.deepEqual(body.entries, [
    { rima_user_id: 'r1', quick_reservation: ['2026-10-23 13:30:00'] },
    { rima_user_id: 'r2', quick_reservation: ['2026-10-23 14:00:00'] },
  ]);
});

test('reopens what it closed, except cells another booking still needs or that are past', () => {
  const account = {
    unmatchedStaff: [],
    tasks: [
      {
        id: 't1',
        state: 'remove_required',
        record: {
          date: '2026-10-23',
          staff: 'r1',
          cells: ['2026-10-23 14:00:00', '2026-10-23 14:30:00', '2026-10-21 10:00:00'],
        },
      },
    ],
  };
  const { ops } = buildOps(account, NOW);
  assert.deepEqual(ops[0].cells, ['2026-10-23 14:00:00', '2026-10-23 14:30:00']);
  const open = new Map([['r1', new Set()]]);
  const busy = [
    { mediumStaffId: 'r1', start: iso('2026-10-23T14:30:00'), end: iso('2026-10-23T15:30:00') },
  ];
  applyDay(open, ops, busy);
  assert.deepEqual(ops[0].done, ['2026-10-23 14:00:00']);
});

test('a moved booking: reopen the old cells and close the new ones in one save', () => {
  const account = {
    unmatchedStaff: [],
    tasks: [
      {
        id: 't1',
        state: 'action_required',
        start: iso('2026-10-23T14:30:00'),
        end: iso('2026-10-23T15:30:00'),
        mediumStaffId: 'r1',
        record: {
          date: '2026-10-23',
          staff: 'r1',
          cells: ['2026-10-23 14:00:00', '2026-10-23 14:30:00'],
        },
      },
    ],
  };
  const { ops } = buildOps(account, NOW);
  const open = new Map([['r1', new Set(['2026-10-23 15:00:00'])]]);
  const busy = [
    { mediumStaffId: 'r1', start: iso('2026-10-23T14:30:00'), end: iso('2026-10-23T15:30:00') },
  ];
  applyDay(open, ops, busy);
  assert.deepEqual([...open.get('r1')].sort(), ['2026-10-23 14:00:00']);
});

test('a stylist who is not on minimo needs nothing there', () => {
  const t = {
    id: 't1',
    state: 'action_required',
    start: iso('2026-10-23T14:00:00'),
    end: iso('2026-10-23T15:00:00'),
    mediumStaffId: null,
    staffName: '佐藤',
  };
  const r = buildOps({ unmatchedStaff: ['🎀fein. official🎀'], tasks: [t] }, NOW);
  assert.deepEqual(r.ops, []);
  assert.deepEqual(r.results.get('t1'), {
    ok: true,
    record: { skipped: 'minimo に「佐藤」がいません' },
  });
});
