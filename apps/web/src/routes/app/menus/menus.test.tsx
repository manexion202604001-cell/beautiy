import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EffectiveMenu, MenuCategory, MenuDetail } from '../../../api/types';
import { ApiError } from '../../../lib/api';
import MenuCategories from './MenuCategories';
import MenuEdit from './MenuEdit';
import MenuList from './MenuList';
import { childLabel, groupColor, groupMenus, groupOfCategory } from './model';

const h = vi.hoisted(() => ({
  menus: [] as unknown[],
  categories: [] as unknown[],
  staff: [] as unknown[],
  equipment: [] as unknown[],
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  api: {
    menu: vi.fn(),
    createMenu: vi.fn(),
    updateMenu: vi.fn(),
    deleteMenu: vi.fn(),
    deleteMenuIfUnused: vi.fn(),
    reorderMenus: vi.fn(),
    setListing: vi.fn(),
    setStaffAssignments: vi.fn(),
    setEquipmentAssignments: vi.fn(),
    createCategory: vi.fn(),
    updateCategory: vi.fn(),
    deleteCategory: vi.fn(),
    deleteAllCategories: vi.fn(),
    reorderCategories: vi.fn(),
  },
  uploadFile: vi.fn(),
}));

vi.mock('../../../lib/auth', () => ({
  useAuth: () => ({ currentShopId: 'shop-1', can: () => true, timezone: 'Asia/Tokyo' }),
}));
vi.mock('../../../components/ui', () => ({ useToast: () => h.toast }));
vi.mock('../../../api/catalog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../api/catalog')>()),
  catalogApi: h.api,
  useMenus: () => ({ data: h.menus, isLoading: false }),
  useCategories: () => ({ data: h.categories, isLoading: false }),
}));
vi.mock('../../../api/org', () => ({ useStaffList: () => ({ data: h.staff, isLoading: false }) }));
vi.mock('../../../api/storeSettings', () => ({ useEquipment: () => ({ data: h.equipment, isLoading: false }) }));
vi.mock('../../../api/files', () => ({
  uploadFile: h.uploadFile,
  sameOriginBlobUrl: (url: string) => url,
}));

const category = (over: Partial<MenuCategory> & { id: string; name: string }): MenuCategory => ({
  shop_id: 'shop-1',
  sort_order: 0,
  color: null,
  parent_id: null,
  ...over,
});

const menu = (over: Partial<EffectiveMenu> & { id: string; name: string }): EffectiveMenu => ({
  shopId: 'shop-1',
  categoryId: null,
  categoryName: null,
  description: null,
  durationMin: 60,
  bufferBeforeMin: 0,
  bufferAfterMin: 0,
  price: 5500,
  priceTaxIncluded: true,
  taxRateBp: 1000,
  isPublic: true,
  isConsultation: false,
  newCustomerOnly: false,
  sortOrder: 0,
  status: 'active',
  isOverridden: false,
  resourceRequirements: [],
  staffIds: [],
  menuType: 'regular',
  couponType: null,
  subCategoryIds: [],
  imageUrl: null,
  ...over,
});

const CATEGORIES = [
  category({ id: 'c-eye', name: 'まつげ', color: '#EAB308' }),
  category({ id: 'c-eye-up', name: 'まつげ：上', color: '#EAB308', parent_id: 'c-eye' }),
  category({ id: 'c-eye-low', name: 'まつげ：下', color: '#EAB308', parent_id: 'c-eye', sort_order: 1 }),
  category({ id: 'c-nail', name: 'ネイル', color: '#3B82F6', sort_order: 1 }),
];

const MENUS = [
  menu({ id: 'm1', name: 'パリジェンヌ', categoryId: 'c-eye-up', categoryName: 'まつげ：上', staffIds: ['s1', 's2'], sortOrder: 0 }),
  menu({ id: 'm2', name: '下まつげパーマ', categoryId: 'c-eye-low', categoryName: 'まつげ：下', sortOrder: 1, status: 'inactive', description: '下まつげ専用' }),
  menu({ id: 'm3', name: 'ジェルネイル', categoryId: 'c-nail', categoryName: 'ネイル', price: 7700, durationMin: 90, resourceRequirements: [{ resourceType: 'ネイル', offsetMin: 0, durationMin: null }] }),
  menu({ id: 'k1', name: '【新規】カット', menuType: 'coupon', couponType: 'new', sortOrder: 1 }),
  menu({ id: 'k2', name: '【再来】カラー', menuType: 'coupon', couponType: 'repeat', sortOrder: 0 }),
  menu({ id: 'k3', name: '【全員】スパ', menuType: 'coupon', couponType: 'all', sortOrder: 2, expiryDate: '2020-01-31' }),
];

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname + loc.search}</div>;
}

