import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { messagingApi, messagingKeys, useSegments, type Segment } from '../../../api/messaging';
import {
  Alert,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  InlineLoading,
  Input,
  Segmented,
  Textarea,
  useToast,
} from '../../../components/ui';
import { isApiError } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { cn } from '../../../lib/cn';
import { formatDate } from '../../../lib/format';
import { SegmentBuilder, SegmentPreview } from './SegmentBuilder';
import {
  describeRule,
  emptyState,
  fromRule,
  newCondition,
  toRule,
  validateState,
  type BuilderState,
} from './segment-dsl';

/** S-52 セグメント: saved segments + visual builder with live preview */
export function SegmentsTab() {
  const { timezone: tz } = useAuth();
  const segments = useSegments();
  const [editing, setEditing] = useState<Segment | 'new' | null>(null);
  const list = segments.data?.items ?? [];

  useEffect(() => {
    if (editing === null && segments.data && !list.length) setEditing('new');
  }, [editing, segments.data, list.length]);

  return (
    <div className="grid gap-5 lg:grid-cols-[18rem_1fr]">
      <Card padded={false} className="h-fit">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-[15px] font-semibold">保存済みセグメント</h2>
          <Button size="sm" icon="plus" onClick={() => setEditing('new')}>
            新規
          </Button>
        </div>
        {segments.isLoading ? <div className="px-4"><InlineLoading /></div> : null}
        {segments.error ? <ErrorState error={segments.error} onRetry={() => void segments.refetch()} /> : null}
        <ul className="divide-y divide-border">
          {list.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => setEditing(s)}
                aria-current={editing !== 'new' && editing?.id === s.id ? 'true' : undefined}
                className={cn(
                  'w-full px-4 py-3 text-left hover:bg-surface-2',
                  editing !== 'new' && editing?.id === s.id && 'bg-primary-soft/60',
                )}
              >
                <p className="truncate text-sm font-medium">{s.name}</p>
                <p className="line-clamp-2 text-xs text-muted">{describeRule(s.rule)}</p>
                <p className="mt-0.5 text-[11px] text-subtle">更新 {formatDate(s.updated_at, tz, { weekday: false })}</p>
              </button>
            </li>
          ))}
        </ul>
        {!segments.isLoading && !list.length ? (
          <p className="px-4 py-4 text-[13px] text-muted">保存済みのセグメントはありません。</p>
        ) : null}
      </Card>
      {editing ? (
        <SegmentEditor key={editing === 'new' ? 'new' : editing.id} segment={editing === 'new' ? null : editing} onDone={(s) => setEditing(s)} />
      ) : (
        <EmptyState icon="filter" title="セグメントを選択してください" description="保存済みセグメントを選ぶか、新規作成してください。" />
      )}
    </div>
  );
}

