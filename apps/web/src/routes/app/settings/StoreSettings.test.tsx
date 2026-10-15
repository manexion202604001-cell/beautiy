import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Shop } from '../../../api/types';
import StoreSettings from './StoreSettings';

const h = vi.hoisted(() => ({
  shop: null as unknown,
  shopLoading: false,
  can: (_p: string) => true as boolean,
  equipment: [] as unknown[],
  equipmentEnabled: [] as boolean[],
  mutate: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  api: { list: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));

vi.mock('../../../lib/auth', () => ({
  useAuth: () => ({ currentShopId: 'shop-1', can: (p: string) => h.can(p) }),
}));
vi.mock('../../../components/ui', () => ({ useToast: () => h.toast }));
vi.mock('../../../api/org', () => ({
  useShop: () => ({ data: h.shop, isLoading: h.shopLoading }),
  useUpdateShop: () => ({ mutate: h.mutate, isPending: false }),
}));
vi.mock('../../../api/storeSettings', () => ({
  equipmentApi: h.api,
  equipmentKeys: { all: ['equipment'] },
  useEquipment: (_shopId: string, _all: boolean, enabled: boolean) => {
    h.equipmentEnabled.push(enabled);
    return { data: enabled ? h.equipment : undefined, isLoading: false, isError: false };
  },
}));

const shop = (over: Partial<Shop> = {}): Shop =>
  ({
    id: 'shop-1',
    name: 'サロン 渋谷店',
    slug: 'shibuya',
    timezone: 'Asia/Tokyo',
    phone: '03-1111-2222',
    email: 'shibuya@example.com',
    postal_code: '150-0001',
    prefecture: '東京都',
    city: '渋谷区',
    address_line: '神南1-2-3',
    description: null,
    status: 'active',
    public_booking_enabled: true,
    settings: { seats: { alertEnabled: false, limit: 0 } },
    created_at: '',
    updated_at: '',
    ...over,
  }) as Shop;

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <StoreSettings />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.shop = shop();
  h.shopLoading = false;
  h.can = () => true;
  h.equipment = [];
  h.equipmentEnabled = [];
});

describe('店舗設定 › 店舗情報', () => {
  it('shows the shop profile with the address on one line and saves only what the form holds', async () => {
    const user = userEvent.setup();
    renderPage();
    expect(screen.getByRole('heading', { name: '店舗設定' })).toBeInTheDocument();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['店舗情報', '設備']);
    expect(screen.getByLabelText('店舗名')).toHaveValue('サロン 渋谷店');
    expect(screen.getByLabelText('郵便番号')).toHaveValue('150-0001');
    expect(screen.getByLabelText('住所')).toHaveValue('東京都渋谷区神南1-2-3');
    expect(screen.getByLabelText('電話番号')).toHaveValue('03-1111-2222');
    expect(screen.getByLabelText('メールアドレス')).toHaveValue('shibuya@example.com');
    // the limit field appears only while the alert is on
    expect(screen.queryByLabelText('同時最大予約数')).not.toBeInTheDocument();

    await user.clear(screen.getByLabelText('店舗名'));
    await user.type(screen.getByLabelText('店舗名'), 'サロン 渋谷本店');
    await user.clear(screen.getByLabelText('メールアドレス'));
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(h.mutate).toHaveBeenCalledTimes(1);
    const [{ id, input }] = h.mutate.mock.calls[0]!;
    expect(id).toBe('shop-1');
    // untouched address → the three address columns are not rewritten
    expect(input).toEqual({
      name: 'サロン 渋谷本店',
      postalCode: '150-0001',
      phone: '03-1111-2222',
      email: null,
      settings: { seats: { alertEnabled: false, limit: 0 } },
    });
  });

  it('splits an edited address and saves the seat alert with its limit', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.clear(screen.getByLabelText('住所'));
    await user.type(screen.getByLabelText('住所'), '東京都渋谷区宇田川町9-9');
    await user.click(screen.getByRole('switch'));
    // on without a number: refused before any request
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(h.mutate).not.toHaveBeenCalled();
    expect(h.toast.error).toHaveBeenCalledWith('店舗情報の保存に失敗しました', '同時最大予約数を入力してください');

    await user.type(screen.getByLabelText('同時最大予約数'), '5');
    await user.click(screen.getByRole('button', { name: '保存' }));
    const [{ input }] = h.mutate.mock.calls[0]!;
    expect(input).toMatchObject({
      prefecture: '東京都',
      city: '渋谷区',
      addressLine: '宇田川町9-9',
      settings: { seats: { alertEnabled: true, limit: 5 } },
    });
  });

  it('reports a failed save and locks the form without shop.manage', async () => {
    const user = userEvent.setup();
    h.mutate.mockImplementation((_vars, opts: { onError: (e: Error) => void }) => opts.onError(new Error('通信エラー')));
    const { unmount } = renderPage();
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(h.toast.error).toHaveBeenCalledWith('店舗情報の保存に失敗しました', '通信エラー');
    unmount();

    h.can = (p) => p !== 'shop.manage';
    renderPage();
    expect(screen.getByLabelText('店舗名')).toBeDisabled();
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
  });

  it('shows the loading and not-found states', () => {
    h.shopLoading = true;
    h.shop = undefined;
    const { unmount } = renderPage();
    expect(screen.getByText('読み込み中...')).toBeInTheDocument();
    unmount();
    h.shopLoading = false;
    renderPage();
    expect(screen.getByText('店舗情報が見つかりません')).toBeInTheDocument();
  });
});

