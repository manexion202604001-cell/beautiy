import { areIntervalsOverlapping } from 'date-fns'
import type {
  CancelReason,
  Reservation,
  ReservationHistory,
  ReservationStatus,
} from '../domain/types'
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

/**
 * 予約状態遷移（マスター要件 §63）。
 * 正常系: requested → confirmed → checked_in → in_service → completed
 * 代替系: requested/confirmed → cancelled、confirmed → no_show
 * completed からの cancelled 変更は禁止（遷移表に存在しないため自動的に拒否される）。
 */
const allowedTransitions: Record<ReservationStatus, ReservationStatus[]> = {
  requested: ['confirmed', 'cancelled'],
  confirmed: ['checked_in', 'cancelled', 'no_show'],
  checked_in: ['in_service'],
  in_service: ['completed'],
  completed: [],
  cancelled: [],
  no_show: [],
}

export class InvalidTransitionError extends Error {
  constructor(
    public from: ReservationStatus,
    public to: ReservationStatus,
  ) {
    super(`予約状態を ${from} から ${to} へ変更することはできません`)
  }
}

export function canTransition(from: ReservationStatus, to: ReservationStatus): boolean {
  return allowedTransitions[from].includes(to)
}

export function nextStatuses(from: ReservationStatus): ReservationStatus[] {
  return allowedTransitions[from]
}

export function transitionReservation(
  id: string,
  to: ReservationStatus,
  opts: { changedBy: string; reason?: CancelReason },
): Reservation {
  const r = db.reservations.find((x) => x.id === id)
  if (!r) throw new Error(`reservation not found: ${id}`)
  if (!canTransition(r.status, to)) throw new InvalidTransitionError(r.status, to)
  const history: ReservationHistory = {
    id: db.nextId('rh'),
    reservationId: r.id,
    before: r.status,
    after: to,
    changedBy: opts.changedBy,
    changedAt: new Date().toISOString(),
    reason: opts.reason ?? null,
  }
  r.status = to
  db.reservationHistories.unshift(history)
  db.notify()
  return r
}

export function listHistory(reservationId: string): ReservationHistory[] {
  return db.reservationHistories.filter((h) => h.reservationId === reservationId)
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

