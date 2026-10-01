import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from 'react';
import {
  CHANNEL_LABEL,
  messagingApi,
  messagingKeys,
  useTemplates,
  type Channel,
} from '../../../api/messaging';
import type { DraftPurpose } from '../../../api/ai';
import { Button, Field, Select, Textarea, useToast } from '../../../components/ui';
import { isApiError, newIdempotencyKey } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { useDebounced } from '../../../lib/hooks';
import { AiDraftDialog } from './AiDraftDialog';

export interface ComposerHandle {
  setText: (text: string) => void;
  openAiDraft: (purpose?: DraftPurpose) => void;
}

/**
 * 1:1 message composer: free text or a template (inserted as editable text — variables are rendered
 * per customer at delivery), live preview, channel choice, and the AI draft entry point.
 */
export const Composer = forwardRef<
  ComposerHandle,
  { customerId: string; customerName?: string; disabled?: boolean; disabledReason?: string }
>(function Composer({ customerId, customerName, disabled, disabledReason }, ref) {
  const { can, currentShopId } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [text, setText] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [channel, setChannel] = useState<'' | Channel>('');
  const [showPreview, setShowPreview] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiPurpose, setAiPurpose] = useState<DraftPurpose>('followup');
  const keyRef = useRef<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const templates = useTemplates({ status: 'active' }, can('message.send'));
  const lineTemplates = useMemo(
    () => (templates.data ?? []).filter((t) => t.channel === 'line' && t.category !== 'transactional'),
    [templates.data],
  );
  const selected = lineTemplates.find((t) => t.id === templateId);

  useImperativeHandle(ref, () => ({
    setText: (t: string) => {
      setText(t);
      setTemplateId('');
      textareaRef.current?.focus();
    },
    openAiDraft: (p?: DraftPurpose) => {
      if (p) setAiPurpose(p);
      setAiOpen(true);
    },
  }));

  const previewBody = useDebounced(text, 400);
  const preview = useQuery({
    queryKey: ['messaging', 'compose-preview', customerId, previewBody],
    queryFn: () => messagingApi.previewTemplate({ body: previewBody, customerId, shopId: currentShopId ?? undefined }),
    enabled: showPreview && !!previewBody.trim(),
  });

  const send = useMutation({
    mutationFn: () => {
      keyRef.current ??= newIdempotencyKey();
      const asTemplate = selected && text === selected.body;
      return messagingApi.send(
        {
          customerId,
          ...(asTemplate ? { templateId: selected.id } : { body: text.trim() }),
          ...(channel ? { channel } : {}),
          shopId: currentShopId,
        },
        keyRef.current,
      );
    },
    onSuccess: () => {
      keyRef.current = null;
      setText('');
      setTemplateId('');
      setShowPreview(false);
      void qc.invalidateQueries({ queryKey: messagingKeys.conversation(customerId) });
      void qc.invalidateQueries({ queryKey: ['messaging', 'inbox'] });
      toast.success('メッセージを送信キューに追加しました');
    },
    onError: (e) => {
      // keep the key only for network failures (safe resend); the server answered otherwise
      if (!(isApiError(e) && e.status === 0)) keyRef.current = null;
      toast.error(e);
    },
  });

  if (!can('message.send')) {
    return <p className="border-t border-border px-4 py-3 text-[13px] text-muted">メッセージを送信する権限がありません。</p>;
  }

  return (
    <form
      className="space-y-2 border-t border-border bg-surface px-4 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim() && !disabled) send.mutate();
      }}
    >
      {disabled && disabledReason ? <p className="text-xs text-warning">{disabledReason}</p> : null}
      <div className="flex flex-wrap items-end gap-2">
        <Field label="テンプレート" className="min-w-40 flex-1">
          <Select
            selectSize="sm"
            value={templateId}
            onChange={(e) => {
              const t = lineTemplates.find((x) => x.id === e.target.value);
              setTemplateId(e.target.value);
              if (t) setText(t.body);
            }}
            disabled={disabled}
          >
            <option value="">（テンプレートを挿入）</option>
            {lineTemplates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="送信チャネル" className="w-36">
          <Select selectSize="sm" value={channel} onChange={(e) => setChannel(e.target.value as '' | Channel)} disabled={disabled}>
            <option value="">自動</option>
            {(Object.keys(CHANNEL_LABEL) as Channel[]).map((c) => (
              <option key={c} value={c}>
                {CHANNEL_LABEL[c]}
              </option>
            ))}
          </Select>
        </Field>
        {can('ai.use') ? (
          <Button size="sm" variant="soft" icon="sparkle" onClick={() => setAiOpen(true)} disabled={disabled}>
            AI下書き
          </Button>
        ) : null}
      </div>
      <Field label="メッセージ本文" labelHidden>
        <Textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          maxLength={5000}
          placeholder="メッセージを入力（{{customer.name}} などの変数は送信時に置き換わります）"
          disabled={disabled}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim() && !disabled) {
              e.preventDefault();
              send.mutate();
            }
          }}
        />
      </Field>
      {showPreview && text.trim() ? (
        <div className="rounded-lg border border-dashed border-border bg-surface-2 px-3 py-2 text-[13px]">
          <p className="mb-1 text-xs font-medium text-muted">プレビュー（このお客様の情報で表示）</p>
          <p className="whitespace-pre-wrap text-fg">{preview.data?.body ?? (preview.isFetching ? '…' : '')}</p>
          {preview.data?.unknownVariables.length ? (
            <p className="mt-1 text-xs text-warning">不明な変数: {preview.data.unknownVariables.join(', ')}</p>
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          className="text-xs font-medium text-primary hover:underline disabled:opacity-50"
          onClick={() => setShowPreview((v) => !v)}
          disabled={!text.trim()}
          aria-pressed={showPreview}
        >
          {showPreview ? 'プレビューを閉じる' : 'プレビュー'}
        </button>
        <div className="flex items-center gap-2">
          <span className="hidden text-xs text-subtle sm:inline">Ctrl/⌘ + Enter で送信</span>
          <Button type="submit" variant="primary" icon="send" loading={send.isPending} disabled={!text.trim() || disabled}>
            送信
          </Button>
        </div>
      </div>
      {aiOpen ? (
        <AiDraftDialog
          open={aiOpen}
          onClose={() => setAiOpen(false)}
          customerId={customerId}
          customerName={customerName}
          initialPurpose={aiPurpose}
          onAccept={(t) => {
            setText(t);
            setTemplateId('');
          }}
        />
      ) : null}
    </form>
  );
});
