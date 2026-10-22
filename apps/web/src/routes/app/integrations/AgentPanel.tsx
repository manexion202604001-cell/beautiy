import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  integrationKeys,
  integrationsApi,
  useSyncAgents,
  type Integration,
  type SyncAgent,
} from '../../../api/integrations';
import { copyText } from '../../../components/QrCode';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  Dialog,
  Field,
  Input,
  Select,
  Switch,
  useToast,
} from '../../../components/ui';
import { useAuth } from '../../../lib/auth';
import { formatAgo } from '../../../lib/format';

/** media the helper can block slots on (SALON BOARD comes later) */
const AGENT_MEDIA: Record<string, string> = {
  minimo_mail: 'minimo',
  hotpepper_mail: 'サロンボード',
};
const SWITCH_HELP: Record<string, string> = {
  minimo_mail:
    'オンにすると、Salon OS とホットペッパーで入った予約の時間は minimo の「すぐ予約」を止めます（予約リクエストのみになります）。取消・変更されたら元に戻します。依頼メールは送らず、拡張機能が止まったときだけ店舗にメールします。',
  hotpepper_mail:
    'オンにすると、Salon OS と minimo で入った予約の時間に、サロンボードへ予定を入れます（表示は「予定あり」、メモに「Salon OS の予約で自動登録」）（予定の時間はホットペッパーの予約受付が止まります）。取消・変更されたら予定を消します。SALOGIC から移した予約はサロンボードに入っているので対象外です。依頼メールは送らず、拡張機能が止まったときだけ店舗にメールします。',
};
const STALE_MS = 30 * 60_000;

function agentState(a: SyncAgent): {
  tone: 'success' | 'warning' | 'danger' | 'neutral';
  label: string;
} {
  if (!a.last_seen_at) return { tone: 'neutral', label: 'まだ動いていません' };
  if (Date.now() - new Date(a.last_seen_at).getTime() > STALE_MS)
    return { tone: 'danger', label: '止まっています' };
  const down = Object.entries(a.last_report?.status ?? {}).filter(([, s]) => s && !s.ok);
  if (down.length)
    return {
      tone: 'danger',
      label: `${down.map(([p]) => AGENT_MEDIA[p] ?? p).join('・')} のログイン切れ`,
    };
  if (a.last_report?.failed)
    return { tone: 'warning', label: `止められない枠 ${a.last_report.failed} 件` };
  return { tone: 'success', label: '正常' };
}

/**
 * 自動枠止め: a helper in the salon's Chrome closes / reopens slots on media without a write API
 * (minimo) every 10 minutes, so staff do not have to.
 */
