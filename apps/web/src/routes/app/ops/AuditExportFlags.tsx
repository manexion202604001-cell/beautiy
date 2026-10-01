import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { useStaffList } from '../../../api/org';
import {
  EXPORT_KIND_LABEL,
  EXPORT_KIND_PERMISSION,
  opsApi,
  useAuditLogs,
  useExports,
  useFlags,
  type AuditQuery,
  type ExportKind,
} from '../../../api/ops';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  InlineLoading,
  Input,
  LoadMore,
  Select,
  Switch,
  TBody,
  THead,
  Table,
  Td,
  Th,
  Tr,
  useToast,
  type Tone,
} from '../../../components/ui';
import { useAuth } from '../../../lib/auth';
import { formatDateTime } from '../../../lib/format';
import { addDays, todayIn, zonedToIso } from '../../../lib/time';
import { sameOriginApiUrl } from '../../../lib/urls';
import { JsonBlock } from './OpsTabs';

const ACTOR_LABEL: Record<string, string> = { staff: 'スタッフ', system: 'システム', customer: 'お客様', public: '公開' };

/** O-05 監査ログ検索 (cursor pagination; the search itself is audited) */
export function AuditTab() {
  const { shops, timezone: tz } = useAuth();
  const staff = useStaffList({ includeInactive: true });
  const [draft, setDraft] = useState({ actorId: '', action: '', resourceType: '', resourceId: '', shopId: '', from: addDays(todayIn(tz), -7), to: todayIn(tz) });
  const [query, setQuery] = useState<AuditQuery | null>(null);
  const q = useAuditLogs(query ?? {}, !!query);
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const [open, setOpen] = useState<string | null>(null);
  const set = (k: keyof typeof draft) => (e: { target: { value: string } }) => setDraft({ ...draft, [k]: e.target.value });
  const search = () =>
    setQuery({
      actorId: draft.actorId || undefined,
      action: draft.action.trim() || undefined,
      resourceType: draft.resourceType.trim() || undefined,
      resourceId: draft.resourceId.trim() || undefined,
      shopId: draft.shopId || undefined,
      from: draft.from ? zonedToIso(draft.from, '00:00', tz) : undefined,
      to: draft.to ? zonedToIso(addDays(draft.to, 1), '00:00', tz) : undefined,
    });
  return (
    <div className="space-y-4">
      <form
        className="grid gap-3 rounded-2xl border border-border bg-surface p-4 sm:grid-cols-2 lg:grid-cols-4"
        onSubmit={(e) => {
          e.preventDefault();
          search();
        }}
      >
        <Field label="操作者">
          <Select selectSize="sm" value={draft.actorId} onChange={set('actorId')}>
            <option value="">すべて</option>
            {(staff.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.display_name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="操作" hint="前方一致は末尾に * （例: customer.*）">
          <Input inputSize="sm" value={draft.action} onChange={set('action')} placeholder="customer.*" />
        </Field>
        <Field label="リソース種別">
          <Input inputSize="sm" value={draft.resourceType} onChange={set('resourceType')} placeholder="customer / appointment …" />
        </Field>
        <Field label="リソースID">
          <Input inputSize="sm" value={draft.resourceId} onChange={set('resourceId')} />
        </Field>
        <Field label="店舗">
          <Select selectSize="sm" value={draft.shopId} onChange={set('shopId')}>
            <option value="">すべて</option>
            {shops.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="開始日">
          <Input type="date" inputSize="sm" value={draft.from} onChange={set('from')} />
        </Field>
        <Field label="終了日">
          <Input type="date" inputSize="sm" value={draft.to} onChange={set('to')} />
        </Field>
        <div className="flex items-end">
          <Button type="submit" variant="primary" icon="search" className="w-full" loading={q.isFetching && !q.isFetchingNextPage}>
            検索
          </Button>
        </div>
      </form>
      <p className="text-xs text-muted">監査ログの検索自体も監査ログに記録されます。</p>
      {!query ? <EmptyState icon="shield" title="条件を指定して検索してください" /> : null}
      {q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : null}
      {query && q.data && !items.length ? <EmptyState icon="search" title="該当するログはありません" /> : null}
      {items.length ? (
        <Table caption="監査ログ">
          <THead>
            <Tr>
              <Th>日時</Th>
              <Th>操作者</Th>
              <Th>操作</Th>
              <Th className="hidden md:table-cell">リソース</Th>
              <Th className="hidden lg:table-cell">店舗 / IP</Th>
              <Th className="w-10">
                <span className="sr-only">詳細</span>
              </Th>
            </Tr>
          </THead>
          <TBody>
            {items.map((l) => (
              <Fragment key={l.id}>
                <Tr>
                  <Td className="whitespace-nowrap text-xs tabular">{formatDateTime(l.created_at, tz)}</Td>
                  <Td>
                    <p>{l.actor_name ?? '—'}</p>
                    <p className="text-[11px] text-subtle">{ACTOR_LABEL[l.actor_type] ?? l.actor_type}</p>
                  </Td>
                  <Td>
                    <code className="text-xs">{l.action}</code>
                  </Td>
                  <Td className="hidden md:table-cell">
                    <p className="text-xs">{l.resource_type ?? '—'}</p>
                    <p className="max-w-[12rem] truncate text-[11px] text-subtle">{l.resource_id ?? ''}</p>
                  </Td>
                  <Td className="hidden text-xs lg:table-cell">
                    {l.shop_name ?? '—'}
                    <p className="text-[11px] text-subtle">{l.ip ?? ''}</p>
                  </Td>
                  <Td>
                    <IconButton
                      icon={open === l.id ? 'chevron-up' : 'chevron-down'}
                      label={open === l.id ? '詳細を閉じる' : '詳細を表示'}
                      size="xs"
                      onClick={() => setOpen(open === l.id ? null : l.id)}
                      aria-expanded={open === l.id}
                    />
                  </Td>
                </Tr>
                {open === l.id ? (
                  <tr>
                    <td colSpan={6} className="bg-surface-2/40 px-4 py-3">
                      <div className="grid gap-3 lg:grid-cols-3">
                        <div>
                          <p className="mb-1 text-xs font-medium text-muted">変更前</p>
                          <JsonBlock value={l.before} />
                        </div>
                        <div>
                          <p className="mb-1 text-xs font-medium text-muted">変更後</p>
                          <JsonBlock value={l.after} />
                        </div>
                        <div>
                          <p className="mb-1 text-xs font-medium text-muted">メタデータ</p>
                          <JsonBlock value={l.metadata} />
                          <p className="mt-1 break-all text-[11px] text-subtle">
                            request {l.request_id ?? '—'} ・trace {l.trace_id ?? '—'}
                            <br />
                            {l.user_agent ?? ''}
                          </p>
                        </div>
                      </div>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            ))}
          </TBody>
        </Table>
      ) : null}
      <LoadMore hasMore={!!q.hasNextPage} loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()} />
    </div>
  );
}

const EXPORT_TONE: Record<string, Tone> = { queued: 'neutral', running: 'info', completed: 'success', failed: 'danger', expired: 'outline' };
const EXPORT_STATUS_LABEL: Record<string, string> = { queued: '待機中', running: '作成中', completed: '完了', failed: '失敗', expired: '期限切れ' };

/** O-06 データエクスポート: async CSV with status polling and short-lived download URLs */
export function ExportsTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const { can, shops, timezone: tz, me } = useAuth();
  const kinds = (Object.keys(EXPORT_KIND_LABEL) as ExportKind[]).filter((k) => can(EXPORT_KIND_PERMISSION[k]));
  const [kind, setKind] = useState<ExportKind | ''>(kinds[0] ?? '');
  const [from, setFrom] = useState(addDays(todayIn(tz), -30));
  const [to, setTo] = useState(todayIn(tz));
  const [shopId, setShopId] = useState('');
  const q = useExports();
  const create = useMutation({
    mutationFn: () => opsApi.createExport({ kind: kind as ExportKind, params: { from: from || undefined, to: to || undefined, shopId: shopId || undefined } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['ops', 'exports'] });
      toast.success('エクスポートを受け付けました', '完了すると一覧からダウンロードできます');
    },
    onError: (e) => toast.error(e),
  });
  const download = useMutation({
    mutationFn: (id: string) => opsApi.exportDownload(id),
    onSuccess: (r) => {
      const a = document.createElement('a');
      a.href = sameOriginApiUrl(r.url) ?? r.url;
      a.download = r.fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
    },
    onError: (e) => toast.error(e),
  });
  const canCreate = can('export.data') && kinds.length > 0;
  return (
    <div className="space-y-5">
      {canCreate ? (
        <Card>
          <CardHeader title="新しいエクスポート" description="個人情報を含むCSVは監査ログに記録され、ダウンロードリンクは5分間のみ有効です（ファイルは7日で失効）。" />
          <form
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5"
            onSubmit={(e) => {
              e.preventDefault();
              if (kind) create.mutate();
            }}
          >
            <Field label="データ">
              <Select selectSize="sm" value={kind} onChange={(e) => setKind(e.target.value as ExportKind)}>
                {kinds.map((k) => (
                  <option key={k} value={k}>
                    {EXPORT_KIND_LABEL[k]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="開始日" optional>
              <Input type="date" inputSize="sm" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label="終了日" optional>
              <Input type="date" inputSize="sm" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
            </Field>
            <Field label="店舗">
              <Select selectSize="sm" value={shopId} onChange={(e) => setShopId(e.target.value)}>
                <option value="">{me?.allShops ? 'すべて' : 'アクセス可能な店舗'}</option>
                {shops.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="flex items-end">
              <Button type="submit" variant="primary" icon="download" className="w-full" loading={create.isPending}>
                作成
              </Button>
            </div>
          </form>
        </Card>
      ) : (
        <Alert tone="info">エクスポートの作成には export.data と対象データの閲覧権限が必要です。</Alert>
      )}
      {q.isLoading ? <InlineLoading /> : null}
      {q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : null}
      {q.data && !q.data.items.length ? <EmptyState icon="download" title="エクスポート履歴はありません" /> : null}
      {q.data?.items.length ? (
        <Table caption="エクスポート履歴">
          <THead>
            <Tr>
              <Th>データ</Th>
              <Th>条件</Th>
              <Th>状態</Th>
              <Th className="text-right">件数</Th>
              <Th className="hidden md:table-cell">依頼 / 期限</Th>
              <Th className="w-32">
                <span className="sr-only">操作</span>
              </Th>
            </Tr>
          </THead>
          <TBody>
            {q.data.items.map((x) => (
              <Tr key={x.id} data-testid="export-row">
                <Td className="font-medium">{EXPORT_KIND_LABEL[x.kind] ?? x.kind}</Td>
                <Td className="text-xs">
                  {x.params.from ?? '—'} 〜 {x.params.to ?? '—'}
                  {x.params.shopId ? ` ・${shops.find((s) => s.id === x.params.shopId)?.name ?? ''}` : ''}
                </Td>
                <Td>
                  <Badge tone={EXPORT_TONE[x.status] ?? 'neutral'}>{EXPORT_STATUS_LABEL[x.status] ?? x.status}</Badge>
                  {x.error ? <p className="mt-0.5 max-w-xs break-all text-[11px] text-danger">{x.error}</p> : null}
                </Td>
                <Td className="text-right tabular">{x.row_count ?? '—'}</Td>
                <Td className="hidden text-xs md:table-cell">
                  {formatDateTime(x.created_at, tz)}
                  <p className="text-[11px] text-subtle">期限 {x.expires_at ? formatDateTime(x.expires_at, tz) : '—'}</p>
                </Td>
                <Td>
                  {x.status === 'completed' ? (
                    <Button size="xs" icon="download" onClick={() => download.mutate(x.id)} loading={download.isPending && download.variables === x.id}>
                      ダウンロード
                    </Button>
                  ) : null}
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      ) : null}
    </div>
  );
}

/** O-07 機能フラグ: organization overrides over global defaults */
export function FlagsTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useFlags();
  const set = useMutation({
    mutationFn: ({ key, enabled }: { key: string; enabled: boolean }) => opsApi.setFlag(key, enabled),
    onSuccess: (f) => {
      void qc.invalidateQueries({ queryKey: ['ops', 'flags'] });
      toast.success(`${f.key} を${f.enabled ? '有効' : '無効'}にしました`);
    },
    onError: (e) => toast.error(e),
  });
  const clear = useMutation({
    mutationFn: (key: string) => opsApi.clearFlag(key),
    onSuccess: (f) => {
      void qc.invalidateQueries({ queryKey: ['ops', 'flags'] });
      toast.success(`${f.key} を既定値に戻しました`);
    },
    onError: (e) => toast.error(e),
  });
  return (
    <div className="space-y-4">
      <Alert tone="info">法人ごとの上書き設定です。グローバルの既定値はシステム管理者が管理します。変更は監査ログに記録されます。</Alert>
      {q.isLoading ? <InlineLoading /> : null}
      {q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : null}
      {q.data && !q.data.length ? <EmptyState icon="layers" title="機能フラグはありません" /> : null}
      {q.data?.length ? (
        <Table caption="機能フラグ">
          <THead>
            <Tr>
              <Th>フラグ</Th>
              <Th>既定値</Th>
              <Th>上書き</Th>
              <Th>現在</Th>
              <Th className="w-40">
                <span className="sr-only">操作</span>
              </Th>
            </Tr>
          </THead>
          <TBody>
            {q.data.map((f) => (
              <Tr key={f.key}>
                <Td>
                  <code className="text-xs">{f.key}</code>
                  {f.description ? <p className="text-xs text-muted">{f.description}</p> : null}
                </Td>
                <Td>{f.global ? (f.global.enabled ? '有効' : '無効') : '—'}</Td>
                <Td>{f.override ? <Badge tone="info">{f.override.enabled ? '有効' : '無効'}</Badge> : <span className="text-xs text-subtle">なし</span>}</Td>
                <Td>
                  <Switch
                    label={<span className="sr-only">{f.key}</span>}
                    checked={f.enabled}
                    onChange={(v) => set.mutate({ key: f.key, enabled: v })}
                    disabled={set.isPending || clear.isPending}
                  />
                </Td>
                <Td>
                  {f.override ? (
                    <Button size="xs" variant="ghost" onClick={() => clear.mutate(f.key)} loading={clear.isPending && clear.variables === f.key}>
                      既定値に戻す
                    </Button>
                  ) : null}
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      ) : null}
    </div>
  );
}
