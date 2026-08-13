/** ドメイン型定義 — docs/requirements.md 6章のデータモデルに準拠 */

export type Role = 'owner' | 'manager' | 'stylist' | 'assistant' | 'freelance'

export interface Staff {
  id: string
  salonId: string
  name: string
  nameKana: string
  role: Role
  color: string
  active: boolean
}

export type OwnerType = 'salon' | 'staff'

export interface Customer {
  id: string
  name: string
  nameKana: string
  phone: string
  email: string
  birthday: string | null
  gender: '女性' | '男性' | 'その他' | null
  lineLinked: boolean
  ownerType: OwnerType
  ownerStaffId: string | null
  tags: string[]
  /** アレルギー・皮膚トラブル等の警告 (F-01-11) */
  warnings: string[]
  visitCycleDays: number | null
  lastVisit: string | null
  visitCount: number
  totalSpent: number
  note: string
  channel: string
  deletedAt: string | null
}

export interface RecipeLine {
  brand: string
  product: string
  ratio: string
  minutes: number | null
}

export interface Karte {
  id: string
  customerId: string
  staffId: string
  date: string
  menuNames: string[]
  durationMin: number
  amount: number
  recipe: RecipeLine[]
  recipeNote: string
  memo: string
  photoCount: number
}

export interface KarteMemo {
  id: string
  customerId: string
  staffId: string
  date: string
  body: string
}

export interface Menu {
  id: string
  category: string
  name: string
  durationMin: number
  price: number
  active: boolean
}

/** マスター要件 §63 の状態遷移に準拠 */
export type ReservationStatus =
  | 'requested'
  | 'confirmed'
  | 'checked_in'
  | 'in_service'
  | 'completed'
  | 'cancelled'
  | 'no_show'

/** RESERVATION-009 キャンセル理由 */
export type CancelReason =
  | 'customer_request'
  | 'shop_request'
  | 'no_show'
  | 'duplicate'
  | 'other'

/** RESERVATION-008 予約変更履歴 */
export interface ReservationHistory {
  id: string
  reservationId: string
  before: ReservationStatus
  after: ReservationStatus
  changedBy: string
  changedAt: string
  reason: CancelReason | null
}

export interface Reservation {
  id: string
  customerId: string | null
  customerName: string
  staffId: string
  menuIds: string[]
  start: string // ISO
  end: string // ISO
  nominated: boolean // 指名 / フリー
  status: ReservationStatus
  source: 'app' | 'web' | 'line' | 'phone' | 'external'
  note: string
}

export type PaymentMethodKind =
  | 'cash'
  | 'credit'
  | 'emoney'
  | 'qr'
  | 'custom'

export interface PaymentTender {
  kind: PaymentMethodKind
  label: string
  amount: number
  /** 決済プロバイダ側の決済ID（§23 PAYMENT-002: transaction と provider payment の紐付け） */
  providerPaymentId?: string
}

export interface PaymentItem {
  name: string
  kind: 'service' | 'product'
  price: number
  quantity: number
  staffId: string
  nominated: boolean
}

export interface Payment {
  id: string
  customerId: string | null
  customerName: string
  items: PaymentItem[]
  tenders: PaymentTender[]
  status: 'draft' | 'fixed' | 'voided'
  fixedAt: string | null
  createdAt: string
  /** 打消し伝票の場合、元伝票ID */
  reversalOf: string | null
}

export interface CashierClosing {
  id: string
  date: string
  theoreticalCash: number
  countedCash: number | null
  closedAt: string | null
  closedBy: string | null
}

export interface MessageThread {
  id: string
  customerId: string
  channel: 'line' | 'app' | 'mail'
  lastMessageAt: string
  unread: number
}

export interface ChatMessage {
  id: string
  threadId: string
  from: 'salon' | 'customer' | 'auto'
  body: string
  at: string
  read: boolean
}

export interface AuditLog {
  id: string
  at: string
  actor: string
  action: string
  target: string
}

export interface Salon {
  id: string
  name: string
  openTime: string
  closeTime: string
  invoiceNumber: string
  closedWeekdays: number[]
}

export interface SessionUser {
  staffId: string
  name: string
  role: Role
  salonName: string
}