describe('店舗設定 › 設備', () => {
  const openTab = async (user: ReturnType<typeof userEvent.setup>) => {
    renderPage();
    await user.click(screen.getByRole('tab', { name: '設備' }));
  };

  it('loads the list when the tab is first opened and shows the empty state', async () => {
    const user = userEvent.setup();
    renderPage();
    expect(h.equipmentEnabled).toEqual([]);
    await user.click(screen.getByRole('tab', { name: '設備' }));
    expect(h.equipmentEnabled.at(-1)).toBe(true);
    expect(screen.getByText('設備管理')).toBeInTheDocument();
    expect(screen.getByText('設備がまだ登録されていません')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '追加' })).toBeDisabled();
  });

  it('adds an equipment with its quantity', async () => {
    const user = userEvent.setup();
    h.api.create.mockResolvedValue({});
    await openTab(user);
    await user.type(screen.getByLabelText('設備名'), ' ネイル ');
    // the field never stays empty (an emptied value falls back to 1), so the number is replaced in one go
    fireEvent.change(screen.getByLabelText('数量'), { target: { value: '4' } });
    await user.click(screen.getByRole('button', { name: '追加' }));
    await waitFor(() => expect(h.api.create).toHaveBeenCalledWith({ shopId: 'shop-1', name: 'ネイル', quantity: 4 }));
    await waitFor(() => expect(screen.getByLabelText('設備名')).toHaveValue(''));

    h.api.create.mockRejectedValueOnce(new Error('同じ名前の設備が既に登録されています'));
    await user.type(screen.getByLabelText('設備名'), 'ネイル{Enter}');
    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith('設備の追加に失敗しました', '同じ名前の設備が既に登録されています'));
  });

  it('lists equipment, edits name / quantity / 有効 inline and deletes after confirmation', async () => {
    const user = userEvent.setup();
    h.equipment = [
      { shopId: 'shop-1', name: 'アイラッシュ', quantity: 5, isActive: true },
      { shopId: 'shop-1', name: 'shampoo', quantity: 2, isActive: false },
    ];
    h.api.update.mockResolvedValue({});
    h.api.delete.mockResolvedValue(undefined);
    await openTab(user);
    const rows = screen.getAllByTestId('equipment-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('アイラッシュ')).toHaveClass('font-medium');
    expect(within(rows[0]!).getByText('5台')).toBeInTheDocument();
    // a preset type of the previous resource screen is shown under its Japanese name
    expect(within(rows[1]!).getByText('シャンプー台')).toHaveClass('line-through');
    expect(within(rows[1]!).getByText('無効')).toBeInTheDocument();

    await user.click(within(rows[1]!).getByRole('button', { name: '編集' }));
    const editing = screen.getAllByTestId('equipment-row')[1]!;
    expect(within(editing).getByLabelText('設備名')).toHaveValue('シャンプー台');
    fireEvent.change(within(editing).getByLabelText('数量'), { target: { value: '3' } });
    await user.click(within(editing).getByRole('switch', { name: '有効' }));
    await user.click(within(editing).getByRole('button', { name: '保存' }));
    // label left as shown → the stored name is not renamed
    await waitFor(() =>
      expect(h.api.update).toHaveBeenCalledWith({ shopId: 'shop-1', name: 'shampoo', newName: undefined, quantity: 3, isActive: true }),
    );

    await user.click(within(screen.getAllByTestId('equipment-row')[0]!).getByRole('button', { name: '編集' }));
    const first = screen.getAllByTestId('equipment-row')[0]!;
    await user.clear(within(first).getByLabelText('設備名'));
    await user.type(within(first).getByLabelText('設備名'), 'マツエク');
    await user.click(within(first).getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(h.api.update).toHaveBeenLastCalledWith({ shopId: 'shop-1', name: 'アイラッシュ', newName: 'マツエク', quantity: 5, isActive: true }),
    );

    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    await user.click(within(screen.getAllByTestId('equipment-row')[0]!).getByRole('button', { name: '削除' }));
    expect(confirm).toHaveBeenCalledWith('この設備を削除しますか？');
    expect(h.api.delete).not.toHaveBeenCalled();
    await user.click(within(screen.getAllByTestId('equipment-row')[0]!).getByRole('button', { name: '削除' }));
    await waitFor(() => expect(h.api.delete).toHaveBeenCalledWith('shop-1', 'アイラッシュ'));
    confirm.mockRestore();
  });
});
