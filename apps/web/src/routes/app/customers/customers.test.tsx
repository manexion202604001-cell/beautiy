import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { customersApi, type CustomerOverview, type NameDuplicateGroup } from '../../../api/customers';
import { kartesApi, type KarteDetail, type KarteListItem } from '../../../api/kartes';
import { orgApi } from '../../../api/org';
import type { CustomerDetail, CustomerListItem, DuplicatePair } from '../../../api/types';
import { ToastProvider } from '../../../components/ui';
import CustomerCreate from './CustomerCreate';
import CustomerShow from './CustomerShow';
import Customers from './Customers';
import KarteShow from './KarteShow';
import { formatWhen, isStaffOrigin, splitName } from './shared';

const perms = { denied: [] as string[] };
vi.mock('../../../lib/auth', () => ({
  useAuth: () => ({
    can: (p: string) => !perms.denied.includes(p),
    currentShopId: 'shop-1',
    timezone: 'Asia/Tokyo',
  }),
}));
vi.mock('../messages/CustomerMessagesTab', () => ({
  CustomerMessagesTab: ({ customerId }: { customerId: string }) => <div>messages of {customerId}</div>,
}));

const listItem = (over: Partial<CustomerListItem>): CustomerListItem => ({
  id: 'c1',
  customer_number: null,
  last_name: '山田',
  first_name: '花子',
  last_name_kana: 'ヤマダ',
  first_name_kana: 'ハナコ',
  gender: 'female',
  birthday: '1990-04-01',
  phone: '090-1111-2222',
  email: 'hanako@example.com',
  primary_shop_id: 'shop-1',
  primary_staff_id: 'staff-1',
  first_visit_at: null,
  last_visit_at: '2026-10-01T03:00:00.000Z',
  visit_count: 3,
  total_sales: 0,
  avg_cycle_days: null,
  next_appointment_at: null,
  point_balance: 0,
  status: 'active',
  marketing_opt_in: true,
  created_at: '2026-01-01T00:00:00.000Z',
  display_name: '山田 花子',
  tags: [],
  primary_staff_name: '佐藤',
  has_line: true,
  name_source: null,
  acquisition_source: null,
  ...over,
});

const detail = (over: Partial<CustomerDetail> = {}): CustomerDetail => ({
  ...listItem({}),
  postal_code: '150-0001',
  address: '東京都渋谷区神宮前',
  occupation: '会社員',
  acquisition_source: null,
  memo: 'カラーはアレルギー注意',
  member_no: null,
  attributes: {},
  merged_into_id: null,
  no_show_count: 0,
  cancel_count: 0,
  identities: [],
  relations: [],
  score: null,
  ...over,
});

const overview: CustomerOverview = {
  name_source: null,
  member_no: 'A-001',
  line: null,
  assigned_staff: [
    { staff_id: 'staff-1', staff_name: '佐藤', is_primary: true, visit_count: 2 },
    { staff_id: 'staff-2', staff_name: '鈴木', is_primary: false, visit_count: 1 },
  ],
  linked_customers: [
    { id: 'c9', store_name: '新宿店', staff_name: '田中', visit_count: 4, last_visit_at: '2026-09-01T03:00:00.000Z', last_reservation_at: null },
  ],
};

const karteItem: KarteListItem = {
  id: 'k1',
  shop_id: 'shop-1',
  customer_id: 'c1',
  appointment_id: null,
  staff_id: 'staff-1',
  staff_name: '佐藤',
  template_id: null,
  template_name: null,
  visit_date: '2026-10-01',
  fields: { menu_content: 'カット＋カラー' },
  note: null,
  shared_with_customer: false,
  shared_at: null,
  asset_count: 0,
  version: 1,
  created_at: '2026-10-01T03:00:00.000Z',
  updated_at: '2026-10-01T03:00:00.000Z',
};

const karteDetail = (over: Partial<KarteDetail> = {}): KarteDetail => ({
  id: 'k1',
  shop_id: 'shop-1',
  customer_id: 'c1',
  appointment_id: null,
  staff_id: 'staff-1',
  staff_name: '佐藤',
  template_id: 't1',
  template: {
    id: 't1',
    name: 'カット',
    category: null,
    status: 'active',
    fields: [{ key: 'style_name', label: 'スタイル', type: 'text' }],
  },
  visit_date: '2026-10-01',
  fields: { menu_content: 'カット＋カラー', color_formula: '8AB:6N', style_name: 'ボブ' },
  chemicals: [{ name: 'ストレートA', brand: null, ratio: '1:1', processing_min: 20, note: null }],
  homecare: { advice: '週1回トリートメント', product_ids: [] },
  homecare_products: [],
  note: 'クレーム注意',
  shared_with_customer: false,
  shared_at: null,
  assets: [],
  version: 3,
  created_at: '2026-10-01T03:00:00.000Z',
  updated_at: '2026-10-01T03:00:00.000Z',
  ...over,
});

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname + loc.search}</div>;
}

