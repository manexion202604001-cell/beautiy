import {
  Calendar,
  CalendarCog,
  FileText,
  House,
  Menu,
  MessageSquare,
  Settings,
  Store,
  UserCog,
  Users,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  /** short label of the mobile bottom bar (first four items only) */
  shortLabel?: string;
  icon: LucideIcon;
  /** required permission to show the item (any of); items without one are shown to everyone */
  permissions?: string[];
  end?: boolean;
}

/**
 * Main menu: same ten entries, order, labels and icons as the system this app replaces.
 * Visibility follows its roles: メニュー・スタッフ・予約受付設定・店舗設定 for オーナー and ディレクター (店長),
 * 設定 for the オーナー only. Expressed as permissions so custom roles follow what they may manage:
 * menu.manage / staff.manage / shop.manage are held by the オーナー and 店長 system roles only, org.manage
 * by the オーナー only. The four items of the mobile bottom bar are shown to everyone.
 */
export const NAV: NavItem[] = [
  { to: '/app', label: 'ダッシュボード', shortLabel: 'ホーム', icon: House, end: true },
  { to: '/app/calendar', label: '予約管理', shortLabel: '予約', icon: Calendar },
  { to: '/app/customers', label: '顧客管理', shortLabel: '顧客', icon: Users },
  { to: '/app/consents', label: '同意書一覧', icon: FileText, permissions: ['karte.read'] },
  { to: '/app/messages', label: 'メッセージ', shortLabel: 'メッセージ', icon: MessageSquare },
  { to: '/app/menus', label: 'メニュー', icon: Menu, permissions: ['menu.manage'] },
  { to: '/app/staff', label: 'スタッフ', icon: UserCog, permissions: ['staff.manage'] },
  {
    to: '/app/reservation-settings',
    label: '予約受付設定',
    icon: CalendarCog,
    permissions: ['shop.manage'],
  },
  { to: '/app/settings', label: '店舗設定', icon: Store, permissions: ['shop.manage'] },
  { to: '/app/system', label: '設定', icon: Settings, permissions: ['org.manage'] },
];

/** Role shown under the name in the sidebar, worded as the original screen (オーナー / ディレクター / スタッフ) */
export function sidebarRoleLabel(roleKey: string | undefined): string {
  if (!roleKey) return '';
  return roleKey === 'owner' ? 'オーナー' : roleKey === 'manager' ? 'ディレクター' : 'スタッフ';
}

export interface FeatureLink {
  to: string;
  label: string;
  description: string;
  permissions?: string[];
}

/** Salon OS features with no counterpart in the main menu; listed on the 設定 page */
export const MORE_FEATURES: FeatureLink[] = [
  {
    to: '/app/calendar-classic',
    label: 'カレンダー（枠ブロック）',
    description: '枠のブロック・休憩の登録',
    permissions: ['appointment.read'],
  },
  {
    to: '/app/customers-classic',
    label: '顧客（詳細検索・CSV出力）',
    description: 'タグ・来店日での絞り込みとCSV出力',
    permissions: ['customer.read'],
  },
  {
    to: '/app/menus-classic',
    label: 'メニュー（詳細設定）',
    description: '店舗別の価格・税・前後の準備時間、割引クーポン、席・設備',
  },
  { to: '/app/shifts', label: 'シフト', description: 'スタッフの勤務予定', permissions: ['schedule.read'] },
  {
    to: '/app/staff-classic',
    label: 'スタッフ（詳細）',
    description: 'メールアドレスなしの登録・店舗間の異動・指名料・公開プロフィール・招待リンク',
    permissions: ['staff.read'],
  },
  { to: '/app/staff/roles', label: '権限ロール', description: '役割ごとの権限の設定', permissions: ['staff.read'] },
  {
    to: '/app/settings-classic',
    label: '店舗設定（営業時間・休業日・予約ルール）',
    description: '営業時間・休業日・予約と通知のルール・法人設定',
  },
  { to: '/app/pos', label: '会計', description: 'レジ・会計・日報', permissions: ['pos.read'] },
  { to: '/app/kartes', label: 'カルテ', description: '施術カルテ・写真・テンプレート', permissions: ['karte.read'] },
  {
    to: '/app/kartes/forms',
    label: '問診・同意書フォームの編集',
    description: '同意書・カウンセリングシート・事前問診の内容',
    permissions: ['karte.read', 'form.manage'],
  },
  {
    to: '/app/messages-classic',
    label: 'メッセージ（AI下書き・テンプレート）',
    description: 'AI下書き・テンプレート・メール/SMSでの送信・再送',
    permissions: ['message.read'],
  },
  {
    to: '/app/campaigns',
    label: '配信',
    description: 'セグメント配信・自動配信',
    permissions: ['campaign.manage', 'template.manage', 'marketing.manage'],
  },
  {
    to: '/app/reviews',
    label: '口コミ',
    description: '口コミ依頼・返信',
    permissions: ['review.manage', 'analytics.read', 'analytics.read_own'],
  },
  {
    to: '/app/commerce',
    label: '商品・EC',
    description: '商品・在庫・注文',
    permissions: ['product.manage', 'order.manage'],
  },
  {
    to: '/app/analytics',
    label: '分析',
    description: '売上・再来・LTV',
    permissions: ['analytics.read', 'analytics.read_own', 'sales.read', 'sales.read_own'],
  },
  {
    to: '/app/integrations',
    label: '外部連携',
    description: 'ホットペッパー・LiME などの連携',
    permissions: ['integration.manage'],
  },
  { to: '/app/migration', label: 'データ移行', description: '旧システムからの取り込み', permissions: ['ops.manage'] },
  {
    to: '/app/ops',
    label: '運用・監査',
    description: '監査ログ・エクスポート・ジョブ',
    permissions: ['ops.manage', 'audit.read', 'export.data'],
  },
];
