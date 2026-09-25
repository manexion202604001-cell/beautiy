'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  LayoutDashboard, CalendarDays, Users, ClipboardList, CreditCard, MessageCircle, BarChart3, Star, ShoppingBag, Settings, Menu as MenuIcon, ExternalLink,
} from 'lucide-react';

export interface NavItem { href: string; label: string; icon: keyof typeof ICONS; group?: string }

const ICONS = {
  dashboard: LayoutDashboard, calendar: CalendarDays, users: Users, karte: ClipboardList, pos: CreditCard,
  message: MessageCircle, chart: BarChart3, star: Star, bag: ShoppingBag, settings: Settings, external: ExternalLink,
};

export function Sidebar({ items, orgName, shopSlug }: { items: NavItem[]; orgName: string; shopSlug: string }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    const h = () => setOpen((o) => !o);
    window.addEventListener('salonos:toggle-nav', h);
    return () => window.removeEventListener('salonos:toggle-nav', h);
  }, []);
  let lastGroup: string | undefined;
  return (
    <>
      <div className={`scrim ${open ? 'open' : ''}`} onClick={() => setOpen(false)} />
      <aside className={`side ${open ? 'open' : ''}`}>
        <Link href="/dashboard" className="brand">
          <span className="brand-mark">M</span>
          <span className="brand-name">MANEXION<small>Salon OS</small></span>
        </Link>
        <nav className="nav">
          {items.map((it) => {
            const Icon = ICONS[it.icon];
            const active = path === it.href || (it.href !== '/dashboard' && path.startsWith(it.href + '/')) || path === it.href;
            const header = it.group && it.group !== lastGroup ? <div className="nav-group" key={`g-${it.group}`}>{it.group}</div> : null;
            lastGroup = it.group;
            return (
              <div key={it.href}>
                {header}
                <Link href={it.href} className={active ? 'active' : ''}><Icon />{it.label}</Link>
              </div>
            );
          })}
          <div className="nav-group">公開ページ</div>
          <a href={`/book/${shopSlug}`} target="_blank" rel="noreferrer"><ExternalLink />ネット予約ページ</a>
          <a href={`/s/${shopSlug}`} target="_blank" rel="noreferrer"><ExternalLink />店舗プロフィール</a>
        </nav>
        <div className="side-foot">{orgName}</div>
      </aside>
    </>
  );
}

export function MenuButton() {
  return (
    <button className="menu-btn" aria-label="メニュー" onClick={() => window.dispatchEvent(new Event('salonos:toggle-nav'))}>
      <MenuIcon size={22} />
    </button>
  );
}