function renderAt(path: string, routes: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>{routes}</Routes>
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const listRoutes = (
  <>
    <Route path="/app/menus" element={<MenuList />} />
    <Route path="/app/menus/categories" element={<div>categories page</div>} />
    <Route path="/app/menus/new" element={<div>new page</div>} />
    <Route path="/app/menus/:id" element={<div>edit page</div>} />
  </>
);
const editRoutes = (
  <>
    <Route path="/app/menus" element={<div>list page</div>} />
    <Route path="/app/menus/new" element={<MenuEdit />} />
    <Route path="/app/menus/:id" element={<MenuEdit />} />
  </>
);

/** the row of a menu (phone and desktop markup are both in the DOM under jsdom) */
const rowOf = (id: string) => document.querySelector<HTMLElement>(`[data-menu="${id}"]`)!;
const rowIds = () => [...document.querySelectorAll('[data-menu]')].map((e) => e.getAttribute('data-menu'));

beforeEach(() => {
  vi.clearAllMocks();
  h.menus = MENUS;
  h.categories = CATEGORIES;
  h.staff = [
    { id: 's1', display_name: '佐藤', status: 'active' },
    { id: 's2', display_name: '鈴木', status: 'active' },
    { id: 's3', display_name: '退職者', status: 'retired' },
  ];
  h.equipment = [
    { shopId: 'shop-1', name: 'ネイル', quantity: 4, isActive: true },
    { shopId: 'shop-1', name: 'アイラッシュ', quantity: 5, isActive: true },
  ];
  for (const fn of Object.values(h.api)) fn.mockResolvedValue({});
});

describe('menu model', () => {
  it('groups by the category name up to 「：」 and colours the group like its parent', () => {
    expect(groupOfCategory('まつげ：上')).toBe('まつげ');
    expect(groupOfCategory('ネイル')).toBe('ネイル');
    expect(groupOfCategory(null)).toBe('その他');
    expect(childLabel('まつげ：上：左')).toBe('上：左');
    expect(childLabel('ネイル')).toBe('ネイル');
    const groups = groupMenus(MENUS.slice(0, 3));
    expect([...groups.keys()]).toEqual(['まつげ', 'ネイル']);
    expect(groups.get('まつげ')!.map((m) => m.id)).toEqual(['m1', 'm2']);
    const colors = new Map<string, string | null>([
      ['まつげ', '#EAB308'],
      ['エステ：顔', '#22C55E'],
    ]);
    expect(groupColor('まつげ', [], colors)).toBe('#EAB308');
    // no category named like the group: the colour of the first menu's own category
    expect(groupColor('エステ', [{ categoryName: 'エステ：顔' }], colors)).toBe('#22C55E');
    expect(groupColor('その他', [{ categoryName: null }], colors)).toBe('#6B7280');
  });
});

describe('メニュー管理', () => {
  it('lists regular menus by category group with counts, badges and the 掲載 state', async () => {
    renderAt('/app/menus', listRoutes);
    expect(screen.getByRole('heading', { level: 1, name: 'メニュー管理' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^通常メニュー\s*3$/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /^クーポン\s*3$/ })).toHaveAttribute('aria-selected', 'false');
    expect(rowIds()).toEqual(['m1', 'm2', 'm3']);
    expect(screen.getByText('まつげ')).toBeInTheDocument();
    expect(screen.getByText('ネイル')).toBeInTheDocument();

    const m1 = within(rowOf('m1'));
    expect(m1.getByText('2名対応')).toBeInTheDocument();
    expect(m1.getAllByText('1時間').length).toBeGreaterThan(0);
    expect(m1.getByRole('button', { name: '非掲載' })).toBeInTheDocument();
    // a hidden menu is dimmed, tagged and offers 掲載
    expect(rowOf('m2').className).toContain('opacity-50');
    expect(within(rowOf('m2')).getAllByText('非掲載').length).toBeGreaterThan(0);
    expect(within(rowOf('m2')).getByRole('button', { name: '掲載' })).toBeInTheDocument();
    expect(within(rowOf('m2')).getAllByText('下まつげ専用').length).toBe(2);
    expect(within(rowOf('m3')).getAllByText(/7,700/).length).toBe(2);
  });

  it('toggles 掲載, reorders inside a group and opens the edit page', async () => {
    const user = userEvent.setup();
    renderAt('/app/menus', listRoutes);

    await user.click(within(rowOf('m1')).getByRole('button', { name: '非掲載' }));
    expect(h.api.setListing).toHaveBeenCalledWith('m1', 'shop-1', false);
    await user.click(within(rowOf('m2')).getByRole('button', { name: '掲載' }));
    expect(h.api.setListing).toHaveBeenCalledWith('m2', 'shop-1', true);

    // first row cannot go up; moving it down swaps the two menus of the group
    const up = within(rowOf('m1')).getAllByRole('button', { name: '上へ移動' });
    expect(up[0]).toBeDisabled();
    await user.click(within(rowOf('m1')).getAllByRole('button', { name: '下へ移動' })[0]!);
    expect(h.api.reorderMenus).toHaveBeenCalledWith([
      { id: 'm2', sortOrder: 0 },
      { id: 'm1', sortOrder: 1 },
    ]);
    expect(await screen.findByText('並び順を保存しました')).toBeInTheDocument();

    await user.click(within(rowOf('m3')).getAllByRole('button', { name: '編集' })[0]!);
    expect(screen.getByTestId('location')).toHaveTextContent('/app/menus/m3');
  });

  it('deletes after one confirmation, or asks again when reservations use the menu', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm');
    renderAt('/app/menus', listRoutes);
    const del = (id: string) => within(rowOf(id)).getAllByRole('button', { name: '削除' })[0]!;

    confirm.mockReturnValueOnce(false);
    await user.click(del('m1'));
    expect(confirm).toHaveBeenLastCalledWith('このメニューを削除しますか？');
    expect(h.api.deleteMenuIfUnused).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    await user.click(del('m1'));
    expect(h.api.deleteMenuIfUnused).toHaveBeenCalledWith('m1');
    expect(h.api.deleteMenu).not.toHaveBeenCalled();

    h.api.deleteMenuIfUnused.mockRejectedValueOnce(
      new ApiError({ status: 409, code: 'MENU_IN_USE', category: 'conflict', message: 'このメニューは予約で使用されています。' }),
    );
    await user.click(del('m3'));
    await waitFor(() => expect(h.api.deleteMenu).toHaveBeenCalledWith('m3'));
    expect(confirm).toHaveBeenLastCalledWith(
      'このメニューは予約で使用されています。\n\n非表示にしますか？（予約履歴は保持されます）',
    );
    expect(h.toast.error).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('shows coupons as one list in their own order, filtered by type', async () => {
    const user = userEvent.setup();
    renderAt('/app/menus?tab=coupon', listRoutes);
    expect(screen.getByRole('tab', { name: /^クーポン\s*3$/ })).toHaveAttribute('aria-selected', 'true');
    expect(rowIds()).toEqual(['k2', 'k1', 'k3']);
    expect(within(rowOf('k1')).getAllByText('新規').length).toBe(2);
    expect(within(rowOf('k3')).getAllByText('全員').length).toBe(2);
    // past its expiry date: marked, since it is no longer offered for reservations
    expect(within(rowOf('k3')).getAllByText('期限切れ').length).toBe(2);
    expect(within(rowOf('k1')).queryByText('期限切れ')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'すべて3' })).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: '再来1' }));
    expect(rowIds()).toEqual(['k2']);
    await user.click(screen.getByRole('button', { name: '全員1' }));
    expect(rowIds()).toEqual(['k3']);

    await user.click(screen.getByRole('button', { name: '新規クーポン' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/app/menus/new?type=coupon');
  });

  it('saves the staff matrix for the active staff of the shop', async () => {
    const user = userEvent.setup();
    renderAt('/app/menus', listRoutes);
    await user.click(screen.getByRole('button', { name: '対応スタッフ' }));
    expect(screen.getByText('対応スタッフ設定')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '佐藤' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: '退職者' })).not.toBeInTheDocument();
    // every menu of the shop is a row, coupons included
    expect(screen.getByRole('checkbox', { name: '【新規】カット × 佐藤' })).toHaveAttribute('aria-checked', 'false');
    const cell = screen.getByRole('checkbox', { name: 'パリジェンヌ × 鈴木' });
    expect(cell).toHaveAttribute('aria-checked', 'true');
    await user.click(cell);
    expect(cell).toHaveAttribute('aria-checked', 'false');
    await user.click(screen.getByRole('checkbox', { name: 'ジェルネイル × 佐藤' }));

    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith('保存しました'));
    const sent = h.api.setStaffAssignments.mock.calls[0]![0];
    expect(sent.shopId).toBe('shop-1');
    expect(sent.staffIds).toEqual(['s1', 's2']);
    expect(sent.assignments).toHaveLength(6);
    expect(sent.assignments.find((a: { menuId: string }) => a.menuId === 'm1')).toEqual({ menuId: 'm1', staffIds: ['s1'] });
    expect(sent.assignments.find((a: { menuId: string }) => a.menuId === 'm3')).toEqual({ menuId: 'm3', staffIds: ['s1'] });

    await user.click(screen.getByRole('button', { name: 'リスト表示' }));
    expect(rowIds()).toEqual(['m1', 'm2', 'm3']);
  });

  it('saves the equipment matrix by equipment name and reports a failed save', async () => {
    const user = userEvent.setup();
    renderAt('/app/menus', listRoutes);
    await user.click(screen.getByRole('button', { name: '対応設備' }));
    expect(screen.getByText('対応設備設定')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'ジェルネイル × ネイル' })).toHaveAttribute('aria-checked', 'true');
    await user.click(screen.getByRole('checkbox', { name: 'パリジェンヌ × アイラッシュ' }));
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(h.api.setEquipmentAssignments).toHaveBeenCalled());
    const sent = h.api.setEquipmentAssignments.mock.calls[0]![0];
    expect(sent.resourceTypes).toEqual(['ネイル', 'アイラッシュ']);
    expect(sent.assignments.find((a: { menuId: string }) => a.menuId === 'm1')).toEqual({ menuId: 'm1', resourceTypes: ['アイラッシュ'] });
    expect(sent.assignments.find((a: { menuId: string }) => a.menuId === 'm3')).toEqual({ menuId: 'm3', resourceTypes: ['ネイル'] });

    h.api.setEquipmentAssignments.mockRejectedValueOnce(new Error('通信エラー'));
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith('保存に失敗しました', '通信エラー'));
  });
});

