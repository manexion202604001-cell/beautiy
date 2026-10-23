import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { publicMessagingApi } from '../../api/messaging';
import { _resetLiffForTests } from '../../lib/liff';
import LineLink from './LineLink';

function mount(url: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/line/link" element={<LineLink />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

beforeEach(() => {
  vi.restoreAllMocks();
  _resetLiffForTests();
  delete (window as unknown as { liff?: unknown }).liff;
});

describe('LineLink (/line/link)', () => {
  it('initialises the LIFF app of the link, sends its id token and offers 友だち追加', async () => {
    const config = vi
      .spyOn(publicMessagingApi, 'liffConfig')
      .mockResolvedValue({ liffId: '1650000000-linkAB', friendUrl: 'https://lin.ee/abcdEFG' });
    const init = vi.fn().mockResolvedValue(undefined);
    (window as unknown as { liff: unknown }).liff = {
      init,
      isLoggedIn: () => true,
      isInClient: () => true,
      login: vi.fn(),
      getIDToken: () => 'liff-id-token',
    };
    const link = vi
      .spyOn(publicMessagingApi, 'lineLink')
      .mockResolvedValue({ linked: true, customerId: 'c1', following: false });
    const user = mount('/line/link?linkToken=link-token-1234567890&liffId=1650000000-linkAB');

    await waitFor(() => expect(init).toHaveBeenCalledWith({ liffId: '1650000000-linkAB' }));
    expect(config).toHaveBeenCalledWith({ linkToken: 'link-token-1234567890' });
    expect((await screen.findByRole('link', { name: /友だち追加/ })).getAttribute('href')).toBe(
      'https://lin.ee/abcdEFG',
    );
    const button = screen.getByRole('button', { name: /LINEで連携する/ });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    await waitFor(() =>
      expect(link).toHaveBeenCalledWith('link-token-1234567890', 'liff-id-token'),
    );
    expect(await screen.findByText('連携が完了しました')).toBeInTheDocument();
    // not a friend yet → the 友だち追加 button again
    expect(
      screen.getByText('お知らせを受け取るには、LINE公式アカウントを友だち追加してください。'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /友だち追加/ })).toHaveAttribute(
      'href',
      'https://lin.ee/abcdEFG',
    );
  });
});