function SegmentEditor({ segment, onDone }: { segment: Segment | null; onDone: (s: Segment | null) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { currentShopId } = useAuth();
  const [name, setName] = useState(segment?.name ?? '');
  const [description, setDescription] = useState(segment?.description ?? '');
  const parsed = segment ? fromRule(segment.rule) : null;
  const [mode, setMode] = useState<'visual' | 'json'>(segment && !parsed ? 'json' : 'visual');
  const [state, setState] = useState<BuilderState>(
    () =>
      parsed ?? (segment ? emptyState() : { match: 'all', items: [newCondition('last_visit_days_gt'), newCondition('no_future_appointment')] }),
  );
  const [json, setJson] = useState(() => JSON.stringify(segment?.rule ?? toRule(state), null, 2));
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [previewScope, setPreviewScope] = useState<'all' | 'shop'>('all');
  const [deleting, setDeleting] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);

  const switchMode = (m: 'visual' | 'json') => {
    if (m === 'json') {
      setJson(JSON.stringify(toRule(state), null, 2));
      setJsonError(null);
      setMode('json');
      return;
    }
    try {
      const next = fromRule(JSON.parse(json));
      if (!next) {
        setJsonError('この条件は入れ子が深いため、ビジュアル編集できません（JSONで編集してください）');
        return;
      }
      setState(next);
      setMode('visual');
    } catch {
      setJsonError('JSONの形式が正しくありません');
    }
  };

  const currentRule = () => {
    if (mode === 'visual') return toRule(state);
    try {
      return JSON.parse(json);
    } catch {
      return undefined;
    }
  };

  const save = useMutation({
    mutationFn: () => {
      const rule = currentRule();
      const input = { name: name.trim(), description: description.trim() || null, rule };
      return segment ? messagingApi.updateSegment(segment.id, input) : messagingApi.createSegment(input);
    },
    onSuccess: (s) => {
      void qc.invalidateQueries({ queryKey: messagingKeys.segments });
      toast.success(segment ? 'セグメントを更新しました' : 'セグメントを保存しました');
      onDone(s);
    },
    onError: (e) => {
      if (isApiError(e) && e.category === 'validation' && mode === 'json') setJsonError(e.message);
      toast.error(e);
    },
  });
  const del = useMutation({
    mutationFn: () => messagingApi.deleteSegment(segment!.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: messagingKeys.segments });
      toast.success('セグメントを削除しました');
      onDone(null);
    },
    onError: (e) => toast.error(e),
  });

  const errors = mode === 'visual' ? validateState(state) : [];
  const canSave = !!name.trim() && !errors.length && (mode === 'json' || !!toRule(state));

  return (
    <div className="grid gap-5 xl:grid-cols-[1fr_22rem]">
      <Card>
        <CardHeader
          title={segment ? 'セグメントを編集' : '新しいセグメント'}
          actions={
            <Segmented
              size="sm"
              label="編集方法"
              value={mode}
              onChange={switchMode}
              options={[
                { value: 'visual', label: 'ビジュアル' },
                { value: 'json', label: 'JSON' },
              ]}
            />
          }
        />
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="セグメント名" required error={nameError}>
              <Input
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setNameError(null);
                }}
                maxLength={100}
                placeholder="例: 休眠60日・次回予約なし"
              />
            </Field>
            <Field label="説明" optional>
              <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
            </Field>
          </div>
          {mode === 'visual' ? (
            <SegmentBuilder value={state} onChange={setState} />
          ) : (
            <Field label="条件（JSON DSL）" error={jsonError} hint='例: {"all":[{"type":"last_visit_days_gt","days":45},{"type":"no_future_appointment"}]}'>
              <Textarea
                value={json}
                onChange={(e) => {
                  setJson(e.target.value);
                  setJsonError(null);
                }}
                rows={14}
                className="font-mono text-xs"
                spellCheck={false}
              />
            </Field>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
            {segment ? (
              <Button variant="ghost" icon="trash" className="text-danger!" onClick={() => setDeleting(true)}>
                削除
              </Button>
            ) : (
              <span />
            )}
            <Button
              variant="primary"
              icon="check"
              loading={save.isPending}
              disabled={!canSave}
              onClick={() => {
                if (!name.trim()) setNameError('セグメント名を入力してください');
                else save.mutate();
              }}
            >
              保存
            </Button>
          </div>
        </div>
      </Card>
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-[15px] font-semibold">プレビュー</h3>
          <Segmented
            size="sm"
            label="プレビューの対象店舗"
            value={previewScope}
            onChange={setPreviewScope}
            options={[
              { value: 'all', label: '全店舗' },
              { value: 'shop', label: 'この店舗' },
            ]}
          />
        </div>
        {mode === 'visual' ? (
          <SegmentPreview compact state={state} shopId={previewScope === 'shop' ? (currentShopId ?? undefined) : undefined} />
        ) : (
          <Alert tone="info">JSON編集中はビジュアルに切り替えるとプレビューできます。</Alert>
        )}
      </div>
      <ConfirmDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title="セグメントを削除しますか？"
        description="作成済みのキャンペーンは条件のスナップショットを保持するため影響を受けません。配信予定のキャンペーンで使用中の場合は削除できません。"
        tone="danger"
        confirmLabel="削除する"
        loading={del.isPending}
        onConfirm={() => del.mutate()}
      />
    </div>
  );
}
