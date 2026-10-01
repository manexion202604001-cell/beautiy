import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { aiApi, type Suggestion } from '../../../api/ai';
import {
  CHANNEL_LABEL,
  messagingApi,
  messagingKeys,
  type Channel,
  type LineLinkToken,
  type Preferences,
} from '../../../api/messaging';
import { copyText, QrCode } from '../../../components/QrCode';
import {
  Alert,
  Button,
  Card,
  CardHeader,
  Dialog,
  ErrorState,
  Input,
  InlineLoading,
  Switch,
  useToast,
} from '../../../components/ui';
import { isApiError } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { formatDateTime } from '../../../lib/format';
import { Conversation } from './Conversation';

/** 顧客詳細「メッセージ」タブ: thread, channel preferences (opt-out), LINE link QR, AI summary */
export function CustomerMessagesTab({ customerId, customerName }: { customerId: string; customerName?: string }) {
  const { can } = useAuth();
  return (
    <div className="grid gap-5 xl:grid-cols-[1fr_22rem]">
      {can('message.read') ? (
        <Card padded={false} className="flex h-[36rem] min-h-0 flex-col overflow-hidden">
          <Conversation customerId={customerId} customerName={customerName} showCustomerLink={false} className="h-full" />
        </Card>
      ) : (
        <Alert tone="info">メッセージの閲覧には権限（message.read）が必要です。</Alert>
      )}
      <div className="space-y-5">
        <ChannelPreferencesCard customerId={customerId} />
        {can('customer.write') ? <LineLinkCard customerId={customerId} /> : null}
        {can('ai.use') && can('karte.read') ? <AiSummaryCard customerId={customerId} /> : null}
      </div>
    </div>
  );
}

const CHANNELS: Channel[] = ['line', 'email', 'sms'];

