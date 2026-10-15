import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MORE_FEATURES } from '../../../components/layout/nav';
import System from '../System';

const OWNER_PERMS = ['org.manage', 'shop.manage', 'staff.manage', 'staff.read', 'analytics.read', 'campaign.manage', 'integration.manage', 'ops.manage', 'schedule.read'];
const STYLIST_PERMS = ['staff.read', 'analytics.read_own', 'schedule.read'];

const h = vi.hoisted(() => ({
  perms: [] as string[],
  shops: [] as { id: string; name: string }[],
  currentShopId: 's1',
  setCurrentShopId: vi.fn(),
  org: undefined as unknown,
  staff: [] as unknown[],
  invitations: [] as unknown[],
  saveOwner: vi.fn(),
  invalidateShops: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  shopApi: { create: vi.fn(), delete: vi.fn() },
  staffApi: { setShops: vi.fn(), setVisibility: vi.fn(), invite: vi.fn(), invitations: vi.fn() },
  orgStaff: vi.fn(),
}));

vi.mock('../../../lib/auth', () => ({
  useAuth: () => ({
    me: {
      user: { email: 'owner@example.com', mfa_enabled: false },
      staff: { id: 'me', display_name: 'オーナー 太郎' },
      organization: { id: 'o1' },
      organizations: [{ id: 'o1', name: '自社', slug: 'own' }],
    },
    shops: h.shops,
    currentShop: h.shops.find((s) => s.id === h.currentShopId) ?? null,
    currentShopId: h.currentShopId,
    setCurrentShopId: h.setCurrentShopId,
    can: (p: string) => h.perms.includes(p),
    timezone: 'Asia/Tokyo',
    switchOrganization: vi.fn(),
  }),
}));
vi.mock('../../../components/ui', () => ({ useToast: () => h.toast }));
vi.mock('../../../components/layout/AccountDialogs', () => ({
  PasswordDialog: ({ open }: { open: boolean }) => (open ? <div>password dialog</div> : null),
  MfaDialog: ({ open }: { open: boolean }) => (open ? <div>mfa dialog</div> : null),
}));
vi.mock('../../../components/layout/usePrimaryShop', () => ({ usePrimaryShopId: () => 's1' }));
vi.mock('../../../api/org', () => ({
  orgApi: { staff: h.orgStaff },
  orgKeys: { org: ['organization'], shops: ['shops'], staffAll: ['staff'], staff: (q: object) => ['staff', 'list', q] },
  useOrganization: () => ({ data: h.org }),
  useStaffList: () => ({ data: h.staff, isLoading: false, isError: false }),
  useRoles: () => ({
    data: [
      { id: 'r1', key: 'stylist', name: 'スタイリスト' },
      { id: 'r2', key: 'manager', name: '店長' },
    ],
  }),
}));
vi.mock('../../../api/storeSettings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../api/storeSettings')>()),
  shopAdminApi: h.shopApi,
  staffAdminApi: h.staffApi,
  useInvalidateShops: () => h.invalidateShops,
  useSaveOwnerProfile: () => ({ mutate: h.saveOwner, isPending: false }),
  useStaffInvitations: () => ({ data: h.invitations, isLoading: false, isError: false }),
}));

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname + loc.search}</div>;
}

function renderAt(path = '/app/system') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/app/system" element={<System />} />
          <Route path="/app/settings" element={<div>store settings page</div>} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const member = (id: string, name: string, shops: { shop_id: string; is_primary?: boolean; is_visible_to_customer?: boolean }[], over = {}) => ({
  id,
  display_name: name,
  email: `${id}@example.com`,
  title: null,
  status: 'active',
  role: { id: 'r1', key: 'stylist', name: 'スタイリスト' },
  shops: shops.map((s) => ({ started_on: null, is_primary: false, is_visible_to_customer: true, ...s })),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.perms = OWNER_PERMS;
  h.shops = [
    { id: 's1', name: '渋谷店' },
    { id: 's2', name: '青山店' },
  ];
  h.currentShopId = 's1';
  h.org = { id: 'o1', name: '自社', settings: {} };
  h.staff = [];
  h.invitations = [];
  h.invalidateShops.mockResolvedValue(undefined);
});

