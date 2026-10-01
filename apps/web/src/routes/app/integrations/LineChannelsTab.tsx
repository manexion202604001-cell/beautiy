import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { messagingApi, messagingKeys, useLineChannels, type LineChannel, type LineChannelInput } from '../../../api/messaging';
import { copyText } from '../../../components/QrCode';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  InlineLoading,
  Input,
  KeyValue,
  Select,
  Switch,
  useToast,
} from '../../../components/ui';
import { newIdempotencyKey } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { formatDateTime } from '../../../lib/format';

/** S-56 LINE公式アカウント: org- or shop-level channels, masked secrets, credential verification */
export function LineChannelsTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const { shops, timezone: tz } = useAuth();
  const q = useLineChannels();
  const [editing, setEditing] = useState<LineChannel | 'new' | null>(null);
  const [deleting, setDeleting] = useState<LineChannel | null>(null);
  const verify = useMutation({
    mutationFn: (id: string) => messagingApi.verifyLineChannel(id),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: messagingKeys.lineChannels });
      toast.success('LINEの認証情報を確認しました', `Bot User ID: ${r.botUserId}`);
    },
    onError: (e) => toast.error(e),
  });
  const del = useMutation({
    mutationFn: (id: string) => messagingApi.deleteLineChannel(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: messagingKeys.lineChannels });
      setDeleting(null);
      toast.success('LINE公式アカウントの設定を削除しました');
    },
    onError: (e) => toast.error(e),
  });
  const shopName = (id: string | null) => (id ? (shops.find((s) => s.id === id)?.name ?? '店舗') : '法人共通');

  return (
    <div className="space-y-4">
      <Alert tone="info">
        店舗ごとのアカウントがない場合は、法人共通のアカウントが使われます。チャネルシークレットとアクセストークンは暗号化して保存され、末尾4文字のみ表示されます。
      </Alert>
      <div className="flex justify-end">
        <Button variant="primary" icon="plus" onClick={() => setEditing('new')}>
          LINE公式アカウントを登録
        </Button>
      </div>
      {q.isLoading ? <InlineLoading /> : null}
      {q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : null}
      {q.data && !q.data.length ? (
        <EmptyState icon="line" title="LINE公式アカウントが未登録です" description="登録するとLINEでのメッセージ送受信・LINE連携QRが使えるようになります。" />
      ) : null}
      <div className="grid gap-4 lg:grid-cols-2">
        {(q.data ?? []).map((c) => (
          <Card key={c.id} className="space-y-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-[15px] font-semibold">{c.name}</p>
                <p className="text-xs text-muted">{shopName(c.shop_id)}</p>
              </div>
              <Badge tone={c.status === 'active' ? 'success' : 'neutral'} dot>
                {c.status === 'active' ? '有効' : '無効'}
              </Badge>
            </div>
            <KeyValue
              items={[
                { label: 'チャネルID', value: c.channel_id },
                { label: 'ベーシックID', value: c.basic_id ?? '—' },
                { label: 'シークレット', value: <code>{c.channelSecretMasked}</code> },
                { label: 'アクセストークン', value: <code>{c.accessTokenMasked}</code> },
                { label: 'Bot User ID', value: c.bot_user_id ?? '未確認' },
                { label: 'LIFF ID', value: c.liff_id ?? '—' },
                { label: 'Webhook確認', value: c.webhook_verified_at ? formatDateTime(c.webhook_verified_at, tz) : '未受信' },
              ]}
            />
            <div className="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2">
              <code className="min-w-0 flex-1 break-all text-xs">{c.webhookUrl}</code>
              <IconButton
                icon="copy"
                label="Webhook URLをコピー"
                size="sm"
                onClick={() => void copyText(c.webhookUrl).then((ok) => (ok ? toast.success('Webhook URLをコピーしました') : toast.error('コピーできませんでした')))}
              />
            </div>
            <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-3">
              <Button size="sm" icon="check" onClick={() => verify.mutate(c.id)} loading={verify.isPending && verify.variables === c.id}>
                認証情報を確認
              </Button>
              <IconButton icon="edit" label="編集" size="sm" variant="secondary" onClick={() => setEditing(c)} />
              <IconButton icon="trash" label="削除" size="sm" variant="secondary" onClick={() => setDeleting(c)} />
            </div>
          </Card>
        ))}
      </div>
      {editing ? <LineChannelDialog channel={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title="LINE公式アカウントの設定を削除しますか？"
        description="このアカウントでのメッセージ送受信ができなくなります。連携済みのお客様のLINE IDは残ります。"
        tone="danger"
        confirmLabel="削除する"
        loading={del.isPending}
        onConfirm={() => deleting && del.mutate(deleting.id)}
      />
    </div>
  );
}

function LineChannelDialog({ channel, onClose }: { channel: LineChannel | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { shops, me } = useAuth();
  const [form, setForm] = useState({
    shopId: channel?.shop_id ?? (me?.allShops ? '' : (shops[0]?.id ?? '')),
    channelId: channel?.channel_id ?? '',
    name: channel?.name ?? '',
    channelSecret: '',
    accessToken: '',
    basicId: channel?.basic_id ?? '',
    liffId: channel?.liff_id ?? '',
    loginChannelId: channel?.login_channel_id ?? '',
  });
  const [active, setActive] = useState((channel?.status ?? 'active') === 'active');
  const [verify, setVerify] = useState(true);
  const [key] = useState(newIdempotencyKey);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const nn = (v: string) => (v.trim() ? v.trim() : null);

  const save = useMutation({
    mutationFn: () => {
      if (channel) {
        const input: LineChannelInput = {
          name: form.name.trim(),
          basicId: nn(form.basicId),
          liffId: nn(form.liffId),
          loginChannelId: nn(form.loginChannelId),
          status: active ? 'active' : 'disabled',
          ...(form.channelSecret ? { channelSecret: form.channelSecret } : {}),
          ...(form.accessToken ? { accessToken: form.accessToken } : {}),
        };
        return messagingApi.updateLineChannel(channel.id, input);
      }
      return messagingApi.createLineChannel(
        {
          shopId: form.shopId || null,
          channelId: form.channelId.trim(),
          name: form.name.trim(),
          channelSecret: form.channelSecret,
          accessToken: form.accessToken,
          basicId: nn(form.basicId),
          liffId: nn(form.liffId),
          loginChannelId: nn(form.loginChannelId),
          verify,
        },
        key,
      );
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: messagingKeys.lineChannels });
      toast.success(channel ? '設定を更新しました' : 'LINE公式アカウントを登録しました');
      onClose();
    },
    onError: (e) => toast.error(e),
  });

  const secretOk = (v: string) => !v || v.length >= 8;
  const valid =
    form.name.trim() &&
    (channel ? secretOk(form.channelSecret) && secretOk(form.accessToken) : form.channelId.trim() && form.channelSecret.length >= 8 && form.accessToken.length >= 8);

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={channel ? 'LINE公式アカウントを編集' : 'LINE公式アカウントを登録'}
      dismissable={!save.isPending}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={save.isPending}>
            キャンセル
          </Button>
          <Button variant="primary" onClick={() => save.mutate()} loading={save.isPending} disabled={!valid}>
            保存
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="対象" hint={channel ? '作成後は変更できません' : '法人共通の登録には全店舗権限が必要です'}>
          <Select value={form.shopId} onChange={set('shopId')} disabled={!!channel}>
            <option value="">法人共通</option>
            {shops.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="表示名" required>
          <Input value={form.name} onChange={set('name')} maxLength={100} />
        </Field>
        <Field label="チャネルID（Messaging API）" required={!channel} hint={channel ? '変更できません' : undefined}>
          <Input value={form.channelId} onChange={set('channelId')} disabled={!!channel} maxLength={100} />
        </Field>
        <Field label="ベーシックID" optional>
          <Input value={form.basicId} onChange={set('basicId')} placeholder="@xxxx" maxLength={50} />
        </Field>
        <Field
          label="チャネルシークレット"
          required={!channel}
          hint={channel ? `保存済み ${channel.channelSecretMasked}（入力すると置き換え）` : '8文字以上'}
          error={secretOk(form.channelSecret) ? null : '8文字以上で入力してください'}
        >
          <Input type="password" autoComplete="off" value={form.channelSecret} onChange={set('channelSecret')} maxLength={200} />
        </Field>
        <Field
          label="チャネルアクセストークン"
          required={!channel}
          hint={channel ? `保存済み ${channel.accessTokenMasked}（入力すると置き換え）` : '長期トークン'}
          error={secretOk(form.accessToken) ? null : '8文字以上で入力してください'}
        >
          <Input type="password" autoComplete="off" value={form.accessToken} onChange={set('accessToken')} maxLength={1000} />
        </Field>
        <Field label="LIFF ID" optional hint="設定するとLINE連携リンクがLIFFで開きます">
          <Input value={form.liffId} onChange={set('liffId')} maxLength={100} />
        </Field>
        <Field label="LINEログインのチャネルID" optional hint="IDトークン検証に使用">
          <Input value={form.loginChannelId} onChange={set('loginChannelId')} maxLength={100} />
        </Field>
        {channel ? (
          <Switch className="sm:col-span-2" checked={active} onChange={setActive} label="有効" description="無効にすると送受信を停止します。" />
        ) : (
          <Checkbox className="sm:col-span-2" label="登録時にLINEへ接続して認証情報を確認する" checked={verify} onChange={(e) => setVerify(e.target.checked)} />
        )}
      </div>
    </Dialog>
  );
}
