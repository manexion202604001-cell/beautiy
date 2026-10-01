import { useState } from 'react';
import {
  FORM_KIND_LABEL,
  formsApi,
  useFormTemplates,
  type FormKind,
  type FormLinkResult,
} from '../../../api/forms';
import { CopyLink } from '../../../components/forms/CopyLink';
import { QrCode } from '../../../components/forms/QrCode';
import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  Field,
  Input,
  Select,
  useToast,
} from '../../../components/ui';
import { errorMessage } from '../../../lib/api';
import { formatDateTime } from '../../../lib/format';
import { useAuth } from '../../../lib/auth';

/**
 * Issue a customer link for a form (事前問診・同意書): from an appointment (pre-visit form) or a
 * customer. Optionally sends it by LINE / email / SMS; shows the URL + QR for the counter.
 */
export function SendFormDialog({
  appointmentId,
  customerId,
  defaultKind = 'pre_visit',
  onClose,
}: {
  appointmentId?: string;
  customerId?: string;
  defaultKind?: FormKind;
  onClose: () => void;
}) {
  const { timezone: tz } = useAuth();
  const toast = useToast();
  const templates = useFormTemplates();
  const active = (templates.data ?? []).filter((t) => t.status === 'active');
  const preferred = active.find((t) => t.kind === defaultKind) ?? active[0];
  const [templateId, setTemplateId] = useState('');
  const [notify, setNotify] = useState(false);
  const [channel, setChannel] = useState<'' | 'line' | 'email' | 'sms'>('');
  const [days, setDays] = useState('');
  const [result, setResult] = useState<FormLinkResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const selected = templateId || preferred?.id || '';

  const submit = async () => {
    if (!selected) return setError('フォームを選択してください');
    const input = {
      templateId: selected,
      notify,
      ...(notify && channel ? { channel } : {}),
      ...(days ? { expiresInDays: Number(days) } : {}),
    };
    setBusy(true);
    setError(null);
    try {
      const r = appointmentId
        ? await formsApi.preVisitLink(appointmentId, input)
        : await formsApi.customerLink(customerId!, input);
      setResult(r);
      toast.success(notify ? 'フォームのリンクを送信しました' : 'フォームのリンクを発行しました');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={appointmentId ? '事前問診を送る' : 'フォームを送る'}
      description="お客様のスマートフォンで記入・署名できるリンクを発行します（1回限り有効）。"
      dismissable={!busy}
      footer={
        result ? (
          <Button variant="primary" onClick={onClose}>
            閉じる
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              キャンセル
            </Button>
            <Button
              variant="primary"
              loading={busy}
              onClick={() => void submit()}
              disabled={!selected}
            >
              {notify ? '発行して送信' : 'リンクを発行'}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="space-y-4">
          <Alert tone="success" title="リンクを発行しました">
            有効期限 {formatDateTime(result.expiresAt, tz)}
            {result.messageId ? ' ・ メッセージ送信をキューに登録しました' : ''}
          </Alert>
          <CopyLink url={result.url} label="フォームのリンク" />
          <div className="flex justify-center">
            <QrCode value={result.url} label="フォームのQRコード" />
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {error ? <Alert tone="danger">{error}</Alert> : null}
          <Field label="フォーム" required>
            <Select value={selected} onChange={(e) => setTemplateId(e.target.value)}>
              {!active.length ? <option value="">（公開中のフォームがありません）</option> : null}
              {active.map((t) => (
                <option key={t.id} value={t.id}>
                  【{FORM_KIND_LABEL[t.kind]}】{t.name}（v{t.version}）
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="有効期限（日）"
            hint={appointmentId ? '未指定の場合は予約日の翌日まで' : '未指定の場合は7日間'}
            optional
          >
            <Input
              type="number"
              min={1}
              max={60}
              value={days}
              onChange={(e) => setDays(e.target.value)}
              inputMode="numeric"
            />
          </Field>
          <Checkbox
            label="お客様に送信する"
            description="LINE連携済みならLINE、なければメール/SMSで送信します"
            checked={notify}
            onChange={(e) => setNotify(e.target.checked)}
          />
          {notify ? (
            <Field label="送信チャネル" optional>
              <Select
                value={channel}
                onChange={(e) => setChannel(e.target.value as typeof channel)}
              >
                <option value="">自動（お客様の設定に従う）</option>
                <option value="line">LINE</option>
                <option value="email">メール</option>
                <option value="sms">SMS</option>
              </Select>
            </Field>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}
