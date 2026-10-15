import { Check, ChevronDown, Ellipsis, LogOut, Settings, Store } from 'lucide-react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useUnreadCount } from '../../api/messaging';
import { useAuth } from '../../lib/auth';
import { cn } from '../../lib/cn';
import { Button, Separator, Wordmark } from '../shad';
import { Menu, MenuItem, MenuLabel, MenuLink, MenuSeparator } from '../shad/dropdown-menu';
import { NAV, type NavItem } from './nav';
import { usePrimaryShopId } from './usePrimaryShop';

function useVisibleNav(): NavItem[] {
  const { can } = useAuth();
  return NAV.filter((it) => !it.permissions || it.permissions.some((p) => can(p)));
}

function useLogout() {
  const { logout } = useAuth();
  const navigate = useNavigate();
  return () => {
    void logout().then(() => navigate('/login'));
  };
}

function DesktopSidebar() {
  const { me, shops, currentShop, setCurrentShopId } = useAuth();
  const items = useVisibleNav();
  const primaryShopId = usePrimaryShopId();
  const logout = useLogout();
  const name = me?.staff.display_name ?? '';
  return (
    <div className="hidden h-full w-64 flex-col border-r bg-card md:flex">
      <div className="flex h-16 items-center px-6">
        <h1 className="text-xl">
          <Wordmark />
        </h1>
      </div>
      <Separator />
      {shops.length > 0 ? (
        <>
          <div className="px-3 py-3">
            <Menu
              label="店舗を切り替え"
              disabled={shops.length <= 1}
              contentClassName="w-[232px]"
              triggerClassName="inline-flex h-9 w-full items-center justify-between gap-2 whitespace-nowrap rounded-md border border-input bg-background px-4 py-2 text-left text-sm font-normal shadow-xs transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0"
              trigger={
                <>
                  <div className="flex items-center gap-2 truncate">
                    <Store className="h-4 w-4 shrink-0" />
                    <span className="truncate">{currentShop?.name || '店舗を選択'}</span>
                  </div>
                  {shops.length > 1 ? <ChevronDown className="h-4 w-4 shrink-0 opacity-50" /> : null}
                </>
              }
            >
              {shops.map((s) => (
                <MenuItem
                  key={s.id}
                  onSelect={() => setCurrentShopId(s.id)}
                  className={cn('cursor-pointer', currentShop?.id === s.id && 'bg-accent')}
                >
                  <Store className="mr-2 h-4 w-4" />
                  <span className="truncate">{s.name}</span>
                  {primaryShopId === s.id ? (
                    <span className="ml-auto text-xs text-muted-foreground">主</span>
                  ) : null}
                </MenuItem>
              ))}
            </Menu>
          </div>
          <Separator />
        </>
      ) : null}
      <nav aria-label="メインメニュー" className="flex-1 sy-1 px-3 py-4">
        {items.map((it) => (
          <NavLink
            key={it.to}
            to={it.to}
            end={it.end}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
              )
            }
          >
            <it.icon className="h-5 w-5" />
            {it.label}
          </NavLink>
        ))}
      </nav>
      <Separator />
      <div className="p-4">
        <div className="mb-3 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary text-primary-foreground">
            {name.charAt(0)}
          </div>
          <div className="flex-1 overflow-hidden">
            <p className="truncate text-sm font-medium">{name}</p>
            <p className="truncate text-xs text-muted-foreground">{me?.staff.role_name ?? ''}</p>
          </div>
        </div>
        <Button variant="outline" className="w-full" onClick={logout}>
          <LogOut className="mr-2 h-4 w-4" />
          ログアウト
        </Button>
      </div>
    </div>
  );
}

function MobileHeader() {
  const { me, shops, currentShop, setCurrentShopId } = useAuth();
  const navigate = useNavigate();
  const logout = useLogout();
  const name = me?.staff.display_name ?? '';
  const title = (
    <h1 className="max-w-[200px] truncate text-lg font-bold text-primary">
      {currentShop?.name || 'Salon OS'}
    </h1>
  );
  return (
    <header className="sticky top-0 z-50 flex h-14 items-center justify-between border-b bg-background px-4 md:hidden">
      {shops.length > 1 ? (
        <Menu
          label="店舗を切り替え"
          contentClassName="w-48"
          triggerClassName="flex items-center gap-1 focus:outline-hidden"
          trigger={
            <>
              {title}
              <ChevronDown className="h-4 w-4 shrink-0 text-primary" />
            </>
          }
        >
          <MenuLabel>店舗切替</MenuLabel>
          <MenuSeparator />
          {shops.map((s) => (
            <MenuItem key={s.id} onSelect={() => setCurrentShopId(s.id)} className="cursor-pointer">
              <Store className="mr-2 h-4 w-4" />
              <span className="truncate">{s.name}</span>
              {currentShop?.id === s.id ? <Check className="ml-auto h-4 w-4" /> : null}
            </MenuItem>
          ))}
        </Menu>
      ) : (
        title
      )}
      <Menu
        label="アカウントメニュー"
        align="end"
        contentClassName="w-48"
        triggerClassName="focus:outline-hidden"
        trigger={
          <span className="relative flex h-8 w-8 shrink-0 overflow-hidden rounded-full">
            <span className="flex h-full w-full items-center justify-center rounded-full bg-primary text-xs text-primary-foreground">
              {name.charAt(0)}
            </span>
          </span>
        }
      >
        <MenuLabel className="font-normal">
          <div className="flex flex-col sy-1">
            <p className="text-sm font-medium">{name}</p>
            <p className="text-xs text-muted-foreground">{me?.user.email}</p>
          </div>
        </MenuLabel>
        <MenuSeparator />
        <MenuItem onSelect={() => navigate('/app/system')}>
          <Settings className="mr-2 h-4 w-4" />
          設定
        </MenuItem>
        <MenuSeparator />
        <MenuItem onSelect={logout} className="text-destructive">
          <LogOut className="mr-2 h-4 w-4" />
          ログアウト
        </MenuItem>
      </Menu>
    </header>
  );
}

