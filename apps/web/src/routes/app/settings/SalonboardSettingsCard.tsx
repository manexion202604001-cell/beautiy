import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Copy, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import {
  integrationKeys,
  integrationsApi,
  useIntegrations,
  useSyncAgents,
  type Integration,
  type SyncAgent,
} from '../../../api/integrations';
import { copyText } from '../../../components/QrCode';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Separator,
} from '../../../components/shad';
import { Alert, AlertDescription, AlertTitle } from '../../../components/shad/alert';
import { Switch } from '../../../components/shad/switch';
import { useToast } from '../../../components/ui';
import { errorMessage } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { formatAgo } from '../../../lib/format';

/** the helper counts as stopped after this long without a report (agent.ts STALE_MIN) */
const STALE_MS = 30 * 60_000;

/** 店舗設定 › サロンボード (SALOGIC サロンボード連携設定), on the shop's hotpepper_mail connector */
export function SalonboardSettingsCard({ shopId }: { shopId: string }) {
  const { can } = useAuth();
  const allowed = can('integration.manage');
  const integrationsQ = useIntegrations(allowed);
  const agentsQ = useSyncAgents(allowed);
  const account = (integrationsQ.data ?? []).find(
    (a) => a.provider === 'hotpepper_mail' && a.shop_id === shopId && a.status !== 'disabled',
  );
  const agents = (agentsQ.data?.data ?? []).filter((a) => a.shop_id === shopId);

  return (
    <Card>
      <CardHeader>
        <CardTitle>サロンボード連携設定</CardTitle>
        <CardDescription>
          ホットペッパービューティーのサロンボードと予約を同期します
        </CardDescription>
      </CardHeader>
      <CardContent className="sy-4">
        <Alert variant="destructive">
          <TriangleAlert className="h-4 w-4" />
          <AlertTitle>注意</AlertTitle>
          <AlertDescription>
            この機能はサロンボードの利用規約に抵触する可能性があります。
            ご利用は自己責任でお願いします。 Salon OS
            はサロンボードのパスワードを保存しません。サロンボードへの反映は、店舗の Chrome
            に入れた自動枠止め（拡張機能）が、その Chrome のサロンボードのログインで行います。
          </AlertDescription>
        </Alert>
        {!allowed ? (
          <p className="text-sm text-muted-foreground">
            サロンボード連携の設定には「外部連携」の権限が必要です。
          </p>
        ) : integrationsQ.isLoading ? (
          <p className="text-sm text-muted-foreground">読み込み中...</p>
        ) : !account ? (
          <p className="text-sm text-muted-foreground">
            この店舗にはサロンボード（ホットペッパー）の連携がまだありません。
            <Link
              to="/app/integrations"
              className="text-primary underline-offset-4 hover:underline"
            >
              外部連携
            </Link>
            で「ホットペッパー」を追加してください。
          </p>
        ) : (
          <SalonboardForm key={account.id} account={account} agents={agents} />
        )}
      </CardContent>
    </Card>
  );
}

function helperStatus(agents: SyncAgent[]): { ok: boolean; lines: string[] } {
  const a = [...agents].sort((x, y) =>
    (y.last_seen_at ?? '').localeCompare(x.last_seen_at ?? ''),
  )[0];
  if (!a)
    return {
      ok: false,
      lines: [
        '自動枠止め（Chrome）がまだ設定されていません。外部連携でトークンを発行してください。',
      ],
    };
  if (!a.last_seen_at)
    return {
      ok: false,
      lines: [`${a.name}: まだ動いていません（拡張機能にトークンを貼り付けてください）`],
    };
  const lines = [`${a.name}: 最終実行 ${formatAgo(a.last_seen_at)}`];
  const stale = Date.now() - new Date(a.last_seen_at).getTime() > STALE_MS;
  if (stale)
    lines.push(
      '止まっています。Chrome が開いているか、Mac がスリープしていないか確認してください。',
    );
  const sb = a.last_report?.status?.hotpepper_mail;
  if (!sb) lines.push('サロンボードのログインはまだ確認されていません');
  else if (sb.ok) lines.push('サロンボード: ログイン中');
  else lines.push(`サロンボード: ${sb.message ?? 'ログインが切れています'}`);
  return { ok: !stale && !!sb?.ok, lines };
}

function SalonboardForm({ account, agents }: { account: Integration; agents: SyncAgent[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({
    enabled: !!account.config.pushBlocks && !!account.config.mail?.agentManaged,
    forwardAddress: account.config.mail?.forwardAddress ?? '',
  });
  const [editingAddress, setEditingAddress] = useState(!account.config.mail?.forwardAddress);
  const save = useMutation({
    mutationFn: () =>
      integrationsApi.update(account.id, {
        config: {
          ...(form.enabled ? { pushBlocks: true } : {}),
          mail: { agentManaged: form.enabled, forwardAddress: form.forwardAddress.trim() },
        },
      }),
    onSuccess: (a) => {
      void qc.invalidateQueries({ queryKey: integrationKeys.all });
      setEditingAddress(!a.config.mail?.forwardAddress);
      toast.success('サロンボード連携設定を保存しました');
    },
    onError: (e) => toast.error('サロンボード連携設定の保存に失敗しました', errorMessage(e)),
  });
  const status = helperStatus(agents);
  const address = account.config.mail?.forwardAddress ?? '';

  return (
    <>
      <div className="flex items-center justify-between">
        <div className="sy-0.5">
          <Label id="salonboard-enabled-label">サロンボード連携を有効にする</Label>
          <p className="text-sm text-muted-foreground">
            有効にすると予約がサロンボードに自動同期されます
          </p>
        </div>
        <Switch
          aria-labelledby="salonboard-enabled-label"
          checked={form.enabled}
          onCheckedChange={(enabled) => setForm({ ...form, enabled })}
        />
      </div>
      <Separator />
      <div className="sy-2">
        <Label>サロンボードID / パスワード</Label>
        <div
          className={`rounded-md border px-3 py-2 text-sm ${status.ok ? 'border-green-200 bg-green-50 text-green-800' : 'border-amber-200 bg-amber-50 text-amber-800'}`}
        >
          {status.lines.map((l) => (
            <p key={l}>{l}</p>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          サロンボードID・パスワードは Salon OS に保存しません。自動枠止め（拡張機能）を入れた
          Chrome でサロンボードにログインしておいてください（10分ごとにその Chrome
          から反映します）。
        </p>
      </div>
      <div className="sy-2">
        <Label htmlFor="salonboard-hpb-email">HPBメール受信アドレス</Label>
        {editingAddress ? (
          <Input
            id="salonboard-hpb-email"
            value={form.forwardAddress}
            maxLength={200}
            onChange={(e) => setForm({ ...form, forwardAddress: e.target.value })}
            placeholder="例: salon.yoyaku+shop@gmail.com"
          />
        ) : (
          <div className="flex gap-2">
            <Input id="salonboard-hpb-email" value={address} readOnly className="font-mono" />
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label="コピー"
              title="コピー"
              onClick={() =>
                void copyText(address).then((ok) =>
                  ok ? toast.success('コピーしました') : toast.error('コピーできませんでした'),
                )
              }
            >
              <Copy className="h-4 w-4" />
            </Button>
            <Button type="button" variant="outline" onClick={() => setEditingAddress(true)}>
              変更
            </Button>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          ホットペッパーからの予約メール受信用アドレスです
        </p>
      </div>
      <Separator />
      <Button onClick={() => save.mutate()} disabled={save.isPending}>
        {save.isPending ? '保存中...' : '保存'}
      </Button>
    </>
  );
}
