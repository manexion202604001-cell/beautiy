import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CHANNEL_LABEL, publicMessagingApi, type Channel, type Preferences } from '../../api/messaging';
import { ErrorState, InlineLoading, Switch, useToast } from '../../components/ui';

const CHANNELS: Channel[] = ['line', 'email', 'sms'];

/** マイページ「通知設定」: per-channel consent wired to GET/PUT /v1/public/me/notification-preferences */
export function NotificationChannels({ token, marketingOptIn }: { token: string; marketingOptIn?: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = ['public', 'notification-preferences', token];
  const q = useQuery({ queryKey: key, queryFn: () => publicMessagingApi.myPreferences(token) });
  const save = useMutation({
    mutationFn: (input: Parameters<typeof publicMessagingApi.updateMyPreferences>[1]) =>
      publicMessagingApi.updateMyPreferences(token, input),
    onSuccess: (p: Preferences) => {
      qc.setQueryData(key, p);
      void qc.invalidateQueries({ queryKey: ['public', 'me', token] });
      toast.success('通知設定を更新しました');
    },
    onError: (e) => toast.error(e),
  });
  if (q.isLoading) return <InlineLoading />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (!q.data) return null;
  // the global opt-in is edited by the parent switch (PATCH /public/me) → prefer the parent's value
  const optIn = marketingOptIn ?? q.data.marketingOptIn;
  return (
    <div className="space-y-4" data-testid="notification-channels">
      <p className="text-[13px] font-medium">通知の受け取り方法</p>
      {CHANNELS.map((ch) => {
        const p = q.data.channels.find((c) => c.channel === ch);
        return (
          <div key={ch} className="space-y-2 rounded-xl border border-border p-3">
            <p className="text-sm font-semibold">{CHANNEL_LABEL[ch]}</p>
            <Switch
              checked={p?.marketingAllowed ?? true}
              onChange={(v) => save.mutate({ channels: [{ channel: ch, marketingAllowed: v }] })}
              disabled={save.isPending || !optIn}
              label="お得な情報・キャンペーン"
              description={!optIn ? '上の「お得な情報を受け取る」がオフのため停止中です' : undefined}
            />
            <Switch
              checked={p?.transactionalAllowed ?? true}
              onChange={(v) => save.mutate({ channels: [{ channel: ch, transactionalAllowed: v }] })}
              disabled={save.isPending}
              label="予約の確認・リマインド"
            />
          </div>
        );
      })}
      <p className="text-xs text-muted">LINEは友だち追加と連携が済んでいる場合に、メール・SMSはご登録の連絡先にお送りします。</p>
    </div>
  );
}
