import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RequireAuth } from './RequireAuth';

const h = vi.hoisted(() => ({
  auth: {
    status: 'authenticated' as string,
    meLoading: false,
    me: null as null | Record<string, unknown>,
    login: vi.fn(),
    logout: vi.fn(),
    retrySession: vi.fn(),
  },
  changePassword: vi.fn(),
}));

vi.mock('../../lib/auth', () => ({ useAuth: () => h.auth }));
vi.mock('../../api/auth', () => ({ authApi: { changePassword: h.changePassword } }));

const me = (mustChange: boolean) => ({
  user: { email: 'staff@example.com', must_change_password: mustChange },
  organization: { id: 'org-1' },
});

function renderApp() {
  return render(
    <MemoryRouter initialEntries={['/app']}>
      <Routes>
        <Route
          path="/app"
          element={
            <RequireAuth>
              <div>app content</div>
            </RequireAuth>
          }
        />
        <Route path="/login" element={<div>login page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.status = 'authenticated';
  h.auth.meLoading = false;
  h.auth.me = me(false);
});

describe('RequireAuth', () => {
  it('shows 読み込み中... while the session and /me are checked', () => {
    h.auth.status = 'loading';
    const { unmount } = renderApp();
    expect(screen.getByText('読み込み中...')).toBeInTheDocument();
    unmount();
    h.auth.status = 'authenticated';
    h.auth.meLoading = true;
    h.auth.me = null;
    renderApp();
    expect(screen.getByText('読み込み中...')).toBeInTheDocument();
    expect(screen.queryByText('app content')).not.toBeInTheDocument();
  });

  it('opens the app once the session is there', () => {
    renderApp();
    expect(screen.getByText('app content')).toBeInTheDocument();
  });

  it('asks for a new password first after signing in with a temporary one', async () => {
    const user = userEvent.setup();
    h.auth.me = me(true);
    h.changePassword.mockResolvedValue(undefined);
    h.auth.login.mockResolvedValue({ status: 'authenticated' });
    renderApp();
    expect(screen.queryByText('app content')).not.toBeInTheDocument();
    expect(
      screen.getByText('初回ログインのため、ご自身の新しいパスワードを設定してください。'),
    ).toBeInTheDocument();

    await user.type(screen.getByLabelText('仮パスワード'), 'temp-pass');
    await user.type(screen.getByLabelText('新しいパスワード'), '1234567');
    await user.type(screen.getByLabelText('パスワード（確認）'), '1234567');
    await user.click(screen.getByRole('button', { name: 'パスワードを設定' }));
    expect(screen.getByRole('alert')).toHaveTextContent('パスワードは8文字以上にしてください');

    await user.clear(screen.getByLabelText('新しいパスワード'));
    await user.clear(screen.getByLabelText('パスワード（確認）'));
    await user.type(screen.getByLabelText('新しいパスワード'), 'my-own-pass');
    await user.type(screen.getByLabelText('パスワード（確認）'), 'my-own-pass');
    await user.click(screen.getByRole('button', { name: 'パスワードを設定' }));
    await waitFor(() => expect(h.changePassword).toHaveBeenCalledWith('temp-pass', 'my-own-pass'));
    // signed in again with the new password (the change ends every session)
    await waitFor(() =>
      expect(h.auth.login).toHaveBeenCalledWith('staff@example.com', 'my-own-pass', 'org-1'),
    );
    expect(h.auth.logout).not.toHaveBeenCalled();
  });
});