function mount(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/app/customers" element={<Customers />} />
            <Route path="/app/customers/new" element={<CustomerCreate />} />
            <Route path="/app/customers/kartes/:id" element={<KarteShow />} />
            <Route path="/app/customers/:id" element={<CustomerShow />} />
            <Route path="*" element={<div>other screen</div>} />
          </Routes>
          <Where />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

const where = () => screen.getByTestId('where').textContent;

beforeEach(() => {
  vi.restoreAllMocks();
  perms.denied = [];
  vi.spyOn(orgApi, 'staff').mockResolvedValue([{ id: 'staff-1', display_name: '佐藤' }] as never);
});

describe('shared helpers', () => {
  it('formats instants in the shop timezone and calendar dates as they are', () => {
    expect(formatWhen('2026-10-13T15:30:00.000Z', 'Asia/Tokyo', 'date')).toBe('2026年10月14日(水)');
    expect(formatWhen('2026-10-13', 'Asia/Tokyo', 'date')).toBe('2026年10月13日(火)');
    expect(formatWhen('2026-10-13T05:30:00.000Z', 'Asia/Tokyo', 'short')).toBe('10月13日');
    expect(formatWhen('2026-10-13T05:30:00.000Z', 'Asia/Tokyo')).toBe('2026年10月13日 14:30');
  });
  it('splits a full name at the first space and recognises staff-acquired customers', () => {
    expect(splitName('山田　花子')).toEqual(['山田', '花子']);
    expect(splitName(' 山田 ')).toEqual(['山田', '']);
    expect(splitName('John Ronald Smith')).toEqual(['John', 'Ronald Smith']);
    expect(isStaffOrigin('スタッフ集客')).toBe(true);
    expect(isStaffOrigin('line')).toBe(false);
  });
});

describe('顧客管理 list', () => {
  const pair: DuplicatePair = {
    a: {
      id: 'line-1',
      last_name: '',
      first_name: 'hana',
      last_name_kana: '',
      first_name_kana: '',
      phone: '090-1111-2222',
      email: null,
      birthday: null,
      last_visit_at: null,
      visit_count: 5,
      created_at: '2026-10-01T00:00:00.000Z',
      line: { display_name: 'はなちゃん', picture_url: null },
    },
    b: {
      id: 'c1',
      last_name: '山田',
      first_name: '花子',
      last_name_kana: 'ヤマダ',
      first_name_kana: 'ハナコ',
      phone: '090-1111-2222',
      email: null,
      birthday: null,
      last_visit_at: '2026-10-01T03:00:00.000Z',
      visit_count: 3,
      created_at: '2026-01-01T00:00:00.000Z',
      primary_staff_name: '佐藤',
      line: null,
    },
    strength: 'exact',
    score: 1,
    reasons: ['phone_exact'],
  };
  const group: NameDuplicateGroup = {
    normalized_name: '山田花子',
    customers: [
      { id: 'c1', name: '山田 花子', name_kana: 'ヤマダ ハナコ', phone: '090-1111-2222', store_name: '渋谷店', staff_name: '佐藤', visit_count: 3, member_no: null },
      { id: 'c2', name: '山田 花子', name_kana: null, phone: null, store_name: '新宿店', staff_name: null, visit_count: 0, member_no: null },
    ],
  };

  function mockList(items: CustomerListItem[], total = items.length) {
    return vi.spyOn(customersApi, 'search').mockImplementation(async (q) =>
      q.unassigned ? { items: items.filter((c) => !c.primary_staff_id), nextCursor: null, total: 1 } : { items, nextCursor: null, total },
    );
  }

  it('lists customers under the カルテ heading and opens a customer', async () => {
    const search = mockList([listItem({}), listItem({ id: 'c2', display_name: '担当 なし', primary_staff_id: null, primary_staff_name: null, has_line: false })], 120);
    vi.spyOn(customersApi, 'duplicatePairs').mockResolvedValue([]);
    vi.spyOn(customersApi, 'nameDuplicates').mockResolvedValue({ groups: [], total: 0 });
    const user = mount('/app/customers?q=山田');

    expect(screen.getByRole('heading', { name: 'カルテ' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('名前、電話番号で検索...')).toHaveValue('山田');
    await waitFor(() => expect(document.querySelectorAll('[data-customer]')).toHaveLength(2));
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ q: '山田', limit: 50 }));
    expect(screen.getByText('(120件)')).toBeInTheDocument();
    expect(screen.getAllByText('担当: 佐藤').length).toBeGreaterThan(0);
    expect(screen.getAllByText('担当未設定').length).toBeGreaterThan(0);
    // the 顧客管理 list does not carry the LINE mark; the tabs with nothing to do are not offered
    expect(screen.queryByRole('img', { name: 'LINE連携済み' })).toBeNull();
    expect(screen.queryByRole('tab', { name: /統合候補/ })).toBeNull();
    expect(screen.queryByRole('tab', { name: /名前重複/ })).toBeNull();
    // the number of customers nobody is in charge of sits on its tab
    expect(within(screen.getByRole('tab', { name: /未設定/ })).getByText('1')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /未設定/ }));
    await waitFor(() => expect(search).toHaveBeenCalledWith(expect.objectContaining({ unassigned: true, limit: 50 })));

    await user.click(document.querySelector('[data-customer="c2"]')!);
    expect(where()).toBe('/app/customers/c2');
  });

  it('picker mode hands the customer back to the reservation form', async () => {
    mockList([listItem({ name_source: 'line' })]);
    vi.spyOn(customersApi, 'duplicatePairs').mockResolvedValue([]);
    vi.spyOn(customersApi, 'nameDuplicates').mockResolvedValue({ groups: [], total: 0 });
    const user = mount('/app/customers?mode=select');
    expect(screen.getByRole('heading', { name: '顧客を選択' })).toBeInTheDocument();
    await waitFor(() => expect(document.querySelectorAll('[data-customer]')).toHaveLength(1));
    expect(screen.getByText('(1/1件)')).toBeInTheDocument();
    expect(screen.getAllByRole('img', { name: 'LINE連携済み' }).length).toBeGreaterThan(0);
    expect(screen.getAllByText('本名未登録').length).toBeGreaterThan(0);
    await user.click(document.querySelector('[data-customer="c1"]')!);
    expect(where()).toBe(`/app/calendar/new?customer_id=c1&customer_name=${encodeURIComponent('山田 花子')}`);
  });

  it('統合候補: merges the LINE record into the existing one, or skips the pair', async () => {
    mockList([listItem({})]);
    vi.spyOn(customersApi, 'duplicatePairs').mockResolvedValue([pair, { ...pair, a: { ...pair.a, id: 'line-2' } }]);
    vi.spyOn(customersApi, 'nameDuplicates').mockResolvedValue({ groups: [], total: 0 });
    const merge = vi.spyOn(customersApi, 'merge').mockResolvedValue({ mergeLogId: 'm', targetId: 'c1', sourceId: 'line-1', moved: {} });
    const dismiss = vi.spyOn(customersApi, 'dismissDuplicate').mockResolvedValue(undefined);
    const user = mount('/app/customers');

    await user.click(await screen.findByRole('tab', { name: /統合候補/ }));
    const cards = await waitFor(() => {
      const found = document.querySelectorAll<HTMLElement>('[data-merge-candidate]');
      expect(found).toHaveLength(2);
      return found;
    });
    const first = within(cards[0]!);
    // the LINE record (even with more visits) goes into the record staff keep
    expect(first.getByText('LINE')).toBeInTheDocument();
    expect(first.getByText('LINE: はなちゃん')).toBeInTheDocument();
    expect(first.getByText('既存')).toBeInTheDocument();
    expect(first.getByText('山田 花子')).toBeInTheDocument();
    expect(first.getByText('担当: 佐藤')).toBeInTheDocument();
    expect(first.getByText('電話番号一致')).toBeInTheDocument();

    await user.click(first.getByRole('button', { name: '統合する' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('LINE顧客「hana」の情報（LINE連携、メッセージ、予約、カルテ）を 既存顧客「山田 花子」に統合します。');
    expect(dialog).toHaveTextContent('この操作は取り消せません。');
    await user.click(within(dialog).getByRole('button', { name: '統合する' }));
    await waitFor(() => expect(merge).toHaveBeenCalledWith('c1', 'line-1'));
    await waitFor(() => expect(document.querySelectorAll('[data-merge-candidate]')).toHaveLength(1));

    await user.click(screen.getByRole('button', { name: 'スキップ' }));
    await waitFor(() => expect(dismiss).toHaveBeenCalledWith('line-2', 'c1'));
    expect(await screen.findByText('統合候補はありません')).toBeInTheDocument();
  });

  it('名前重複: link as one person, dismiss, and merge into the recommended record', async () => {
    mockList([listItem({})]);
    vi.spyOn(customersApi, 'duplicatePairs').mockResolvedValue([]);
    vi.spyOn(customersApi, 'nameDuplicates').mockResolvedValue({ groups: [group, { ...group, normalized_name: '佐藤愛', customers: group.customers.map((c) => ({ ...c, id: `s-${c.id}`, name: '佐藤 愛' })) }], total: 2 });
    const link = vi.spyOn(customersApi, 'linkMaster').mockResolvedValue({ member_no: 'M00000042', customerIds: ['c1', 'c2'] });
    const dismiss = vi.spyOn(customersApi, 'dismissNameDuplicate').mockResolvedValue({ dismissed: 2 });
    const merge = vi.spyOn(customersApi, 'merge').mockResolvedValue({ mergeLogId: 'm', targetId: 'c1', sourceId: 'c2', moved: {} });
    const user = mount('/app/customers');

    await user.click(await screen.findByRole('tab', { name: /名前重複/ }));
    expect(screen.getByText('名前重複候補')).toBeInTheDocument();
    expect(await screen.findByText('2/2グループ')).toBeInTheDocument();
    const yamada = within(document.querySelector<HTMLElement>('[data-name-duplicate="山田花子"]')!);
    expect(yamada.getByText('推奨')).toBeInTheDocument();
    expect(yamada.getByText('電話番号なし')).toBeInTheDocument();
    expect(yamada.getByText('店舗: 新宿店')).toBeInTheDocument();

    await user.click(yamada.getByRole('button', { name: '同一人物としてリンク' }));
    await waitFor(() => expect(link).toHaveBeenCalledWith(['c1', 'c2']));
    expect(await screen.findByText('会員番号 M00000042 に統合しました（カルテ等は各店舗に残ります）')).toBeInTheDocument();
    expect(yamada.getAllByText('M00000042')).toHaveLength(2);

    await user.click(yamada.getByRole('button', { name: '統合' }));
    let dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('「山田 花子」（新宿店）の予約・カルテ・メッセージを 「山田 花子」（渋谷店）に統合し、重複レコードを削除します。');
    await user.click(within(dialog).getByRole('button', { name: '統合する' }));
    await waitFor(() => expect(merge).toHaveBeenCalledWith('c1', 'c2'));
    // a group left with one record is settled
    await waitFor(() => expect(document.querySelector('[data-name-duplicate="山田花子"]')).toBeNull());
    expect(screen.getByText('1/1グループ')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '統合しない' }));
    dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('統合しないとしてスキップしますか？');
    expect(dialog).toHaveTextContent('「佐藤 愛」「佐藤 愛」 を重複候補から除外します。今後この組み合わせは表示されません。');
    await user.click(within(dialog).getByRole('button', { name: 'スキップする' }));
    await waitFor(() => expect(dismiss).toHaveBeenCalledWith('佐藤愛'));
    expect(await screen.findByText('名前重複の候補はありません')).toBeInTheDocument();
  });
});

