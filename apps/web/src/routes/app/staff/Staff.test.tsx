import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { orgApi } from '../../../api/org';
import { staffScreenApi, type StaffDirectoryRow } from '../../../api/staffScreen';
import { staffAdminApi, type StaffInvitation } from '../../../api/storeSettings';
import type { Role, Staff as StaffRow } from '../../../api/types';
import { ToastProvider } from '../../../components/ui';
import { todayIn } from '../../../lib/time';
import Staff from './Staff';

const navigate = vi.fn();
vi.mock('react-router', async (orig) => ({
  ...(await orig<typeof import('react-router')>()),
  useNavigate: () => navigate,
}));

let permissions: (p: string) => boolean = () => true;
vi.mock('../../../lib/auth', () => ({
  useAuth: () => ({
    can: (p: string) => permissions(p),
    currentShopId: 'shop-1',
    currentShop: { id: 'shop-1', name: '渋谷店' },
    timezone: 'Asia/Tokyo',
  }),
}));

const roles: Role[] = [
  {
    id: 'r-owner',
    key: 'owner',
    name: 'オーナー',
    description: null,
    is_system: true,
    permissions: [],
  },
  {
    id: 'r-manager',
    key: 'manager',
    name: '店長',
    description: null,
    is_system: true,
    permissions: [],
  },
  {
    id: 'r-stylist',
    key: 'stylist',
    name: 'スタイリスト',
    description: null,
    is_system: true,
    permissions: [],
  },
  {
    id: 'r-reception',
    key: 'reception',
    name: '受付',
    description: null,
    is_system: true,
    permissions: [],
  },
];

function staff(patch: Partial<StaffDirectoryRow>): StaffDirectoryRow {
  return {
    id: 's1',
    user_id: 'u1',
    role_id: 'r-stylist',
    display_name: '山田 花子',
    display_name_kana: null,
    email: 'hanako@example.com',
    phone: null,
    employment_type: 'full_time',
    title: null,
    color: '#7c3aed',
    is_bookable: true,
    nomination_fee: 0,
    public_profile: {},
    public_slug: null,
    sort_order: 0,
    status: 'active',
    hired_on: null,
    retired_on: null,
    created_at: '2026-04-01T03:00:00.000Z',
    avatar_url: null,
    role: { id: 'r-stylist', key: 'stylist', name: 'スタイリスト' },
    shops: [
      {
        shop_id: 'shop-1',
        is_primary: true,
        started_on: '2026-04-01',
        is_visible_to_customer: true,
      },
    ],
    nickname: null,
    login_email: 'hanako@example.com',
    login_ready: true,
    notify_line: false,
    line_user_id: null,
    is_visible_to_customer: true,
    customer_count: 0,
    ...patch,
  };
}

const owner = staff({
  id: 'owner',
  display_name: '佐藤 オーナー',
  role_id: 'r-owner',
  role: { id: 'r-owner', key: 'owner', name: 'オーナー' },
  email: 'owner@example.com',
  login_email: 'owner@example.com',
  customer_count: 1234,
  notify_line: true,
  line_user_id: `U${'a'.repeat(32)}`,
});
const hanako = staff({ nickname: 'はな', avatar_url: 'https://files.example/hanako.png' });
const invited = staff({
  id: 's2',
  display_name: '新人 太郎',
  status: 'invited',
  login_ready: false,
  login_email: 'taro@example.com',
  email: 'taro@example.com',
});
const noLogin = staff({
  id: 's3',
  display_name: '取込 次郎',
  user_id: null,
  login_ready: false,
  login_email: null,
  email: null,
  is_visible_to_customer: false,
  role_id: 'r-reception',
  role: { id: 'r-reception', key: 'reception', name: '受付' },
});
const retired = staff({
  id: 's4',
  display_name: '退職 三郎',
  status: 'retired',
  retired_on: '2026-03-31',
});

const invitation: StaffInvitation = {
  id: 'i1',
  staff_id: 's2',
  shop_id: 'shop-1',
  email: 'taro@example.com',
  accepted_at: null,
  created_at: '2026-10-01T00:00:00.000Z',
  staff_name: '新人 太郎',
  shop_name: '渋谷店',
  role_key: 'stylist',
  role_name: 'スタイリスト',
  invited_by_name: '佐藤 オーナー',
  status: 'pending',
};

