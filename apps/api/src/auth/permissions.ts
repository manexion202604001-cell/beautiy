/**
 * Permission catalog (RBAC). Keys are "<domain>.<action>".
 * System roles are seeded per organization; organizations can create custom roles from these keys.
 */
export const PERMISSIONS = {
  'org.manage': '法人設定の管理',
  'shop.manage': '店舗の作成・設定',
  'staff.read': 'スタッフ閲覧',
  'staff.manage': 'スタッフ管理・招待',
  'role.manage': '権限ロールの変更',
  'customer.read': '顧客閲覧(所属店舗)',
  'customer.read_all_shops': '店舗横断の顧客閲覧',
  'customer.write': '顧客作成・編集',
  'customer.delete': '顧客削除',
  'customer.merge': '顧客統合',
  'appointment.read': '予約閲覧',
  'appointment.write': '予約作成・変更・取消',
  'schedule.read': 'シフト・営業時間閲覧',
  'schedule.manage': 'シフト・営業時間管理',
  'menu.manage': 'メニュー・クーポン・設備管理',
  'karte.read': 'カルテ閲覧',
  'karte.write': 'カルテ作成・編集',
  'form.manage': 'カウンセリング/同意書テンプレート管理',
  'pos.read': '会計閲覧',
  'pos.operate': '会計操作',
  'pos.void': '会計取消',
  'pos.refund': '返金',
  'register.manage': 'レジ開局・締め',
  'sales.read': '売上閲覧(全体)',
  'sales.read_own': '自分の売上閲覧',
  'message.read': 'メッセージ閲覧',
  'message.send': '個別メッセージ送信',
  'campaign.manage': '一括配信・自動配信管理',
  'template.manage': 'メッセージテンプレート管理',
  'review.manage': '口コミ管理・返信',
  'marketing.manage': '紹介リンク・SNS素材',
  'product.manage': '商品・在庫管理',
  'order.manage': 'EC注文管理',
  'analytics.read': '分析閲覧(全体)',
  'analytics.read_own': '自分の分析閲覧',
  'integration.manage': '外部連携設定・再同期',
  'audit.read': '監査ログ閲覧',
  'ops.manage': '運用管理(DLQ/Webhook再処理/フラグ)',
  'export.data': 'データエクスポート',
  'ai.use': 'AIアシスト利用',
  'scope.all_shops': '全店舗へのアクセス(未所属店舗含む)',
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export interface SystemRoleDef {
  key: string;
  name: string;
  description: string;
  permissions: Permission[];
  /** org-wide roles see all shops; others are limited to assigned shops */
  allShops: boolean;
}

const STAFF_BASE: Permission[] = [
  'staff.read',
  'customer.read',
  'customer.write',
  'appointment.read',
  'appointment.write',
  'schedule.read',
  'karte.read',
  'karte.write',
  'pos.read',
  'pos.operate',
  'sales.read_own',
  'analytics.read_own',
  'message.read',
  'message.send',
  'ai.use',
];

export const SYSTEM_ROLES: SystemRoleDef[] = [
  {
    key: 'owner',
    name: 'オーナー',
    description: '法人の全権限',
    permissions: ALL_PERMISSIONS,
    allShops: true,
  },
  {
    key: 'manager',
    name: '店長',
    description: '担当店舗の運営全般',
    permissions: ALL_PERMISSIONS.filter((p) => !['org.manage', 'role.manage', 'customer.delete', 'customer.read_all_shops'].includes(p)),
    allShops: false,
  },
  {
    key: 'stylist',
    name: 'スタイリスト',
    description: '施術・カルテ・自分の売上',
    permissions: STAFF_BASE,
    allShops: false,
  },
  {
    key: 'assistant',
    name: 'アシスタント',
    description: '予約・カルテ閲覧中心',
    permissions: ['staff.read', 'customer.read', 'appointment.read', 'schedule.read', 'karte.read', 'karte.write', 'pos.read'],
    allShops: false,
  },
  {
    key: 'reception',
    name: '受付',
    description: '予約・会計・レジ',
    permissions: [
      'staff.read',
      'customer.read',
      'customer.write',
      'appointment.read',
      'appointment.write',
      'schedule.read',
      'pos.read',
      'pos.operate',
      'register.manage',
      'message.read',
      'message.send',
    ],
    allShops: false,
  },
  {
    key: 'accountant',
    name: '経理',
    description: '売上・分析・エクスポート',
    permissions: ['staff.read', 'pos.read', 'sales.read', 'analytics.read', 'export.data', 'audit.read'],
    allShops: true,
  },
];

/** Effective permission keys stored for a system role (adds scope.all_shops for org-wide roles) */
export function systemRolePermissions(role: SystemRoleDef): Permission[] {
  const set = new Set<Permission>(role.permissions);
  if (role.allShops) set.add('scope.all_shops');
  else set.delete('scope.all_shops');
  return [...set];
}
