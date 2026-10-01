export const STAFF_STATUS: Record<
  string,
  { label: string; tone: 'success' | 'warning' | 'neutral' | 'danger' }
> = {
  active: { label: '在籍', tone: 'success' },
  invited: { label: '招待中', tone: 'warning' },
  inactive: { label: '休止', tone: 'neutral' },
  retired: { label: '退職', tone: 'danger' },
};

export const EMPLOYMENT_LABEL: Record<string, string> = {
  full_time: '正社員',
  part_time: 'パート・アルバイト',
  contractor: '業務委託',
  owner: 'オーナー',
};

export const STAFF_COLORS = [
  '#0d9488',
  '#2563eb',
  '#db2777',
  '#d97706',
  '#7c3aed',
  '#16a34a',
  '#dc2626',
  '#475569',
];

/** Permission key prefix → section label for the matrix */
export const PERMISSION_GROUPS: Record<string, string> = {
  org: '法人・店舗',
  shop: '法人・店舗',
  scope: '法人・店舗',
  staff: 'スタッフ・権限',
  role: 'スタッフ・権限',
  customer: '顧客',
  export: '顧客',
  appointment: '予約・シフト',
  schedule: '予約・シフト',
  menu: 'メニュー',
  karte: 'カルテ・フォーム',
  form: 'カルテ・フォーム',
  pos: '会計・売上',
  register: '会計・売上',
  sales: '会計・売上',
  message: 'メッセージ・配信',
  campaign: 'メッセージ・配信',
  template: 'メッセージ・配信',
  review: '口コミ・集客',
  marketing: '口コミ・集客',
  product: '商品・EC',
  order: '商品・EC',
  analytics: '分析・AI',
  ai: '分析・AI',
  integration: '連携・運用',
  audit: '連携・運用',
  ops: '連携・運用',
};