// retired first on purpose: the screen moves retired staff below the others
function mount(rows: StaffDirectoryRow[] = [retired, owner, hanako, invited, noLogin]) {
  const directory = vi.spyOn(staffScreenApi, 'directory').mockResolvedValue(rows);
  vi.spyOn(orgApi, 'roles').mockResolvedValue(roles);
  vi.spyOn(staffAdminApi, 'invitations').mockResolvedValue([
    invitation,
    { ...invitation, id: 'i2', shop_id: 'other-shop', staff_name: '他店の人' },
    { ...invitation, id: 'i3', staff_name: '辞退の人', role_key: 'manager', status: 'declined' },
  ]);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/app/staff']}>
          <Staff />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { directory };
}

const rowOf = async (name: string) => {
  await screen.findAllByText(name);
  return document.querySelector<HTMLElement>(`[data-staff-name="${name}"]`)!;
};
/** the row renders a phone and a desktop layout: every control exists twice */
const first = (els: HTMLElement[]) => els[0]!;
const staffResult = hanako as unknown as StaffRow;

beforeEach(() => {
  vi.restoreAllMocks();
  navigate.mockReset();
  permissions = () => true;
});

describe('Staff (スタッフ管理)', () => {
  it('lists the staff of the shop: retired last, roles, login state, visibility, customers', async () => {
    const { directory } = mount();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'スタッフ管理' }),
    ).toBeInTheDocument();
    expect(directory).toHaveBeenCalledWith('shop-1');
    expect(screen.getByText('(在籍4名 / 退職1名)')).toBeInTheDocument();
    const names = [...document.querySelectorAll<HTMLElement>('[data-staff]')].map(
      (el) => el.dataset.staffName,
    );
    expect(names).toEqual(['佐藤 オーナー', '山田 花子', '新人 太郎', '取込 次郎', '退職 三郎']);
    expect(screen.getByText('退職スタッフ')).toBeInTheDocument();

    const ownerRow = await rowOf('佐藤 オーナー');
    expect(within(ownerRow).getAllByText('オーナー')).toHaveLength(2);
    expect(within(ownerRow).getAllByText('顧客: 1,234人')).toHaveLength(2);
    expect(within(ownerRow).getAllByTitle('LINE通知ON')).toHaveLength(2);
    expect(within(ownerRow).queryByText('未認証')).not.toBeInTheDocument();

    const hanakoRow = await rowOf('山田 花子');
    expect(within(hanakoRow).getAllByText('スタッフ')).toHaveLength(2);
    expect(within(hanakoRow).getAllByText('(はな)')).toHaveLength(2);
    expect(hanakoRow.querySelector('img')?.getAttribute('src')).toBe(
      'https://files.example/hanako.png',
    );
    expect(within(hanakoRow).getAllByText(/^登録: 2026年4月1日\(水\)$/)).toHaveLength(2);

    const invitedRow = await rowOf('新人 太郎');
    expect(within(invitedRow).getAllByText('未認証')).toHaveLength(2);
    expect(within(invitedRow).getAllByRole('button', { name: 'ログイン情報を設定' })).toHaveLength(
      2,
    );

    const importedRow = await rowOf('取込 次郎');
    // a role outside the three of this screen keeps its own name; hidden from customers
    expect(within(importedRow).getAllByText('受付')).toHaveLength(2);
    expect(within(importedRow).getByText('非表示')).toBeInTheDocument();

    const retiredRow = await rowOf('退職 三郎');
    expect(within(retiredRow).getByText('退職 2026年3月31日(火)')).toBeInTheDocument();
    expect(
      within(retiredRow).queryByRole('button', { name: 'ログイン情報を設定' }),
    ).not.toBeInTheDocument();
    expect(retiredRow.className).toContain('opacity-50');

    // 招待履歴: this shop only
    expect(screen.getByText('招待履歴')).toBeInTheDocument();
    expect(screen.getByText('スタッフ / 佐藤 オーナーが招待')).toBeInTheDocument();
    expect(screen.getByText('保留中')).toBeInTheDocument();
    expect(screen.getByText('辞退')).toBeInTheDocument();
    expect(screen.queryByText('他店の人')).not.toBeInTheDocument();
  });

  it('担当顧客 opens the customer list of that staff member; ↑↓ saves the new order', async () => {
    const user = userEvent.setup();
    const reorder = vi.spyOn(staffScreenApi, 'reorder').mockResolvedValue({ staffIds: [] });
    mount();
    const ownerRow = await rowOf('佐藤 オーナー');
    await user.click(first(within(ownerRow).getAllByRole('button', { name: '担当顧客' })));
    expect(navigate).toHaveBeenCalledWith('/app/customers?staff_id=owner');

    expect(within(ownerRow).getByRole('button', { name: '上へ' })).toBeDisabled();
    await user.click(within(ownerRow).getByRole('button', { name: '下へ' }));
    expect(reorder).toHaveBeenCalledWith('shop-1', ['s1', 'owner', 's2', 's3', 's4']);
  });

  it('退職 / 有効・無効 / お客様に表示 are saved with the same confirmations', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const update = vi.spyOn(staffScreenApi, 'update').mockResolvedValue(staffResult);
    const setVisibility = vi.spyOn(staffAdminApi, 'setVisibility').mockResolvedValue(staffResult);
    mount();

    const row = await rowOf('山田 花子');
    await user.click(first(within(row).getAllByRole('button', { name: '退職にする' })));
    expect(confirm).toHaveBeenLastCalledWith(
      '山田 花子を退職にしますか？\nお客様への表示がOFFになり、ログインもできなくなります。',
    );
    await waitFor(() =>
      expect(update).toHaveBeenLastCalledWith('s1', {
        status: 'retired',
        retiredOn: todayIn('Asia/Tokyo'),
      }),
    );
    expect(
      await screen.findByText('山田 花子を退職にしました（ログイン不可・お客様非表示）。'),
    ).toBeInTheDocument();

    await user.click(first(within(row).getAllByRole('button', { name: '無効にする' })));
    await waitFor(() => expect(update).toHaveBeenLastCalledWith('s1', { status: 'inactive' }));

    await user.click(first(within(row).getAllByRole('button', { name: 'お客様に表示中' })));
    expect(setVisibility).toHaveBeenCalledWith('s1', 'shop-1', false);
    await waitFor(() =>
      expect(within(row).getAllByRole('button', { name: 'お客様に非表示' }).length).toBeGreaterThan(
        0,
      ),
    );

    // 退職取り消し: back to active; an invitation that was never accepted goes back to 招待中
    const retiredRow = await rowOf('退職 三郎');
    await user.click(first(within(retiredRow).getAllByRole('button', { name: '退職取り消し' })));
    expect(confirm).toHaveBeenLastCalledWith(
      '退職 三郎の退職を取り消しますか？\n再びログインできるようになります。',
    );
    await waitFor(() =>
      expect(update).toHaveBeenLastCalledWith('s4', { status: 'active', retiredOn: null }),
    );
    expect(first(within(retiredRow).getAllByRole('button', { name: '無効にする' }))).toBeDisabled();

    confirm.mockReturnValue(false);
    update.mockClear();
    await user.click(first(within(row).getAllByRole('button', { name: '退職にする' })));
    expect(update).not.toHaveBeenCalled();
  });

  it('スタッフ編集 saves name / role, nickname / LINE通知 and the login', async () => {
    const user = userEvent.setup();
    const update = vi.spyOn(staffScreenApi, 'update').mockResolvedValue(staffResult);
    const extras = vi.spyOn(staffScreenApi, 'extras').mockResolvedValue(staffResult);
    const credentials = vi.spyOn(staffScreenApi, 'credentials').mockResolvedValue(staffResult);
    mount();
    const row = await rowOf('山田 花子');
    await user.click(first(within(row).getAllByRole('button', { name: 'スタッフ編集' })));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'スタッフ編集' })).toBeInTheDocument();
    expect(within(dialog).getByLabelText('氏名')).toHaveValue('山田 花子');
    expect(within(dialog).getByLabelText('ニックネーム')).toHaveValue('はな');
    expect(within(dialog).getByLabelText('メールアドレス')).toHaveValue('hanako@example.com');
    expect(within(dialog).getByRole('combobox', { name: '権限' })).toHaveTextContent('スタッフ');

    await user.clear(within(dialog).getByLabelText('氏名'));
    await user.type(within(dialog).getByLabelText('氏名'), '山田 華子');
    await user.clear(within(dialog).getByLabelText('ニックネーム'));
    await user.type(within(dialog).getByLabelText('ニックネーム'), 'はなちゃん');
    await user.click(within(dialog).getByRole('combobox', { name: '権限' }));
    expect(
      within(dialog)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['スタッフ', 'ディレクター', 'オーナー']);
    await user.click(within(dialog).getByRole('option', { name: 'ディレクター' }));
    // LINE通知: the User ID field appears only when switched on
    expect(within(dialog).queryByLabelText('LINE User ID')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('switch', { name: 'LINE通知' }));
    await user.type(within(dialog).getByLabelText('LINE User ID'), `U${'b'.repeat(32)}`);
    await user.type(
      within(dialog).getByLabelText('パスワード（変更する場合のみ）'),
      'new-password-1',
    );
    await user.click(within(dialog).getByRole('button', { name: '更新' }));

    await waitFor(() => expect(credentials).toHaveBeenCalled());
    expect(update).toHaveBeenCalledWith('s1', { displayName: '山田 華子', roleId: 'r-manager' });
    expect(extras).toHaveBeenCalledWith('s1', {
      nickname: 'はなちゃん',
      notifyLine: true,
      lineUserId: `U${'b'.repeat(32)}`,
    });
    expect(credentials).toHaveBeenCalledWith('s1', {
      email: 'hanako@example.com',
      password: 'new-password-1',
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('スタッフ編集: removing the photo and leaving the rest alone touches neither name nor login', async () => {
    const user = userEvent.setup();
    const update = vi.spyOn(staffScreenApi, 'update').mockResolvedValue(staffResult);
    const extras = vi.spyOn(staffScreenApi, 'extras').mockResolvedValue(staffResult);
    const credentials = vi.spyOn(staffScreenApi, 'credentials').mockResolvedValue(staffResult);
    mount();
    const row = await rowOf('山田 花子');
    await user.click(first(within(row).getAllByRole('button', { name: 'スタッフ編集' })));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: '写真を削除' }));
    expect(within(dialog).getByRole('button', { name: /追加/ })).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: '更新' }));
    await waitFor(() =>
      expect(extras).toHaveBeenCalledWith('s1', {
        nickname: 'はな',
        notifyLine: false,
        lineUserId: null,
        photoFileId: null,
      }),
    );
    expect(update).not.toHaveBeenCalled();
    expect(credentials).not.toHaveBeenCalled();
  });

  it('ログイン情報を設定 registers the address with a generated temporary password and shows what to send', async () => {
    const user = userEvent.setup();
    const credentials = vi.spyOn(staffScreenApi, 'credentials').mockResolvedValue(staffResult);
    mount();
    const row = await rowOf('新人 太郎');
    await user.click(first(within(row).getAllByRole('button', { name: 'ログイン情報を設定' })));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByRole('heading', { name: 'ログイン情報を設定: 新人 太郎' }),
    ).toBeInTheDocument();
    expect(within(dialog).getByLabelText('メールアドレス')).toHaveValue('taro@example.com');
    const password = (within(dialog).getByLabelText('仮パスワード') as HTMLInputElement).value;
    expect(password).toMatch(/^[A-Za-z2-9]{10}$/);
    await user.click(within(dialog).getByRole('button', { name: '再生成' }));
    const regenerated = (within(dialog).getByLabelText('仮パスワード') as HTMLInputElement).value;
    expect(regenerated).not.toBe(password);

    expect(dialog).toHaveTextContent(
      'メールアドレスと仮パスワードを登録します。スタッフは初回ログイン時にパスワードの変更が必須になります。',
    );
    expect(dialog).toHaveTextContent('8文字以上。自動生成されたものをそのまま使えます。');
    // too short (under 8 characters) → cannot be saved
    fireEvent.change(within(dialog).getByLabelText('仮パスワード'), {
      target: { value: '1234567' },
    });
    expect(within(dialog).getByRole('button', { name: '設定する' })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('仮パスワード'), {
      target: { value: '12345678' },
    });
    expect(within(dialog).getByRole('button', { name: '設定する' })).toBeEnabled();
    fireEvent.change(within(dialog).getByLabelText('仮パスワード'), {
      target: { value: 'temp-pass-1234' },
    });
    await user.click(within(dialog).getByRole('button', { name: '設定する' }));
    await waitFor(() =>
      expect(credentials).toHaveBeenCalledWith('s2', {
        email: 'taro@example.com',
        password: 'temp-pass-1234',
        temporary: true,
      }),
    );
    expect(await within(dialog).findByText(/設定が完了しました/)).toBeInTheDocument();
    expect(within(dialog).getByText(/メールアドレス: taro@example.com/)).toBeInTheDocument();
    expect(within(dialog).getByText(/仮パスワード: temp-pass-1234/)).toBeInTheDocument();
    const sent = within(dialog).getByText(/仮パスワード: temp-pass-1234/).textContent ?? '';
    expect(sent.startsWith('【Salon OS スタッフアプリ ログイン情報】\nURL: ')).toBe(true);
    expect(
      sent.endsWith('\n\n※初回ログイン時に、ご自身の新しいパスワードの設定をお願いします。'),
    ).toBe(true);
    expect(
      within(dialog).getByRole('button', { name: 'URL・メール・パスワードを一式コピー' }),
    ).toBeInTheDocument();
  });

  it('スタッフ招待 sends the invitation for the current shop and shows the link', async () => {
    const user = userEvent.setup();
    const invite = vi.spyOn(staffAdminApi, 'invite').mockResolvedValue({
      invitationId: 'i9',
      staffId: 's9',
      inviteUrl: 'https://app.example/invite/tok',
      emailSent: false,
    });
    mount();
    await screen.findByText('スタッフ招待');
    expect(screen.getByText('スタッフの6桁IDを入力して、渋谷店に招待します')).toBeInTheDocument();
    // the e-mail invitation (Salon OS) is folded under the ID search
    expect(screen.queryByLabelText('招待するメールアドレス')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'メールアドレスで招待' }));
    const send = screen.getByRole('button', { name: '招待を送信' });
    expect(send).toBeDisabled();
    await user.type(screen.getByLabelText('招待するメールアドレス'), 'new@example.com');
    await user.type(screen.getByLabelText('招待するスタッフの氏名'), '新規 花');
    await user.click(screen.getByRole('combobox', { name: '招待する権限' }));
    await user.click(screen.getByRole('option', { name: 'ディレクター' }));
    await user.click(send);
    await waitFor(() =>
      expect(invite).toHaveBeenCalledWith({
        email: 'new@example.com',
        displayName: '新規 花',
        roleKey: 'manager',
        shopId: 'shop-1',
      }),
    );
    const result = await screen.findByTestId('invite-result');
    expect(within(result).getByText(/招待メールを送信できませんでした/)).toBeInTheDocument();
    expect(within(result).getByText('https://app.example/invite/tok')).toBeInTheDocument();
  });

  it('スタッフ招待 adds a staff member of the salon to this shop by the 6-digit ID', async () => {
    const user = userEvent.setup();
    const search = vi.spyOn(staffAdminApi, 'searchByCode').mockResolvedValue({
      staff: {
        staff_code: '615204',
        name: '他店 次郎',
        avatar_url: null,
        same_organization: true,
        id: 's7',
        status: 'active',
        role_key: 'manager',
        shop_ids: ['shop-2'],
      },
    });
    const link = vi
      .spyOn(staffAdminApi, 'linkByCode')
      .mockResolvedValue({ invitationId: 'i1', staffId: 's7', status: 'accepted' });
    mount();
    await screen.findByText('スタッフ招待');
    await user.type(screen.getByLabelText('6桁のスタッフID'), '615204');
    await user.click(screen.getByRole('button', { name: '検索' }));
    await waitFor(() => expect(search).toHaveBeenCalledWith('615204'));
    const result = await screen.findByTestId('staff-code-result');
    expect(result).toHaveTextContent('他店 次郎ID: 615204');
    // 権限 starts at the staff member's current role
    expect(within(result).getByRole('combobox', { name: '権限' })).toHaveTextContent(
      'ディレクター',
    );
    await user.click(within(result).getByRole('button', { name: '招待を送信' }));
    await waitFor(() =>
      expect(link).toHaveBeenCalledWith({
        staffCode: '615204',
        shopId: 'shop-1',
        roleKey: 'manager',
      }),
    );
  });

  it('営業時間・予約設定 opens the staff settings, saves hours and the individual booking rules', async () => {
    const user = userEvent.setup();
    const hours = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
      weekday,
      openTime: '10:00',
      closeTime: '20:00',
      isClosed: weekday === 2,
    }));
    const settings = {
      advanceBookingDays: 60,
      sameDayCutoffHours: 1,
      maxConcurrent: 1,
      acceptSameStartTime: false,
      acceptOutsideHours: false,
    };
    vi.spyOn(staffScreenApi, 'businessHours').mockResolvedValue({ configured: false, hours });
    vi.spyOn(staffScreenApi, 'reservationSettings').mockResolvedValue({
      individual: false,
      settings,
    });
    const saveHours = vi
      .spyOn(staffScreenApi, 'saveBusinessHours')
      .mockImplementation((_s, _shop, h) => Promise.resolve({ configured: true, hours: h }));
    const copy = vi
      .spyOn(staffScreenApi, 'copyShopHours')
      .mockResolvedValue({ configured: true, hours });
    const saveSettings = vi
      .spyOn(staffScreenApi, 'saveReservationSettings')
      .mockImplementation((_s, _shop, s) => Promise.resolve({ individual: true, settings: s }));
    const reset = vi
      .spyOn(staffScreenApi, 'resetReservationSettings')
      .mockResolvedValue({ individual: false, settings });
    mount();
    const row = await rowOf('山田 花子');
    await user.click(first(within(row).getAllByRole('button', { name: '営業時間・予約設定' })));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: '山田 花子 - 設定' })).toBeInTheDocument();
    expect(await within(dialog).findByText('未設定（サロンの営業時間を使用）')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('火曜 開始')).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('月曜 開始'), { target: { value: '12:00' } });
    await user.click(within(dialog).getAllByRole('checkbox')[3]!); // 水 → 休み
    await user.click(within(dialog).getByRole('button', { name: '営業時間を保存' }));
    await waitFor(() => expect(saveHours).toHaveBeenCalled());
    const saved = saveHours.mock.calls[0]![2];
    expect(saved).toHaveLength(7);
    expect(saved[1]).toEqual({
      weekday: 1,
      openTime: '12:00',
      closeTime: '20:00',
      isClosed: false,
    });
    expect(saved[3]!.isClosed).toBe(true);
    expect(await within(dialog).findByText('個別設定済み')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'サロンの営業時間を反映' }));
    expect(copy).toHaveBeenCalledWith('s1', 'shop-1');

    await user.click(within(dialog).getByRole('tab', { name: '予約設定' }));
    expect(within(dialog).getByText('未設定（サロンの予約設定を使用）')).toBeInTheDocument();
    expect(
      within(dialog).queryByRole('button', { name: 'サロンの予約設定に戻す' }),
    ).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('何日先まで予約を受け付ける'), {
      target: { value: '30' },
    });
    fireEvent.change(within(dialog).getByLabelText('当日予約の締め切り'), {
      target: { value: '3' },
    });
    fireEvent.change(within(dialog).getByLabelText('同時刻に予約可能な人数'), {
      target: { value: '2' },
    });
    await user.click(within(dialog).getByRole('switch', { name: '開始時刻が同じ予約を受付する' }));
    await user.click(within(dialog).getByRole('button', { name: '予約設定を保存' }));
    await waitFor(() =>
      expect(saveSettings).toHaveBeenCalledWith('s1', 'shop-1', {
        advanceBookingDays: 30,
        sameDayCutoffHours: 3,
        maxConcurrent: 2,
        acceptSameStartTime: true,
        acceptOutsideHours: false,
      }),
    );
    await user.click(await within(dialog).findByRole('button', { name: 'サロンの予約設定に戻す' }));
    expect(reset).toHaveBeenCalledWith('s1', 'shop-1');
  });

  it('without staff.manage only 担当顧客 and 受付QR are offered', async () => {
    permissions = (p) => p === 'staff.read';
    mount();
    const row = await rowOf('山田 花子');
    expect(within(row).getAllByRole('button', { name: '担当顧客' })).toHaveLength(2);
    // 受付QR is on the phone layout only
    expect(within(row).getAllByRole('button', { name: '受付QR' })).toHaveLength(1);
    expect(within(row).queryByRole('button', { name: 'スタッフ編集' })).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: '退職にする' })).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: '上へ' })).not.toBeInTheDocument();
    expect(screen.queryByText('スタッフ招待')).not.toBeInTheDocument();
  });
});
