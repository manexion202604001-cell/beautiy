import { areIntervalsOverlapping } from 'date-fns'
import type { Reservation } from '../domain/types'
import * as db from './store'

export function listReservations(): Reservation[] {
  return db.reservations
}

export function listByDate(date: Date): Reservation[] {
  const key = date.toDateString()
  return db.reservations
    .filter((r) => new Date(r.start).toDateString() === key)
    .sort((a, b) => a.start.localeCompare(b.start))
}

export function getReservation(id: string): Reservation | undefined {
  return db.reservations.find((r) => r.id === id)
}

/**
 * ダブルブッキング検査 (F-02-03)。
 * 本番ではDB層の EXCLUDE USING gist 制約が最終防衛線となる（supabase/migrations 参照）。
 * アプリ層でも事前チェックして即時フィードバックする。
 */
export function findConflict(
  staffId: string,
  start: Date,
  end: Date,
  excludeId?: string,
): Reservation | undefined {
  return db.reservations.find((r) => {
    if (r.id === excludeId) return false
    if (r.staffId !== staffId) return false
    if (r.status === 'cancelled' || r.status === 'no_show') return false
    return areIntervalsOverlapping(
      { start, end },
      { start: new Date(r.start), end: new Date(r.end) },
    )
  })
}

export class DoubleBookingError extends Error {
  constructor(public conflict: Reservation) {
    super('指定時間帯は既に予約が入っています')
  }
}

export function createReservation(input: Omit<Reservation, 'id'>): Reservation {
  const conflict = findConflict(input.staffId, new Date(input.start), new Date(input.end))
  if (conflict) throw new DoubleBookingError(conflict)
  const created: Reservation = { ...input, id: db.nextId('r') }
  db.reservations.push(created)
  db.notify()
  return created
}

export function updateStatus(id: string, status: Reservation['status']) {
  const r = db.reservations.find((x) => x.id === id)
  if (r) {
    r.status = status
    db.notify()
  }
}