export function AgentPanel({ integrations }: { integrations: Integration[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { shops } = useAuth();
  const agents = useSyncAgents();
  const [issuing, setIssuing] = useState(false);
  const [revoking, setRevoking] = useState<SyncAgent | null>(null);
  const supported = integrations.filter((a) => AGENT_MEDIA[a.provider] && a.status !== 'disabled');

  const toggle = useMutation({
    mutationFn: ({ a, on }: { a: Integration; on: boolean }) =>
      integrationsApi.update(a.id, {
        config: { ...(on ? { pushBlocks: true } : {}), mail: { agentManaged: on } },
      }),
    onSuccess: (_r, v) => {
      void qc.invalidateQueries({ queryKey: integrationKeys.all });
      toast.success(
        v.on
          ? `${AGENT_MEDIA[v.a.provider]} の枠止めを自動にしました`
          : `${AGENT_MEDIA[v.a.provider]} の自動枠止めを止めました`,
        v.on
          ? 'これからの予約すべてについて、次の実行（10分以内）で枠を止めます'
          : '枠止めの依頼はメールと「媒体の枠止め」に戻ります',
      );
    },
    onError: (e) => toast.error(e),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => integrationsApi.revokeAgent(id),
    onSuccess: () => {
      setRevoking(null);
      void qc.invalidateQueries({ queryKey: integrationKeys.agents });
      toast.success('トークンを無効にしました');
    },
    onError: (e) => toast.error(e),
  });

  if (!supported.length && !agents.data?.data.length) return null;
  const list = agents.data?.data ?? [];
  return (
    <Card>
      <CardHeader
        title="自動枠止め（Chrome）"
        description="店舗の Mac の Chrome に入れた拡張機能が、10分ごとに Salon OS の予約に合わせて媒体の枠を止め・再開します。媒体へのログインはその Chrome のものを使います（パスワードは Salon OS に保存しません）。"
        actions={
          <Button size="sm" icon="plus" onClick={() => setIssuing(true)}>
            トークンを発行
          </Button>
        }
      />
      <div className="space-y-4">
        {list.length ? (
          <ul className="divide-y divide-border rounded-md border border-border">
            {list.map((a) => {
              const st = agentState(a);
              return (
                <li key={a.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">
                      {a.shop_name}・{a.name}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {a.last_seen_at
                        ? `最終実行 ${formatAgo(a.last_seen_at)}`
                        : '拡張機能にトークンを貼り付けると動き始めます'}
                    </p>
                    {Object.entries(a.last_report?.status ?? {}).map(([p, s]) =>
                      s?.unmatchedStaff?.length ? (
                        <p key={p} className="text-xs text-muted-foreground">
                          {AGENT_MEDIA[p] ?? p}{' '}
                          の名前でスタッフと対応していないもの（この名前の予約枠は止めません）:{' '}
                          {s.unmatchedStaff.join('、')}
                        </p>
                      ) : null,
                    )}
                  </div>
                  <Badge tone={st.tone} dot>
                    {st.label}
                  </Badge>
                  <Button size="sm" variant="ghost" onClick={() => setRevoking(a)}>
                    無効にする
                  </Button>
                </li>
              );
            })}
          </ul>
        ) : (
          <Alert tone="info" title="まだ設定されていません">
            「トークンを発行」→ 拡張機能（infra/chrome-sync-agent）を Chrome
            に入れてトークンを貼り付け → 下のスイッチをオン、の順に設定します。
          </Alert>
        )}
        {supported.map((a) => (
          <Switch
            key={a.id}
            checked={!!a.config.pushBlocks && !!a.config.mail?.agentManaged}
            disabled={toggle.isPending}
            onChange={(on) => toggle.mutate({ a, on })}
            label={`${AGENT_MEDIA[a.provider]} の枠止めを自動にする（${shops.find((s) => s.id === a.shop_id)?.name ?? ''}）`}
            description={SWITCH_HELP[a.provider]}
          />
        ))}
      </div>
      <IssueDialog open={issuing} onClose={() => setIssuing(false)} />
      <ConfirmDialog
        open={!!revoking}
        onClose={() => setRevoking(null)}
        title="トークンを無効にしますか？"
        description="この拡張機能は枠止めできなくなります。自動枠止めをオンにしたままだと、30分後に店舗へ「止まっています」とメールが届きます。"
        tone="danger"
        confirmLabel="無効にする"
        loading={revoke.isPending}
        onConfirm={() => revoking && revoke.mutate(revoking.id)}
      />
    </Card>
  );
}

function IssueDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { shops } = useAuth();
  const [shopId, setShopId] = useState('');
  const [name, setName] = useState('Chrome');
  const [token, setToken] = useState<string | null>(null);
  const issue = useMutation({
    mutationFn: () =>
      integrationsApi.issueAgent({ shopId: shopId || shops[0]!.id, name: name.trim() || 'Chrome' }),
    onSuccess: (r) => {
      setToken(r.token);
      void qc.invalidateQueries({ queryKey: integrationKeys.agents });
    },
    onError: (e) => toast.error(e),
  });
  const close = () => {
    setToken(null);
    onClose();
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title="自動枠止めのトークン"
      description={
        token
          ? 'このトークンは今だけ表示されます。拡張機能の設定画面に貼り付けてください。'
          : '拡張機能を入れる Chrome（店舗の Mac）ごとに1つ発行します。'
      }
      footer={
        token ? (
          <Button variant="primary" onClick={close}>
            閉じる
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>
              キャンセル
            </Button>
            <Button variant="primary" loading={issue.isPending} onClick={() => issue.mutate()}>
              発行
            </Button>
          </>
        )
      }
    >
      {token ? (
        <div className="space-y-3">
          <code className="block break-all rounded-md border border-border bg-muted p-3 text-xs">
            {token}
          </code>
          <Button
            icon="copy"
            onClick={async () =>
              (await copyText(token))
                ? toast.success('コピーしました')
                : toast.error('コピーできませんでした')
            }
          >
            コピー
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <Field label="店舗">
            <Select
              value={shopId || shops[0]?.id || ''}
              onChange={(e) => setShopId(e.target.value)}
            >
              {shops.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="名前" hint="どの Mac の Chrome か分かる名前（例: 表参道 受付Mac）">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
          </Field>
        </div>
      )}
    </Dialog>
  );
}
