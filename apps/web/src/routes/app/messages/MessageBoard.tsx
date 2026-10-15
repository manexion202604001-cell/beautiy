import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Send } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type UIEvent } from 'react';
import { Navigate, useSearchParams } from 'react-router';
import {
  CHANNEL_LABEL,
  messagingApi,
  messagingKeys,
  useConversation,
  type InboxItem,
  type Message,
} from '../../../api/messaging';
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Separator,
} from '../../../components/shad';
import { useToast } from '../../../components/ui';
import { errorMessage } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { cx } from '../../../lib/cn';
import { useDebounced } from '../../../lib/hooks';

const PAGE_SIZE = 100;

/** Body shown for a message without text (stickers / images from LINE, templates rendered at delivery) */
function contentOf(m: Pick<Message, 'body' | 'message_type' | 'direction'>): string {
  if (m.body) return m.body;
  if (m.message_type === 'sticker') return '［スタンプ］';
  if (m.message_type === 'image') return '［画像］';
  if (m.message_type !== 'text') return `［${m.message_type}］`;
  return m.direction === 'outbound' ? '（本文は送信時に作成されます）' : '（本文なし）';
}

/** Notifications the system sent on its own (booking confirmed, reminders, campaigns) are shown as centred cards */
const isSystemMessage = (m: Message) => m.direction === 'outbound' && m.category !== 'conversation';