describe('設定: tabs', () => {
  it('shows the four tabs to the owner and opens 店舗一覧 first', () => {
    renderAt();
    expect(screen.getByRole('heading', { name: '設定' })).toBeInTheDocument();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['店舗一覧', 'オーナー情報', 'スタッフ管理', 'その他の機能']);
    expect(screen.getByRole('tab', { name: '店舗一覧' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('オーナーが管理する全店舗')).toBeInTheDocument();
  });

  it('gives staff without owner rights their account tab and only the features they may open', async () => {
    const user = userEvent.setup();
    h.perms = STYLIST_PERMS;
    renderAt();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['店舗一覧', 'アカウント', 'その他の機能']);
    expect(screen.queryByRole('button', { name: '新しい店舗' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'その他の機能' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/app/system?tab=more');
    const main = screen.getByRole('tabpanel');
    expect(within(main).getByRole('link', { name: /分析/ })).toHaveAttribute('href', '/app/analytics');
    expect(within(main).queryByRole('link', { name: /配信/ })).not.toBeInTheDocument();
    expect(within(main).queryByRole('link', { name: /外部連携/ })).not.toBeInTheDocument();
    expect(within(main).queryByRole('link', { name: /運用・監査/ })).not.toBeInTheDocument();
    // the list is whatever nav.ts declares, filtered by permission
    const allowed = MORE_FEATURES.filter((f) => !f.permissions || f.permissions.some((p) => STYLIST_PERMS.includes(p)));
    expect(within(main).getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(allowed.map((f) => f.to));

    await user.click(screen.getByRole('tab', { name: 'アカウント' }));
    expect(screen.queryByText('事業形態や会社情報を設定します')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'パスワード変更' }));
    expect(screen.getByText('password dialog')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '二段階認証' }));
    expect(screen.getByText('mfa dialog')).toBeInTheDocument();
  });

  it('opens the tab named in the address', () => {
    renderAt('/app/system?tab=more');
    expect(screen.getByRole('tab', { name: 'その他の機能' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('メニューにない機能はここから開きます')).toBeInTheDocument();
  });
});

describe('設定 › 店舗一覧', () => {
  it('marks the main and the selected shop and opens the shop settings of a shop', async () => {
    const user = userEvent.setup();
    renderAt();
    const rows = screen.getAllByTestId('shop-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('主')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('選択中')).toBeInTheDocument();
    expect(within(rows[1]!).queryByText('主')).not.toBeInTheDocument();
    expect(within(rows[1]!).queryByText('選択中')).not.toBeInTheDocument();

    await user.click(within(rows[1]!).getByRole('button', { name: '店舗設定' }));
    expect(h.setCurrentShopId).toHaveBeenCalledWith('s2');
    expect(screen.getByTestId('location')).toHaveTextContent('/app/settings');
  });

  it('creates a shop from the dialog', async () => {
    const user = userEvent.setup();
    h.shopApi.create.mockResolvedValue({ id: 's3' });
    renderAt();
    await user.click(screen.getByRole('button', { name: '新しい店舗' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('新しい店舗を作成')).toBeInTheDocument();
    const create = within(dialog).getByRole('button', { name: '作成' });
    expect(create).toBeDisabled();
    await user.type(within(dialog).getByLabelText('店舗名 *'), '新宿店');
    await user.type(within(dialog).getByLabelText('住所'), '東京都新宿区1-1');
    await user.type(within(dialog).getByLabelText('電話番号'), '03-1234-5678');
    await user.click(create);
    await waitFor(() =>
      expect(h.shopApi.create).toHaveBeenCalledWith({ name: '新宿店', addressLine: '東京都新宿区1-1', phone: '03-1234-5678', email: null }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(h.invalidateShops).toHaveBeenCalled();

    h.shopApi.create.mockRejectedValueOnce(new Error('通信エラー'));
    await user.click(screen.getByRole('button', { name: '新しい店舗' }));
    await user.type(within(screen.getByRole('dialog')).getByLabelText('店舗名 *'), '池袋店');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '作成' }));
    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith('店舗の作成に失敗しました', '通信エラー'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('deletes a shop after confirmation and moves off it when it was selected', async () => {
    const user = userEvent.setup();
    h.shopApi.delete.mockResolvedValue(undefined);
    renderAt();
    await user.click(screen.getByRole('button', { name: '渋谷店を削除' }));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText('店舗を削除しますか？')).toBeInTheDocument();
    expect(dialog).toHaveTextContent('「渋谷店」を削除します。');
    await user.click(within(dialog).getByRole('button', { name: 'キャンセル' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(h.shopApi.delete).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '渋谷店を削除' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '削除する' }));
    await waitFor(() => expect(h.shopApi.delete).toHaveBeenCalledWith('s1'));
    await waitFor(() => expect(h.setCurrentShopId).toHaveBeenCalledWith('s2'));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('offers no delete button for the only shop', () => {
    h.shops = [{ id: 's1', name: '渋谷店' }];
    renderAt();
    expect(screen.queryByRole('button', { name: /を削除$/ })).not.toBeInTheDocument();
  });
});

describe('設定 › オーナー情報', () => {
  it('loads the saved profile, shows company fields only for 法人 and saves', async () => {
    const user = userEvent.setup();
    h.org = { id: 'o1', name: '自社', settings: { ownerProfile: { ownerType: 'company', companyName: '株式会社サンプル', companyPhone: '03-0000-0000' } } };
    h.saveOwner.mockImplementation((_v, opts: { onSuccess: () => void }) => opts.onSuccess());
    renderAt('/app/system?tab=owner');
    expect(screen.getByLabelText('会社名')).toHaveValue('株式会社サンプル');
    expect(screen.getByLabelText('電話番号')).toHaveValue('03-0000-0000');
    await user.type(screen.getByLabelText('郵便番号'), '150-0001');
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(h.saveOwner.mock.calls[0]![0]).toEqual({
      ownerType: 'company',
      companyName: '株式会社サンプル',
      companyPostalCode: '150-0001',
      companyPhone: '03-0000-0000',
      companyAddress: null,
      companyEmail: null,
    });
    expect(screen.getByRole('alert')).toHaveTextContent('オーナー情報を保存しました');

    // 個人: the company fields disappear and are saved empty
    await user.click(screen.getByRole('combobox', { name: '事業形態' }));
    await user.click(screen.getByRole('option', { name: '個人' }));
    expect(screen.queryByLabelText('会社名')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(h.saveOwner.mock.calls[1]![0]).toEqual({
      ownerType: 'individual',
      companyName: null,
      companyPostalCode: null,
      companyPhone: null,
      companyAddress: null,
      companyEmail: null,
    });
    // the account settings stay available under the owner's own content
    expect(screen.getByRole('button', { name: 'パスワード変更' })).toBeInTheDocument();
  });

  it('cannot be saved before 事業形態 is chosen and shows a failed save', async () => {
    const user = userEvent.setup();
    h.saveOwner.mockImplementation((_v, opts: { onError: (e: Error) => void }) => opts.onError(new Error('権限がありません')));
    renderAt('/app/system?tab=owner');
    expect(screen.getByRole('combobox', { name: '事業形態' })).toHaveTextContent('選択してください');
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
    await user.click(screen.getByRole('combobox', { name: '事業形態' }));
    await user.click(screen.getByRole('option', { name: '法人' }));
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(screen.getByRole('alert')).toHaveTextContent('権限がありません');
  });
});

describe('設定 › スタッフ管理', () => {
  it('ticks and unticks shops keeping the main shop, and toggles visibility to customers', async () => {
    const user = userEvent.setup();
    h.staff = [
      member('a', '佐藤', [{ shop_id: 's1', is_primary: true }]),
      member('b', '鈴木', [{ shop_id: 's2', is_primary: true, is_visible_to_customer: false }]),
    ];
    h.staffApi.setShops.mockResolvedValue({});
    h.staffApi.setVisibility.mockResolvedValue({});
    renderAt('/app/system?tab=staff');
    // columns follow the group's shop order
    expect(screen.getAllByRole('columnheader').map((c) => c.textContent)).toEqual(['スタッフ', '渋谷店', '青山店']);
    const rows = screen.getAllByTestId('staff-row');
    expect(rows.map((r) => within(r).getAllByRole('checkbox').map((c) => c.getAttribute('aria-checked')))).toEqual([
      ['true', 'false'],
      ['false', 'true'],
    ]);

    await user.click(within(rows[0]!).getAllByRole('checkbox')[1]!);
    await waitFor(() => expect(h.staffApi.setShops).toHaveBeenCalledWith('a', ['s1', 's2'], 's1'));
    await user.click(within(rows[1]!).getAllByRole('checkbox')[1]!);
    await waitFor(() => expect(h.staffApi.setShops).toHaveBeenLastCalledWith('b', [], undefined));

    await user.click(within(rows[0]!).getByRole('button', { name: 'お客様に表示中' }));
    await waitFor(() => expect(h.staffApi.setVisibility).toHaveBeenCalledWith('a', 's1', false));
    await user.click(within(rows[1]!).getByRole('button', { name: 'お客様に非表示' }));
    await waitFor(() => expect(h.staffApi.setVisibility).toHaveBeenLastCalledWith('b', 's2', true));

    // header button: staff of that shop first
    await user.click(screen.getByRole('button', { name: '青山店' }));
    expect(screen.getAllByTestId('staff-row').map((r) => within(r).getByText(/佐藤|鈴木/).textContent)).toEqual(['鈴木', '佐藤']);
  });

  it('invites a new person by e-mail and shows the link', async () => {
    const user = userEvent.setup();
    h.orgStaff.mockResolvedValue([]);
    h.staffApi.invite.mockResolvedValue({ invitationId: 'i1', staffId: 'n1', inviteUrl: 'https://app.example/invite/tok', emailSent: true });
    renderAt('/app/system?tab=staff');
    const search = screen.getByRole('button', { name: '検索' });
    expect(search).toBeDisabled();
    await user.type(screen.getByLabelText('スタッフのメールアドレス'), 'new@example.com');
    await user.click(search);
    const result = await screen.findByTestId('invite-result');
    const send = within(result).getByRole('button', { name: '招待を送信' });
    expect(send).toBeDisabled();
    await user.type(within(result).getByLabelText('お名前'), '新人 花子');
    await user.click(within(result).getByRole('combobox', { name: '権限' }));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['スタイリスト', '店長']);
    await user.click(screen.getByRole('option', { name: '店長' }));
    await user.click(send);
    await waitFor(() =>
      expect(h.staffApi.invite).toHaveBeenCalledWith({ email: 'new@example.com', displayName: '新人 花子', roleKey: 'manager', shopId: 's1' }),
    );
    const sent = await screen.findByTestId('invite-sent');
    expect(sent).toHaveTextContent('new@example.com に招待メールを送信しました。');
    expect(within(sent).getByLabelText('招待リンク')).toHaveValue('https://app.example/invite/tok');
    expect(screen.queryByTestId('invite-result')).not.toBeInTheDocument();
  });

  it('adds an already registered staff member to the selected shop instead of inviting again', async () => {
    const user = userEvent.setup();
    h.orgStaff.mockResolvedValue([member('b', '鈴木', [{ shop_id: 's2', is_primary: true }])]);
    h.staffApi.setShops.mockResolvedValue({});
    renderAt('/app/system?tab=staff');
    await user.type(screen.getByLabelText('スタッフのメールアドレス'), 'B@example.com');
    await user.click(screen.getByRole('button', { name: '検索' }));
    const result = await screen.findByTestId('invite-result');
    expect(within(result).getByText('鈴木')).toBeInTheDocument();
    await user.click(within(result).getByRole('button', { name: 'この店舗に追加' }));
    await waitFor(() => expect(h.staffApi.setShops).toHaveBeenCalledWith('b', ['s2', 's1'], 's2'));
    expect(h.staffApi.invite).not.toHaveBeenCalled();
  });

  it('shows a failed invitation and the invitation history with its states', async () => {
    const user = userEvent.setup();
    h.orgStaff.mockResolvedValue([]);
    h.staffApi.invite.mockRejectedValue(new Error('このメールアドレスのスタッフは既に登録されています'));
    const inv = (id: string, status: string) => ({
      id,
      staff_id: id,
      shop_id: 's1',
      email: `${id}@example.com`,
      accepted_at: null,
      created_at: '2026-10-01T03:00:00Z',
      staff_name: `招待${id}`,
      shop_name: '渋谷店',
      role_key: 'stylist',
      role_name: 'スタイリスト',
      invited_by_name: 'オーナー 太郎',
      status,
    });
    h.invitations = [inv('1', 'pending'), inv('2', 'accepted'), inv('3', 'cancelled')];
    renderAt('/app/system?tab=staff');
    const rows = screen.getAllByTestId('invitation-row');
    expect(rows.map((r) => within(r).getByText(/承認待ち|承認済み|取消/).textContent)).toEqual(['承認待ち', '承認済み', '取消']);
    expect(rows[0]).toHaveTextContent('渋谷店 / スタイリスト / オーナー 太郎が招待');
    expect(rows[0]).toHaveTextContent('2026/10/1');

    await user.type(screen.getByLabelText('スタッフのメールアドレス'), 'dup@example.com');
    await user.click(screen.getByRole('button', { name: '検索' }));
    const result = await screen.findByTestId('invite-result');
    await user.type(within(result).getByLabelText('お名前'), '重複');
    await user.click(within(result).getByRole('button', { name: '招待を送信' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('このメールアドレスのスタッフは既に登録されています');
  });
});
