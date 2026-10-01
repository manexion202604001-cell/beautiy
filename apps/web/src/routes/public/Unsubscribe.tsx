import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { CHANNEL_LABEL, publicMessagingApi } from '../../api/messaging';
import { Alert, Button, Card, Icon, InlineLoading } from '../../components/ui';
import { errorMessage } from '../../lib/api';
import { PublicShell } from './PublicShell';

/** /unsubscribe?token= — e-mail footer link: confirm, then stop marketing on this channel or entirely */
export default function Unsubscribe() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [scope, setScope] = useState<'channel' | 'all'>('channel');
  const info = useQuery({
    queryKey: ['public', 'unsubscribe', token],
    queryFn: () => publicMessagingApi.unsubscribeInfo(token),
    enabled: token.length >= 10,
    retry: false,
  });
  const submit = useMutation({ mutationFn: () => publicMessagingApi.unsubscribe(token, scope) });

  return (
    <PublicShell>
      <Card className="mt-6">
        <div className="mb-4 flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-primary-soft text-primary">
            <Icon name="mail" size={20} />
          </span>
          <h1 className="text-lg font-semibold">配信停止の手続き</h1>
        </div>
        {token.length < 10 ? (
          <Alert tone="danger" title="リンクが正しくありません">
            お手数ですが、メールに記載されたリンクをもう一度開いてください。
          </Alert>
        ) : info.isLoading ? (
          <InlineLoading />
        ) : info.error ? (
          <Alert tone="danger" title="リンクが無効か、有効期限が切れています">
            {errorMessage(info.error)}
          </Alert>
        ) : submit.isSuccess ? (
          <div className="space-y-2" role="status">
            <Alert tone="success" title="配信を停止しました">
              {submit.data.scope === 'all'
                ? 'すべてのお知らせ・キャンペーンの配信を停止しました。'
                : `${CHANNEL_LABEL[submit.data.channel]}でのお知らせ・キャンペーンの配信を停止しました。`}
            </Alert>
            <p className="text-[13px] text-muted">ご予約の確認やリマインドなど、大切なお知らせは引き続きお送りします。</p>
          </div>
        ) : info.data ? (
          <div className="space-y-4">
            <p className="text-sm">
              {info.data.email ? `${info.data.email} 宛ての` : ''}
              お知らせ・キャンペーンの配信を停止します。
            </p>
            {!info.data.marketingAllowed && !info.data.marketingOptIn ? (
              <Alert tone="info">すでに配信は停止されています。</Alert>
            ) : null}
            <fieldset className="space-y-2">
              <legend className="sr-only">停止する範囲</legend>
              {(
                [
                  ['channel', `${CHANNEL_LABEL[info.data.channel]}での配信のみ停止する`],
                  ['all', 'すべての配信（LINE・メール・SMS）を停止する'],
                ] as const
              ).map(([v, label]) => (
                <label key={v} className="flex cursor-pointer items-center gap-3 rounded-xl border border-border p-3 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary-soft/40">
                  <input type="radio" name="scope" className="accent-[var(--primary)]" checked={scope === v} onChange={() => setScope(v)} />
                  {label}
                </label>
              ))}
            </fieldset>
            {submit.error ? <Alert tone="danger">{errorMessage(submit.error)}</Alert> : null}
            <Button variant="primary" size="lg" className="w-full" onClick={() => submit.mutate()} loading={submit.isPending}>
              配信を停止する
            </Button>
            <p className="text-xs text-muted">ご予約の確認・リマインドは停止されません。配信はマイページからいつでも再開できます。</p>
          </div>
        ) : null}
      </Card>
    </PublicShell>
  );
}
