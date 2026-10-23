import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Invite from './Invite';
import ResetPassword from './ResetPassword';
import Signup from './Signup';

const h = vi.hoisted(() => ({
  acceptTokens: vi.fn(),
  api: { resetPassword: vi.fn(), signup: vi.fn(), acceptInvite: vi.fn(), declineInvite: vi.fn() },
}));

vi.mock('../../lib/auth', () => ({ useAuth: () => ({ acceptTokens: h.acceptTokens }) }));
vi.mock('../../api/auth', () => ({ authApi: h.api }));

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname + loc.search}</div>;
}

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/reset-password/:token" element={<ResetPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/signup" element={<Signup />} />
          <Route path="/invite/:token" element={<Invite />} />
          <Route path="*" element={<div>other page</div>} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());

describe('新しいパスワードの設定', () => {
  it('checks the two passwords, changes the password and offers the way back to login', async () => {
    const user = userEvent.setup();
    h.api.resetPassword.mockResolvedValue(undefined);
    renderAt('/reset-password/token-123456');
    expect(screen.getByText('新しいパスワードの設定')).toBeInTheDocument();
    await user.type(screen.getByLabelText('新しいパスワード'), 'short');
    await user.type(screen.getByLabelText('パスワード（確認）'), 'short');
    await user.click(screen.getByRole('button', { name: 'パスワードを変更' }));
    expect(screen.getByRole('alert')).toHaveTextContent('パスワードは8文字以上にしてください');

    await user.clear(screen.getByLabelText('新しいパスワード'));
    await user.type(screen.getByLabelText('新しいパスワード'), 'new-password-1');
    await user.click(screen.getByRole('button', { name: 'パスワードを変更' }));
    expect(screen.getByRole('alert')).toHaveTextContent('パスワードが一致しません');
    expect(h.api.resetPassword).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText('パスワード（確認）'));
    await user.type(screen.getByLabelText('パスワード（確認）'), 'new-password-1');
    await user.click(screen.getByRole('button', { name: 'パスワードを変更' }));
    await waitFor(() => expect(h.api.resetPassword).toHaveBeenCalledWith('token-123456', 'new-password-1'));
    expect(await screen.findByText('パスワードを変更しました。新しいパスワードでログインしてください。')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'ログインへ' })).toHaveAttribute('href', '/login');
  });

  it('shows the API message for an expired link and accepts ?token=', async () => {
    const user = userEvent.setup();
    h.api.resetPassword.mockRejectedValue(new Error('リセットリンクが無効か期限切れです'));
    renderAt('/reset-password?token=query-token-1');
    await user.type(screen.getByLabelText('新しいパスワード'), 'new-password-1');
    await user.type(screen.getByLabelText('パスワード（確認）'), 'new-password-1');
    await user.click(screen.getByRole('button', { name: 'パスワードを変更' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('リセットリンクが無効か期限切れです');
    expect(h.api.resetPassword).toHaveBeenCalledWith('query-token-1', 'new-password-1');
  });

  it('says the link is invalid when there is no token', () => {
    renderAt('/reset-password');
    expect(screen.getByText('無効なリンクです。')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'パスワードリセットを再申請' })).toHaveAttribute('href', '/forgot-password');
  });
});

