/**
 * ローカル永続化層。
 * デモ/スタンドアロン運用時は localStorage にDBスナップショットを保存し、
 * リロード・再起動後もデータを保持する。Supabase接続時は本層は不要になる。
 */
import type {
  AuditLog,
  CashierClosing,
  ChatMessage,
  Customer,
  Karte,
  KarteMemo,
  Menu,
  MessageThread,
  Payment,
  Reservation,
  ReservationHistory,
} from '../domain/types'

const KEY = 'beautiy.db.v1'

export interface DbSnapshot {
  customers: Customer[]
  kartes: Karte[]
  karteMemos: KarteMemo[]
  menus: Menu[]
  reservations: Reservation[]
  reservationHistories?: ReservationHistory[]
  payments: Payment[]
  closings: CashierClosing[]
  threads: MessageThread[]
  messages: ChatMessage[]
  auditLogs: AuditLog[]
  idSeq: number
}

export function loadSnapshot(): DbSnapshot | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    return JSON.parse(raw) as DbSnapshot
  } catch {
    return null
  }
}

export function saveSnapshot(snapshot: DbSnapshot): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(snapshot))
  } catch {
    // ストレージ満杯・プライベートモード等では永続化をスキップ（動作は継続）
  }
}

/** 保存データを破棄して初期デモデータへ戻す */
export function resetDb(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* noop */
  }
  window.location.reload()
}

export function hasSavedData(): boolean {
  try {
    return localStorage.getItem(KEY) !== null
  } catch {
    return false
  }
}
