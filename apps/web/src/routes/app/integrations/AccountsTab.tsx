import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useMenus } from '../../../api/catalog';
import {
  PROVIDERS,
  integrationKeys,
  integrationsApi,
  isMailProvider,
  useIntegrations,
  useSyncStatus,
  useSyncJobs,
  type ConflictPolicy,
  type Integration,
} from '../../../api/integrations';
import { useStaffList } from '../../../api/org';
import { copyText } from '../../../components/QrCode';
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Dialog,
  Drawer,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  InlineLoading,
  Input,
  KeyValue,
  LoadMore,
  Select,
  Switch,
  Textarea,
  useToast,
  type Tone,
} from '../../../components/ui';
import { newIdempotencyKey } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { formatAgo, formatDateTime } from '../../../lib/format';
import { CsvImportDialog, MailSetupDialog, MailSetupGuide, ParseTestDialog } from './MailTools';

export const STATUS_LABEL: Record<string, string> = {
  active: '正常',
  error: 'エラー',
  degraded: '縮退中',
  disabled: '無効',
};
export const STATUS_TONE: Record<string, Tone> = { active: 'success', error: 'danger', degraded: 'warning', disabled: 'neutral' };

const POLICY_LABEL: Record<ConflictPolicy, { label: string; description: string }> = {
  manual: { label: '手動で解決', description: '競合は「競合キュー」に入り、スタッフが判断します（推奨）' },
  external_wins: { label: '外部を優先', description: '外部の予約を反映し、重なる自社予約は取消されます' },
  internal_wins: { label: '自社を優先', description: '自社の予約を残し、外部の予約は反映しません' },
};

export function providerLabel(p: string) {
  return PROVIDERS.find((x) => x.value === p)?.label ?? p;
}

