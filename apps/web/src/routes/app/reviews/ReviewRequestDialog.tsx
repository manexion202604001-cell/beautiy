import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { reviewKeys, reviewsApi } from '../../../api/reviews';
import {
  CustomerPicker,
  type PickedCustomer,
} from '../../../components/appointments/CustomerPicker';
import { CopyLink } from '../../../components/forms/CopyLink';
import { QrCode } from '../../../components/forms/QrCode';
import { Alert, Button, Checkbox, Dialog, useToast } from '../../../components/ui';
import { errorMessage, isApiError, newIdempotencyKey } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { formatDateTime } from '../../../lib/format';
import { useStableKey } from '../../../lib/hooks';

/** Manual review request: issue the single-use link (show URL + QR at the counter) and optionally send it */
export function ReviewRequestDialog({
  customer: initial,
  appointmentId,
  onClose,
}: {
  customer?: PickedCustomer | null;
  appointmentId?: string;
  onClose: () => void;
}) {
  const { currentShopId, timezone: tz } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [customer, setCustomer] = useState<PickedCustomer | null>(initial ?? null);
  const [send, setSend] = useState(false);
  const [result, setResult] = useState<{ url: string; expires_at: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [key, regenerate] = useStableKey(newIdempotencyKey);

  const submit = async () => {
    if (!customer) return setError('お客様を選択してください');
    setBusy(true);
    setError(null);
    try {
      const r = await reviewsApi.createRequest(
        {
          customerId: customer.id,
          shopId: currentShopId ?? undefined,
          ...(appointmentId ? { appointmentId } : {}),
          send,
        },
        key,
      );
      setResult({ url: r.url, expires_at: r.expires_at });
      toast.success(send ? '口コミ依頼を送信しました' : '口コミ依頼のリンクを発行しました');
      void qc.invalidateQueries({ queryKey: reviewKeys.all });
    } catch (e) {
      setError(
        isApiError(e) && e.code === 'REVIEW_REQUEST_EXISTS'
          ? 'この来店には既に口コミ依頼が発行されています。'
          : errorMessage(e),
      );
      if (!isApiError(e) || e.status > 0) regenerate();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="口コミ依頼を作成"
      description="1回限り有効な口コミ投稿リンクを発行します。特典の提供など、口コミを条件とした誘導は行わないでください。"
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
              disabled={!customer}
            >
              {send ? '発行して送信' : 'リンクを発行'}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="space-y-4">
          <CopyLink url={result.url} label="口コミ投稿リンク" />
          {result.expires_at ? (
            <p className="text-xs text-muted">有効期限 {formatDateTime(result.expires_at, tz)}</p>
          ) : null}
          <div className="flex flex-col items-center gap-2">
            <QrCode value={result.url} size={200} label="口コミ投稿リンクのQRコード" />
            <p className="text-xs text-muted">お客様のスマートフォンで読み取ってください</p>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {error ? <Alert tone="danger">{error}</Alert> : null}
          {initial ? (
            <p className="text-sm">
              お客様: <span className="font-medium">{initial.name}</span>
            </p>
          ) : (
            <CustomerPicker value={customer} onChange={setCustomer} />
          )}
          <Checkbox
            label="メッセージで送信する"
            description="オフの場合はリンクとQRコードのみ表示します（店頭で読み取り）"
            checked={send}
            onChange={(e) => setSend(e.target.checked)}
          />
        </div>
      )}
    </Dialog>
  );
}