describe('初期設定', () => {
  it('walks the three steps and creates the organization, first shop and owner', async () => {
    const user = userEvent.setup();
    h.api.signup.mockResolvedValue({ auth: { status: 'authenticated', accessToken: 'a', refreshToken: 'r' } });
    renderAt('/signup');
    expect(screen.getByText('初期設定（ステップ 1/3）')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '個人事業主' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByLabelText('会社名 *')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '法人' }));
    await user.click(screen.getByRole('button', { name: '次へ' }));
    expect(screen.getByRole('alert')).toHaveTextContent('法人の場合は会社名を入力してください');
    await user.type(screen.getByLabelText('会社名 *'), '株式会社サンプル');
    await user.type(screen.getByLabelText('郵便番号'), '150-0002');
    await user.click(screen.getByRole('button', { name: '次へ' }));

    expect(screen.getByText('初期設定（ステップ 2/3）')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '次へ' }));
    expect(screen.getByRole('alert')).toHaveTextContent('店舗名は必須です');
    await user.type(screen.getByLabelText('店舗名 *'), 'ビューティーサロン 渋谷店');
    await user.type(screen.getByLabelText('住所'), '東京都渋谷区1-2-3');
    await user.type(screen.getByLabelText('電話番号'), '03-0000-0000');
    // 戻る keeps what was entered
    await user.click(screen.getByRole('button', { name: '戻る' }));
    expect(screen.getByLabelText('会社名 *')).toHaveValue('株式会社サンプル');
    await user.click(screen.getByRole('button', { name: '次へ' }));
    expect(screen.getByLabelText('店舗名 *')).toHaveValue('ビューティーサロン 渋谷店');
    await user.click(screen.getByRole('button', { name: '次へ' }));

    expect(screen.getByText('初期設定（ステップ 3/3）')).toBeInTheDocument();
    await user.type(screen.getByLabelText('お名前 *'), 'オーナー 花子');
    await user.click(screen.getByRole('button', { name: '設定完了' }));
    expect(screen.getByRole('alert')).toHaveTextContent('メールアドレスは必須です');
    await user.type(screen.getByLabelText('メールアドレス *'), 'owner@example.com');
    await user.type(screen.getByLabelText('新しいパスワード *'), 'password-1234');
    await user.type(screen.getByLabelText('パスワード（確認） *'), 'password-12345');
    await user.click(screen.getByRole('button', { name: '設定完了' }));
    expect(screen.getByRole('alert')).toHaveTextContent('パスワードが一致しません');
    await user.clear(screen.getByLabelText('パスワード（確認） *'));
    await user.type(screen.getByLabelText('パスワード（確認） *'), 'password-1234');
    await user.click(screen.getByRole('button', { name: '設定完了' }));

    await waitFor(() => expect(h.api.signup).toHaveBeenCalledTimes(1));
    expect(h.api.signup.mock.calls[0]![0]).toEqual({
      organizationName: '株式会社サンプル',
      shopName: 'ビューティーサロン 渋谷店',
      ownerName: 'オーナー 花子',
      email: 'owner@example.com',
      password: 'password-1234',
      phone: '03-0000-0000',
      shopPostalCode: undefined,
      shopAddressLine: '東京都渋谷区1-2-3',
      shopEmail: undefined,
      ownerProfile: {
        ownerType: 'company',
        companyName: '株式会社サンプル',
        companyPostalCode: '150-0002',
        companyPhone: undefined,
        companyAddress: undefined,
        companyEmail: undefined,
      },
    });
    await waitFor(() => expect(h.acceptTokens).toHaveBeenCalled());
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/app$/);
  });

  it('names a sole proprietor’s business after the shop and shows a failed registration', async () => {
    const user = userEvent.setup();
    h.api.signup.mockRejectedValue(new Error('このメールアドレスは既に登録されています'));
    renderAt('/signup');
    await user.click(screen.getByRole('button', { name: '次へ' }));
    await user.type(screen.getByLabelText('店舗名 *'), 'サロン花');
    await user.click(screen.getByRole('button', { name: '次へ' }));
    await user.type(screen.getByLabelText('お名前 *'), '花子');
    await user.type(screen.getByLabelText('メールアドレス *'), 'hana@example.com');
    await user.type(screen.getByLabelText('新しいパスワード *'), 'password-1234');
    await user.type(screen.getByLabelText('パスワード（確認） *'), 'password-1234');
    await user.click(screen.getByRole('button', { name: '設定完了' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('このメールアドレスは既に登録されています');
    expect(h.api.signup.mock.calls[0]![0]).toMatchObject({ organizationName: 'サロン花', ownerProfile: { ownerType: 'individual', companyName: undefined } });
    expect(screen.getByRole('button', { name: '設定完了' })).toBeEnabled();
  });
});

describe('スタッフ招待の受諾', () => {
  it('sets the password and signs the invited staff member in', async () => {
    const user = userEvent.setup();
    h.api.acceptInvite.mockResolvedValue({ accessToken: 'a', refreshToken: 'r' });
    renderAt('/invite/invite-token-1');
    expect(screen.getByText('スタッフ招待')).toBeInTheDocument();
    await user.type(screen.getByLabelText('パスワード'), 'password-1234');
    await user.type(screen.getByLabelText('パスワード（確認）'), 'password-9999');
    await user.click(screen.getByRole('button', { name: '招待を受け付ける' }));
    expect(screen.getByRole('alert')).toHaveTextContent('パスワードが一致しません');
    await user.clear(screen.getByLabelText('パスワード（確認）'));
    await user.type(screen.getByLabelText('パスワード（確認）'), 'password-1234');
    await user.click(screen.getByRole('button', { name: '招待を受け付ける' }));
    await waitFor(() => expect(h.api.acceptInvite).toHaveBeenCalledWith('invite-token-1', 'password-1234'));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/app'));
    expect(h.acceptTokens).toHaveBeenCalled();
  });
  it('accepts 8 characters (not 7) and can decline the invitation instead', async () => {
    const user = userEvent.setup();
    h.api.declineInvite.mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderAt('/invite/invite-token-2');
    await user.type(screen.getByLabelText('パスワード'), '1234567');
    await user.type(screen.getByLabelText('パスワード（確認）'), '1234567');
    await user.click(screen.getByRole('button', { name: '招待を受け付ける' }));
    expect(screen.getByRole('alert')).toHaveTextContent('パスワードは8文字以上にしてください');
    expect(h.api.acceptInvite).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '辞退' }));
    expect(confirm).toHaveBeenCalledWith('この招待を辞退しますか？');
    await waitFor(() => expect(h.api.declineInvite).toHaveBeenCalledWith('invite-token-2'));
    expect(await screen.findByText('招待を辞退しました。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '招待を受け付ける' })).not.toBeInTheDocument();
    confirm.mockRestore();
  });
});
