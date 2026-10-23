import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { customersApi, type LineMergeCandidate } from '../../../api/customers';
import { ToastProvider } from '../../../components/ui';
import { LineMergeCandidatesPanel } from './LineMergeCandidatesPanel';

vi.mock('../../../lib/auth', () => ({
  useAuth: () => ({ can: () => true, currentShopId: 'shop-1', timezone: 'Asia/Tokyo' }),
}));

const candidate: LineMergeCandidate = {
  id: 'line-1:c1',
  match_type: 'name_kana',
  line_customer_id: 'line-1',
  line_customer_name: 'はなこ',
  line_display_name: 'hana',
  line_customer_avatar: null,
  existing_customer_id: 'c1',
  existing_customer_name: '山田 花子',
  existing_customer_name_kana: 'ハナコ',
  existing_customer_phone: '090-1111-2222',
  existing_customer_visit_count: 4,
  existing_customer_last_visit_at: null,
  existing_customer_staff_name: '佐藤',
};

function mount(customerId: string | null = 'line-1') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <LineMergeCandidatesPanel customerId={customerId} shopId="shop-1" />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

beforeEach(() => vi.restoreAllMocks());

describe('予約詳細: 既存顧客との統合候補', () => {
  it('shows the LINE customer of the reservation next to the existing one and merges after confirming', async () => {
    const list = vi
      .spyOn(customersApi, 'lineMergeCandidates')
      .mockResolvedValue({
        candidates: [
          candidate,
          { ...candidate, id: 'line-1:c2', existing_customer_id: 'c2', match_type: 'phone' },
        ],
        total: 2,
      });
    const merge = vi
      .spyOn(customersApi, 'merge')
      .mockResolvedValue({ mergeLogId: 'm', targetId: 'c1', sourceId: 'line-1', moved: {} });
    const dismiss = vi.spyOn(customersApi, 'dismissDuplicate').mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = mount();

    const box = await screen.findByTestId('line-merge-candidates');
    expect(list).toHaveBeenCalledWith({ shopId: 'shop-1', customerId: 'line-1', limit: 20 });
    expect(within(box).getByText('既存顧客との統合候補があります')).toBeInTheDocument();
    expect(within(box).getAllByText('LINE（この予約）')).toHaveLength(2);
    expect(within(box).getAllByText('LINE: hana')).toHaveLength(2);
    expect(within(box).getAllByText('来店4回')).toHaveLength(2);
    expect(within(box).getByText('読み仮名一致')).toBeInTheDocument();
    expect(within(box).getByText('電話番号一致')).toBeInTheDocument();

    await user.click(within(box).getAllByRole('button', { name: '統合する' })[0]!);
    expect(confirm).toHaveBeenCalledWith(
      '「はなこ」を「山田 花子」に統合しますか？\nこの操作は取り消せません。',
    );
    await waitFor(() => expect(merge).toHaveBeenCalledWith('c1', 'line-1'));
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: '統合する' })).toHaveLength(1),
    );

    await user.click(screen.getByRole('button', { name: 'スキップ' }));
    await waitFor(() => expect(dismiss).toHaveBeenCalledWith('line-1', 'c2'));
    await waitFor(() => expect(screen.queryByTestId('line-merge-candidates')).toBeNull());
  });

  it('does nothing without a confirmation, and is hidden without candidates or customer', async () => {
    vi.spyOn(customersApi, 'lineMergeCandidates').mockResolvedValue({
      candidates: [candidate],
      total: 1,
    });
    const merge = vi.spyOn(customersApi, 'merge');
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const user = mount();
    await user.click(await screen.findByRole('button', { name: '統合する' }));
    expect(merge).not.toHaveBeenCalled();
  });

  it('is not shown for a reservation without a customer', () => {
    const list = vi.spyOn(customersApi, 'lineMergeCandidates');
    mount(null);
    expect(screen.queryByTestId('line-merge-candidates')).toBeNull();
    expect(list).not.toHaveBeenCalled();
  });
});