/** 外部連携の一覧: test connection, delta/full resync, mappings, sync job history */
export function AccountsTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const { shops, timezone: tz } = useAuth();
  const q = useIntegrations();
  const [editing, setEditing] = useState<Integration | 'new' | null>(null);
  const [jobsFor, setJobsFor] = useState<Integration | null>(null);
  const [fullFor, setFullFor] = useState<Integration | null>(null);
  const [disabling, setDisabling] = useState<Integration | null>(null);
  const [setupFor, setSetupFor] = useState<Integration | null>(null);
  const [parseFor, setParseFor] = useState<Integration | null>(null);
  const [csvFor, setCsvFor] = useState<Integration | null>(null);
  const status = useSyncStatus();
  const manualOpen = (id: string) =>
    status.data?.shops.flatMap((s) => s.accounts).find((x) => x.integrationAccountId === id)?.manualActionRequired ?? 0;
  const shopName = (id: string | null) => shops.find((s) => s.id === id)?.name ?? '—';

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: integrationKeys.all });
  };
  const test = useMutation({
    mutationFn: (id: string) => integrationsApi.test(id),
    onSuccess: (r) =>
      r.ok
        ? toast.success('接続に成功しました', r.latencyMs !== undefined ? `応答 ${r.latencyMs}ms` : undefined)
        : toast.error('接続に失敗しました', r.message),
    onError: (e) => toast.error(e),
  });
  const resync = useMutation({
    mutationFn: ({ id, mode }: { id: string; mode: 'delta' | 'full' }) => integrationsApi.resync(id, mode),
    onSuccess: (r, v) => {
      refresh();
      setFullFor(null);
      toast.success(v.mode === 'full' ? '全件再同期を受け付けました' : '差分同期を受け付けました');
      void r;
    },
    onError: (e) => toast.error(e),
  });
  const setStatus = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: 'active' | 'disabled' }) => {
      if (status === 'disabled') await integrationsApi.disable(id);
      else await integrationsApi.update(id, { status });
    },
    onSuccess: (_r, v) => {
      refresh();
      setDisabling(null);
      toast.success(v.status === 'disabled' ? '連携を無効にしました' : '連携を有効にしました');
    },
    onError: (e) => toast.error(e),
  });

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button variant="primary" icon="plus" onClick={() => setEditing('new')}>
          連携を追加
        </Button>
      </div>
      {q.isLoading ? <InlineLoading /> : null}
      {q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : null}
      {q.data && !q.data.length ? (
        <EmptyState icon="plug" title="外部連携はまだありません" description="予約媒体と接続すると、外部の予約を自動で取り込み、空き枠を反映できます。" />
      ) : null}
      <div className="grid gap-4 lg:grid-cols-2">
        {(q.data ?? []).map((a) => {
          const mail = isMailProvider(a.provider);
          const pending = mail ? manualOpen(a.id) : 0;
          return (
          <Card key={a.id} className="flex flex-col gap-3" as="article">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-[15px] font-semibold">{a.display_name}</p>
                <p className="text-xs text-muted">
                  {providerLabel(a.provider)} ・{shopName(a.shop_id)}
                </p>
              </div>
              <Badge tone={STATUS_TONE[a.status] ?? 'neutral'} dot>
                {STATUS_LABEL[a.status] ?? a.status}
              </Badge>
            </div>
            <KeyValue
              items={[
                { label: '最終成功', value: a.last_success_at ? `${formatDateTime(a.last_success_at, tz)}（${formatAgo(a.last_success_at)}）` : '—' },
                { label: '競合ルール', value: POLICY_LABEL[a.config.conflictPolicy]?.label ?? a.config.conflictPolicy },
                ...(mail ? [{ label: '取り込み', value: '予約通知メール（新規・変更・キャンセル）' }] : []),
                {
                  label: '枠の反映',
                  value: !a.config.pushBlocks
                    ? '反映しない'
                    : a.pushMode === 'manual'
                      ? `スタッフへ枠止めを依頼${pending ? `（未対応 ${pending}件）` : ''}`
                      : '外部へ反映する',
                },
                {
                  label: '対応表',
                  value: `スタッフ ${Object.keys(a.config.staffMap).length}件 ・メニュー ${Object.keys(a.config.menuMap).length}件`,
                },
              ]}
            />
            {a.last_error ? (
              <Alert tone={a.status === 'degraded' ? 'warning' : 'danger'} title={`直近のエラー（連続${a.consecutive_failures}回）`}>
                <span className="break-all">{a.last_error}</span>
                {a.last_error_at ? <span className="ml-1 text-xs text-muted">{formatDateTime(a.last_error_at, tz)}</span> : null}
              </Alert>
            ) : null}
            {pending ? (
              <Alert tone="warning" title={`媒体で止める・再開する枠が ${pending} 件あります`}>
                「媒体の枠止め」タブで確認し、{a.provider === 'lime_mail' ? 'LiME' : 'SALON BOARD'} で操作後に「対応済み」を押してください。
              </Alert>
            ) : null}
            {mail ? (
              <div className="mt-auto flex flex-wrap gap-2 border-t border-border pt-3">
                <Button size="sm" icon="info" onClick={() => setSetupFor(a)}>
                  設定手順・受信URL
                </Button>
                <Button size="sm" icon="mail" onClick={() => setParseFor(a)} disabled={a.status === 'disabled'}>
                  解析テスト
                </Button>
                <Button size="sm" variant="ghost" icon="download" onClick={() => setCsvFor(a)} disabled={a.status === 'disabled'}>
                  CSV取り込み
                </Button>
                <span className="flex-1" />
                <IconButton icon="edit" label="設定を編集" size="sm" variant="secondary" onClick={() => setEditing(a)} />
                {a.status === 'disabled' ? (
                  <Button size="sm" variant="soft" onClick={() => setStatus.mutate({ id: a.id, status: 'active' })}>
                    有効にする
                  </Button>
                ) : (
                  <IconButton icon="x" label="無効にする" size="sm" variant="secondary" onClick={() => setDisabling(a)} />
                )}
              </div>
            ) : (
            <div className="mt-auto flex flex-wrap gap-2 border-t border-border pt-3">
              <Button size="sm" icon="plug" onClick={() => test.mutate(a.id)} loading={test.isPending && test.variables === a.id} disabled={a.status === 'disabled'}>
                接続テスト
              </Button>
              <Button
                size="sm"
                icon="refresh"
                onClick={() => resync.mutate({ id: a.id, mode: 'delta' })}
                loading={resync.isPending && resync.variables?.id === a.id && resync.variables.mode === 'delta'}
                disabled={a.status === 'disabled'}
              >
                差分同期
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setFullFor(a)} disabled={a.status === 'disabled'}>
                全件再同期
              </Button>
              <Button size="sm" variant="ghost" icon="list" onClick={() => setJobsFor(a)}>
                同期履歴
              </Button>
              <span className="flex-1" />
              <IconButton icon="edit" label="設定を編集" size="sm" variant="secondary" onClick={() => setEditing(a)} />
              {a.status === 'disabled' ? (
                <Button size="sm" variant="soft" onClick={() => setStatus.mutate({ id: a.id, status: 'active' })}>
                  有効にする
                </Button>
              ) : (
                <IconButton icon="x" label="無効にする" size="sm" variant="secondary" onClick={() => setDisabling(a)} />
              )}
            </div>
            )}
          </Card>
          );
        })}
      </div>
      {editing ? (
        <IntegrationDialog
          integration={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onCreated={(created) => (isMailProvider(created.provider) ? setSetupFor(created) : undefined)}
        />
      ) : null}
      <MailSetupDialog integration={setupFor} onClose={() => setSetupFor(null)} />
      <ParseTestDialog integration={parseFor} onClose={() => setParseFor(null)} />
      <CsvImportDialog integration={csvFor} onClose={() => setCsvFor(null)} />
      <SyncJobsDrawer integration={jobsFor} onClose={() => setJobsFor(null)} />
      <ConfirmDialog
        open={!!fullFor}
        onClose={() => setFullFor(null)}
        title="全件再同期を実行しますか？"
        description="外部の予約をすべて取り込み直します。件数によっては時間がかかります。差分の取りこぼしが疑われる場合に使用してください。"
        confirmLabel="全件再同期"
        loading={resync.isPending}
        onConfirm={() => fullFor && resync.mutate({ id: fullFor.id, mode: 'full' })}
      />
      <ConfirmDialog
        open={!!disabling}
        onClose={() => setDisabling(null)}
        title="連携を無効にしますか？"
        description="同期と枠の反映が停止します。設定と取り込み済みの予約は残ります。"
        tone="danger"
        confirmLabel="無効にする"
        loading={setStatus.isPending}
        onConfirm={() => disabling && setStatus.mutate({ id: disabling.id, status: 'disabled' })}
      />
    </div>
  );
}

