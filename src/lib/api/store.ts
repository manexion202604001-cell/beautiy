/**
 * モックデータストア。
 * 本番では本ファイルを Supabase クライアント実装に差し替える（リポジトリ層のIFは維持）。
 * UIコンポーネントは lib/api 配下のリポジトリ関数と hooks 経由でのみアクセスすること。
 */
import { addDays, format, setHours, setMinutes, subDays } from 'date-fns'
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
  Salon,
  Staff,
} from '../domain/types'

const today = new Date()
const iso = (d: Date) => d.toISOString()
const at = (base: Date, h: number, m: number) => iso(setMinutes(setHours(base, h), m))
const day = (offset: number) => format(addDays(today, offset), 'yyyy-MM-dd')

export const salon: Salon = {
  id: 'salon-1',
  name: 'MAISON BEAUTIY 表参道',
  openTime: '10:00',
  closeTime: '20:00',
  invoiceNumber: 'T1234567890123',
  closedWeekdays: [1],
}

export const staffList: Staff[] = [
  { id: 'st-1', salonId: 'salon-1', name: '真行寺 蓮', nameKana: 'シンギョウジ レン', role: 'owner', color: '#C8A96A', active: true },
  { id: 'st-2', salonId: 'salon-1', name: '桐生 美月', nameKana: 'キリュウ ミツキ', role: 'manager', color: '#134E43', active: true },
  { id: 'st-3', salonId: 'salon-1', name: '早乙女 汐里', nameKana: 'サオトメ シオリ', role: 'stylist', color: '#4A7A5C', active: true },
  { id: 'st-4', salonId: 'salon-1', name: '氷室 隼', nameKana: 'ヒムロ ジュン', role: 'freelance', color: '#9A7E45', active: true },
]

export const menus: Menu[] = [
  { id: 'm-1', category: 'カット', name: 'デザインカット', durationMin: 60, price: 8800, active: true },
  { id: 'm-2', category: 'カット', name: '前髪カット', durationMin: 20, price: 2200, active: true },
  { id: 'm-3', category: 'カラー', name: 'フルカラー', durationMin: 90, price: 12100, active: true },
  { id: 'm-4', category: 'カラー', name: 'リタッチカラー', durationMin: 60, price: 8250, active: true },
  { id: 'm-5', category: 'パーマ', name: 'ニュアンスパーマ', durationMin: 120, price: 15400, active: true },
  { id: 'm-6', category: 'トリートメント', name: '髪質改善トリートメント', durationMin: 60, price: 9900, active: true },
  { id: 'm-7', category: 'スパ', name: 'ヘッドスパ 40分', durationMin: 40, price: 6600, active: true },
]

