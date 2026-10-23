import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppLayout } from './AppLayout';

const h = vi.hoisted(() => ({
  perms: null as string[] | null,
  roleKey: 'owner',
  shops: [] as { id: string; name: string }[],
  setCurrentShopId: vi.fn(),
  logout: vi.fn(),
}));

vi.mock('../../lib/auth', () => ({
  useAuth: () => ({
    me: {
      user: { email: 'staff@example.com' },
      staff: { id: 'me', display_name: '山田 花子', role_key: h.roleKey, role_name: 'ロール名' },
    },
    shops: h.shops,
    currentShop: h.shops[0] ?? null,
    currentShopId: h.shops[0]?.id ?? null,
    setCurrentShopId: h.setCurrentShopId,
    can: (p: string) => (h.perms ? h.perms.includes(p) : true),
    logout: h.logout,
  }),
}));
vi.mock('../../api/messaging', () => ({ useUnreadCount: () => ({ data: { count: 3 } }) }));
vi.mock('./usePrimaryShop', () => ({ usePrimaryShopId: () => 's2' }));

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname}</div>;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/app" element={<AppLayout />}>
          <Route index element={<div>dashboard</div>} />
          <Route path="*" element={<div>page</div>} />
        </Route>
        <Route path="/login" element={<div>login page</div>} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.perms = null;
  h.roleKey = 'owner';
  h.shops = [
    { id: 's1', name: '渋谷店' },
    { id: 's2', name: '青山店' },
  ];
  h.logout.mockResolvedValue(undefined);
});