function SyncJobsDrawer({ integration, onClose }: { integration: Integration | null; onClose: () => void }) {
  const { timezone: tz } = useAuth();
  const q = useSyncJobs(integration?.id ?? null);
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const tone: Record<string, Tone> = { succeeded: 'success', failed: 'danger', running: 'info', queued: 'neutral' };
  return (
    <Drawer open={!!integration} onClose={onClose} title="同期ジョブ履歴" description={integration?.display_name} width="lg">
      {q.isLoading ? <InlineLoading /> : null}
      {q.error ? <ErrorState error={q.error} /> : null}
      {q.data && !items.length ? <EmptyState icon="list" title="同期履歴はまだありません" /> : null}
      <ul className="space-y-2">
        {items.map((j) => (
          <li key={j.id} className="rounded-xl border border-border p-3 text-[13px]">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={tone[j.state] ?? 'neutral'}>{j.state}</Badge>
              <span className="font-medium">{j.mode === 'full' ? '全件' : '差分'}</span>
              <span className="text-xs text-muted">{j.triggered_by === 'manual' ? '手動' : j.triggered_by}</span>
              <span className="ml-auto text-xs text-subtle tabular">{formatDateTime(j.created_at, tz)}</span>
            </div>
            {j.stats ? (
              <p className="mt-1 text-xs text-muted">
                {Object.entries(j.stats)
                  .map(([k, v]) => `${STAT_LABEL[k] ?? k} ${v}`)
                  .join(' ・ ')}
              </p>
            ) : null}
            {j.error ? <p className="mt-1 break-all text-xs text-danger">{j.error}</p> : null}
            {j.finished_at ? <p className="mt-0.5 text-[11px] text-subtle">完了 {formatDateTime(j.finished_at, tz)}</p> : null}
          </li>
        ))}
      </ul>
      <LoadMore hasMore={!!q.hasNextPage} loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()} />
    </Drawer>
  );
}