describe('新規顧客登録', () => {
  it('requires a name, registers the customer and opens them', async () => {
    const create = vi.spyOn(customersApi, 'create').mockResolvedValue({ customer: detail({ id: 'new-1' }), duplicateCandidates: [] });
    const user = mount('/app/customers/new');
    expect(screen.getByRole('heading', { name: '新規顧客登録' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '登録する' }));
    expect(await screen.findByText('名前は必須です')).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText(/^名前/), '山田 花子');
    await user.type(screen.getByLabelText('よみがな'), 'ヤマダ ハナコ');
    await user.type(screen.getByLabelText('電話番号'), '090-1111-2222');
    await user.type(screen.getByLabelText('メモ'), '午前希望');
    await user.click(screen.getByRole('combobox', { name: '担当スタッフ' }));
    await user.click(await screen.findByRole('option', { name: '佐藤' }));
    await user.click(screen.getByRole('button', { name: '登録する' }));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]![0]).toMatchObject({
      lastName: '山田',
      firstName: '花子',
      lastNameKana: 'ヤマダ',
      firstNameKana: 'ハナコ',
      phone: '090-1111-2222',
      memo: '午前希望',
      primaryStaffId: 'staff-1',
      primaryShopId: 'shop-1',
    });
    await waitFor(() => expect(where()).toBe('/app/customers/new-1'));
  });

  it('picker mode continues the reservation with the new customer', async () => {
    vi.spyOn(customersApi, 'create').mockResolvedValue({ customer: detail({ id: 'new-2', display_name: '新規 太郎' }), duplicateCandidates: [] });
    const user = mount('/app/customers/new?mode=select');
    await user.type(screen.getByLabelText(/^名前/), '新規 太郎');
    await user.click(screen.getByRole('button', { name: '登録する' }));
    await waitFor(() => expect(where()).toBe(`/app/calendar/new?customer_id=new-2&customer_name=${encodeURIComponent('新規 太郎')}`));
  });
});