export const customers: Customer[] = [
  {
    id: 'c-1', name: '綾瀬 花恋', nameKana: 'アヤセ カレン', phone: '090-1234-5678',
    email: 'karen.a@example.com', birthday: '1992-04-18', gender: '女性', lineLinked: true,
    ownerType: 'salon', ownerStaffId: null, tags: ['VIP', 'カラー定期'],
    warnings: ['ジアミンアレルギー（ノンジアミンカラーのみ使用可）'],
    visitCycleDays: 45, lastVisit: day(-12), visitCount: 28, totalSpent: 412500,
    note: '仕上がりは柔らかい印象を好む。雑誌よりも会話中心。', channel: 'Instagram', deletedAt: null,
  },
  {
    id: 'c-2', name: '如月 蒼真', nameKana: 'キサラギ ソウマ', phone: '080-2345-6789',
    email: 'soma.k@example.com', birthday: '1988-11-02', gender: '男性', lineLinked: true,
    ownerType: 'salon', ownerStaffId: null, tags: ['新規'],
    warnings: [],
    visitCycleDays: 30, lastVisit: day(-3), visitCount: 2, totalSpent: 17600,
    note: 'ビジネス寄りの短髪。ワックスの香りに敏感。', channel: 'Web検索', deletedAt: null,
  },
  {
    id: 'c-3', name: '篠宮 るい', nameKana: 'シノミヤ ルイ', phone: '070-3456-7890',
    email: 'rui.s@example.com', birthday: '1999-07-24', gender: '女性', lineLinked: false,
    ownerType: 'staff', ownerStaffId: 'st-4', tags: ['ブリーチ'],
    warnings: ['頭皮が敏感（前回カラーで軽い刺激感）'],
    visitCycleDays: 60, lastVisit: day(-95), visitCount: 6, totalSpent: 128700,
    note: 'ハイトーン維持希望。紫シャンプー購入歴あり。', channel: '紹介', deletedAt: null,
  },
  {
    id: 'c-4', name: '橘 京香', nameKana: 'タチバナ キョウカ', phone: '090-4567-8901',
    email: 'kyoka.t@example.com', birthday: '1975-01-30', gender: '女性', lineLinked: true,
    ownerType: 'salon', ownerStaffId: null, tags: ['VIP'],
    warnings: [],
    visitCycleDays: 35, lastVisit: day(-33), visitCount: 54, totalSpent: 892000,
    note: '白髪ぼかしハイライト継続中。次回は明るさを半トーン上げたい意向。', channel: '紹介', deletedAt: null,
  },
  {
    id: 'c-5', name: '水無月 泉', nameKana: 'ミナヅキ イズミ', phone: '080-5678-9012',
    email: 'izumi.m@example.com', birthday: '1995-09-12', gender: 'その他', lineLinked: false,
    ownerType: 'salon', ownerStaffId: null, tags: ['失客リスク'],
    warnings: [],
    visitCycleDays: 40, lastVisit: day(-88), visitCount: 11, totalSpent: 96800,
    note: '転居の可能性あり。オンライン予約派。', channel: 'ホットペッパー', deletedAt: null,
  },
  {
    id: 'c-6', name: '鷺沢 一颯', nameKana: 'サギサワ イブキ', phone: '070-6789-0123',
    email: 'ibuki.s@example.com', birthday: '2001-03-08', gender: '男性', lineLinked: true,
    ownerType: 'staff', ownerStaffId: 'st-4', tags: ['パーマ'],
    warnings: [],
    visitCycleDays: 50, lastVisit: day(-20), visitCount: 4, totalSpent: 46200,
    note: '学生。夕方以降の来店が多い。', channel: 'Instagram', deletedAt: null,
  },
]

export const kartes: Karte[] = [
  {
    id: 'k-1', customerId: 'c-1', staffId: 'st-1', date: day(-12),
    menuNames: ['デザインカット', 'フルカラー'], durationMin: 150, amount: 20900,
    recipe: [
      { brand: 'THROW', product: 'A/8 : Mt/8', ratio: '2:1', minutes: 25 },
      { brand: 'THROW', product: 'OX 3%', ratio: '1:1', minutes: null },
    ],
    recipeNote: 'ノンジアミン指定。根元は8Lv、毛先は透明感重視でモノトーン寄せ。',
    memo: '次回はインナーに淡いベージュの提案。旅行の予定あり（来月・沖縄）。',
    photoCount: 4,
  },
  {
    id: 'k-2', customerId: 'c-1', staffId: 'st-1', date: day(-57),
    menuNames: ['リタッチカラー', '髪質改善トリートメント'], durationMin: 120, amount: 18150,
    recipe: [{ brand: 'THROW', product: 'A/8', ratio: '1:1', minutes: 20 }],
    recipeNote: '前回と同処方。トリートメントは酸熱系を弱めに。',
    memo: '乾燥が気になる季節。ホームケアにオイルを案内。',
    photoCount: 2,
  },
  {
    id: 'k-3', customerId: 'c-4', staffId: 'st-2', date: day(-33),
    menuNames: ['デザインカット', 'フルカラー', 'ヘッドスパ 40分'], durationMin: 190, amount: 27500,
    recipe: [
      { brand: 'イルミナ', product: 'ヌード/8 + オーシャン/10', ratio: '3:1', minutes: 30 },
    ],
    recipeNote: '白髪ぼかしハイライト15枚。次回は半トーンアップ予定。',
    memo: 'お孫さんの話題。スパを大変気に入っている。',
    photoCount: 3,
  },
  {
    id: 'k-4', customerId: 'c-3', staffId: 'st-4', date: day(-95),
    menuNames: ['フルカラー'], durationMin: 100, amount: 12100,
    recipe: [{ brand: 'N.', product: 'ラベンダー/10', ratio: '1:1', minutes: 20 }],
    recipeNote: '頭皮保護オイル使用。次回はケアブリーチ推奨。',
    memo: '刺激感の申告あり → 保護剤必須。ムラサキシャンプー継続中。',
    photoCount: 5,
  },
  {
    id: 'k-5', customerId: 'c-2', staffId: 'st-3', date: day(-3),
    menuNames: ['デザインカット'], durationMin: 60, amount: 8800,
    recipe: [],
    recipeNote: '',
    memo: '刈り上げは6mm。前髪は目にかからない長さ。無香料スタイリング剤を使用。',
    photoCount: 1,
  },
]