const STAT_LABEL: Record<string, string> = {
  fetched: '取得',
  created: '作成',
  updated: '更新',
  cancelled: '取消',
  linked: '紐付け',
  conflicts: '競合',
  errors: 'エラー',
  skipped: 'スキップ',
};

type MapRow = { key: string; value: string };
const toRows = (m: Record<string, string>): MapRow[] => Object.entries(m).map(([key, value]) => ({ key, value }));
const toMap = (rows: MapRow[]) =>
  Object.fromEntries(rows.filter((r) => r.key.trim() && r.value).map((r) => [r.key.trim(), r.value]));

function IntegrationDialog({
  integration,
  onClose,
  onCreated,
}: {
  integration: Integration | null;
  onClose: () => void;
  onCreated?: (created: Integration) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const { shops, currentShopId } = useAuth();
  const [provider, setProvider] = useState(integration?.provider ?? PROVIDERS[0]!.value);
  const [shopId, setShopId] = useState(integration?.shop_id ?? currentShopId ?? '');
  const [displayName, setDisplayName] = useState(integration?.display_name ?? '');
  const [credentials, setCredentials] = useState('');
  const [policy, setPolicy] = useState<ConflictPolicy>(integration?.config.conflictPolicy ?? 'manual');
  const [pushBlocks, setPushBlocks] = useState(integration?.config.pushBlocks ?? false);
  const [pushTouched, setPushTouched] = useState(!!integration);
  const mail = isMailProvider(provider);
  const mailCfg = integration?.config.mail;
  const [defaultMenuId, setDefaultMenuId] = useState(mailCfg?.defaultMenuId ?? '');
  const [autoMatch, setAutoMatch] = useState(mailCfg?.autoMatchNames ?? true);
  const [notifyEmails, setNotifyEmails] = useState((mailCfg?.notifyEmails ?? []).join(', '));
  const [subjectIncludes, setSubjectIncludes] = useState((mailCfg?.subjectIncludes ?? []).join(', '));
  const splitList = (v: string) =>
    v
      .split(/[,、\s]+/)
      .map((x) => x.trim())
      .filter(Boolean);
  const emailsInvalid = splitList(notifyEmails).some((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
  const [staffRows, setStaffRows] = useState<MapRow[]>(toRows(integration?.config.staffMap ?? {}));
  const [menuRows, setMenuRows] = useState<MapRow[]>(toRows(integration?.config.menuMap ?? {}));
  const [credError, setCredError] = useState<string | null>(null);
  const [key] = useState(newIdempotencyKey);
  const staff = useStaffList({ shopId: shopId || undefined });
  const menus = useMenus(shopId || null, true);
  const toast2 = toast;

  const parseCreds = (): Record<string, unknown> | undefined | null => {
    if (!credentials.trim()) return undefined;
    try {
      const v = JSON.parse(credentials);
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
      return v as Record<string, unknown>;
    } catch {
      setCredError('JSONオブジェクトで入力してください（例: {"apiKey":"..."}）');
      return null;
    }
  };

  const save = useMutation({
    mutationFn: (creds: Record<string, unknown> | undefined) => {
      const config = {
        conflictPolicy: policy,
        pushBlocks,
        staffMap: toMap(staffRows),
        menuMap: toMap(menuRows),
        ...(mail
          ? {
              mail: {
                ...(defaultMenuId ? { defaultMenuId } : {}),
                autoMatchNames: autoMatch,
                notifyEmails: splitList(notifyEmails),
                subjectIncludes: splitList(subjectIncludes),
              },
            }
          : {}),
      };
      return integration
        ? integrationsApi.update(integration.id, { displayName: displayName.trim(), config, ...(creds ? { credentials: creds } : {}) })
        : integrationsApi.create({ provider, shopId, displayName: displayName.trim(), config, ...(creds ? { credentials: creds } : {}) }, key);
    },
    onSuccess: (saved) => {
      void qc.invalidateQueries({ queryKey: integrationKeys.all });
      toast.success(integration ? '連携設定を更新しました' : '連携を追加しました');
      onClose();
      if (!integration) onCreated?.(saved);
    },
    onError: (e) => toast.error(e),
  });

  return (
    <Dialog
      open
      onClose={onClose}
      size="xl"
      title={integration ? '連携設定を編集' : '外部連携を追加'}
      dismissable={!save.isPending}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={save.isPending}>
            キャンセル
          </Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={!displayName.trim() || !shopId || (mail && emailsInvalid)}
            onClick={() => {
              const c = parseCreds();
              if (c !== null) save.mutate(c);
            }}
          >
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="連携先" hint={integration ? '作成後は変更できません' : PROVIDERS.find((p) => p.value === provider)?.description}>
            <Select
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value);
                // e-mail connectors exist to prevent double booking: blocking requests on by default
                if (!pushTouched) setPushBlocks(isMailProvider(e.target.value));
              }}
              disabled={!!integration}
            >
              {PROVIDERS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="店舗" required>
            <Select value={shopId} onChange={(e) => setShopId(e.target.value)} disabled={!!integration}>
              <option value="">選択してください</option>
              {shops.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="表示名" required>
            <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={100} placeholder="例: 予約媒体A（渋谷）" />
          </Field>
        </div>
        {mail ? null : (
        <Field
          label="認証情報（JSON）"
          optional
          error={credError}
          hint={
            integration?.hasCredentials
              ? '保存済みの認証情報は表示されません。入力すると置き換えます（空欄なら変更なし）。'
              : '暗号化して保存され、画面やAPIで再表示されることはありません。'
          }
        >
          <Textarea
            value={credentials}
            onChange={(e) => {
              setCredentials(e.target.value);
              setCredError(null);
            }}
            rows={3}
            className="font-mono text-xs"
            placeholder={integration?.hasCredentials ? '••••••••（保存済み）' : '{"apiKey": "..."}'}
            spellCheck={false}
            autoComplete="off"
          />
        </Field>
        )}
        <fieldset className="space-y-2">
          <legend className="mb-1 text-[13px] font-medium">競合時のルール</legend>
          {(Object.keys(POLICY_LABEL) as ConflictPolicy[]).map((p) => (
            <label key={p} className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-border p-3 text-[13px] has-[:checked]:border-primary has-[:checked]:bg-primary-soft/40">
              <input type="radio" name="policy" className="mt-0.5 accent-[var(--primary)]" checked={policy === p} onChange={() => setPolicy(p)} />
              <span>
                <span className="font-medium">{POLICY_LABEL[p].label}</span>
                <span className="block text-xs text-muted">{POLICY_LABEL[p].description}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <Switch
          checked={pushBlocks}
          onChange={(v) => {
            setPushBlocks(v);
            setPushTouched(true);
          }}
          label={mail ? '他の経路で入った予約の枠止めを依頼する' : '自社の予約で埋まった枠を外部へ反映する'}
          description={
            mail
              ? '自社Web・LINE・電話・他媒体の予約が入ると、この媒体で止める枠を「媒体の枠止め」と通知メールでお知らせします（媒体に公開APIがないため操作はスタッフが行います）。'
              : 'ダブルブッキングを防ぐため、自社予約の時間を外部媒体側でブロックします。'
          }
        />
        {mail ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="既定メニュー" optional hint="メール記載のメニュー名を特定できないときに使います。未設定なら競合キューで確認します。">
              <Select value={defaultMenuId} onChange={(e) => setDefaultMenuId(e.target.value)}>
                <option value="">設定しない</option>
                {(menus.data ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="枠止め依頼の通知先" optional hint="カンマ区切り・最大5件。空欄なら店舗のメールアドレスへ送ります。" error={emailsInvalid ? 'メールアドレスの形式を確認してください' : null}>
              <Input value={notifyEmails} onChange={(e) => setNotifyEmails(e.target.value)} placeholder="front@example.com" />
            </Field>
            <Field label="件名フィルタ" optional hint="この語を件名に含むメールだけ取り込みます（カンマ区切り）。空欄なら予約メールを自動判定。">
              <Input value={subjectIncludes} onChange={(e) => setSubjectIncludes(e.target.value)} placeholder="SALON BOARD" />
            </Field>
            <div className="self-end">
              <Switch checked={autoMatch} onChange={setAutoMatch} label="スタッフ・メニューを名前で自動判定" description="対応表にない名前は、自社の名前と一意に一致すれば自動で対応付けます。" />
            </div>
          </div>
        ) : null}
        <div className="grid gap-5 lg:grid-cols-2">
          <MapEditor
            title="スタッフ対応表"
            description={mail ? 'メールに記載のスタッフ名 → 自社スタッフ（名前が違う場合のみ）' : '外部のスタイリストコード → 自社スタッフ'}
            rows={staffRows}
            onChange={setStaffRows}
            options={(staff.data ?? []).map((s) => ({ id: s.id, label: s.display_name }))}
            placeholder={mail ? '例: SAKI' : '例: ST001'}
          />
          <MapEditor
            title="メニュー対応表"
            description={mail ? 'メールに記載のメニュー名 → 自社メニュー（名前が違う場合のみ）' : '外部のメニューコード → 自社メニュー'}
            rows={menuRows}
            onChange={setMenuRows}
            options={(menus.data ?? []).map((m) => ({ id: m.id, label: m.name }))}
            placeholder={mail ? '例: 【平日限定】カット' : '例: MN-CUT'}
          />
        </div>
        {integration && mail ? <MailSetupGuide integration={integration} /> : null}
        {integration && !mail ? (
          <div className="rounded-xl bg-surface-2 p-3 text-[13px]">
            <p className="text-xs text-muted">Webhook URL（連携先の管理画面に登録）</p>
            <div className="mt-1 flex items-center gap-2">
              <code className="min-w-0 flex-1 break-all text-xs">{integration.webhookUrl}</code>
              <IconButton
                icon="copy"
                label="Webhook URLをコピー"
                size="sm"
                onClick={() => void copyText(integration.webhookUrl).then((ok) => (ok ? toast2.success('コピーしました') : toast2.error('コピーできませんでした')))}
              />
            </div>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

function MapEditor({
  title,
  description,
  rows,
  onChange,
  options,
  placeholder,
}: {
  title: string;
  description: string;
  rows: MapRow[];
  onChange: (rows: MapRow[]) => void;
  options: { id: string; label: string }[];
  placeholder: string;
}) {
  const dupKeys = new Set(rows.map((r) => r.key.trim()).filter((k, i, a) => k && a.indexOf(k) !== i));
  return (
    <fieldset className="space-y-2">
      <legend className="text-[13px] font-medium">{title}</legend>
      <p className="text-xs text-muted">{description}</p>
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            inputSize="sm"
            aria-label={`${title} 外部コード ${i + 1}`}
            value={r.key}
            placeholder={placeholder}
            invalid={dupKeys.has(r.key.trim())}
            onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))}
            className="w-32!"
          />
          <span className="text-muted" aria-hidden>
            →
          </span>
          <div className="min-w-0 flex-1">
            <Select
              selectSize="sm"
              aria-label={`${title} 対応先 ${i + 1}`}
              value={r.value}
              onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
            >
              <option value="">選択してください</option>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </Select>
          </div>
          <IconButton icon="x" label="行を削除" size="sm" onClick={() => onChange(rows.filter((_, j) => j !== i))} />
        </div>
      ))}
      {dupKeys.size ? <p className="text-xs text-danger">同じ外部コードが重複しています（後の行が優先されます）</p> : null}
      <Button size="xs" variant="ghost" icon="plus" onClick={() => onChange([...rows, { key: '', value: '' }])}>
        行を追加
      </Button>
    </fieldset>
  );
}