describe('メニュー編集', () => {
  it('registers a new menu with its categories, price, duration and 掲載', async () => {
    const user = userEvent.setup();
    h.api.createMenu.mockResolvedValue({ id: 'new-1' });
    renderAt('/app/menus/new?type=regular', editRoutes);
    expect(screen.getByRole('heading', { level: 1, name: '新規メニュー' })).toBeInTheDocument();

    // name is required
    await user.click(screen.getByRole('button', { name: '登録' }));
    expect(h.toast.error).toHaveBeenCalledWith('名前は必須です');
    expect(h.api.createMenu).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'カテゴリを選択' }));
    const picker = screen.getByRole('dialog', { name: 'カテゴリ' });
    // a parent with children is a heading; its children are listed without the parent part
    await user.click(within(picker).getByText('上'));
    await user.click(within(picker).getByText('ネイル'));
    expect(screen.getByRole('button', { name: '2件選択中' })).toBeInTheDocument();

    await user.type(screen.getByLabelText(/^メニュー名/), 'パリジェンヌラッシュリフト');
    await user.type(screen.getByLabelText('メニュー説明'), '根元から立ち上げます');
    await user.clear(screen.getByLabelText(/^価格（税込）/));
    await user.type(screen.getByLabelText(/^価格（税込）/), '6600');
    await user.clear(screen.getByLabelText(/^所要目安時間/));
    await user.type(screen.getByLabelText(/^所要目安時間/), '75');
    await user.click(screen.getByText('「～」を表示'));
    await user.click(screen.getByRole('radio', { name: '非掲載' }));
    await user.click(screen.getByRole('button', { name: '登録' }));

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/app\/menus$/));
    expect(h.api.createMenu).toHaveBeenCalledWith({
      shopId: 'shop-1',
      status: 'inactive',
      subCategoryIds: ['c-eye-up', 'c-nail'],
      name: 'パリジェンヌラッシュリフト',
      description: '根元から立ち上げます',
      durationMin: 75,
      price: 6600,
      menuType: 'regular',
      couponType: null,
      presentationCondition: null,
      usageCondition: null,
      expiryDate: null,
      priceTilde: true,
    });
    expect(h.uploadFile).not.toHaveBeenCalled();
  });

  it('refuses a duration the booking engine cannot use', async () => {
    const user = userEvent.setup();
    renderAt('/app/menus/new?type=regular', editRoutes);
    await user.type(screen.getByLabelText(/^メニュー名/), 'カット');
    await user.clear(screen.getByLabelText(/^所要目安時間/));
    await user.click(screen.getByRole('button', { name: '登録' }));
    expect(h.toast.error).toHaveBeenCalledWith('所要目安時間は5〜720分で入力してください');
    expect(h.api.createMenu).not.toHaveBeenCalled();
  });

  it('takes a category name while the shop has no categories', async () => {
    const user = userEvent.setup();
    h.categories = [];
    h.api.createCategory.mockResolvedValue({ id: 'c-new' });
    h.api.createMenu.mockResolvedValue({ id: 'new-2' });
    renderAt('/app/menus/new', editRoutes);
    await user.type(screen.getByPlaceholderText('カテゴリ名'), 'エステ');
    await user.type(screen.getByLabelText(/^メニュー名/), 'フェイシャル');
    await user.click(screen.getByRole('button', { name: '登録' }));
    await waitFor(() => expect(h.api.createMenu).toHaveBeenCalled());
    expect(h.api.createCategory).toHaveBeenCalledWith({ shopId: 'shop-1', name: 'エステ' });
    expect(h.api.createMenu.mock.calls[0]![0]).toMatchObject({ subCategoryIds: ['c-new'], status: 'active' });
  });

  it('edits a coupon: loads its fields, uploads the picture, returns to the coupon tab', async () => {
    const user = userEvent.setup();
    const detail: MenuDetail = {
      id: 'k1',
      shop_id: 'shop-1',
      category_id: 'c-nail',
      name: '【新規】カット',
      description: '初回限定',
      duration_min: 90,
      buffer_before_min: 0,
      buffer_after_min: 0,
      price: 8000,
      price_tax_included: true,
      tax_rate_bp: 1000,
      is_public: true,
      is_consultation: false,
      new_customer_only: true,
      sort_order: 0,
      status: 'active',
      menu_type: 'coupon',
      coupon_type: 'new',
      presentation_condition: '来店時',
      usage_condition: '他券併用不可',
      expiry_date: '2026-12-31',
      price_tilde: true,
      sub_category_ids: ['c-nail'],
      image_file_id: null,
      image_url: null,
      resourceRequirements: [],
      staff: [],
      overrides: [],
    };
    h.api.menu.mockResolvedValue(detail);
    h.uploadFile.mockResolvedValue({ id: 'file-9' });
    // FileReader preview is asynchronous under jsdom as in the browser
    renderAt('/app/menus/k1?type=coupon', editRoutes);

    expect(await screen.findByRole('heading', { level: 1, name: 'クーポン編集' })).toBeInTheDocument();
    expect(screen.getByLabelText(/^クーポン名/)).toHaveValue('【新規】カット');
    expect(screen.getByLabelText('クーポン内容')).toHaveValue('初回限定');
    expect(screen.getByRole('combobox', { name: '種別' })).toHaveTextContent('新規');
    expect(screen.getByRole('combobox', { name: '提示条件' })).toHaveTextContent('来店時');
    expect(screen.getByLabelText('利用条件')).toHaveValue('他券併用不可');
    expect(screen.getByRole('radio', { name: '設定する' })).toBeChecked();
    expect(screen.getByLabelText('有効期限')).toHaveValue('2026-12-31');
    expect(screen.getByRole('button', { name: '1件選択中' })).toBeInTheDocument();
    // the coupon form has no 掲載 switch
    expect(screen.queryByRole('radio', { name: '非掲載' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('combobox', { name: '種別' }));
    await user.click(screen.getByRole('option', { name: '再来' }));
    await user.click(screen.getByRole('radio', { name: '設定しない' }));
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'coupon.png', { type: 'image/png' });
    await user.upload(screen.getByLabelText('写真を選択'), file);
    expect(await screen.findByAltText('クーポン画像')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '更新' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/app/menus?tab=coupon'));
    expect(h.api.updateMenu).toHaveBeenNthCalledWith(1, 'k1', {
      subCategoryIds: ['c-nail'],
      name: '【新規】カット',
      description: '初回限定',
      durationMin: 90,
      price: 8000,
      menuType: 'coupon',
      couponType: 'repeat',
      presentationCondition: '来店時',
      usageCondition: '他券併用不可',
      expiryDate: null,
      priceTilde: true,
    });
    expect(h.uploadFile).toHaveBeenCalledWith(file, 'menu_image');
    expect(h.api.updateMenu).toHaveBeenNthCalledWith(2, 'k1', { imageFileId: 'file-9' });
    // 掲載 was not changed
    expect(h.api.setListing).not.toHaveBeenCalled();
  });

  it('edits a regular menu: 掲載 follows the shop override, and a removed picture is cleared', async () => {
    const user = userEvent.setup();
    h.api.menu.mockResolvedValue({
      id: 'm1',
      shop_id: null,
      category_id: 'c-eye-up',
      name: 'パリジェンヌ',
      description: null,
      duration_min: 60,
      buffer_before_min: 0,
      buffer_after_min: 0,
      price: 5500,
      price_tax_included: true,
      tax_rate_bp: 1000,
      is_public: true,
      is_consultation: false,
      new_customer_only: false,
      sort_order: 0,
      status: 'active',
      menu_type: 'regular',
      sub_category_ids: [],
      image_file_id: 'file-1',
      image_url: 'https://files.example/menu.png',
      resourceRequirements: [],
      staff: [],
      overrides: [{ shop_id: 'shop-1', price: null, duration_min: null, is_available: false }],
    } satisfies MenuDetail);
    renderAt('/app/menus/m1', editRoutes);

    expect(await screen.findByRole('heading', { level: 1, name: 'メニュー編集' })).toBeInTheDocument();
    // hidden in this shop by its override although the menu itself is active
    expect(screen.getByRole('radio', { name: '非掲載' })).toBeChecked();
    expect(screen.getByAltText('メニュー画像')).toHaveAttribute('src', 'https://files.example/menu.png');
    // the single category of an older menu is ticked
    expect(screen.getByRole('button', { name: '1件選択中' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '写真を削除' }));
    await user.click(screen.getByRole('radio', { name: '掲載' }));
    await user.click(screen.getByRole('button', { name: '更新' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/app\/menus$/));
    expect(h.api.updateMenu.mock.calls[0]![1]).toMatchObject({ subCategoryIds: ['c-eye-up'], menuType: 'regular', couponType: null });
    expect(h.api.setListing).toHaveBeenCalledWith('m1', 'shop-1', true);
    expect(h.api.updateMenu).toHaveBeenLastCalledWith('m1', { imageFileId: null });
  });

  it('keeps the form and reports the error when saving fails; a second try does not create twice', async () => {
    const user = userEvent.setup();
    h.api.createMenu.mockResolvedValue({ id: 'new-3' });
    h.uploadFile.mockRejectedValueOnce(new Error('アップロードに失敗しました (500)'));
    h.uploadFile.mockResolvedValue({ id: 'file-2' });
    renderAt('/app/menus/new', editRoutes);
    await user.type(screen.getByLabelText(/^メニュー名/), 'カット');
    const file = new File([new Uint8Array([0xff, 0xd8, 0xff])], 'cut.jpg', { type: 'image/jpeg' });
    await user.upload(screen.getByLabelText('写真を選択'), file);
    await user.click(screen.getByRole('button', { name: '登録' }));
    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith('保存に失敗しました', 'アップロードに失敗しました (500)'));
    expect(screen.getByTestId('location')).toHaveTextContent('/app/menus/new');
    expect(screen.getByLabelText(/^メニュー名/)).toHaveValue('カット');

    await user.click(screen.getByRole('button', { name: '登録' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/app\/menus$/));
    expect(h.api.createMenu).toHaveBeenCalledTimes(1);
    expect(h.api.updateMenu).toHaveBeenCalledWith('new-3', expect.objectContaining({ name: 'カット' }));
    expect(h.api.updateMenu).toHaveBeenLastCalledWith('new-3', { imageFileId: 'file-2' });
  });

  it('shows why a menu could not be loaded', async () => {
    h.api.menu.mockRejectedValue(new ApiError({ status: 404, code: 'NOT_FOUND', category: 'not_found', message: 'メニューが見つかりません' }));
    renderAt('/app/menus/missing', editRoutes);
    expect(await screen.findByText('読み込み失敗 (ID: missing, 404: メニューが見つかりません)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'メニュー一覧に戻る' })).toBeInTheDocument();
  });
});

describe('カテゴリ管理', () => {
  const routes = (
    <>
      <Route path="/app/menus" element={<div>list page</div>} />
      <Route path="/app/menus/categories" element={<MenuCategories />} />
    </>
  );
  const rowOfCategory = (id: string) => document.querySelector<HTMLElement>(`[data-category="${id}"]`)!;

  it('lists parents (open) with their child categories and the number of children', async () => {
    const user = userEvent.setup();
    renderAt('/app/menus/categories', routes);
    expect(screen.getByRole('heading', { level: 1, name: 'カテゴリ管理' })).toBeInTheDocument();
    expect(within(rowOfCategory('c-eye')).getByText('まつげ')).toBeInTheDocument();
    expect(within(rowOfCategory('c-eye')).getByText('2件')).toBeInTheDocument();
    expect(within(rowOfCategory('c-nail')).getByText('0件')).toBeInTheDocument();
    // children show their own part only, under a rule in the parent's colour
    expect(within(rowOfCategory('c-eye-up')).getByText('上')).toBeInTheDocument();
    expect(within(rowOfCategory('c-eye-low')).getByText('下')).toBeInTheDocument();
    expect(rowOfCategory('c-eye-up').parentElement).toHaveStyle({ borderColor: '#EAB30840' });
    expect(screen.queryByText('SBから取込')).not.toBeInTheDocument();

    // collapse and reopen
    await user.click(screen.getByRole('button', { name: 'まつげ を閉じる' }));
    expect(rowOfCategory('c-eye-up')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'まつげ を開く' }));
    expect(rowOfCategory('c-eye-up')).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'メニュー一覧に戻る' }));
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/app\/menus$/);
  });

  it('adds a parent with the next palette colour, or the colour picked', async () => {
    const user = userEvent.setup();
    renderAt('/app/menus/categories', routes);
    await user.click(screen.getByRole('button', { name: '親カテゴリを追加' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: '親カテゴリ追加' })).toBeInTheDocument();
    // two parents exist: the third palette colour is preselected
    expect(within(dialog).getByRole('button', { name: 'オレンジ' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(dialog).queryByRole('combobox', { name: '親カテゴリ' })).not.toBeInTheDocument();
    const add = within(dialog).getByRole('button', { name: '追加' });
    expect(add).toBeDisabled();
    await user.type(within(dialog).getByLabelText('カテゴリ名'), 'エステ');
    await user.click(within(dialog).getByRole('button', { name: 'グリーン' }));
    await user.click(add);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(h.api.createCategory).toHaveBeenCalledWith({ shopId: 'shop-1', name: 'エステ', color: '#22C55E', parentId: null, sortOrder: 2 });

    // Enter saves too
    await user.click(screen.getByRole('button', { name: '親カテゴリを追加' }));
    await user.type(screen.getByLabelText('カテゴリ名'), 'リラク{Enter}');
    await waitFor(() => expect(h.api.createCategory).toHaveBeenCalledTimes(2));
    expect(h.api.createCategory).toHaveBeenLastCalledWith({ shopId: 'shop-1', name: 'リラク', color: '#F97316', parentId: null, sortOrder: 2 });
  });

  it('adds a child from the parent row and can put it under another parent', async () => {
    const user = userEvent.setup();
    renderAt('/app/menus/categories', routes);
    await user.click(screen.getByRole('button', { name: 'まつげ に子カテゴリを追加' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: '子カテゴリ追加' })).toBeInTheDocument();
    expect(within(dialog).getByRole('combobox', { name: '親カテゴリ' })).toHaveTextContent('まつげ');
    // a child takes its parent's colour: no colour choice
    expect(within(dialog).queryByRole('button', { name: 'グリーン' })).not.toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('子カテゴリ名'), 'パーマ');
    await user.click(within(dialog).getByRole('button', { name: '追加' }));
    await waitFor(() => expect(h.api.createCategory).toHaveBeenCalledWith({ shopId: 'shop-1', name: 'パーマ', parentId: 'c-eye', sortOrder: 2 }));

    await user.click(screen.getByRole('button', { name: 'ネイル に子カテゴリを追加' }));
    await user.click(screen.getByRole('combobox', { name: '親カテゴリ' }));
    await user.click(screen.getByRole('option', { name: 'まつげ' }));
    await user.type(screen.getByLabelText('子カテゴリ名'), 'エクステ');
    await user.click(screen.getByRole('button', { name: '追加' }));
    await waitFor(() => expect(h.api.createCategory).toHaveBeenLastCalledWith({ shopId: 'shop-1', name: 'エクステ', parentId: 'c-eye', sortOrder: 2 }));
  });

  it('edits a parent (name, colour) and a child (own part, parent)', async () => {
    const user = userEvent.setup();
    renderAt('/app/menus/categories', routes);
    await user.click(screen.getByRole('button', { name: 'まつげ を編集' }));
    let dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: '親カテゴリ編集' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'イエロー' })).toHaveAttribute('aria-pressed', 'true');
    const name = within(dialog).getByLabelText('カテゴリ名');
    expect(name).toHaveValue('まつげ');
    await user.clear(name);
    await user.type(name, 'アイ');
    await user.click(within(dialog).getByRole('button', { name: 'ピンク' }));
    await user.click(within(dialog).getByRole('button', { name: '更新' }));
    await waitFor(() => expect(h.api.updateCategory).toHaveBeenCalledWith('c-eye', { name: 'アイ', color: '#EC4899' }));
    // the children are renamed by the server together with their parent: one call only
    expect(h.api.updateCategory).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'まつげ：下 を編集' }));
    dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: '子カテゴリ編集' })).toBeInTheDocument();
    expect(within(dialog).getByLabelText('子カテゴリ名')).toHaveValue('下');
    await user.type(within(dialog).getByLabelText('子カテゴリ名'), 'まつげ');
    await user.click(within(dialog).getByRole('combobox', { name: '親カテゴリ' }));
    await user.click(within(dialog).getByRole('option', { name: 'ネイル' }));
    await user.click(within(dialog).getByRole('button', { name: '更新' }));
    await waitFor(() => expect(h.api.updateCategory).toHaveBeenLastCalledWith('c-eye-low', { name: '下まつげ', parentId: 'c-nail' }));

    // a failed save keeps the dialog open and says so
    h.api.updateCategory.mockRejectedValueOnce(new Error('通信エラー'));
    await user.click(screen.getByRole('button', { name: 'ネイル を編集' }));
    await user.click(screen.getByRole('button', { name: '更新' }));
    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith('保存に失敗しました', '通信エラー'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('deletes one category after the matching confirmation', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderAt('/app/menus/categories', routes);

    await user.click(screen.getByRole('button', { name: 'まつげ を削除' }));
    expect(confirm).toHaveBeenLastCalledWith('「まつげ」と配下の2件の子カテゴリを削除しますか？');
    expect(h.api.deleteCategory).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    await user.click(screen.getByRole('button', { name: 'まつげ：上 を削除' }));
    expect(confirm).toHaveBeenLastCalledWith('「上」を削除しますか？');
    expect(h.api.deleteCategory).toHaveBeenCalledWith('c-eye-up');
    await user.click(screen.getByRole('button', { name: 'ネイル を削除' }));
    expect(confirm).toHaveBeenLastCalledWith('「ネイル」を削除しますか？');
    expect(h.api.deleteCategory).toHaveBeenLastCalledWith('c-nail');

    h.api.deleteCategory.mockRejectedValueOnce(new Error('通信エラー'));
    await user.click(screen.getByRole('button', { name: 'まつげ を削除' }));
    await waitFor(() =>
      expect(h.toast.error).toHaveBeenCalledWith('削除に失敗しました。メニューで使用されている可能性があります。', '通信エラー'),
    );
    confirm.mockRestore();
  });

  it('全削除 asks first, deletes every category of the shop and reports shared ones that stay', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    h.api.deleteAllCategories.mockResolvedValue({ deleted: 4, kept: 0 });
    renderAt('/app/menus/categories', routes);

    await user.click(screen.getByRole('button', { name: '全削除' }));
    expect(confirm).toHaveBeenLastCalledWith('すべてのカテゴリを削除しますか？');
    expect(h.api.deleteAllCategories).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    await user.click(screen.getByRole('button', { name: '全削除' }));
    await waitFor(() => expect(h.api.deleteAllCategories).toHaveBeenCalledWith('shop-1'));
    expect(h.toast.info).not.toHaveBeenCalled();

    h.api.deleteAllCategories.mockResolvedValue({ deleted: 3, kept: 1 });
    await user.click(screen.getByRole('button', { name: '全削除' }));
    await waitFor(() =>
      expect(h.toast.info).toHaveBeenCalledWith('全店共通のカテゴリ1件は削除されませんでした', '全店舗の権限を持つスタッフだけが削除できます'),
    );
    confirm.mockRestore();
  });

  it('shows the empty state without 全削除 when there are no categories', () => {
    h.categories = [];
    renderAt('/app/menus/categories', routes);
    expect(screen.getByText('カテゴリがありません。ボタンから追加してください。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '全削除' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '親カテゴリを追加' })).toBeInTheDocument();
  });
});
