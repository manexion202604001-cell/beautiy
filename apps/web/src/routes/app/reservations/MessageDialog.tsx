import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageCircle, Send } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { messagingApi, messagingKeys } from '../../../api/messaging';
import { Badge, Button, Checkbox, Dialog, DialogTitle, Input } from '../../../components/shad';
import { useToast } from '../../../components/ui';
import { errorMessage } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { cx } from '../../../lib/cn';
import { zonedParts } from '../../../lib/time';

/**
 * 「◯◯さんとのメッセージ」: the thread with one customer and a one-line composer.
 * Opened from the dashboard's reservation dialog and from the reservation detail.
 */
export function MessageDialog({
  open,
  onOpenChange,
  customerId,
  customerName,
  shopId,
  checkboxId,
  threadClassName = 'min-h-[200px]',
  composerClassName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customerId: string | null;
  customerName: string;
  shopId: string | null;
  checkboxId: string;
  /** minimum height of the thread area (differs between the two places it is used) */
  threadClassName?: string;
  composerClassName?: string;
}) {
  const { timezone: tz } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [draft, setDraft] = useState('');
  const [sendToLine, setSendToLine] = useState(true);
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // each time the dialog opens: empty box, LINE option off
  useEffect(() => {
    if (open) {
      setDraft('');
      setSendToLine(false);
    }
  }, [open]);

  const convoQ = useQuery({
    queryKey: [...messagingKeys.conversation(customerId ?? ''), 'dialog'],
    queryFn: () => messagingApi.conversation({ customerId: customerId!, limit: 50 }),
    enabled: open && !!customerId,
  });
  const messages = useMemo(() => [...(convoQ.data?.items ?? [])].reverse(), [convoQ.data]);
  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, open]);
  useEffect(() => {
    if (!open) return;
    const unread = messages.find((m) => m.direction === 'inbound' && m.status === 'received');
    if (unread) void messagingApi.markRead(unread.id).then(() => qc.invalidateQueries({ queryKey: messagingKeys.all }));
  }, [messages, open, qc]);

  const send = async () => {
    if (!draft.trim() || !customerId || sending) return;
    setSending(true);
    try {
      // ticked: sent through the official LINE account; unticked: recorded on the thread only
      await messagingApi.send(
        sendToLine
          ? { customerId, body: draft, shopId, channel: 'line' }
          : { customerId, body: draft, shopId, deliver: false },
      );
      setDraft('');
      setSendToLine(false);
      void qc.invalidateQueries({ queryKey: messagingKeys.conversation(customerId) });
    } catch (e) {
      toast.error('メッセージの送信に失敗しました', errorMessage(e));
    } finally {
      setSending(false);
    }
  };

  const timeOf = (iso: string) => zonedParts(iso, tz).time;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      className="flex max-h-[80vh] max-w-md flex-col"
      title={
        <DialogTitle className="flex items-center gap-2">
          <MessageCircle className="h-5 w-5" />
          {customerName}さんとのメッセージ
        </DialogTitle>
      }
    >
      <div className={cx('max-h-[400px] flex-1 overflow-auto rounded-lg border bg-muted/30 p-2', threadClassName)}>
        {convoQ.isLoading ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">読み込み中...</div>
        ) : messages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            メッセージがありません
          </div>
        ) : (
          <div className="sy-3">
            {messages.map((m) => {
              const out = m.direction === 'outbound';
              return (
                <div key={m.id} className={cx('flex', out ? 'justify-end' : 'justify-start')}>
                  <div
                    className={cx(
                      'max-w-[80%] rounded-lg px-3 py-2',
                      out ? 'bg-primary text-primary-foreground' : 'border bg-white',
                    )}
                  >
                    <p className="whitespace-pre-wrap text-sm">{m.body}</p>
                    <div
                      className={cx(
                        'mt-1 flex items-center gap-1 text-xs',
                        out ? 'text-primary-foreground/70' : 'text-muted-foreground',
                      )}
                    >
                      {timeOf(m.sent_at ?? m.created_at)}
                      {out && m.sent_by_staff_name ? <span className="ml-1">{m.sent_by_staff_name}</span> : null}
                      {m.channel === 'line' ? (
                        <Badge variant="outline" className="ml-1 h-4 px-1 text-xs">
                          LINE
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })}
            <div ref={bottomRef} />
          </div>
        )}
      </div>
      <div className={cx('pt-2 sy-3', composerClassName)}>
        <div className="flex items-center gap-2">
          <Input
            placeholder="メッセージを入力..."
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
              e.preventDefault();
              void send();
            }}
            className="flex-1"
          />
          <Button onClick={() => void send()} disabled={!draft.trim() || sending} size="icon" aria-label="送信">
            <Send className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex items-center sx-2">
          <Checkbox id={checkboxId} checked={sendToLine} onCheckedChange={setSendToLine} />
          <label htmlFor={checkboxId} className="cursor-pointer text-sm text-muted-foreground">
            公式LINEからも送信する
          </label>
        </div>
      </div>
    </Dialog>
  );
}