export const karteMemos: KarteMemo[] = [
  { id: 'km-1', customerId: 'c-1', staffId: 'st-2', date: day(-12), body: 'お茶はカフェインレス希望とのこと（担当外メモ）。' },
  { id: 'km-2', customerId: 'c-4', staffId: 'st-3', date: day(-33), body: '雨の日は膝が痛むそうなので、シャンプー台への誘導ゆっくりめに。' },
]

export const reservations: Reservation[] = [
  { id: 'r-1', customerId: 'c-1', customerName: '綾瀬 花恋', staffId: 'st-1', menuIds: ['m-1', 'm-3'], start: at(today, 10, 0), end: at(today, 12, 30), nominated: true, status: 'confirmed', source: 'line', note: 'ノンジアミン' },
  { id: 'r-2', customerId: 'c-2', customerName: '如月 蒼真', staffId: 'st-3', menuIds: ['m-1'], start: at(today, 11, 0), end: at(today, 12, 0), nominated: false, status: 'confirmed', source: 'web', note: '' },
  { id: 'r-3', customerId: 'c-4', customerName: '橘 京香', staffId: 'st-2', menuIds: ['m-4', 'm-7'], start: at(today, 13, 0), end: at(today, 14, 40), nominated: true, status: 'confirmed', source: 'phone', note: 'スパ強め' },
  { id: 'r-4', customerId: 'c-6', customerName: '鷺沢 一颯', staffId: 'st-4', menuIds: ['m-5'], start: at(today, 16, 0), end: at(today, 18, 0), nominated: true, status: 'tentative', source: 'line', note: '' },
  { id: 'r-5', customerId: null, customerName: '新規：宇佐美 様', staffId: 'st-3', menuIds: ['m-3'], start: at(today, 15, 0), end: at(today, 16, 30), nominated: false, status: 'confirmed', source: 'web', note: '初来店。カウンセリング長めに。' },
  { id: 'r-6', customerId: 'c-5', customerName: '水無月 泉', staffId: 'st-2', menuIds: ['m-1'], start: at(addDays(today, 1), 18, 0), end: at(addDays(today, 1), 19, 0), nominated: false, status: 'confirmed', source: 'web', note: '' },
  { id: 'r-7', customerId: 'c-3', customerName: '篠宮 るい', staffId: 'st-4', menuIds: ['m-3', 'm-6'], start: at(addDays(today, 2), 12, 0), end: at(addDays(today, 2), 14, 30), nominated: true, status: 'confirmed', source: 'line', note: 'ケアブリーチ相談' },
]

