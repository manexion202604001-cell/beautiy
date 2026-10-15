import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { messagingApi, type InboxItem, type Message, type ThreadInfo } from '../../../api/messaging';
import { ToastProvider } from '../../../components/ui';
import MessageBoard from './MessageBoard';

vi.mock('../../../lib/auth', () => ({
  useAuth: () => ({ can: () => true, currentShopId: 'shop-1', timezone: 'Asia/Tokyo' }),
}));

const inboxItem = (over: Partial<InboxItem>): InboxItem => ({
  id: 'm1',
  customer_id: 'c1',
  created_at: '2026-10-13T03:00:00.000Z',
  body: '予約できますか？',
  direction: 'inbound',
  channel: 'line',
  status: 'received',
  message_type: 'text',
  unread_count: 2,
  customer_name: '山田 花子',
  customer_staff_name: '佐藤',
  customer_avatar: null,
  ...over,
});

const message = (over: Partial<Message>): Message => ({
  id: 'm1',
  shop_id: 'shop-1',
  customer_id: 'c1',
  channel: 'line',
  direction: 'inbound',
  category: 'conversation',
  message_type: 'text',
  body: '予約できますか？',
  template_id: null,
  campaign_id: null,
  automation_id: null,
  appointment_id: null,
  status: 'received',
  skip_reason: null,
  error: null,
  attempts: 0,
  scheduled_at: null,
  sent_at: null,
  read_at: null,
  sent_by_staff_id: null,
  sent_by_staff_name: null,
  created_at: '2026-10-13T03:00:00.000Z',
  updated_at: '2026-10-13T03:00:00.000Z',
  ...over,
});

function mount(thread: ThreadInfo, items: InboxItem[], messages: Message[]) {
  vi.spyOn(messagingApi, 'inbox').mockResolvedValue({ items, nextCursor: null });
  vi.spyOn(messagingApi, 'thread').mockResolvedValue(thread);
  vi.spyOn(messagingApi, 'conversation').mockResolvedValue({ items: messages, nextCursor: null });
  vi.spyOn(messagingApi, 'readThread').mockResolvedValue({ ok: true, updated: 2 });
  const send = vi.spyOn(messagingApi, 'send').mockResolvedValue(message({ id: 'sent', direction: 'outbound', status: 'queued' }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/app/messages']}>
          <MessageBoard />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { send };
}

beforeEach(() => {
  vi.restoreAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
});

describe('MessageBoard', () => {
  it('lists conversations, opens a thread, marks it read and sends through LINE', async () => {
    const user = userEvent.setup();
    const { send } = mount(
      { customer: { id: 'c1', name: '山田 花子', status: 'active', staff_name: '佐藤' }, line: { display_name: 'はなこ', picture_url: null, deliverable: true } },
      [inboxItem({}), inboxItem({ id: 'm9', customer_id: 'c2', customer_name: '別 次郎', customer_staff_name: null, unread_count: 0, direction: 'outbound', body: 'ありがとうございました' })],
      [
        message({ id: 'n1', direction: 'outbound', category: 'transactional', status: 'sent', body: 'ご予約を承りました', sent_at: '2026-10-13T01:00:00.000Z' }),
        message({ id: 'o1', direction: 'outbound', status: 'sent', body: 'お待ちしています', sent_by_staff_name: '佐藤', sent_at: '2026-10-13T02:00:00.000Z' }),
        message({}),
      ].reverse(),
    );

    expect(await screen.findByText('会話一覧')).toBeInTheDocument();
    const list = screen.getByRole('complementary', { name: '受信箱' });
    expect(within(list).getByLabelText('未読2件')).toHaveTextContent('2');
    expect(within(list).getByText('佐藤')).toBeInTheDocument();
    expect(within(list).getByText(/あなた: ありがとうございました/)).toBeInTheDocument();
    expect(screen.getByText('会話を選択してください')).toBeInTheDocument();

    await user.click(within(list).getByText('山田 花子'));
    expect(await screen.findByText('LINE: はなこ')).toBeInTheDocument();
    expect(screen.getByText('最近の担当: 佐藤')).toBeInTheDocument();
    expect(await screen.findByText('LINEで送信されます')).toBeInTheDocument();
    await waitFor(() => expect(messagingApi.readThread).toHaveBeenCalledWith('c1'));

    // staff message with the sender's name, the customer's message, and the notification as a centred card
    const bubbles = await screen.findAllByTestId('message-bubble');
    expect(bubbles).toHaveLength(2);
    expect(bubbles[0]).toHaveTextContent('お待ちしています');
    expect(bubbles[0]).toHaveTextContent('佐藤');
    expect(bubbles[0]).toHaveTextContent('LINE');
    expect(screen.getByTestId('message-system')).toHaveTextContent('ご予約を承りました');

    const input = screen.getByPlaceholderText('メッセージを入力...');
    await user.type(input, '14時はいかがですか{Enter}');
    await waitFor(() => expect(send).toHaveBeenCalledWith({ customerId: 'c1', body: '14時はいかがですか', shopId: 'shop-1', channel: 'line' }));
    await waitFor(() => expect(input).toHaveValue(''));
  });

  it('records the message as a note when LINE cannot reach the customer', async () => {
    const user = userEvent.setup();
    const { send } = mount(
      { customer: { id: 'c1', name: '山田 花子', status: 'active', staff_name: null }, line: null },
      [inboxItem({ unread_count: 0, status: 'read', customer_staff_name: null })],
      [message({ id: 'x1', direction: 'outbound', channel: 'note', status: 'skipped', skip_reason: 'note_only', body: '来店メモ' })],
    );
    await user.click(await screen.findByText('山田 花子'));
    expect(await screen.findByText('⚠️ LINE未連携のため、お客様に通知は届きません')).toBeInTheDocument();
    expect(screen.queryByText(/^LINE:/)).not.toBeInTheDocument();
    expect(await screen.findByTestId('message-delivery')).toHaveTextContent('記録のみ');
    expect(messagingApi.readThread).not.toHaveBeenCalled();

    await user.type(screen.getByPlaceholderText('メッセージを入力...'), 'お電話しました');
    await user.click(screen.getByRole('button', { name: '送信' }));
    await waitFor(() => expect(send).toHaveBeenCalledWith({ customerId: 'c1', body: 'お電話しました', shopId: 'shop-1', deliver: false }));
  });

  it('filters by 自分宛のみ and by customer name on the server', async () => {
    const user = userEvent.setup();
    mount({ customer: { id: 'c1', name: '山田 花子', status: 'active', staff_name: null }, line: null }, [inboxItem({})], []);
    await screen.findByText('会話一覧');
    expect(messagingApi.inbox).toHaveBeenLastCalledWith(expect.objectContaining({ shopId: 'shop-1', mine: undefined, q: undefined }));
    await user.click(screen.getByRole('button', { name: '自分宛のみ' }));
    await waitFor(() => expect(messagingApi.inbox).toHaveBeenLastCalledWith(expect.objectContaining({ mine: true })));
    await user.type(screen.getByPlaceholderText('顧客名で検索...'), '山田');
    await waitFor(() => expect(messagingApi.inbox).toHaveBeenLastCalledWith(expect.objectContaining({ mine: true, q: '山田' })));
  });
});
