import { LogOut } from 'lucide-react';
import { ROLE_LABEL, type Permission } from '@salonos/core';
import { requireStaff } from '@/lib/server/session';
import { Sidebar, MenuButton, type NavItem } from '@/components/shell/Sidebar';
import { ShopSwitcher } from '@/components/shell/ShopSwitcher';
import { Avatar } from '@/components/ui';
import { logoutAction, switchShopAction } from '../(auth)/actions';

const NAV: (NavItem & { perm?: Permission })[] = [
  { href: '/dashboard', label: 'ダッシュボード', icon: 'dashboard', group: '日々の業務' },
  { href: '/reservations', label: '予約台帳', icon: 'calendar', group: '日々の業務', perm: 'appointment.read' },
  { href: '/customers', label: '顧客', icon: 'users', group: '日々の業務', perm: 'customer.read' },
  { href: '/karte', label: 'カルテ', icon: 'karte', group: '日々の業務', perm: 'karte.read' },
  { href: '/pos', label: 'POS・会計', icon: 'pos', group: '日々の業務', perm: 'pos.checkout' },
  { href: '/messages', label: 'メッセージ', icon: 'message', group: '集客・再来店', perm: 'message.send' },
  { href: '/reviews', label: '口コミ・プロフィール', icon: 'star', group: '集客・再来店', perm: 'review.reply' },
  { href: '/commerce', label: '店販EC', icon: 'bag', group: '集客・再来店', perm: 'commerce.manage' },
  { href: '/reports', label: '分析・LTV', icon: 'chart', group: '経営', perm: 'report.read' },
  { href: '/settings', label: '設定', icon: 'settings', group: '経営' },
];

export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireStaff();
  const items = NAV.filter((n) => !n.perm || ctx.can(n.perm)).map(({ perm: _p, ...n }) => n);
  return (
    <div className="shell">
      <Sidebar items={items} orgName={ctx.org.name} shopSlug={ctx.shop.slug} />
      <div className="main">
        <header className="topbar no-print">
          <MenuButton />
          <ShopSwitcher shops={ctx.shops.map((s) => ({ id: s.id, name: s.name }))} current={ctx.shop.id} action={switchShopAction} />
          <div className="spacer" />
          <div className="row hide-sm" style={{ gap: 8 }}>
            <Avatar name={ctx.membership.displayName} />
            <div style={{ lineHeight: 1.25 }}>
              <div style={{ fontWeight: 700, fontSize: 13 }}>{ctx.membership.displayName}</div>
              <div className="sub" style={{ fontSize: 11 }}>{ROLE_LABEL[ctx.role]}</div>
            </div>
          </div>
          <form action={logoutAction}>
            <button className="icon-btn" title="ログアウト" aria-label="ログアウト"><LogOut size={16} /></button>
          </form>
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
