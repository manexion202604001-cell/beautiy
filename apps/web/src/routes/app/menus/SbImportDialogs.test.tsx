import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EffectiveMenu, MenuCategory, MenuDetail } from '../../../api/types';
import MenuCategories from './MenuCategories';
import MenuEdit from './MenuEdit';
import MenuList from './MenuList';
import { matchSbCategories } from './SbImportDialogs';
import { SB_COUPON_LIST_SCRIPT, SB_MENU_SCRIPT } from './sbImportScripts';

const h = vi.hoisted(() => ({
  menus: [] as unknown[],
  categories: [] as unknown[],
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  api: {
    menu: vi.fn(),
    createMenu: vi.fn(),
    updateMenu: vi.fn(),
    setListing: vi.fn(),
    createCategory: vi.fn(),
  },
  sb: {
    preview: vi.fn(),
    run: vi.fn(),
    staffAssignments: vi.fn(),
    equipmentAssignments: vi.fn(),
    categories: vi.fn(),
    imageFromUrl: vi.fn(),
  },
  importSbImages: vi.fn(),
}));

vi.mock('../../../lib/auth', () => ({
  useAuth: () => ({
    currentShopId: 'shop-1',
    currentShop: { id: 'shop-1', name: '表参道店' },
    can: () => true,
    timezone: 'Asia/Tokyo',
  }),
}));
vi.mock('../../../components/ui', () => ({ useToast: () => h.toast }));
vi.mock('../../../api/catalog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../api/catalog')>()),
  catalogApi: h.api,
  useMenus: () => ({ data: h.menus, isLoading: false }),
  useCategories: () => ({ data: h.categories, isLoading: false }),
}));
vi.mock('../../../api/menuSbImport', () => ({
  sbImportApi: h.sb,
  importSbImages: h.importSbImages,
}));
vi.mock('../../../api/org', () => ({
  useStaffList: () => ({
    data: [{ id: 's1', display_name: 'スタッフA', status: 'active' }],
    isLoading: false,
  }),
}));
vi.mock('../../../api/storeSettings', () => ({
  useEquipment: () => ({ data: [{ name: 'ベッド', quantity: 1 }], isLoading: false }),
}));
vi.mock('../../../api/files', () => ({
  uploadFile: vi.fn(),
  sameOriginBlobUrl: (url: string) => url,
}));

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
const category = (over: Partial<MenuCategory> & { id: string; name: string }): MenuCategory => ({
  shop_id: 'shop-1',
  sort_order: 0,
  color: null,
  parent_id: null,
  ...over,
});

function renderAt(path: string, routes: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>{routes}</Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.menus = [menu({ id: 'm1', name: 'カット' }), menu({ id: 'm2', name: '廃止' })];
  h.categories = [];
  h.importSbImages.mockResolvedValue(0);
});

const paste = async (user: ReturnType<typeof userEvent.setup>, text: string) => {
  await user.click(screen.getByRole('textbox', { name: 'コピーされたJSON' }));
  await user.paste(text);
};