export const payments: Payment[] = [
  {
    id: 'p-1', customerId: 'c-2', customerName: '如月 蒼真',
    items: [{ name: 'デザインカット', kind: 'service', price: 8800, quantity: 1, staffId: 'st-3', nominated: false }],
    tenders: [{ kind: 'credit', label: 'クレジット', amount: 8800 }],
    status: 'fixed', fixedAt: at(subDays(today, 3), 12, 10), createdAt: at(subDays(today, 3), 12, 0), reversalOf: null,
  },
  {
    id: 'p-2', customerId: 'c-1', customerName: '綾瀬 花恋',
    items: [
      { name: 'デザインカット', kind: 'service', price: 8800, quantity: 1, staffId: 'st-1', nominated: true },
      { name: 'フルカラー', kind: 'service', price: 12100, quantity: 1, staffId: 'st-1', nominated: true },
      { name: 'ヘアオイル N.', kind: 'product', price: 3740, quantity: 1, staffId: 'st-1', nominated: true },
    ],
    tenders: [
      { kind: 'cash', label: '現金', amount: 10000 },
      { kind: 'qr', label: 'QR決済', amount: 14640 },
    ],
    status: 'fixed', fixedAt: at(subDays(today, 12), 13, 5), createdAt: at(subDays(today, 12), 12, 40), reversalOf: null,
  },
  {
    id: 'p-3', customerId: 'c-4', customerName: '橘 京香',
    items: [
      { name: 'リタッチカラー', kind: 'service', price: 8250, quantity: 1, staffId: 'st-2', nominated: true },
      { name: 'ヘッドスパ 40分', kind: 'service', price: 6600, quantity: 1, staffId: 'st-2', nominated: true },
    ],
    tenders: [],
    status: 'draft', fixedAt: null, createdAt: at(today, 13, 5), reversalOf: null,
  },
]

export const closings: CashierClosing[] = [
  { id: 'cl-1', date: day(-1), theoreticalCash: 42300, countedCash: 42300, closedAt: at(subDays(today, 1), 20, 25), closedBy: 'st-2' },
]

export const threads: MessageThread[] = [
  { id: 'th-1', customerId: 'c-1', channel: 'line', lastMessageAt: at(today, 9, 12), unread: 1 },
  { id: 'th-2', customerId: 'c-4', channel: 'line', lastMessageAt: at(subDays(today, 1), 19, 40), unread: 0 },
  { id: 'th-3', customerId: 'c-3', channel: 'app', lastMessageAt: at(subDays(today, 4), 15, 2), unread: 0 },
]

export const messages: ChatMessage[] = [
  { id: 'ms-1', threadId: 'th-1', from: 'auto', body: '【ご予約確認】本日10:00よりお待ちしております。MAISON BEAUTIY 表参道', at: at(today, 8, 0), read: true },
  { id: 'ms-2', threadId: 'th-1', from: 'customer', body: '少し早めに着きそうです。よろしくお願いします。', at: at(today, 9, 12), read: false },
  { id: 'ms-3', threadId: 'th-2', from: 'salon', body: '本日はご来店ありがとうございました。次回のハイライトのご相談もお気軽に。', at: at(subDays(today, 1), 19, 40), read: true },
  { id: 'ms-4', threadId: 'th-3', from: 'auto', body: 'ご無沙汰しております。ハイトーンの色味キープには8週間以内のメンテナンスがおすすめです。', at: at(subDays(today, 4), 15, 2), read: true },
]

export const auditLogs: AuditLog[] = [
  { id: 'a-1', at: at(today, 9, 45), actor: '桐生 美月', action: 'カルテ閲覧', target: '綾瀬 花恋' },
  { id: 'a-2', at: at(subDays(today, 1), 20, 25), actor: '桐生 美月', action: 'レジ締め確定', target: day(-1) },
  { id: 'a-3', at: at(subDays(today, 2), 11, 30), actor: '真行寺 蓮', action: '顧客CSVエクスポート', target: '全顧客 (6件)' },
]

/* ---- 変更通知（useSyncExternalStore 用） ---- */
let version = 0
const listeners = new Set<() => void>()

export function getVersion() {
  return version
}
export function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
export function notify() {
  version += 1
  listeners.forEach((fn) => fn())
}

let idSeq = 100
export function nextId(prefix: string) {
  idSeq += 1
  return `${prefix}-${idSeq}`
}