export function ChannelPreferencesCard({ customerId }: { customerId: string }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: messagingKeys.preferences(customerId),
    queryFn: () => messagingApi.preferences(customerId),
  });
  const save = useMutation({
    mutationFn: (input: Parameters<typeof messagingApi.updatePreferences>[1]) =>
      messagingApi.updatePreferences(customerId, input),
    onSuccess: (p: Preferences) => {
      qc.setQueryData(messagingKeys.preferences(customerId), p);
      void qc.invalidateQueries({ queryKey: ['customers', 'detail', customerId] });
      toast.success('配信設定を更新しました');
    },
    onError: (e) => toast.error(e),
  });
  const readOnly = !can('customer.write');
  return (
    <Card>
      <CardHeader title="配信設定" description="お客様の同意に基づいて送信可否を管理します。" />
      {q.isLoading ? <InlineLoading /> : null}
      {q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : null}
      {q.data ? (
        <div className="space-y-4">
          <Switch
            checked={q.data.marketingOptIn}
            onChange={(v) => save.mutate({ marketingOptIn: v })}
            disabled={readOnly || save.isPending}
            label="販促メッセージの受け取り（全体）"
            description="オフにすると一括配信・自動配信の対象から外れます。"
          />
          <div className="border-t border-border pt-3">
            <table className="w-full text-[13px]">
              <caption className="sr-only">チャネル別の同意</caption>
              <thead>
                <tr className="text-xs text-muted">
                  <th scope="col" className="py-1 text-left font-medium">チャネル</th>
                  <th scope="col" className="py-1 text-center font-medium">販促</th>
                  <th scope="col" className="py-1 text-center font-medium">予約通知</th>
                </tr>
              </thead>
              <tbody>
                {CHANNELS.map((ch) => {
                  const p = q.data.channels.find((c) => c.channel === ch);
                  return (
                    <tr key={ch} className="border-t border-border">
                      <th scope="row" className="py-2 text-left font-medium">
                        {CHANNEL_LABEL[ch]}
                        {p?.source ? <span className="ml-1 text-[11px] font-normal text-subtle">（{SOURCE_LABEL[p.source] ?? p.source}）</span> : null}
                      </th>
                      <td className="py-2 text-center">
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-[var(--primary)]"
                          aria-label={`${CHANNEL_LABEL[ch]}の販促メッセージ`}
                          checked={p?.marketingAllowed ?? true}
                          disabled={readOnly || save.isPending}
                          onChange={(e) => save.mutate({ channels: [{ channel: ch, marketingAllowed: e.target.checked }] })}
                        />
                      </td>
                      <td className="py-2 text-center">
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-[var(--primary)]"
                          aria-label={`${CHANNEL_LABEL[ch]}の予約通知`}
                          checked={p?.transactionalAllowed ?? true}
                          disabled={readOnly || save.isPending}
                          onChange={(e) => save.mutate({ channels: [{ channel: ch, transactionalAllowed: e.target.checked }] })}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-muted">変更は監査ログに記録されます。</p>
          </div>
        </div>
      ) : null}
    </Card>
  );
}

const SOURCE_LABEL: Record<string, string> = {
  unfollow: 'ブロック',
  follow: '友だち追加',
  customer_request: '本人',
  staff: 'スタッフ',
  unsubscribe_link: '配信停止リンク',
};

export function LineLinkCard({ customerId }: { customerId: string }) {
  const toast = useToast();
  const { currentShopId } = useAuth();
  const [result, setResult] = useState<LineLinkToken | null>(null);
  const issue = useMutation({
    mutationFn: () => messagingApi.lineLinkToken(customerId, { shopId: currentShopId ?? undefined, ttlHours: 72 }),
    onSuccess: setResult,
    onError: (e) =>
      toast.error(
        isApiError(e) && e.code === 'LINE_NOT_CONFIGURED'
          ? 'LINE公式アカウントが未設定です（外部連携 > LINE公式アカウント で登録してください）'
          : e,
      ),
  });
  return (
    <Card>
      <CardHeader
        title="LINE連携"
        description="来店中のお客様にQRコードを読み取ってもらい、LINEアカウントを連携します。"
      />
      <Button icon="line" onClick={() => issue.mutate()} loading={issue.isPending}>
        連携用QRコードを発行
      </Button>
      <Dialog
        open={!!result}
        onClose={() => setResult(null)}
        title="LINE連携用QRコード"
        description="お客様のスマートフォンで読み取ってください。リンクは1回限り有効です。"
        footer={<Button onClick={() => setResult(null)}>閉じる</Button>}
      >
        {result ? (
          <div className="flex flex-col items-center gap-4">
            <QrCode value={result.qrPayload} size={220} label="LINE連携用QRコード" />
            <div className="w-full space-y-1.5">
              <label htmlFor="line-link-url" className="text-[13px] font-medium">
                連携URL
              </label>
              <div className="flex gap-2">
                <Input id="line-link-url" readOnly value={result.url} onFocus={(e) => e.currentTarget.select()} />
                <Button
                  icon="copy"
                  onClick={() =>
                    void copyText(result.url).then((ok) =>
                      ok ? toast.success('URLをコピーしました') : toast.error('コピーできませんでした'),
                    )
                  }
                >
                  コピー
                </Button>
              </div>
              <p className="text-xs text-muted">有効期限: {formatDateTime(result.expiresAt)}</p>
            </div>
          </div>
        ) : null}
      </Dialog>
    </Card>
  );
}

function AiSummaryCard({ customerId }: { customerId: string }) {
  const toast = useToast();
  const [s, setS] = useState<Suggestion | null>(null);
  const gen = useMutation({
    mutationFn: () => aiApi.karteSummary(customerId),
    onSuccess: setS,
    onError: (e) => toast.error(isApiError(e) && e.code === 'AI_DISABLED' ? 'この法人ではAIアシストが無効です' : e),
  });
  return (
    <Card>
      <CardHeader
        title="AIカルテ要約"
        description="直近のカルテと来店履歴をスタッフ向けに要約します。"
        actions={
          <Button size="sm" variant="soft" icon="sparkle" onClick={() => gen.mutate()} loading={gen.isPending}>
            {s ? '再生成' : '要約する'}
          </Button>
        }
      />
      {s ? (
        <div className="space-y-2">
          <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-fg">{s.text}</p>
          <p className="text-[11px] text-subtle">
            AIの提案です。内容は必ずカルテ原本でご確認ください。{s.output?.fallbackReason ? '（定型文で作成）' : ''}
          </p>
        </div>
      ) : (
        <p className="text-[13px] text-muted">ボタンを押すと要約を作成します。</p>
      )}
    </Card>
  );
}
