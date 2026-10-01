import type { IconName } from '../ui/Icon';

export interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  /** required permission to show the item (any of) */
  permissions?: string[];
  /** feature implemented in a later pass → rendered disabled with 「準備中」 */
  soon?: boolean;
  end?: boolean;
}

export interface NavSection {
  label?: string;
  items: NavItem[];
}

export const NAV: NavSection[] = [
  {
    items: [
      { to: '/app', label: 'ダッシュボード', icon: 'home', end: true },
      {
        to: '/app/calendar',
        label: '予約カレンダー',
        icon: 'calendar',
        permissions: ['appointment.read'],
      },
      { to: '/app/customers', label: '顧客', icon: 'users', permissions: ['customer.read'] },
    ],
  },
  {
    label: 'サロン管理',
    items: [
      { to: '/app/menus', label: 'メニュー', icon: 'scissors' },
      { to: '/app/staff', label: 'スタッフ', icon: 'user', permissions: ['staff.read'] },
      { to: '/app/shifts', label: 'シフト', icon: 'clock', permissions: ['schedule.read'] },
      { to: '/app/settings', label: '店舗設定', icon: 'settings' },
    ],
  },
  {
    label: '近日公開',
    items: [
      { to: '/app/soon/pos', label: '会計', icon: 'receipt', soon: true },
      { to: '/app/soon/kartes', label: 'カルテ', icon: 'file', soon: true },
      { to: '/app/soon/messages', label: 'メッセージ', icon: 'message', soon: true },
      { to: '/app/soon/campaigns', label: '配信', icon: 'send', soon: true },
      { to: '/app/soon/reviews', label: '口コミ', icon: 'star', soon: true },
      { to: '/app/soon/commerce', label: '商品・EC', icon: 'bag', soon: true },
      { to: '/app/soon/analytics', label: '分析', icon: 'chart', soon: true },
      { to: '/app/soon/integrations', label: '外部連携', icon: 'plug', soon: true },
      { to: '/app/soon/ops', label: '運用・監査', icon: 'shield', soon: true },
    ],
  },
];