/** メッセージ: conversation list (unread counts, 自分宛のみ, name search) + thread + one-line composer */
export default function MessageBoard() {
  const { can, currentShopId, timezone: tz } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('customer');
  const [search, setSearch] = useState('');
  const [mineOnly, setMineOnly] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const term = useDebounced(search.trim(), 300);
  const canRead = can('message.read');
  const canSend = can('message.send');

  const select = (customerId: string | null) => {
    if (customerId !== selectedId) setDraft('');
    const next = new URLSearchParams(params);
    if (customerId) next.set('customer', customerId);
    else next.delete('customer');
    setParams(next);
  };

  // switching the shop closes the open conversation (it belongs to the other shop's list)
  const shopRef = useRef(currentShopId);
  useEffect(() => {
    if (shopRef.current === currentShopId) return;
    shopRef.current = currentShopId;
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('customer');
      return next;
    });
  }, [currentShopId, setParams]);

  // ---------------------------------------------------------------- conversations
  const listQuery = { shopId: currentShopId ?? undefined, mine: mineOnly || undefined, q: term || undefined };
  const inbox = useInfiniteQuery({
    queryKey: messagingKeys.inbox({ ...listQuery, board: true }),
    queryFn: ({ pageParam }) => messagingApi.inbox({ ...listQuery, cursor: pageParam, limit: PAGE_SIZE }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: canRead,
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });
  const conversations: InboxItem[] = useMemo(() => inbox.data?.pages.flatMap((p) => p.items) ?? [], [inbox.data]);
  const selectedRow = selectedId ? conversations.find((c) => c.customer_id === selectedId) : undefined;
  const onListScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 200 && inbox.hasNextPage && !inbox.isFetchingNextPage) {
      void inbox.fetchNextPage();
    }
  };

  // ---------------------------------------------------------------- open conversation
  const threadQ = useQuery({
    queryKey: messagingKeys.thread({ customerId: selectedId, shopId: currentShopId }),
    queryFn: () => messagingApi.thread({ customerId: selectedId!, shopId: currentShopId ?? undefined }),
    enabled: canRead && !!selectedId,
  });
  const convo = useConversation(canRead ? selectedId : null);
  const messages = useMemo(() => [...(convo.data?.pages.flatMap((p) => p.items) ?? [])].reverse(), [convo.data]);
  const customer = threadQ.data?.customer;
  const line = threadQ.data?.line ?? null;
  const customerName = customer?.name || selectedRow?.customer_name || '';
  const staffName = selectedRow?.customer_staff_name ?? customer?.staff_name ?? null;

  const lastId = messages[messages.length - 1]?.id;
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lastId]);

  // opening a conversation (or receiving while it is open) marks its messages as read
  const newestUnread = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.direction === 'inbound' && m.status === 'received') return m.id;
    }
    return null;
  }, [messages]);
  const hasUnread = !!newestUnread || (selectedRow?.unread_count ?? 0) > 0;
  useEffect(() => {
    if (!selectedId || !hasUnread) return;
    let cancelled = false;
    messagingApi
      .readThread(selectedId)
      .then(() => {
        if (cancelled) return;
        void qc.invalidateQueries({ queryKey: ['messaging', 'inbox'] });
        void qc.invalidateQueries({ queryKey: ['messaging', 'unread-count'] });
        void qc.invalidateQueries({ queryKey: messagingKeys.conversation(selectedId) });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [selectedId, hasUnread, newestUnread, qc]);

  const send = async () => {
    if (!draft.trim() || !selectedId || sending || !canSend) return;
    setSending(true);
    try {
      // LINE when the customer can receive it; otherwise the message is only recorded on the thread
      await messagingApi.send(
        line?.deliverable
          ? { customerId: selectedId, body: draft, shopId: currentShopId, channel: 'line' }
          : { customerId: selectedId, body: draft, shopId: currentShopId, deliver: false },
      );
      setDraft('');
      void qc.invalidateQueries({ queryKey: messagingKeys.conversation(selectedId) });
      void qc.invalidateQueries({ queryKey: ['messaging', 'inbox'] });
    } catch (e) {
      toast.error('メッセージの送信に失敗しました', errorMessage(e));
    } finally {
      setSending(false);
    }
  };

  const retry = async (id: string) => {
    try {
      await messagingApi.retry(id);
      if (selectedId) void qc.invalidateQueries({ queryKey: messagingKeys.conversation(selectedId) });
    } catch (e) {
      toast.error('メッセージの再送に失敗しました', errorMessage(e));
    }
  };

  const dateTime = (iso: string) =>
    new Date(iso).toLocaleString('ja-JP', {
      timeZone: tz,
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  const timeOf = (iso: string) =>
    new Date(iso).toLocaleTimeString('ja-JP', { timeZone: tz, hour: '2-digit', minute: '2-digit' });

  // AI drafts live on the previous screen: links that ask for one are passed on
  if (params.get('draft')) return <Navigate to={`/app/messages-classic?${params.toString()}`} replace />;

  if (!canRead) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">メッセージを閲覧する権限がありません</div>
      </div>
    );
  }
  if (inbox.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">読み込み中...</div>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-8rem)] flex-col md:h-[calc(100vh-10rem)]">
      <h1 className="mb-4 text-xl font-bold md:hidden md:text-2xl">
        {selectedId ? (
          <button type="button" onClick={() => select(null)} className="flex items-center gap-2">
            <ArrowLeft className="h-5 w-5" />
            {customerName || 'メッセージ'}
          </button>
        ) : (
          'メッセージ'
        )}
      </h1>
      <h1 className="mb-4 hidden text-2xl font-bold md:block">メッセージ</h1>

      <div className="flex min-h-0 flex-1 gap-4">
        <Card className={cx('flex min-h-0 flex-col', selectedId ? 'hidden md:flex' : 'flex', 'w-full md:w-80 lg:w-96')}>
          <CardHeader className="flex-shrink-0 pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base md:text-lg">会話一覧</CardTitle>
              <Button
                variant={mineOnly ? 'default' : 'outline'}
                size="sm"
                aria-pressed={mineOnly}
                onClick={() => setMineOnly(!mineOnly)}
                className="h-7 text-xs"
              >
                自分宛のみ
              </Button>
            </div>
          </CardHeader>
          <CardContent className="flex-1 overflow-auto p-0" onScroll={onListScroll}>
            <div className="border-b p-2">
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="顧客名で検索..."
                className="w-full min-w-0 max-w-full appearance-none rounded-md border bg-background px-3 py-1.5 text-sm"
              />
            </div>
            {inbox.isError ? (
              <div className="p-4 text-center text-muted-foreground">
                会話一覧を読み込めませんでした
                <div className="mt-2">
                  <Button variant="outline" size="sm" onClick={() => void inbox.refetch()}>
                    再読み込み
                  </Button>
                </div>
              </div>
            ) : conversations.length === 0 && !term ? (
              <div className="p-4 text-center text-muted-foreground">メッセージがありません</div>
            ) : (
              <div role="complementary" aria-label="受信箱">
                {conversations.map((c) => (
                  <button
                    key={c.customer_id}
                    type="button"
                    data-thread={c.customer_id}
                    onClick={() => select(c.customer_id)}
                    className={cx(
                      'flex w-full items-start gap-3 border-b p-3 text-left transition-colors hover:bg-accent md:p-4',
                      c.customer_id === selectedId && 'bg-accent',
                    )}
                  >
                    <Avatar name={c.customer_name} src={c.customer_avatar} className="h-10 w-10 flex-shrink-0" />
                    <div className="min-w-0 flex-1 overflow-hidden">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate font-medium">{c.customer_name}</span>
                          {c.customer_staff_name ? (
                            <Badge variant="secondary" className="flex-shrink-0 text-xs">
                              {c.customer_staff_name}
                            </Badge>
                          ) : null}
                        </div>
                        {c.unread_count > 0 ? (
                          <Badge variant="destructive" className="flex-shrink-0" aria-label={`未読${c.unread_count}件`}>
                            {c.unread_count}
                          </Badge>
                        ) : null}
                      </div>
                      <div className="truncate text-sm text-muted-foreground">
                        {c.direction === 'outbound' && 'あなた: '}
                        {contentOf(c) || 'メッセージなし'}
                      </div>
                      {c.created_at ? <div className="text-xs text-muted-foreground">{dateTime(c.created_at)}</div> : null}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className={cx('flex min-h-0 flex-1 flex-col', selectedId ? 'flex' : 'hidden md:flex')}>
          {selectedId ? (
            <>
              <CardHeader className="flex-shrink-0 border-b py-3">
                <div className="flex items-center gap-3">
                  <button type="button" onClick={() => select(null)} className="md:hidden" aria-label="会話一覧に戻る">
                    <ArrowLeft className="h-5 w-5" />
                  </button>
                  <Avatar name={customerName} src={line?.picture_url ?? selectedRow?.customer_avatar} className="h-10 w-10" />
                  <div className="min-w-0">
                    <CardTitle className="truncate text-base md:text-lg">{customerName}</CardTitle>
                    <div className="flex items-center gap-2">
                      {line ? (
                        <p className="truncate text-xs text-muted-foreground md:text-sm">LINE: {line.display_name}</p>
                      ) : null}
                      {staffName ? (
                        <Badge variant="secondary" className="text-xs">
                          最近の担当: {staffName}
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="flex min-h-0 flex-1 flex-col overflow-hidden p-0">
                <section aria-label="メッセージスレッド" className="flex-1 overflow-auto p-3 md:p-4">
                  <div className="sy-3 md:sy-4">
                    {convo.hasNextPage ? (
                      <div className="flex justify-center">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={convo.isFetchingNextPage}
                          onClick={() => void convo.fetchNextPage()}
                        >
                          以前のメッセージを表示
                        </Button>
                      </div>
                    ) : null}
                    {threadQ.isError || convo.isError ? (
                      <div className="flex justify-center">
                        <p className="text-sm text-muted-foreground">メッセージを読み込めませんでした</p>
                      </div>
                    ) : null}
                    {messages.map((m) =>
                      isSystemMessage(m) ? (
                        <div key={m.id} className="flex justify-center" data-testid="message-system">
                          <div className="max-w-[85%] rounded-lg border bg-muted/60 px-4 py-2 text-center">
                            <p className="whitespace-pre-wrap text-xs text-muted-foreground">{contentOf(m)}</p>
                            <p className="mt-1 text-[10px] text-muted-foreground/60">
                              {dateTime(m.sent_at ?? m.created_at)}
                              <DeliveryNote m={m} className="ml-1" />
                            </p>
                          </div>
                        </div>
                      ) : (
                        <div
                          key={m.id}
                          data-testid="message-bubble"
                          className={cx('flex', m.direction === 'outbound' ? 'justify-end' : 'justify-start')}
                        >
                          <div
                            className={cx(
                              'max-w-[85%] rounded-lg px-3 py-2 md:max-w-[70%] md:px-4',
                              m.direction === 'outbound' ? 'bg-primary text-primary-foreground' : 'bg-muted',
                            )}
                          >
                            <p className="whitespace-pre-wrap text-sm md:text-base">{contentOf(m)}</p>
                            <div
                              className={cx(
                                'mt-1 flex flex-wrap items-center gap-1 text-xs',
                                m.direction === 'outbound' ? 'text-primary-foreground/70' : 'text-muted-foreground',
                              )}
                            >
                              {timeOf(m.sent_at ?? m.created_at)}
                              {m.direction === 'outbound' && m.sent_by_staff_name ? (
                                <span className="ml-1">{m.sent_by_staff_name}</span>
                              ) : null}
                              {m.channel === 'line' && !['skipped', 'failed', 'cancelled'].includes(m.status) ? (
                                <Badge variant="outline" className="h-4 px-1 text-xs">
                                  LINE
                                </Badge>
                              ) : null}
                              {(m.channel === 'email' || m.channel === 'sms') &&
                              !['skipped', 'failed', 'cancelled'].includes(m.status) ? (
                                <Badge variant="outline" className="h-4 px-1 text-xs">
                                  {CHANNEL_LABEL[m.channel]}
                                </Badge>
                              ) : null}
                              <DeliveryNote m={m} />
                              {m.status === 'failed' && canSend ? (
                                <button type="button" className="underline" onClick={() => void retry(m.id)}>
                                  再送
                                </button>
                              ) : null}
                            </div>
                          </div>
                        </div>
                      ),
                    )}
                    <div ref={bottomRef} />
                  </div>
                </section>
                <Separator />
                {line?.deliverable ? (
                  <div className="px-3 pt-2 md:px-4">
                    <p className="text-xs text-muted-foreground">LINEで送信されます</p>
                  </div>
                ) : threadQ.data ? (
                  <div className="px-3 pt-2 md:px-4">
                    <p className="text-xs font-medium text-amber-600">⚠️ LINE未連携のため、お客様に通知は届きません</p>
                  </div>
                ) : (
                  <div className="px-3 pt-2 md:px-4">
                    <p className="text-xs text-muted-foreground">&nbsp;</p>
                  </div>
                )}
                <div className="flex flex-shrink-0 items-center gap-2 p-3 md:p-4">
                  <Input
                    placeholder="メッセージを入力..."
                    aria-label="メッセージ本文"
                    value={draft}
                    disabled={!canSend || !threadQ.data}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
                      e.preventDefault();
                      void send();
                    }}
                    className="text-base"
                  />
                  <Button
                    onClick={() => void send()}
                    disabled={!draft.trim() || sending || !canSend || !threadQ.data}
                    size="icon"
                    className="flex-shrink-0"
                    aria-label="送信"
                  >
                    <Send className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </>
          ) : (
            <CardContent className="flex h-full items-center justify-center">
              <div className="text-muted-foreground">会話を選択してください</div>
            </CardContent>
          )}
        </Card>
      </div>
    </div>
  );
}

/** Says so when an outgoing message did not (or not yet) reach the customer */
function DeliveryNote({ m, className }: { m: Message; className?: string }) {
  if (m.direction !== 'outbound') return null;
  const text =
    m.status === 'failed'
      ? '送信失敗'
      : m.status === 'cancelled'
        ? '送信取消'
        : m.status === 'skipped'
          ? m.channel === 'note'
            ? '記録のみ'
            : m.skip_reason === 'no_line_identity'
              ? '未送信（LINE未連携）'
              : m.skip_reason === 'opted_out'
                ? '未送信（配信停止中）'
                : '未送信'
          : m.status === 'queued' || m.status === 'sending'
            ? '送信中'
            : null;
  if (!text) return null;
  return (
    <span className={className} data-testid="message-delivery">
      {text}
    </span>
  );
}