/** Order of the mobile 「その他」 menu (differs from the sidebar: 予約受付設定 comes before スタッフ) */
const MOBILE_MORE_ORDER = [
  '/app/consents',
  '/app/menus',
  '/app/reservation-settings',
  '/app/staff',
  '/app/settings',
  '/app/system',
];

function MobileBottomNav() {
  const { can, currentShopId } = useAuth();
  const items = useVisibleNav();
  const location = useLocation();
  const primary = items.filter((it) => it.shortLabel);
  const rest = items
    .filter((it) => !it.shortLabel)
    .sort((a, b) => MOBILE_MORE_ORDER.indexOf(a.to) - MOBILE_MORE_ORDER.indexOf(b.to));
  const unread = useUnreadCount({ shopId: currentShopId ?? undefined }, can('message.read'));
  const unreadCount = unread.data?.count ?? 0;
  const restActive = rest.some(
    (it) => location.pathname === it.to || location.pathname.startsWith(`${it.to}/`),
  );
  return (
    <nav
      aria-label="モバイルメニュー"
      className="fixed bottom-0 left-0 right-0 z-50 border-t bg-background md:hidden"
    >
      <div className="flex h-16 items-center justify-around">
        {primary.map((it) => (
          <NavLink
            key={it.to}
            to={it.to}
            end={it.end}
            className={({ isActive }) =>
              cn(
                'flex flex-col items-center gap-1 px-3 py-2',
                isActive ? 'text-primary' : 'text-muted-foreground',
              )
            }
          >
            <span className="relative">
              <it.icon className="h-5 w-5" />
              {it.to === '/app/messages' && unreadCount > 0 ? (
                <span className="absolute -right-2.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
                  {unreadCount > 99 ? '99+' : unreadCount}
                </span>
              ) : null}
            </span>
            <span className="text-[10px] font-medium">{it.shortLabel}</span>
          </NavLink>
        ))}
        {rest.length > 0 ? (
          <Menu
            label="その他のメニュー"
            side="top"
            align="end"
            contentClassName="mb-2"
            triggerClassName={cn(
              'flex flex-col items-center gap-1 px-3 py-2',
              restActive ? 'text-primary' : 'text-muted-foreground',
            )}
            trigger={
              <>
                <Ellipsis className="h-5 w-5" />
                <span className="text-[10px] font-medium">その他</span>
              </>
            }
          >
            {rest.map((it) => (
              <MenuLink key={it.to} to={it.to}>
                {it.label}
              </MenuLink>
            ))}
          </Menu>
        ) : null}
      </div>
    </nav>
  );
}

/** Routes already rebuilt on the new layout (16px base, own page padding inside <main>) */
const PORTED = [
  /^\/app\/?$/,
  /^\/app\/system\/?$/,
  /^\/app\/settings\/?$/,
  /^\/app\/calendar(\/[^/]+)?\/?$/,
  /^\/app\/customers\/?$/,
  /^\/app\/customers\/(?!duplicates)[^/]+\/?$/,
  /^\/app\/customers\/kartes\/[^/]+\/?$/,
  /^\/app\/menus\/select\/?$/,
  /^\/app\/menus(\/[^/]+)?\/?$/,
  /^\/app\/messages\/?$/,
  /^\/app\/consents\/?$/,
  /^\/app\/staff\/?$/,
  /^\/app\/reservation-settings\/?$/,
];

export function AppLayout() {
  const location = useLocation();
  const ported = PORTED.some((re) => re.test(location.pathname));
  return (
    <div className="flex h-screen flex-col text-base leading-normal md:flex-row">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:rounded-lg focus:bg-card focus:px-3 focus:py-2 focus:shadow-md"
      >
        本文へスキップ
      </a>
      <MobileHeader />
      <DesktopSidebar />
      <main id="main" className="flex-1 overflow-auto bg-muted/30 pb-20 md:pb-0">
        <div className={cn('p-4 md:p-6', !ported && 'text-[14px] leading-[1.6]')}>
          <Outlet />
        </div>
      </main>
      <MobileBottomNav />
    </div>
  );
}