describe('mobile header', () => {
  it('opens the account menu with name, e-mail, 設定 and ログアウト', async () => {
    const user = userEvent.setup();
    renderAt('/app');
    const header = screen.getByRole('banner');
    await user.click(within(header).getByRole('button', { name: 'アカウントメニュー' }));
    const menu = within(header).getByRole('menu');
    expect(menu).toHaveTextContent('山田 花子');
    expect(menu).toHaveTextContent('staff@example.com');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((i) => i.textContent),
    ).toEqual(['設定', 'ログアウト']);
    await user.click(within(menu).getByRole('menuitem', { name: '設定' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/app/system');
    expect(within(header).queryByRole('menu')).not.toBeInTheDocument();

    await user.click(within(header).getByRole('button', { name: 'アカウントメニュー' }));
    await user.click(within(header).getByRole('menuitem', { name: 'ログアウト' }));
    expect(h.logout).toHaveBeenCalled();
    expect(await screen.findByText('login page')).toBeInTheDocument();
  });

  it('switches shops from the shop name when there is more than one shop', async () => {
    const user = userEvent.setup();
    renderAt('/app');
    const header = screen.getByRole('banner');
    await user.click(within(header).getByRole('button', { name: '店舗を切り替え' }));
    const menu = within(header).getByRole('menu');
    expect(menu).toHaveTextContent('店舗切替');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((i) => i.textContent),
    ).toEqual(['渋谷店', '青山店']);
    await user.click(within(menu).getByRole('menuitem', { name: '青山店' }));
    expect(h.setCurrentShopId).toHaveBeenCalledWith('s2');
  });

  it('shows just the shop name with a single shop', () => {
    h.shops = [{ id: 's1', name: '渋谷店' }];
    renderAt('/app');
    const header = screen.getByRole('banner');
    expect(within(header).getByRole('heading', { name: '渋谷店' })).toBeInTheDocument();
    expect(
      within(header).queryByRole('button', { name: '店舗を切り替え' }),
    ).not.toBeInTheDocument();
    // the sidebar switcher is there but has nothing to switch to
    expect(screen.getByRole('button', { name: '店舗を切り替え' })).toBeDisabled();
  });
});

describe('mobile bottom bar', () => {
  it('lists the remaining screens under その他 in the mobile order', async () => {
    const user = userEvent.setup();
    renderAt('/app/staff');
    const bar = screen.getByRole('navigation', { name: 'モバイルメニュー' });
    expect(
      within(bar)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['ホーム', '予約', '顧客', '3メッセージ']);
    const more = within(bar).getByRole('button', { name: 'その他のメニュー' });
    // a screen of the その他 menu is open → the button is highlighted
    expect(more).toHaveClass('text-primary');
    await user.click(more);
    const items = within(bar).getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual([
      '同意書一覧',
      'メニュー',
      '予約受付設定',
      'スタッフ',
      '店舗設定',
      '設定',
    ]);
    expect(items.map((i) => i.getAttribute('href'))).toEqual([
      '/app/consents',
      '/app/menus',
      '/app/reservation-settings',
      '/app/staff',
      '/app/settings',
      '/app/system',
    ]);
    await user.click(items[4]!);
    expect(screen.getByTestId('location')).toHaveTextContent('/app/settings');
    expect(within(bar).queryByRole('menu')).not.toBeInTheDocument();
  });

  it('leaves out screens the staff member may not open and is not highlighted elsewhere', async () => {
    const user = userEvent.setup();
    h.perms = MANAGER;
    renderAt('/app');
    const bar = screen.getByRole('navigation', { name: 'モバイルメニュー' });
    const more = within(bar).getByRole('button', { name: 'その他のメニュー' });
    expect(more).toHaveClass('text-muted-foreground');
    await user.click(more);
    expect(
      within(bar)
        .getAllByRole('menuitem')
        .map((i) => i.textContent),
    ).toEqual(['同意書一覧', 'メニュー', '予約受付設定', 'スタッフ', '店舗設定']);
  });

  it('always shows its four items, even without the matching permissions', () => {
    h.perms = [];
    renderAt('/app');
    const bar = screen.getByRole('navigation', { name: 'モバイルメニュー' });
    expect(
      within(bar)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['ホーム', '予約', '顧客', '3メッセージ']);
    expect(within(bar).queryByRole('button', { name: 'その他のメニュー' })).not.toBeInTheDocument();
  });
});

// permissions of the system roles (apps/api/src/auth/permissions.ts) that decide the menu
const OWNER = [
  'org.manage',
  'shop.manage',
  'staff.manage',
  'menu.manage',
  'staff.read',
  'karte.read',
  'appointment.read',
  'customer.read',
  'message.read',
];
const MANAGER = OWNER.filter((p) => p !== 'org.manage');
const STYLIST = ['staff.read', 'customer.read', 'appointment.read', 'karte.read', 'message.read'];
const RECEPTION = ['staff.read', 'customer.read', 'appointment.read', 'message.read'];

describe('menu by role', () => {
  const sidebar = () =>
    within(screen.getByRole('navigation', { name: 'メインメニュー' }))
      .getAllByRole('link')
      .map((a) => a.textContent);
  const all = [
    'ダッシュボード',
    '予約管理',
    '顧客管理',
    '同意書一覧',
    'メッセージ',
    'メニュー',
    'スタッフ',
    '予約受付設定',
    '店舗設定',
    '設定',
  ];

  it.each([
    ['owner', OWNER, all, 'オーナー'],
    ['manager', MANAGER, all.filter((l) => l !== '設定'), 'ディレクター'],
    [
      'stylist',
      STYLIST,
      ['ダッシュボード', '予約管理', '顧客管理', '同意書一覧', 'メッセージ'],
      'スタッフ',
    ],
    ['reception', RECEPTION, ['ダッシュボード', '予約管理', '顧客管理', 'メッセージ'], 'スタッフ'],
  ])('%s: sidebar items and the role under the name', (roleKey, perms, items, label) => {
    h.roleKey = roleKey;
    h.perms = perms;
    renderAt('/app');
    expect(sidebar()).toEqual(items);
    const account = screen.getByRole('link', { name: /山田 花子/ });
    expect(account).toHaveTextContent(`山田 花子${label}`);
    expect(account).toHaveAttribute('href', '/app/system?tab=owner');
  });
});

describe('sidebar shop switcher', () => {
  it('marks the main shop', async () => {
    const user = userEvent.setup();
    renderAt('/app');
    const switchers = screen.getAllByRole('button', { name: '店舗を切り替え' });
    // [0] = mobile header, [1] = sidebar
    await user.click(switchers[1]!);
    const menu = screen.getByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((i) => i.textContent),
    ).toEqual(['渋谷店', '青山店主']);
    await user.click(within(menu).getByRole('menuitem', { name: /青山店/ }));
    expect(h.setCurrentShopId).toHaveBeenCalledWith('s2');
  });
});
