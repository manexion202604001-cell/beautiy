import { addMinutes } from 'date-fns'
import { describe, expect, it } from 'vitest'
import {
  canTransition,
  createReservation,
  DoubleBookingError,
  InvalidTransitionError,
  listHistory,
  transitionReservation,
} from './reservations'

function makeReservation(hourOffset: number, staffId = 'st-2') {
  const start = addMinutes(new Date(), 60 * 24 * 30 + hourOffset * 60) // 30日後の枠でシードと衝突させない
  return createReservation({
    customerId: null,
    customerName: 'テスト 様',
    staffId,
    menuIds: ['m-1'],
    start: start.toISOString(),
    end: addMinutes(start, 60).toISOString(),
    nominated: false,
    status: 'requested',
    source: 'web',
    note: '',
  })
}

describe('予約状態遷移（§63）', () => {
  it('正常系: requested → confirmed → checked_in → in_service → completed', () => {
    const r = makeReservation(0)
    transitionReservation(r.id, 'confirmed', { changedBy: 'test' })
    transitionReservation(r.id, 'checked_in', { changedBy: 'test' })
    transitionReservation(r.id, 'in_service', { changedBy: 'test' })
    const done = transitionReservation(r.id, 'completed', { changedBy: 'test' })
    expect(done.status).toBe('completed')
    expect(listHistory(r.id)).toHaveLength(4)
  })

  it('completed から cancelled への変更は禁止（§63）', () => {
    const r = makeReservation(2)
    transitionReservation(r.id, 'confirmed', { changedBy: 'test' })
    transitionReservation(r.id, 'checked_in', { changedBy: 'test' })
    transitionReservation(r.id, 'in_service', { changedBy: 'test' })
    transitionReservation(r.id, 'completed', { changedBy: 'test' })
    expect(() => transitionReservation(r.id, 'cancelled', { changedBy: 'test' })).toThrow(
      InvalidTransitionError,
    )
  })

  it('confirmed → no_show は許可、requested → no_show は拒否', () => {
    expect(canTransition('confirmed', 'no_show')).toBe(true)
    expect(canTransition('requested', 'no_show')).toBe(false)
    expect(canTransition('requested', 'checked_in')).toBe(false)
  })

  it('キャンセル理由が履歴に記録される（RESERVATION-008/009）', () => {
    const r = makeReservation(4)
    transitionReservation(r.id, 'cancelled', { changedBy: 'test', reason: 'customer_request' })
    const history = listHistory(r.id)
    expect(history[0].reason).toBe('customer_request')
    expect(history[0].before).toBe('requested')
    expect(history[0].after).toBe('cancelled')
  })

  it('キャンセル済み予約の枠は再予約可能（排他対象外）', () => {
    const r = makeReservation(6, 'st-3')
    transitionReservation(r.id, 'cancelled', { changedBy: 'test', reason: 'other' })
    // 同一枠に再作成できる
    const again = createReservation({
      customerId: null,
      customerName: '再予約 様',
      staffId: 'st-3',
      menuIds: ['m-1'],
      start: r.start,
      end: r.end,
      nominated: false,
      status: 'requested',
      source: 'web',
      note: '',
    })
    expect(again.id).not.toBe(r.id)
    // アクティブ予約がある枠は拒否される
    expect(() =>
      createReservation({
        customerId: null,
        customerName: '三重予約 様',
        staffId: 'st-3',
        menuIds: ['m-1'],
        start: r.start,
        end: r.end,
        nominated: false,
        status: 'requested',
        source: 'web',
        note: '',
      }),
    ).toThrow(DoubleBookingError)
  })
})