describe('メニュー管理「SB取込」', () => {
  it('shows the script for the chosen SALON BOARD screen, then the comparison table, then imports the ticked rows', async () => {
    const user = userEvent.setup();
    renderAt('/app/menus', <Route path="/app/menus" element={<MenuList />} />);
    await user.click(screen.getByRole('button', { name: 'SB取込' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('サロンボードから取込（表参道店）')).toBeInTheDocument();
    expect(
      within(dialog).getByText('1. SBのメニュー編集画面のコンソールで実行'),
    ).toBeInTheDocument();
    expect(dialog.querySelector('pre')!.textContent).toBe(SB_MENU_SCRIPT);
    await user.click(within(dialog).getByRole('button', { name: 'クーポン' }));
    expect(
      within(dialog).getByText('1. SBのクーポン一覧画面のコンソールで実行'),
    ).toBeInTheDocument();
    expect(dialog.querySelector('pre')!.textContent).toBe(SB_COUPON_LIST_SCRIPT);
    await user.click(within(dialog).getByRole('button', { name: 'メニュー' }));

    h.sb.preview.mockResolvedValue({
      rows: [
        {
          index: 0,
          kind: 'update',
          item: {
            name: 'カット',
            category: null,
            description: null,
            price: 6000,
            durationMin: 60,
            priceTilde: false,
            listed: true,
            couponType: null,
          },
          existing: {
            id: 'm1',
            name: 'カット',
            categoryName: null,
            price: 5500,
            durationMin: 60,
            listed: true,
            priceTilde: false,
            couponType: null,
            description: null,
          },
          changes: [{ label: '価格', from: '¥5,500', to: '¥6,000' }],
          selected: true,
        },
        {
          index: 1,
          kind: 'new',
          item: {
            name: 'カラー',
            category: 'ヘア：カラー',
            description: null,
            price: 8000,
            durationMin: 90,
            priceTilde: false,
            listed: true,
            couponType: null,
          },
          existing: null,
          changes: [],
          selected: true,
        },
        {
          index: 2,
          kind: 'same',
          item: {
            name: '同じ',
            category: null,
            description: null,
            price: 1000,
            durationMin: 60,
            priceTilde: false,
            listed: true,
            couponType: null,
          },
          existing: {
            id: 'm3',
            name: '同じ',
            categoryName: null,
            price: 1000,
            durationMin: 60,
            listed: true,
            priceTilde: false,
            couponType: null,
            description: null,
          },
          changes: [],
          selected: false,
        },
      ],
      missing: [{ id: 'm2', name: '廃止', categoryName: null, price: 3000, durationMin: 60 }],
      invalid: 0,
    });
    await paste(
      user,
      '[{"name":"カット","price":"6,000","durationMin":60}][{"name":"カラー","price":8000}],[{"name":"同じ"}]',
    );
    await user.click(within(dialog).getByRole('button', { name: '比較表を見る' }));
    expect(h.sb.preview).toHaveBeenCalledWith({
      shopId: 'shop-1',
      kind: 'regular',
      items: [
        { name: 'カット', price: 6000, durationMin: 60 },
        { name: 'カラー', price: 8000 },
        { name: '同じ' },
      ],
    });

    expect(
      await within(dialog).findByText('取り込み前の比較表です。チェックした行だけが反映されます。'),
    ).toBeInTheDocument();
    expect(within(dialog).getByText('新規追加 1')).toBeInTheDocument();
    expect(within(dialog).getByText('上書き 1')).toBeInTheDocument();
    expect(within(dialog).getByText('変更なし 1')).toBeInTheDocument();
    expect(within(dialog).getByText('SBに無い 1')).toBeInTheDocument();
    // 変更なし rows are hidden until 「変更なしを隠す」 is unticked
    expect(dialog.querySelectorAll('[data-sb-row="same"]')).toHaveLength(0);
    await user.click(
      within(dialog).getByText('変更なしを隠す').querySelector('[role="checkbox"]')!,
    );
    expect(dialog.querySelectorAll('[data-sb-row="same"]')).toHaveLength(1);
    expect(within(dialog).getByText('Salon OS に無いので追加')).toBeInTheDocument();
    expect(within(dialog).getByText('¥5,500')).toHaveClass('line-through');

    // overwrite off explains what is still applied
    await user.click(
      within(dialog)
        .getByText('価格・時間・説明・カテゴリも上書き')
        .querySelector('[role="checkbox"]')!,
    );
    expect(
      within(dialog).getByText(
        '上書きオフの間は、掲載状態・〜表示・並び順・クーポン種別だけが更新されます。',
      ),
    ).toBeInTheDocument();

    // tick the 「SBに無い」 row: it becomes 非掲載
    const missingRow = dialog.querySelector<HTMLElement>('[data-sb-row="missing"]')!;
    await user.click(within(missingRow).getByRole('checkbox'));
    expect(within(missingRow).getByText('非掲載にする')).toBeInTheDocument();
    // untick the new row
    const newRow = dialog.querySelector<HTMLElement>('[data-sb-row="new"]')!;
    await user.click(within(newRow).getByRole('checkbox'));

    h.sb.run.mockResolvedValue({
      created: 0,
      updated: 1,
      hidden: 1,
      skipped: 0,
      images: [{ menuId: 'm1', url: 'https://imgbp.salonboard.com/a.jpg' }],
    });
    await user.click(
      within(dialog).getByRole('button', { name: '取り込み実行（追加 0 / 上書き 1 / 非掲載 1）' }),
    );
    await waitFor(() =>
      expect(h.toast.success).toHaveBeenCalledWith('0件追加、1件上書き、1件を非掲載、0件スキップ'),
    );
    expect(h.sb.run).toHaveBeenCalledWith(
      expect.objectContaining({
        shopId: 'shop-1',
        mode: 'compare',
        kind: 'regular',
        selected: [0],
        overwriteDetails: false,
        hideMenuIds: ['m2'],
      }),
    );
    expect(h.importSbImages).toHaveBeenCalledWith([
      { menuId: 'm1', url: 'https://imgbp.salonboard.com/a.jpg' },
    ]);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('reports a broken paste', async () => {
    const user = userEvent.setup();
    renderAt('/app/menus', <Route path="/app/menus" element={<MenuList />} />);
    await user.click(screen.getByRole('button', { name: 'SB取込' }));
    await paste(user, '{broken');
    await user.click(screen.getByRole('button', { name: '比較表を見る' }));
    expect(h.toast.error).toHaveBeenCalledWith('JSONの形式が正しくありません');
    expect(h.sb.preview).not.toHaveBeenCalled();
  });

  it('「SB取込（個別）」 imports every pasted coupon at once', async () => {
    const user = userEvent.setup();
    renderAt('/app/menus?tab=coupon', <Route path="/app/menus" element={<MenuList />} />);
    await user.click(screen.getByRole('button', { name: 'SB取込（個別）' }));
    expect(screen.getByText('クーポン編集ページから取込（表参道店）')).toBeInTheDocument();
    expect(
      screen.getByText(
        '2. コピーされたJSONを貼り付け（複数クーポンの場合は各ページで実行して配列を結合）',
      ),
    ).toBeInTheDocument();
    h.sb.run.mockResolvedValue({ created: 1, updated: 1, hidden: 0, skipped: 0, images: [] });
    await paste(user, '[{"name":"a","couponType":"new"}]\n[{"name":"b","couponType":"repeat"}]');
    await user.click(screen.getByRole('button', { name: '取り込み' }));
    await waitFor(() =>
      expect(h.toast.success).toHaveBeenCalledWith('1件作成、1件更新、0件スキップ'),
    );
    expect(h.sb.run).toHaveBeenCalledWith({
      shopId: 'shop-1',
      mode: 'single',
      items: [
        { name: 'a', couponType: 'new' },
        { name: 'b', couponType: 'repeat' },
      ],
    });
  });

  it('対応スタッフ / 対応設備 tables take the SALON BOARD tables', async () => {
    const user = userEvent.setup();
    renderAt('/app/menus', <Route path="/app/menus" element={<MenuList />} />);
    await user.click(screen.getByRole('button', { name: '対応スタッフ' }));
    await user.click(screen.getByRole('button', { name: 'SB取込' }));
    expect(screen.getByText('サロンボードから対応スタッフ取込（表参道店）')).toBeInTheDocument();
    h.sb.staffAssignments.mockResolvedValue({
      message:
        '1件のメニューの対応スタッフを取り込みました（スタッフ1名）\n一致するスタッフが無いもの1名: X',
    });
    await paste(
      user,
      '{"kind":"regular","staff":["A","X"],"assignments":[{"menuName":"カット","noStaffNeeded":false,"assignedStaff":["A"]}]}',
    );
    await user.click(screen.getByRole('button', { name: 'インポート' }));
    await waitFor(() =>
      expect(h.toast.success).toHaveBeenCalledWith(
        '1件のメニューの対応スタッフを取り込みました（スタッフ1名）',
        '一致するスタッフが無いもの1名: X',
      ),
    );
    expect(h.sb.staffAssignments).toHaveBeenCalledWith({
      shopId: 'shop-1',
      staffNames: ['A', 'X'],
      assignments: [{ menuName: 'カット', noStaffNeeded: false, assignedStaff: ['A'] }],
    });

    await user.click(screen.getByRole('button', { name: '対応設備' }));
    await user.click(screen.getByRole('button', { name: 'SB取込' }));
    expect(screen.getByText('サロンボードから対応設備取込')).toBeInTheDocument();
    h.sb.equipmentAssignments.mockResolvedValue({
      message: '1件のメニューの対応設備を取り込みました（設備1件）',
    });
    await paste(user, '[{"menuName":"カット","assignedEquipment":["ベッド"]}]');
    await user.click(screen.getByRole('button', { name: 'インポート' }));
    await waitFor(() =>
      expect(h.sb.equipmentAssignments).toHaveBeenCalledWith({
        shopId: 'shop-1',
        equipmentNames: undefined,
        assignments: [{ menuName: 'カット', assignedEquipment: ['ベッド'] }],
      }),
    );
  });
});

describe('編集画面「SBから取込」', () => {
  it('fills the form as a coupon (not saved) and fetches the picture on save', async () => {
    const user = userEvent.setup();
    h.categories = [
      category({ id: 'c-eye', name: 'まつげ' }),
      category({ id: 'c-eye-perm', name: 'まつげ：まつげパーマ', parent_id: 'c-eye' }),
    ];
    h.api.createMenu.mockResolvedValue({ id: 'new-1' } as MenuDetail);
    renderAt('/app/menus/new', <Route path="/app/menus/new" element={<MenuEdit />} />);
    expect(screen.getByRole('heading', { level: 1, name: '新規メニュー' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'SBから取込' }));
    expect(screen.getByText('サロンボードから取り込み')).toBeInTheDocument();
    await paste(
      user,
      JSON.stringify({
        couponType: 'new',
        name: '【新規】まつげパーマ',
        description: '説明',
        presentationCondition: '予約時',
        usageCondition: '新規の方',
        expiryDate: '2026-03-31',
        price: 6600,
        priceTilde: true,
        durationMin: 75,
        imageUrl: 'https://imgbp.salonboard.com/p.jpg',
        categories: ['まつげ：まつげパーマ', 'ヘア：カット'],
      }),
    );
    await user.click(screen.getByRole('button', { name: '取り込み' }));
    expect(h.api.createMenu).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { level: 1, name: '新規クーポン' })).toBeInTheDocument();
    expect(screen.getByLabelText(/クーポン名/)).toHaveValue('【新規】まつげパーマ');
    expect(screen.getByLabelText('有効期限')).toHaveValue('2026-03-31');
    expect(screen.getByRole('img', { name: 'クーポン画像' })).toHaveAttribute(
      'src',
      'https://imgbp.salonboard.com/p.jpg',
    );
    expect(h.toast.info).toHaveBeenCalledWith(
      '取り込みました。',
      '1件のカテゴリをマッチ、1件は未マッチです。',
    );

    await user.click(screen.getByRole('button', { name: '登録' }));
    await waitFor(() =>
      expect(h.importSbImages).toHaveBeenCalledWith([
        { menuId: 'new-1', url: 'https://imgbp.salonboard.com/p.jpg' },
      ]),
    );
    expect(h.api.createMenu).toHaveBeenCalledWith(
      expect.objectContaining({
        menuType: 'coupon',
        couponType: 'new',
        name: '【新規】まつげパーマ',
        price: 6600,
        durationMin: 75,
        priceTilde: true,
        subCategoryIds: ['c-eye-perm'],
        expiryDate: '2026-03-31',
      }),
    );
  });

  it('matches categories by exact name first, then by containment', () => {
    const cats = [
      category({ id: 'a', name: 'まつげ' }),
      category({ id: 'b', name: 'まつげ：パーマ' }),
    ];
    expect(matchSbCategories(['まつげ：パーマ', 'まつげ：エクステ', 'ネイル'], cats)).toEqual([
      'b',
      'a',
    ]);
  });
});

describe('カテゴリ管理「SBから取込」', () => {
  it('sends the pasted groups and reports what was created', async () => {
    const user = userEvent.setup();
    renderAt(
      '/app/menus/categories',
      <Route path="/app/menus/categories" element={<MenuCategories />} />,
    );
    expect(
      screen.getByText('カテゴリがありません。「SBから取込」またはボタンから追加してください。'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'SBから取込' }));
    expect(screen.getByText('サロンボードからカテゴリ取込')).toBeInTheDocument();
    h.sb.categories.mockResolvedValue({
      parents: 1,
      children: 2,
      skipped: 0,
      message: '親カテゴリ 1件、子カテゴリ 2件を作成しました。',
    });
    await paste(user, '[{"parent":"ネイル","children":["ジェル","スカルプ"]}]');
    await user.click(screen.getByRole('button', { name: '取り込み' }));
    await waitFor(() =>
      expect(h.toast.success).toHaveBeenCalledWith(
        '親カテゴリ 1件、子カテゴリ 2件を作成しました。',
      ),
    );
    expect(h.sb.categories).toHaveBeenCalledWith({
      shopId: 'shop-1',
      groups: [{ parent: 'ネイル', children: ['ジェル', 'スカルプ'] }],
    });
  });
});
