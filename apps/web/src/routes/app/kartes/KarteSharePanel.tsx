import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { karteKeys, kartesApi, type KarteDetail } from '../../../api/kartes';
import { CopyLink } from '../../../components/forms/CopyLink';
import { QrCode } from '../../../components/forms/QrCode';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  Checkbox,
  ConfirmDialog,
  Dialog,
  Field,
  Select,
  useToast,
} from '../../../components/ui';
import { errorMessage } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { formatDateTime } from '../../../lib/format';

/** Share the karte (photos / homecare / visible fields) with the customer via a signed link */
export function KarteSharePanel({ karte, writable }: { karte: KarteDetail; writable: boolean }) {
  const { timezone: tz } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const sharedCount = karte.assets.filter((a) => a.share_with_customer).length;

  const revoke = async () => {
    try {
      await kartesApi.unshare(karte.id);
      setLink(null);
      toast.success('共有を取り消しました', 'リンクは無効になりました');
      void qc.invalidateQueries({ queryKey: karteKeys.detail(karte.id) });
    } catch (e) {
      toast.error(e);
    } finally {
      setRevoking(false);
    }
  };

  return (
    <Card>
      <CardHeader
        title="お客様への共有"
        actions={
          karte.shared_with_customer ? (
            <Badge tone="success" dot>
              共有中
            </Badge>
          ) : (
            <Badge>未共有</Badge>
          )
        }
      />
      <p className="mb-3 text-[13px] text-muted">
        共有される内容: 写真 {sharedCount}
        枚・ホームケア・「共有」項目（スタッフメモと薬剤は共有されません）
      </p>
      {karte.shared_at ? (
        <p className="mb-3 text-xs text-subtle">最終共有 {formatDateTime(karte.shared_at, tz)}</p>
      ) : null}
      {link ? (
        <div className="mb-3 space-y-3">
          <CopyLink url={link.url} label="共有リンク" />
          <p className="text-xs text-muted">有効期限 {formatDateTime(link.expiresAt, tz)}</p>
          <div className="flex justify-center">
            <QrCode value={link.url} label="共有リンクのQRコード" />
          </div>
        </div>
      ) : null}
      {writable ? (
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" size="sm" icon="send" onClick={() => setOpen(true)}>
            {karte.shared_with_customer ? 'リンクを再発行' : '共有する'}
          </Button>
          {karte.shared_with_customer ? (
            <Button
              variant="ghost"
              size="sm"
              className="!text-danger"
              onClick={() => setRevoking(true)}
            >
              共有を取り消す
            </Button>
          ) : null}
        </div>
      ) : null}
      {open ? (
        <ShareDialog
          karte={karte}
          onClose={() => setOpen(false)}
          onShared={(r) => {
            setLink(r);
            setOpen(false);
            void qc.invalidateQueries({ queryKey: karteKeys.detail(karte.id) });
          }}
        />
      ) : null}
      <ConfirmDialog
        open={revoking}
        onClose={() => setRevoking(false)}
        title="共有を取り消しますか？"
        description="発行済みのリンクはすぐに無効になります。"
        tone="danger"
        confirmLabel="取り消す"
        onConfirm={() => void revoke()}
      />
    </Card>
  );
}

function ShareDialog({
  karte,
  onClose,
  onShared,
}: {
  karte: KarteDetail;
  onClose: () => void;
  onShared: (r: { url: string; expiresAt: string }) => void;
}) {
  const toast = useToast();
  const [days, setDays] = useState('30');
  const [notify, setNotify] = useState(true);
  const [channel, setChannel] = useState<'' | 'line' | 'email' | 'sms'>('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await kartesApi.share(karte.id, {
        expiresInDays: Number(days),
        notify,
        ...(notify && channel ? { channel } : {}),
      });
      toast.success(r.messageId ? '共有リンクを送信しました' : '共有リンクを発行しました');
      onShared({ url: r.url, expiresAt: r.expiresAt });
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
      size="sm"
      title="カルテを共有"
      description={
        karte.shared_with_customer ? '再発行すると以前のリンクは無効になります。' : undefined
      }
      dismissable={!busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            キャンセル
          </Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={() => void submit()}
            data-testid="share-karte-submit"
          >
            共有する
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <Field label="閲覧期限">
          <Select value={days} onChange={(e) => setDays(e.target.value)}>
            {[7, 14, 30, 90, 180, 365].map((d) => (
              <option key={d} value={d}>
                {d}日間
              </option>
            ))}
          </Select>
        </Field>
        <Checkbox
          label="お客様に通知する"
          description="LINE / メール / SMS でリンクを送ります"
          checked={notify}
          onChange={(e) => setNotify(e.target.checked)}
        />
        {notify ? (
          <Field label="送信チャネル" optional>
            <Select value={channel} onChange={(e) => setChannel(e.target.value as typeof channel)}>
              <option value="">自動</option>
              <option value="line">LINE</option>
              <option value="email">メール</option>
              <option value="sms">SMS</option>
            </Select>
          </Field>
        ) : null}
      </div>
    </Dialog>
  );
}
