import { useMutation, useQueryClient } from '@tanstack/react-query';
import { forwardRef, useEffect, useRef } from 'react';
import { Link } from 'react-router';
import {
  CHANNEL_LABEL,
  MESSAGE_STATUS_LABEL,
  SKIP_REASON_LABEL,
  messagingApi,
  messagingKeys,
  useConversation,
  type Message,
} from '../../../api/messaging';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  IconButton,
  InlineLoading,
  useToast,
  type Tone,
} from '../../../components/ui';
import { useAuth } from '../../../lib/auth';
import { cn } from '../../../lib/cn';
import { formatDateTime } from '../../../lib/format';
import { Composer, type ComposerHandle } from './Composer';

const STATUS_TONE: Record<string, Tone> = {
  queued: 'neutral',
  sending: 'info',
  sent: 'success',
  read: 'success',
  failed: 'danger',
  skipped: 'warning',
  cancelled: 'neutral',
  received: 'primary',
};

const CATEGORY_LABEL: Record<string, string> = {
  conversation: '個別',
  marketing: '配信',
  transactional: '通知',
  reminder: 'リマインド',
};

/** Thread with one customer (oldest → newest) + composer */
export const Conversation = forwardRef<
  ComposerHandle,
  { customerId: string; customerName?: string; onBack?: () => void; showCustomerLink?: boolean; className?: string }
>(function Conversation({ customerId, customerName, onBack, showCustomerLink = true, className }, ref) {
  const { can, timezone: tz } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useConversation(customerId);
  const items = [...(q.data?.pages.flatMap((p) => p.items) ?? [])].reverse();
  const unread = items.filter((m) => m.direction === 'inbound' && m.status === 'received');
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastId = items[items.length - 1]?.id;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [lastId]);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: messagingKeys.conversation(customerId) });
    void qc.invalidateQueries({ queryKey: ['messaging', 'inbox'] });
  };
  const markRead = useMutation({
    mutationFn: () => messagingApi.markRead(unread[unread.length - 1]!.id),
    onSuccess: (r) => {
      invalidate();
      toast.success(`${r.updated}件を既読にしました`);
    },
    onError: (e) => toast.error(e),
  });
  const retry = useMutation({
    mutationFn: (id: string) => messagingApi.retry(id),
    onSuccess: () => {
      invalidate();
      toast.success('再送を受け付けました');
    },
    onError: (e) => toast.error(e),
  });

  return (
    <section className={cn('flex min-h-0 min-w-0 flex-col', className)} aria-label="メッセージスレッド">
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        {onBack ? <IconButton icon="chevron-left" label="受信箱に戻る" size="sm" onClick={onBack} className="lg:hidden" /> : null}
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-semibold">{customerName || 'お客様'}</h2>
          {showCustomerLink ? (
            <Link to={`/app/customers/${customerId}`} className="text-xs text-primary hover:underline">
              顧客詳細を開く
            </Link>
          ) : null}
        </div>
        {unread.length ? (
          <Button size="sm" icon="check" onClick={() => markRead.mutate()} loading={markRead.isPending}>
            既読にする（{unread.length}）
          </Button>
        ) : null}
      </header>
      <div className="scrollbar-thin min-h-0 flex-1 space-y-3 overflow-y-auto bg-bg/60 px-4 py-4" aria-live="polite">
        {q.hasNextPage ? (
          <div className="flex justify-center">
            <Button size="xs" variant="ghost" onClick={() => void q.fetchNextPage()} loading={q.isFetchingNextPage}>
              以前のメッセージを表示
            </Button>
          </div>
        ) : null}
        {q.isLoading ? <InlineLoading /> : null}
        {q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : null}
        {!q.isLoading && !q.error && !items.length ? (
          <EmptyState icon="message" title="まだメッセージはありません" description="下の入力欄から最初のメッセージを送信できます。" />
        ) : null}
        {items.map((m) => (
          <Bubble key={m.id} m={m} tz={tz} canRetry={can('message.send')} onRetry={() => retry.mutate(m.id)} retrying={retry.isPending && retry.variables === m.id} />
        ))}
        <div ref={bottomRef} />
      </div>
      <Composer ref={ref} customerId={customerId} customerName={customerName} />
    </section>
  );
});

function Bubble({
  m,
  tz,
  canRetry,
  onRetry,
  retrying,
}: {
  m: Message;
  tz: string;
  canRetry: boolean;
  onRetry: () => void;
  retrying: boolean;
}) {
  const out = m.direction === 'outbound';
  return (
    <div className={cn('flex', out ? 'justify-end' : 'justify-start')} data-testid="message-bubble">
      <div className={cn('max-w-[85%] sm:max-w-[70%]')}>
        <div
          className={cn(
            'whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-sm',
            out ? 'rounded-br-md bg-primary-soft text-fg' : 'rounded-bl-md border border-border bg-surface text-fg',
          )}
        >
          {m.body ||
            (m.message_type !== 'text'
              ? `［${m.message_type === 'sticker' ? 'スタンプ' : m.message_type === 'image' ? '画像' : m.message_type}］`
              : out
                ? '（本文はテンプレートから送信時に作成されます）'
                : '（本文なし）')}
        </div>
        <div className={cn('mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-subtle', out && 'justify-end')}>
          <span className="tabular">{formatDateTime(m.sent_at ?? m.created_at, tz)}</span>
          <span>{CHANNEL_LABEL[m.channel] ?? m.channel}</span>
          {CATEGORY_LABEL[m.category] && m.category !== 'conversation' ? <span>・{CATEGORY_LABEL[m.category]}</span> : null}
          {out && m.sent_by_staff_name ? <span>・{m.sent_by_staff_name}</span> : null}
          <Badge size="sm" tone={STATUS_TONE[m.status] ?? 'neutral'}>
            {MESSAGE_STATUS_LABEL[m.status] ?? m.status}
          </Badge>
          {m.status === 'queued' && m.scheduled_at ? <span>・送信予定 {formatDateTime(m.scheduled_at, tz)}</span> : null}
        </div>
        {m.status === 'skipped' && m.skip_reason ? (
          <p className={cn('mt-0.5 text-[11px] text-warning', out && 'text-right')}>
            {SKIP_REASON_LABEL[m.skip_reason] ?? m.skip_reason}
          </p>
        ) : null}
        {m.status === 'failed' ? (
          <div className={cn('mt-1 flex items-center gap-2 text-[11px] text-danger', out && 'justify-end')}>
            <span className="truncate">{m.error ?? '送信に失敗しました'}</span>
            {canRetry ? (
              <Button size="xs" variant="outline" icon="refresh" onClick={onRetry} loading={retrying}>
                再送
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
