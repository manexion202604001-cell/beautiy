import { describe, expect, it } from 'vitest'
import { availableSlots } from './slots'

const day = new Date(2026, 7, 12) // 2026-08-12 (local)

const at = (h: number, m = 0) => new Date(2026, 7, 12, h, m)

describe('availableSlots', () => {
  it('営業時間内で所要時間が収まる開始時刻のみ返す', () => {
    const slots = availableSlots(day, [], { openTime: '10:00', closeTime: '12:00', durationMin: 60 })
    expect(slots.map((d) => d.getHours() * 60 + d.getMinutes())).toEqual([600, 630, 660])
  })

  it('既存予約と重複する枠を除外する（ダブルブッキング防止）', () => {
    const busy = [{ start: at(10, 30), end: at(11, 30) }]
    const slots = availableSlots(day, busy, { openTime: '10:00', closeTime: '13:00', durationMin: 60 })
    // 10:00開始は10:30-11:30と重複、11:30開始のみ非重複…
    const starts = slots.map((d) => `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`)
    expect(starts).toEqual(['11:30', '12:00'])
  })

  it('全時間帯が埋まっている場合は空配列', () => {
    const busy = [{ start: at(10), end: at(20) }]
    const slots = availableSlots(day, busy, { openTime: '10:00', closeTime: '20:00', durationMin: 30 })
    expect(slots).toEqual([])
  })

  it('隣接（終了=開始）は重複とみなさない', () => {
    const busy = [{ start: at(10), end: at(11) }]
    const slots = availableSlots(day, busy, { openTime: '10:00', closeTime: '12:00', durationMin: 60 })
    expect(slots.map((d) => d.getHours())).toEqual([11])
  })
})
