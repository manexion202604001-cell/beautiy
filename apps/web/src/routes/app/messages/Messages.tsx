import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import type { DraftPurpose } from '../../../api/ai';
import { useCustomer } from '../../../api/customers';
import { CHANNEL_LABEL, useInbox } from '../../../api/messaging';
import { CustomerPicker } from '../../../components/appointments/CustomerPicker';
import { Forbidden } from '../../../components/Forbidden';
import {
  Avatar,
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  InlineLoading,
  LoadMore,
  PageHeader,
  Segmented,
} from '../../../components/ui';
import { useAuth } from '../../../lib/auth';
import { cn } from '../../../lib/cn';
import { formatAgo } from '../../../lib/format';
import type { ComposerHandle } from './Composer';
import { Conversation } from './Conversation';

const PURPOSES: DraftPurpose[] = ['followup', 'dormant', 'birthday', 'review_thanks'];

/** S-50 メッセージ受信箱: latest message per customer, unread badges, thread + composer */
export default function Messages() {
  const { can, currentShopId } = useAuth();
  const [params, setParams] = useSearchParams();
  const selected = params.get('customer');
  const draft = params.get('draft') as DraftPurpose | null;
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const [scope, setScope] = useState<'shop' | 'all'>('shop');
  const [picking, setPicking] = useState(false);
  const inbox = useInbox(
    { unreadOnly: filter === 'unread' || undefined, shopId: scope === 'shop' ? (currentShopId ?? undefined) : undefined },
    can('message.read'),
  );
  const items = inbox.data?.pages.flatMap((p) => p.items) ?? [];
  const selectedItem = items.find((i) => i.customer_id === selected);
  const customer = useCustomer(selected && !selectedItem ? selected : null);
  const selectedName = selectedItem?.customer_name ?? customer.data?.display_name ?? undefined;
  const composerRef = useRef<ComposerHandle>(null);

  // deep link from AI insights: open the AI draft dialog once
  useEffect(() => {
    if (!selected || !draft || !PURPOSES.includes(draft)) return;
    const t = window.setTimeout(() => composerRef.current?.openAiDraft(draft), 50);
    const next = new URLSearchParams(params);
    next.delete('draft');
    setParams(next, { replace: true });
    return () => window.clearTimeout(t);
  }, [selected, draft, params, setParams]);

  const open = (customerId: string | null) => {
    const next = new URLSearchParams(params);
    if (customerId) next.set('customer', customerId);
    else next.delete('customer');
    setParams(next);
  };

  if (!can('message.read')) {
    return <Forbidden permission="message.read" />;
  }

  return (
    <div className="flex h-[calc(100dvh-7.5rem)] min-h-[32rem] flex-col">
      <PageHeader
        title="メッセージ"
        description="お客様ごとの最新メッセージと未読。返信はスレッドから送信します。"
        actions={
          can('message.send') ? (
            <Button variant="primary" icon="plus" onClick={() => setPicking(true)}>
              新しいメッセージ
            </Button>
          ) : null
        }
      />
      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden rounded-2xl border border-border bg-surface shadow-card lg:grid-cols-[22rem_minmax(0,1fr)]">
        <aside
          className={cn('flex min-h-0 flex-col border-border lg:border-r', selected ? 'hidden lg:flex' : 'flex')}
          aria-label="受信箱"
        >
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.5">
            <Segmented
              size="sm"
              label="表示する会話"
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: 'すべて' },
                { value: 'unread', label: '未読' },
              ]}
            />
            <Segmented
              size="sm"
              label="店舗"
              value={scope}
              onChange={setScope}
              options={[
                { value: 'shop', label: 'この店舗' },
                { value: 'all', label: '全店舗' },
              ]}
            />
          </div>
          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
            {inbox.isLoading ? <div className="px-4"><InlineLoading /></div> : null}
            {inbox.error ? <ErrorState className="m-3" error={inbox.error} onRetry={() => void inbox.refetch()} /> : null}
            {!inbox.isLoading && !inbox.error && !items.length ? (
              <EmptyState
                className="m-3"
                icon="message"
                title={filter === 'unread' ? '未読のメッセージはありません' : 'メッセージはまだありません'}
                description="LINEで受信したメッセージや個別に送信したメッセージがここに表示されます。"
              />
            ) : null}
            <ul className="divide-y divide-border">
              {items.map((it) => (
                <li key={it.customer_id}>
                  <button
                    type="button"
                    onClick={() => open(it.customer_id)}
                    aria-current={selected === it.customer_id ? 'true' : undefined}
                    className={cn(
                      'flex w-full items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-surface-2',
                      selected === it.customer_id && 'bg-primary-soft/60',
                    )}
                  >
                    <Avatar name={it.customer_name} size={36} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className={cn('min-w-0 flex-1 truncate text-sm', it.unread_count ? 'font-semibold' : 'font-medium')}>
                          {it.customer_name || '（氏名未登録）'}
                        </p>
                        <span className="shrink-0 text-[11px] text-subtle">{formatAgo(it.created_at)}</span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-2">
                        <p className="min-w-0 flex-1 truncate text-xs text-muted">
                          {it.direction === 'outbound' ? 'あなた: ' : ''}
                          {it.body ?? `［${it.message_type}］`}
                        </p>
                        {it.unread_count ? (
                          <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-fg" aria-label={`未読${it.unread_count}件`}>
                            {it.unread_count}
                          </span>
                        ) : (
                          <Badge size="sm" tone="outline">
                            {CHANNEL_LABEL[it.channel] ?? it.channel}
                          </Badge>
                        )}
                      </div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
            <LoadMore hasMore={!!inbox.hasNextPage} loading={inbox.isFetchingNextPage} onClick={() => void inbox.fetchNextPage()} />
          </div>
        </aside>
        <div className={cn('min-h-0 min-w-0', selected ? 'flex' : 'hidden lg:flex')}>
          {selected ? (
            <Conversation
              key={selected}
              ref={composerRef}
              customerId={selected}
              customerName={selectedName}
              onBack={() => open(null)}
              className="w-full"
            />
          ) : (
            <div className="flex w-full items-center justify-center p-6">
              <EmptyState icon="message" title="会話を選択してください" description="左の受信箱からお客様を選ぶと、スレッドが表示されます。" />
            </div>
          )}
        </div>
      </div>
      <Dialog open={picking} onClose={() => setPicking(false)} title="新しいメッセージ" description="送信するお客様を選択してください。">
        <CustomerPicker
          value={null}
          onChange={(c) => {
            if (c) {
              setPicking(false);
              open(c.id);
            }
          }}
        />
      </Dialog>
    </div>
  );
}
