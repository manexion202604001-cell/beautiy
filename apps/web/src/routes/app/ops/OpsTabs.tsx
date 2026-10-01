import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import {
  JOB_STATE_LABEL,
  WEBHOOK_STATUS_LABEL,
  opsApi,
  useHealth,
  useJobs,
  useOpsDashboard,
  useWebhookEvents,
  type JobState,
  type WebhookStatus,
} from '../../../api/ops';
import { StatTile } from '../../../components/charts';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  InlineLoading,
  Input,
  LoadMore,
  Select,
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
import { formatAgo, formatDateTime } from '../../../lib/format';
import { useDebounced } from '../../../lib/hooks';

export function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="scrollbar-thin max-h-80 overflow-auto rounded-lg bg-surface-2 p-3 text-xs leading-relaxed text-fg">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

/** O-01 障害ダッシュボード */
export function OpsDashboardTab({ onOpen }: { onOpen: (tab: 'jobs' | 'webhooks') => void }) {
  const { timezone: tz } = useAuth();
  const q = useOpsDashboard();
  const d = q.data;
  if (q.isLoading) return <InlineLoading />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (!d) return null;
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile label="Webhook失敗" value={`${d.webhookEvents.failed + d.webhookEvents.dead}件`} sub={`DLQ ${d.webhookEvents.dead}件`} />
        <StatTile label="ジョブ（DLQ）" value={`${d.jobs.dead}件`} sub={`再試行待ち ${d.jobs.failed}件`} />
        <StatTile label="外部連携エラー" value={`${d.integrations.failing}件`} sub={`縮退中 ${d.integrations.degraded}件`} />
        <StatTile label="メッセージ送信失敗" value={`${d.messages.failed}件`} />
        <StatTile
          label="未解決の同期競合"
          value={`${d.syncConflicts.open}件`}
          sub={
            <Link to="/app/integrations?tab=conflicts" className="text-primary hover:underline">
              競合キューを開く
            </Link>
          }
        />
      </div>
      <p className="text-xs text-subtle">集計 {formatDateTime(d.generatedAt, tz)}（1分ごとに更新）</p>
      <div className="grid gap-5 xl:grid-cols-2">
        <Card>
          <CardHeader title="最近の失敗ジョブ" actions={<Button size="sm" variant="ghost" onClick={() => onOpen('jobs')}>DLQを開く</Button>} />
          {d.jobs.recent.length ? (
            <ul className="divide-y divide-border text-[13px]">
              {d.jobs.recent.map((j) => (
                <li key={j.id} className="py-2">
                  <div className="flex items-center gap-2">
                    <code className="text-xs">{j.type}</code>
                    <Badge size="sm" tone={j.state === 'dead' ? 'danger' : 'warning'}>
                      {JOB_STATE_LABEL[j.state]}
                    </Badge>
                    <span className="ml-auto text-xs text-subtle">{formatAgo(j.created_at)}</span>
                  </div>
                  {j.last_error ? <p className="mt-0.5 line-clamp-2 break-all text-xs text-danger">{j.last_error}</p> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-muted">失敗したジョブはありません。</p>
          )}
        </Card>
        <Card>
          <CardHeader title="最近の失敗Webhook" actions={<Button size="sm" variant="ghost" onClick={() => onOpen('webhooks')}>Webhookを開く</Button>} />
          {d.webhookEvents.recent.length ? (
            <ul className="divide-y divide-border text-[13px]">
              {d.webhookEvents.recent.map((w) => (
                <li key={w.id} className="py-2">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{w.provider}</span>
                    <code className="text-xs text-muted">{w.event_type ?? '—'}</code>
                    <span className="ml-auto text-xs text-subtle">{formatAgo(w.received_at)}</span>
                  </div>
                  {w.last_error ? <p className="mt-0.5 line-clamp-2 break-all text-xs text-danger">{w.last_error}</p> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-muted">失敗したWebhookはありません。</p>
          )}
        </Card>
        <Card>
          <CardHeader title="外部連携のエラー" actions={<Link to="/app/integrations" className="text-[13px] font-medium text-primary hover:underline">外部連携へ</Link>} />
          {d.integrations.accounts.length ? (
            <ul className="divide-y divide-border text-[13px]">
              {d.integrations.accounts.map((a) => (
                <li key={a.id} className="py-2">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{a.display_name}</span>
                    <Badge size="sm" tone={a.status === 'degraded' ? 'warning' : 'danger'}>
                      {a.status === 'degraded' ? '縮退中' : 'エラー'}
                    </Badge>
                    <span className="ml-auto text-xs text-subtle">連続{a.consecutive_failures}回</span>
                  </div>
                  {a.last_error ? <p className="mt-0.5 break-all text-xs text-danger">{a.last_error}</p> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-muted">エラーのある連携はありません。</p>
          )}
        </Card>
        <Card>
          <CardHeader title="送信失敗メッセージ" actions={<Link to="/app/messages" className="text-[13px] font-medium text-primary hover:underline">メッセージへ</Link>} />
          {d.messages.recent.length ? (
            <ul className="divide-y divide-border text-[13px]">
              {d.messages.recent.map((m) => (
                <li key={m.id} className="flex items-center gap-2 py-2">
                  {m.customer_id ? (
                    <Link to={`/app/messages?customer=${m.customer_id}`} className="text-primary hover:underline">
                      スレッドを開く
                    </Link>
                  ) : null}
                  <span className="text-xs text-muted">{m.channel}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-danger">{m.error ?? '—'}</span>
                  <span className="text-xs text-subtle">{formatAgo(m.updated_at)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-muted">送信失敗はありません。</p>
          )}
        </Card>
      </div>
    </div>
  );
}

const JOB_TONE: Record<JobState, Tone> = { queued: 'neutral', running: 'info', succeeded: 'success', failed: 'warning', dead: 'danger', cancelled: 'outline' };

/** O-02 ジョブ / DLQ */
export function JobsTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const { timezone: tz } = useAuth();
  const [state, setState] = useState<JobState>('dead');
  const [typeInput, setTypeInput] = useState('');
  const type = useDebounced(typeInput.trim(), 300);
  const q = useJobs({ state, type: type || undefined });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const [detail, setDetail] = useState<(typeof items)[number] | null>(null);
  const [cancelId, setCancelId] = useState<string | null>(null);
  const done = (msg: string) => {
    void qc.invalidateQueries({ queryKey: ['ops'] });
    toast.success(msg);
  };
  const retry = useMutation({ mutationFn: opsApi.retryJob, onSuccess: () => done('ジョブを再実行キューに戻しました'), onError: (e) => toast.error(e) });
  const cancel = useMutation({
    mutationFn: opsApi.cancelJob,
    onSuccess: () => {
      setCancelId(null);
      done('ジョブを取り消しました');
    },
    onError: (e) => toast.error(e),
  });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="状態">
          <Select selectSize="sm" value={state} onChange={(e) => setState(e.target.value as JobState)}>
            {(Object.keys(JOB_STATE_LABEL) as JobState[]).map((s) => (
              <option key={s} value={s}>
                {JOB_STATE_LABEL[s]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="ジョブ種別">
          <Input inputSize="sm" value={typeInput} onChange={(e) => setTypeInput(e.target.value)} placeholder="例: message.deliver" />
        </Field>
      </div>
      {q.isLoading ? <InlineLoading /> : null}
      {q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : null}
      {q.data && !items.length ? <EmptyState icon="check" title="該当するジョブはありません" /> : null}
      {items.length ? (
        <Table caption="ジョブ一覧">
          <THead>
            <Tr>
              <Th>種別</Th>
              <Th>状態</Th>
              <Th className="text-right">試行</Th>
              <Th className="hidden md:table-cell">エラー</Th>
              <Th className="hidden sm:table-cell">作成</Th>
              <Th className="w-44">
                <span className="sr-only">操作</span>
              </Th>
            </Tr>
          </THead>
          <TBody>
            {items.map((j) => (
              <Tr key={j.id}>
                <Td>
                  <button type="button" className="text-left hover:underline" onClick={() => setDetail(j)}>
                    <code className="text-xs">{j.type}</code>
                  </button>
                </Td>
                <Td>
                  <Badge tone={JOB_TONE[j.state]}>{JOB_STATE_LABEL[j.state]}</Badge>
                </Td>
                <Td className="text-right tabular">
                  {j.attempts}/{j.max_attempts}
                </Td>
                <Td className="hidden max-w-sm md:table-cell">
                  <p className="line-clamp-2 break-all text-xs text-danger">{j.last_error ?? '—'}</p>
                </Td>
                <Td className="hidden text-xs sm:table-cell">{formatDateTime(j.created_at, tz)}</Td>
                <Td>
                  <div className="flex justify-end gap-1">
                    {j.state === 'dead' || j.state === 'failed' ? (
                      <Button size="xs" icon="refresh" onClick={() => retry.mutate(j.id)} loading={retry.isPending && retry.variables === j.id}>
                        再実行
                      </Button>
                    ) : null}
                    {['queued', 'dead', 'failed'].includes(j.state) ? (
                      <Button size="xs" variant="ghost" onClick={() => setCancelId(j.id)}>
                        取消
                      </Button>
                    ) : null}
                  </div>
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      ) : null}
      <LoadMore hasMore={!!q.hasNextPage} loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()} />
      <Dialog open={!!detail} onClose={() => setDetail(null)} size="lg" title={detail?.type ?? ''} description={detail ? `ID ${detail.id}` : undefined}>
        {detail ? (
          <div className="space-y-3 text-[13px]">
            <p>
              キュー {detail.queue} ・実行予定 {formatDateTime(detail.run_at, tz)} ・重複キー {detail.dedupe_key ?? '—'}
            </p>
            {detail.last_error ? <p className="break-all text-danger">{detail.last_error}</p> : null}
            <JsonBlock value={detail.payload} />
          </div>
        ) : null}
      </Dialog>
      <ConfirmDialog
        open={!!cancelId}
        onClose={() => setCancelId(null)}
        title="ジョブを取り消しますか？"
        description="取り消したジョブは実行されません。"
        tone="danger"
        confirmLabel="取り消す"
        loading={cancel.isPending}
        onConfirm={() => cancelId && cancel.mutate(cancelId)}
      />
    </div>
  );
}

const WEBHOOK_TONE: Record<WebhookStatus, Tone> = { received: 'neutral', processing: 'info', processed: 'success', failed: 'warning', ignored: 'outline', dead: 'danger' };

/** O-03 Webhook イベント */
export function WebhooksTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const { timezone: tz } = useAuth();
  const [status, setStatus] = useState<'' | WebhookStatus>('failed');
  const [providerInput, setProviderInput] = useState('');
  const provider = useDebounced(providerInput.trim(), 300);
  const q = useWebhookEvents({ status: status || undefined, provider: provider || undefined });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const [detail, setDetail] = useState<(typeof items)[number] | null>(null);
  const reprocess = useMutation({
    mutationFn: opsApi.reprocess,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['ops'] });
      toast.success('再処理を受け付けました');
    },
    onError: (e) => toast.error(e),
  });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="状態">
          <Select selectSize="sm" value={status} onChange={(e) => setStatus(e.target.value as '' | WebhookStatus)}>
            <option value="">すべて</option>
            {(Object.keys(WEBHOOK_STATUS_LABEL) as WebhookStatus[]).map((s) => (
              <option key={s} value={s}>
                {WEBHOOK_STATUS_LABEL[s]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="プロバイダ">
          <Input inputSize="sm" value={providerInput} onChange={(e) => setProviderInput(e.target.value)} placeholder="line / stripe / mock_booking" />
        </Field>
      </div>
      {q.isLoading ? <InlineLoading /> : null}
      {q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : null}
      {q.data && !items.length ? <EmptyState icon="check" title="該当するイベントはありません" /> : null}
      {items.length ? (
        <Table caption="Webhookイベント">
          <THead>
            <Tr>
              <Th>プロバイダ / 種別</Th>
              <Th>状態</Th>
              <Th>署名</Th>
              <Th className="hidden md:table-cell">エラー</Th>
              <Th className="hidden sm:table-cell">受信</Th>
              <Th className="w-28">
                <span className="sr-only">操作</span>
              </Th>
            </Tr>
          </THead>
          <TBody>
            {items.map((w) => (
              <Tr key={w.id}>
                <Td>
                  <button type="button" className="text-left hover:underline" onClick={() => setDetail(w)}>
                    <span className="font-medium">{w.provider}</span> <code className="text-xs text-muted">{w.event_type ?? '—'}</code>
                  </button>
                </Td>
                <Td>
                  <Badge tone={WEBHOOK_TONE[w.status]}>{WEBHOOK_STATUS_LABEL[w.status]}</Badge>
                </Td>
                <Td>{w.signature_valid ? <Badge tone="success">有効</Badge> : <Badge tone="danger">不正</Badge>}</Td>
                <Td className="hidden max-w-sm md:table-cell">
                  <p className="line-clamp-2 break-all text-xs text-danger">{w.last_error ?? '—'}</p>
                </Td>
                <Td className="hidden text-xs sm:table-cell">{formatDateTime(w.received_at, tz)}</Td>
                <Td>
                  {w.signature_valid && ['failed', 'dead', 'ignored'].includes(w.status) ? (
                    <Button size="xs" icon="refresh" onClick={() => reprocess.mutate(w.id)} loading={reprocess.isPending && reprocess.variables === w.id}>
                      再処理
                    </Button>
                  ) : null}
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      ) : null}
      <LoadMore hasMore={!!q.hasNextPage} loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()} />
      <Dialog open={!!detail} onClose={() => setDetail(null)} size="lg" title={`${detail?.provider ?? ''} ${detail?.event_type ?? ''}`} description={detail ? `イベントID ${detail.event_id ?? '—'}` : undefined}>
        {detail ? <JsonBlock value={detail.payload} /> : null}
      </Dialog>
    </div>
  );
}

/** ヘルス: queue backlog, worker lag, DB latency */
export function HealthTab() {
  const { timezone: tz } = useAuth();
  const q = useHealth();
  const d = q.data;
  if (q.isLoading) return <InlineLoading />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (!d) return null;
  const sec = (n: number) => (n < 60 ? `${n}秒` : n < 3600 ? `${Math.round(n / 60)}分` : `${Math.round(n / 3600)}時間`);
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Badge tone={d.status === 'ok' ? 'success' : 'warning'} dot>
          {d.status === 'ok' ? '正常' : 'ワーカー遅延'}
        </Badge>
        <span className="text-xs text-subtle">確認 {formatDateTime(d.checkedAt, tz)}（30秒ごとに更新）</span>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="DB応答" value={`${d.db.latencyMs}ms`} />
        <StatTile label="ワーカー遅延（全体）" value={sec(d.workerLagSec)} sub={`実行待ち ${d.clusterReadyJobs}件`} />
        <StatTile label="この法人の遅延" value={sec(d.orgWorkerLagSec)} sub={`最古の待機 ${sec(d.oldestQueuedAgeSec)}`} />
        <StatTile label="キュー" value={`${d.queue.queued}件`} sub={`実行可能 ${d.queue.ready} ・実行中 ${d.queue.running}`} />
        <StatTile label="再試行待ち" value={`${d.queue.failed}件`} />
        <StatTile label="DLQ" value={`${d.queue.dead}件`} />
      </div>
    </div>
  );
}
