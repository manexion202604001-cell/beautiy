import { useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  aiApi,
  PURPOSE_LABEL,
  TONE_LABEL,
  type DraftPurpose,
  type Suggestion,
  type Tone,
} from '../../../api/ai';
import { Alert, Badge, Button, Dialog, Field, Select, Textarea, useToast } from '../../../components/ui';
import { isApiError } from '../../../lib/api';

/**
 * AI message draft: generate → review/edit → accept (copies the text into the composer) or reject.
 * Accepting NEVER sends anything — delivery is always a separate, explicit staff action.
 */
export function AiDraftDialog({
  open,
  onClose,
  customerId,
  customerName,
  initialPurpose = 'followup',
  onAccept,
}: {
  open: boolean;
  onClose: () => void;
  customerId: string;
  customerName?: string;
  initialPurpose?: DraftPurpose;
  onAccept: (text: string) => void;
}) {
  const toast = useToast();
  const [purpose, setPurpose] = useState<DraftPurpose>(initialPurpose);
  const [tone, setTone] = useState<Tone>('polite');
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [text, setText] = useState('');

  useEffect(() => {
    if (open) {
      setPurpose(initialPurpose);
      setSuggestion(null);
      setText('');
    }
  }, [open, initialPurpose]);

  const generate = useMutation({
    mutationFn: () => aiApi.messageDraft({ customerId, purpose, tone }),
    onSuccess: (s) => {
      setSuggestion(s);
      setText(s.text ?? '');
    },
    onError: (e) =>
      toast.error(
        isApiError(e) && e.code === 'AI_DISABLED' ? 'この法人ではAIアシストが無効です' : e,
      ),
  });
  const accept = useMutation({
    mutationFn: () =>
      aiApi.accept(suggestion!.id, text.trim() !== (suggestion!.text ?? '').trim() ? text.trim() : undefined),
    onSuccess: (r) => {
      onAccept(r.text ?? text);
      toast.success('下書きを作成欄にコピーしました', '内容を確認してから送信してください');
      onClose();
    },
    onError: (e) => toast.error(e),
  });
  const reject = useMutation({
    mutationFn: () => aiApi.reject(suggestion!.id),
    onSuccess: () => {
      toast.info('AI提案を却下しました');
      onClose();
    },
    onError: (e) => toast.error(e),
  });

  const busy = generate.isPending || accept.isPending || reject.isPending;
  const fallback = suggestion?.output?.fallbackReason;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissable={!busy}
      size="lg"
      title="AIでメッセージ下書きを作成"
      description={customerName ? `${customerName} 様へのメッセージ案` : undefined}
      footer={
        suggestion ? (
          <>
            <Button variant="ghost" onClick={() => reject.mutate()} loading={reject.isPending} disabled={busy}>
              却下する
            </Button>
            <Button variant="secondary" icon="refresh" onClick={() => generate.mutate()} disabled={busy}>
              作り直す
            </Button>
            <Button
              variant="primary"
              icon="copy"
              onClick={() => accept.mutate()}
              loading={accept.isPending}
              disabled={busy || !text.trim()}
            >
              採用して作成欄にコピー
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              閉じる
            </Button>
            <Button variant="primary" icon="sparkle" onClick={() => generate.mutate()} loading={generate.isPending}>
              下書きを生成
            </Button>
          </>
        )
      }
    >
      <div className="space-y-4">
        <Alert tone="info">
          AIは提案を作るだけで、メッセージを送信することはありません。採用すると本文が作成欄にコピーされます。
          内容を確認・修正したうえで、担当者が送信してください。
        </Alert>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="目的">
            <Select value={purpose} onChange={(e) => setPurpose(e.target.value as DraftPurpose)} disabled={busy}>
              {(Object.keys(PURPOSE_LABEL) as DraftPurpose[]).map((p) => (
                <option key={p} value={p}>
                  {PURPOSE_LABEL[p]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="トーン">
            <Select value={tone} onChange={(e) => setTone(e.target.value as Tone)} disabled={busy}>
              {(Object.keys(TONE_LABEL) as Tone[]).map((t) => (
                <option key={t} value={t}>
                  {TONE_LABEL[t]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {suggestion ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
              <Badge tone="primary">AI提案</Badge>
              <span>
                {suggestion.provider === 'heuristic' ? 'テンプレート生成' : suggestion.provider}
                {suggestion.model ? `（${suggestion.model}）` : ''}
              </span>
            </div>
            {fallback ? (
              <p className="text-xs text-muted">
                外部AIを利用できなかったため、定型文から作成しました（理由: {fallback}）。
              </p>
            ) : null}
            <Field label="提案された本文（編集できます）">
              <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={8} maxLength={5000} />
            </Field>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