describe('顧客詳細', () => {
  function mockDetail(c: CustomerDetail = detail()) {
    vi.spyOn(customersApi, 'get').mockResolvedValue(c);
    vi.spyOn(customersApi, 'overview').mockResolvedValue(overview);
    vi.spyOn(customersApi, 'visits').mockResolvedValue([
      {
        id: 'a1',
        shop_id: 'shop-1',
        shop_name: '渋谷店',
        staff_id: 'staff-1',
        staff_name: '佐藤',
        is_nominated: true,
        start_at: '2026-10-01T03:00:00.000Z',
        end_at: '2026-10-01T04:00:00.000Z',
        status: 'confirmed',
        source: 'staff',
        estimated_total: 9900,
        services: [{ name: 'カット', price: 5500, duration_min: 60 }, { name: 'カラー', price: 4400, duration_min: 60 }],
        transaction: null,
      },
    ]);
    vi.spyOn(customersApi, 'legacyVisits').mockResolvedValue([
      { id: 'lv1', visited_at: '2026-08-31T15:00:00.000Z', shop_id: null, shop_name: null, staff_id: null, staff_name: '旧担当', menu_text: 'パーマ', amount: 12100, memo: '8Lv アッシュ', external_id: null, source_label: null },
    ]);
    vi.spyOn(customersApi, 'memos').mockResolvedValue([
      { id: 'm1', body: '【旧システムより移行】\n雑誌は不要', visibility: 'shared', pinned: false, staff_id: 'staff-1', created_at: '2026-10-01T00:00:00.000Z' },
      { id: 'm2', body: '自分だけのメモ', visibility: 'private', pinned: false, staff_id: 'staff-1', created_at: '2026-10-01T00:00:00.000Z' },
    ]);
    vi.spyOn(kartesApi, 'list').mockResolvedValue({ items: [karteItem], nextCursor: null });
  }

  it('shows the profile, the staff in charge, linked records and the karte list', async () => {
    mockDetail();
    const user = mount('/app/customers/c1');
    expect(await screen.findByRole('heading', { name: '山田 花子' })).toBeInTheDocument();
    expect(screen.getByText('ヤマダ ハナコ')).toBeInTheDocument();
    expect(await screen.findByText('会員番号: A-001')).toBeInTheDocument();
    expect(screen.getByText('〒150-0001 東京都渋谷区神宮前')).toBeInTheDocument();
    expect(screen.getByText('3回')).toBeInTheDocument();
    // 最終来店 in the profile card (the karte of that day shows the same date)
    expect(screen.getAllByText('2026年10月1日(木)').length).toBeGreaterThan(0);
    expect(screen.getByText('女性')).toBeInTheDocument();
    expect(screen.getByText('1990-04-01')).toBeInTheDocument();
    expect(screen.getByText('店舗集客')).toBeInTheDocument();
    expect(screen.getByText('カラーはアレルギー注意')).toBeInTheDocument();
    // shared staff memos (e.g. carried over from the previous system) are shown with the memo, private ones are not
    expect(screen.getByText(/雑誌は不要/)).toBeInTheDocument();
    expect(screen.queryByText('自分だけのメモ')).toBeNull();
    expect(screen.getByText('佐藤')).toBeInTheDocument();
    expect(screen.getByText('鈴木（来店1回）')).toBeInTheDocument();
    expect(screen.getByText('同一会員番号のリンク済みレコード（他店舗含む）')).toBeInTheDocument();
    expect(screen.getByText('最終来店: 2026-09-01')).toBeInTheDocument();
    expect(screen.getByTestId('customer-classic-link')).toHaveAttribute('href', '/app/customers-classic/c1');

    // カルテ is the tab shown first
    const tabs = screen.getByRole('tablist', { name: '顧客情報' });
    expect(within(tabs).getByRole('tab', { name: 'カルテ', selected: true })).toBeInTheDocument();
    expect(await screen.findByText('カット＋カラー')).toBeInTheDocument();
    expect(screen.getByText('未共有')).toBeInTheDocument();

    // 予約履歴: reservations and the visits carried over from the previous system, newest first
    await user.click(within(tabs).getByRole('tab', { name: /予約履歴/ }));
    const rows = document.querySelectorAll<HTMLElement>('[data-history]');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('2026年10月1日 12:00');
    expect(rows[0]).toHaveTextContent('カット、カラー / 佐藤');
    expect(rows[0]).toHaveTextContent('確定');
    expect(rows[0]).toHaveTextContent('9,900');
    expect(rows[1]).toHaveTextContent('2026年9月1日');
    expect(rows[1]).not.toHaveTextContent('00:00');
    expect(rows[1]).toHaveTextContent('パーマ / 旧担当');
    expect(rows[1]).toHaveTextContent('8Lv アッシュ');
    expect(rows[1]).toHaveTextContent('完了');
    expect(screen.getByText('2件')).toBeInTheDocument();

    await user.click(within(tabs).getByRole('tab', { name: /メッセージ/ }));
    expect(screen.getByText('messages of c1')).toBeInTheDocument();

    await user.click(within(tabs).getByRole('tab', { name: 'カルテ' }));
    await user.click(document.querySelector('[data-karte="k1"]')!);
    expect(where()).toBe('/app/customers/kartes/k1');
  });

  it('opens on the tab a link asks for and marks LINE display names', async () => {
    mockDetail(detail({ name_source: 'line' }));
    vi.spyOn(customersApi, 'overview').mockResolvedValue({ ...overview, name_source: 'line', member_no: null, assigned_staff: [], linked_customers: [] });
    mount('/app/customers/c1?tab=messages');
    expect(await screen.findByText('本名未登録（LINE表示名）')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /メッセージ/, selected: true })).toBeInTheDocument();
    expect(await screen.findByText('未定（来店済みの予約がありません）')).toBeInTheDocument();
  });

  it('edits the profile and deletes the customer', async () => {
    mockDetail();
    const updated = detail({ last_name: '田中', display_name: '田中 花子', memo: null });
    const update = vi.spyOn(customersApi, 'update').mockImplementation(async () => {
      vi.spyOn(customersApi, 'get').mockResolvedValue(updated);
      return updated;
    });
    const remove = vi.spyOn(customersApi, 'remove').mockResolvedValue(undefined);
    const user = mount('/app/customers/c1');
    await user.click(await screen.findByRole('button', { name: '編集' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('顧客情報を編集')).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/^姓/)).toHaveValue('山田');
    expect(within(dialog).getByLabelText('メイ')).toHaveValue('ハナコ');
    expect(within(dialog).getByRole('combobox', { name: '性別' })).toHaveTextContent('女性');
    await user.clear(within(dialog).getByLabelText(/^姓/));
    // without a family name nothing is saved
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    expect(update).not.toHaveBeenCalled();
    await user.type(within(dialog).getByLabelText(/^姓/), '田中');
    await user.clear(within(dialog).getByLabelText('メモ'));
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenCalledWith('c1', {
      lastName: '田中',
      firstName: '花子',
      lastNameKana: 'ヤマダ',
      firstNameKana: 'ハナコ',
      gender: 'female',
      birthday: '1990-04-01',
      occupation: '会社員',
      postalCode: '150-0001',
      address: '東京都渋谷区神宮前',
      phone: '090-1111-2222',
      email: 'hanako@example.com',
      memo: null,
    });
    expect(await screen.findByRole('heading', { name: '田中 花子' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();

    await user.click(screen.getByRole('button', { name: '削除' }));
    const confirm = screen.getByRole('alertdialog');
    expect(confirm).toHaveTextContent('「田中 花子」を削除します。この操作は取り消せません。');
    await user.click(within(confirm).getByRole('button', { name: '削除する' }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith('c1'));
    await waitFor(() => expect(where()).toBe('/app/customers'));
  });

  it('hides what the staff member may not do, and starts a karte from the karte tab', async () => {
    mockDetail();
    perms.denied = ['customer.delete', 'customer.write'];
    const create = vi.spyOn(kartesApi, 'create').mockResolvedValue(karteDetail({ id: 'k-new' }));
    vi.spyOn(kartesApi, 'get').mockResolvedValue(karteDetail({ id: 'k-new' }));
    const user = mount('/app/customers/c1');
    await screen.findByRole('heading', { name: '山田 花子' });
    expect(screen.queryByRole('button', { name: '編集' })).toBeNull();
    expect(screen.queryByRole('button', { name: '削除' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '追加' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]![0]).toMatchObject({ customerId: 'c1', shopId: 'shop-1', fields: {} });
    expect(create.mock.calls[0]![0].visitDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await waitFor(() => expect(where()).toMatch(/^\/app\/customers\/kartes\/k-new/));
  });

  it('says so when the customer does not exist', async () => {
    vi.spyOn(customersApi, 'get').mockRejectedValue(new Error('not found'));
    const user = mount('/app/customers/missing');
    expect(await screen.findByText('顧客が見つかりません')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '顧客一覧に戻る' }));
    expect(where()).toBe('/app/customers');
  });
});

describe('カルテ詳細 and カウンセリングシート', () => {
  beforeEach(() => {
    vi.spyOn(customersApi, 'get').mockResolvedValue(detail());
  });

  it('shows the record, saves the edited record and shares the karte', async () => {
    vi.spyOn(kartesApi, 'get').mockResolvedValue(karteDetail());
    const update = vi.spyOn(kartesApi, 'update').mockResolvedValue(karteDetail());
    const share = vi.spyOn(kartesApi, 'share').mockResolvedValue({ url: 'https://example.test/k/token', expiresAt: '', sharedAt: '', messageId: null });
    const user = mount('/app/customers/kartes/k1');

    expect(await screen.findByRole('heading', { name: 'カルテ詳細' })).toBeInTheDocument();
    expect(await screen.findByText('山田 花子')).toBeInTheDocument();
    expect(screen.getByText('2026年10月1日(木)')).toBeInTheDocument();
    expect(screen.getByText('担当: 佐藤')).toBeInTheDocument();
    expect(screen.getByText('カット＋カラー')).toBeInTheDocument();
    expect(screen.getByText('8AB:6N')).toBeInTheDocument();
    expect(screen.getByText('内部メモ（非公開）')).toBeInTheDocument();
    expect(screen.getByText('クレーム注意')).toBeInTheDocument();
    // what was recorded with a template / chemicals / home care is not hidden
    expect(screen.getByText('スタイル')).toBeInTheDocument();
    expect(screen.getByText('ボブ')).toBeInTheDocument();
    expect(screen.getByText('ストレートA 1:1 20分')).toBeInTheDocument();
    expect(screen.getByText('週1回トリートメント')).toBeInTheDocument();
    expect(screen.getByText('写真がありません')).toBeInTheDocument();
    expect(screen.getByTestId('karte-classic-link')).toHaveAttribute('href', '/app/kartes/k1');

    await user.click(screen.getByRole('button', { name: '共有' }));
    await waitFor(() => expect(share).toHaveBeenCalledWith('k1', { expiresInDays: 30, notify: false }));
    expect(await screen.findByText('カルテを共有しました')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '編集' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('カルテ編集')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('施術内容')).toHaveValue('カット＋カラー');
    expect(within(dialog).getByLabelText('内部メモ（非公開）')).toHaveValue('クレーム注意');
    await user.clear(within(dialog).getByLabelText('カラー配合'));
    await user.type(within(dialog).getByLabelText('次回提案'), '次回はトリートメント');
    await user.click(within(dialog).getByTestId('save-karte-record'));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenCalledWith('k1', {
      version: 3,
      visitDate: '2026-10-01',
      // the template's own fields travel along untouched; emptied fields are cleared
      fields: {
        style_name: 'ボブ',
        menu_content: 'カット＋カラー',
        hair_condition: null,
        color_formula: null,
        perm_info: null,
        styling_notes: null,
        customer_feedback: null,
        next_suggestion: '次回はトリートメント',
      },
      note: 'クレーム注意',
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('adds and removes photos, and deletes the karte', async () => {
    const asset = { id: 'as1', karte_id: 'k1', file_id: 'f1', asset_type: 'photo_before' as const, caption: '施術前の状態', share_with_customer: true, sort_order: 0, created_at: '', content_type: 'image/png', file_name: 'a.png', url: 'http://localhost/v1/files/blob/x', url_expires_at: '' };
    vi.spyOn(kartesApi, 'get').mockResolvedValue(karteDetail({ assets: [asset], shared_with_customer: true }));
    const removeAsset = vi.spyOn(kartesApi, 'removeAsset').mockResolvedValue(undefined);
    const remove = vi.spyOn(kartesApi, 'remove').mockResolvedValue(undefined);
    const user = mount('/app/customers/kartes/k1');

    expect(await screen.findByText('共有済み')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '施術前の状態' })).toBeInTheDocument();
    expect(screen.getByText('施術前')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '追加' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('写真を追加')).toBeInTheDocument();
    expect(within(dialog).getByRole('combobox', { name: '写真の種類' })).toHaveTextContent('その他');
    expect(within(dialog).getByRole('button', { name: '写真を選択' })).toBeEnabled();
    await user.click(within(dialog).getByRole('button', { name: 'キャンセル' }));

    await user.click(screen.getByRole('button', { name: '写真を削除' }));
    let confirm = screen.getByRole('alertdialog');
    expect(confirm).toHaveTextContent('写真を削除しますか？');
    await user.click(within(confirm).getByRole('button', { name: '削除' }));
    await waitFor(() => expect(removeAsset).toHaveBeenCalledWith('k1', 'as1'));

    await user.click(screen.getByRole('button', { name: 'カルテを削除' }));
    confirm = screen.getByRole('alertdialog');
    expect(confirm).toHaveTextContent('このカルテと関連する写真がすべて削除されます。この操作は取り消せません。');
    await user.click(within(confirm).getByRole('button', { name: '削除' }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith('k1'));
  });

  it('fills in and saves the counselling sheet', async () => {
    vi.spyOn(kartesApi, 'get').mockResolvedValue(karteDetail());
    vi.spyOn(kartesApi, 'counselingSheet').mockResolvedValue({
      counseling_sheet: { id: 's1', customer_id: 'c1', shop_id: 'shop-1', data: { hair: { hair_curl: 'なし' } }, updated_at: '' },
    });
    const save = vi.spyOn(kartesApi, 'saveCounselingSheet').mockResolvedValue({ counseling_sheet: { id: 's1', customer_id: 'c1', shop_id: 'shop-1', data: {}, updated_at: '' } });
    const user = mount('/app/customers/kartes/k1');

    await user.click(await screen.findByRole('tab', { name: 'カウンセリングシート' }));
    const categories = await screen.findByRole('tablist', { name: 'カウンセリングの種類' });
    expect(within(categories).getAllByRole('tab').map((t) => t.textContent)).toEqual(['髪', '目', 'エクステ', '眉', 'ネイル', '顔', '体']);
    // 癖の種類 / 癖の強さ only follow the answer あり
    expect(screen.queryByText('癖の種類')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'あり' }));
    expect(screen.getByText('癖の種類')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '生え癖' }));
    await user.click(screen.getByRole('button', { name: '髪癖' }));
    await user.click(screen.getByRole('button', { name: '生え癖' }));
    const volume = screen.getByRole('slider', { name: '毛量' });
    expect(volume).toHaveAttribute('aria-valuenow', '50');
    volume.focus();
    await user.keyboard('{ArrowRight}');
    expect(volume).toHaveAttribute('aria-valuenow', '75');

    // follow-up inputs open for the answer that asks for them
    await user.click(within(categories).getByRole('tab', { name: 'ネイル' }));
    expect(screen.queryByText('アレルギー詳細')).toBeNull();
    const allergy = screen.getByText('アレルギーをお持ちですか？').parentElement!;
    await user.click(within(allergy).getByRole('button', { name: 'はい' }));
    await user.type(screen.getByLabelText('アレルギー詳細'), 'ジェル');

    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith(
      'c1',
      {
        hair: { hair_curl: 'あり', hair_curl_type: ['髪癖'], hair_volume: '75' },
        nail: { allergy: 'はい', allergy_detail: 'ジェル' },
      },
      'shop-1',
    );
    expect(await screen.findByRole('button', { name: '保存しました' })).toBeInTheDocument();
  });
});
