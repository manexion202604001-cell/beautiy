import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import {
  CONFLICT_TYPE_LABEL,
  RESOLUTION_LABEL,
  integrationKeys,
  integrationsApi,
  useConflicts,
  useSyncStatus,
  type ConflictType,
  type Resolution,
  type SyncConflict,
} from '../../../api/integrations';
import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  InlineLoading,
  Input,
  LoadMore,
  Segmented,
  Select,
  Textarea,
  useToast,
} from '../../../components/ui';
import { newIdempotencyKey } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { formatAgo, formatDateTime, formatTimeRange } from '../../../lib/format';
import { STATUS_LABEL, STATUS_TONE, providerLabel } from './AccountsTab';

/** O-04 同期ステータス（店舗別） */
export function StatusTab() {
  const { timezone: tz } = useAuth();
  const q = useSyncStatus();
  return (
    <div className="space-y-4">
      {q.isLoading ? <InlineLoading /> : null}
      {q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : null}
      {q.data && !q.data.shops.length ? <EmptyState icon="plug" title="有効な外部連携はありません" /> : null}
      {q.data ? <p className="text-xs text-subtle">確認時刻 {formatDateTime(q.data.checkedAt, tz)}（30秒ごとに更新）</p> : null}
      <div className="grid gap-4 lg:grid-cols-2">
        {(q.data?.shops ?? []).map((s) => (
          <Card key={s.shopId ?? 'org'}>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-[15px] font-semibold">{s.shopName ?? '法人'}</h2>
              <div className="flex gap-2">
                {s.degraded ? (
                  <Badge tone="warning" dot>
                    縮退中
                  </Badge>
                ) : (
                  <Badge tone="success" dot>
                    正常
                  </Badge>
                )}
                {s.openConflicts ? <Badge tone="danger">未解決の競合 {s.openConflicts}件</Badge> : null}
              </div>
            </div>
            <ul className="space-y-3">
              {s.accounts.map((a) => (
                <li key={a.integrationAccountId} className="rounded-xl border border-border p-3 text-[13px]">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{a.displayName}</span>
                    <span className="text-xs text-muted">{providerLabel(a.provider)}</span>
                    <Badge size="sm" tone={STATUS_TONE[a.status] ?? 'neutral'} className="ml-auto">
                      {STATUS_LABEL[a.status] ?? a.status}
                    </Badge>
                  </div>
                  <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                    <dt className="text-muted">最終成功</dt>
                    <dd>{a.lastSuccessAt ? `${formatDateTime(a.lastSuccessAt, tz)}（${formatAgo(a.lastSuccessAt)}）` : '—'}</dd>
                    <dt className="text-muted">連続失敗</dt>
                    <dd>{a.consecutiveFailures}回</dd>
                    <dt className="text-muted">未反映の枠</dt>
                    <dd>{a.pushBlocks ? `${a.unsyncedBlocks}件` : '枠反映なし'}</dd>
                    <dt className="text-muted">直近のジョブ</dt>
                    <dd>{a.lastJob ? `${a.lastJob.mode === 'full' ? '全件' : '差分'} ${a.lastJob.state}（${formatAgo(a.lastJob.createdAt)}）` : '—'}</dd>
                  </dl>
                  {a.lastError ? <p className="mt-2 break-all text-xs text-danger">{a.lastError}</p> : null}
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </div>
    </div>
  );
}

/** O-04 競合キュー: keep internal / accept external / ignore / manual link */
export function ConflictsTab() {
  const [state, setState] = useState<'open' | 'resolved' | 'ignored'>('open');
  const [type, setType] = useState<'' | ConflictType>('');
  const q = useConflicts({ state, type: type || undefined });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const [resolving, setResolving] = useState<{ c: SyncConflict; resolution: Resolution } | null>(null);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Segmented
          label="状態"
          value={state}
          onChange={setState}
          options={[
            { value: 'open', label: '未解決' },
            { value: 'resolved', label: '解決済み' },
            { value: 'ignored', label: '無視' },
          ]}
        />
        <Field label="種類">
          <Select selectSize="sm" value={type} onChange={(e) => setType(e.target.value as '' | ConflictType)}>
            <option value="">すべて</option>
            {(Object.keys(CONFLICT_TYPE_LABEL) as ConflictType[]).map((t) => (
              <option key={t} value={t}>
                {CONFLICT_TYPE_LABEL[t]}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {q.isLoading ? <InlineLoading /> : null}
      {q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : null}
      {q.data && !items.length ? (
        <EmptyState icon="check" title={state === 'open' ? '未解決の競合はありません' : '該当する競合はありません'} />
      ) : null}
      <ul className="space-y-3">
        {items.map((c) => (
          <ConflictItem key={c.id} c={c} onResolve={(resolution) => setResolving({ c, resolution })} />
        ))}
      </ul>
      <LoadMore hasMore={!!q.hasNextPage} loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()} />
      {resolving ? <ResolveDialog conflict={resolving.c} resolution={resolving.resolution} onClose={() => setResolving(null)} /> : null}
    </div>
  );
}

function ConflictItem({ c, onResolve }: { c: SyncConflict; onResolve: (r: Resolution) => void }) {
  const { timezone: tz } = useAuth();
  const b = c.external_booking;
  const details = (c.details ?? {}) as Record<string, unknown>;
  const message = typeof details.message === 'string' ? details.message : typeof details.reason === 'string' ? details.reason : null;
  return (
    <li className="rounded-2xl border border-border bg-surface p-4 shadow-card" data-testid="conflict-item">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="danger">{CONFLICT_TYPE_LABEL[c.conflict_type] ?? c.conflict_type}</Badge>
        <span className="text-[13px] font-medium">{c.integration_name ?? providerLabel(c.provider ?? '')}</span>
        {c.external_id ? <code className="text-xs text-muted">外部ID {c.external_id}</code> : null}
        <span className="ml-auto text-xs text-subtle">{formatDateTime(c.created_at, tz)}</span>
      </div>
      <dl className="mt-3 grid max-w-xl grid-cols-[9rem_1fr] gap-x-4 gap-y-1 text-[13px]">
        {b?.start && b.end ? (
          <>
            <dt className="text-xs text-muted">外部予約の日時</dt>
            <dd>
              {formatDateTime(b.start, tz).split(' ')[0]} {formatTimeRange(b.start, b.end, tz)}
            </dd>
          </>
        ) : null}
        {b?.customer?.name || b?.customer?.kana ? (
          <>
            <dt className="text-xs text-muted">お客様</dt>
            <dd>{b.customer.name ?? b.customer.kana}</dd>
          </>
        ) : null}
        {b?.staffExternalId ? (
          <>
            <dt className="text-xs text-muted">外部スタッフコード</dt>
            <dd>{b.staffExternalId}</dd>
          </>
        ) : null}
        {b?.menuExternalIds?.length ? (
          <>
            <dt className="text-xs text-muted">外部メニューコード</dt>
            <dd>{b.menuExternalIds.join(', ')}</dd>
          </>
        ) : null}
        {c.appointment_id ? (
          <>
            <dt className="text-xs text-muted">関連する自社予約</dt>
            <dd>
              <Link className="text-primary hover:underline" to={`/app/calendar?appt=${c.appointment_id}`}>
                予約を開く
              </Link>
            </dd>
          </>
        ) : null}
      </dl>
      {message ? <p className="mt-2 text-xs text-muted">{message}</p> : null}
      {c.state === 'open' ? (
        <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
          <Button size="sm" onClick={() => onResolve('keep_internal')}>
            {RESOLUTION_LABEL.keep_internal}
          </Button>
          <Button size="sm" variant="primary" onClick={() => onResolve('accept_external')}>
            {c.conflict_type === 'push_failed' ? '枠の反映を再試行' : RESOLUTION_LABEL.accept_external}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onResolve('manual')}>
            {RESOLUTION_LABEL.manual}・予約に紐付け
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onResolve('ignore')}>
            {RESOLUTION_LABEL.ignore}
          </Button>
        </div>
      ) : (
        <p className="mt-3 text-xs text-muted">
          {c.resolution ? RESOLUTION_LABEL[c.resolution] : '—'} ・{c.resolved_at ? formatDateTime(c.resolved_at, tz) : ''}
        </p>
      )}
    </li>
  );
}

const RESOLUTION_HELP: Record<Resolution, string> = {
  keep_internal: '自社の予約をそのまま残します。外部媒体側の予約は媒体の管理画面で調整してください。',
  accept_external: '外部の予約を反映します。時間が重なる自社の予約は取消されます（スタッフ・メニュー未対応の場合は現在の対応表で再反映）。',
  ignore: '何もせずに閉じます。',
  manual: 'スタッフが手動で対応済みとして閉じます。手入力した自社予約と紐付ける場合は予約IDを指定してください。',
};

function ResolveDialog({ conflict, resolution, onClose }: { conflict: SyncConflict; resolution: Resolution; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [note, setNote] = useState('');
  const [appointmentId, setAppointmentId] = useState('');
  const [key] = useState(newIdempotencyKey);
  const uuidOk = !appointmentId || /^[0-9a-f-]{36}$/i.test(appointmentId.trim());
  const m = useMutation({
    mutationFn: () =>
      integrationsApi.resolve(
        conflict.id,
        { resolution, note: note.trim() || undefined, ...(resolution === 'manual' && appointmentId.trim() ? { appointmentId: appointmentId.trim() } : {}) },
        key,
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: integrationKeys.all });
      toast.success('競合を解決しました');
      onClose();
    },
    onError: (e) => toast.error(e),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={`競合の解決: ${RESOLUTION_LABEL[resolution]}`}
      dismissable={!m.isPending}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={m.isPending}>
            やめる
          </Button>
          <Button variant={resolution === 'accept_external' ? 'danger' : 'primary'} onClick={() => m.mutate()} loading={m.isPending} disabled={!uuidOk}>
            実行する
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Alert tone={resolution === 'accept_external' ? 'warning' : 'info'}>{RESOLUTION_HELP[resolution]}</Alert>
        {resolution === 'manual' && conflict.external_booking_id ? (
          <Field label="紐付ける自社予約のID" optional hint="予約詳細のURL末尾などで確認できます" error={uuidOk ? null : '予約IDの形式が正しくありません'}>
            <Input value={appointmentId} onChange={(e) => setAppointmentId(e.target.value)} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
          </Field>
        ) : null}
        <Field label="メモ" optional>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={1000} />
        </Field>
      </div>
    </Dialog>
  );
}
