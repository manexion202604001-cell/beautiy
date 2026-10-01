import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { customerKeys, customersApi } from '../../../api/customers';
import type { DuplicatePair, DuplicatePairCustomer } from '../../../api/types';
import { reasonLabel } from '../../../components/appointments/CustomerPicker';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  InlineLoading,
  PageHeader,
  useToast,
} from '../../../components/ui';
import { useAuth } from '../../../lib/auth';
import { formatDate } from '../../../lib/format';

const nameOf = (c: DuplicatePairCustomer) =>
  `${c.last_name} ${c.first_name}`.trim() ||
  `${c.last_name_kana} ${c.first_name_kana}`.trim() ||
  '（氏名未登録）';

export default function Duplicates() {
  const { can, timezone: tz } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: customerKeys.pairs,
    queryFn: () => customersApi.duplicatePairs(200),
    enabled: can('customer.merge'),
  });
  const [pending, setPending] = useState<{
    pair: DuplicatePair;
    target: DuplicatePairCustomer;
    source: DuplicatePairCustomer;
  } | null>(null);

  const merge = useMutation({
    mutationFn: ({ target, source, reason }: { target: string; source: string; reason?: string }) =>
      customersApi.merge(target, source, reason),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: customerKeys.all });
      toast.success('顧客を統合しました', '統合履歴から取り消すことができます');
      setPending(null);
    },
    onError: (e) => toast.error(e),
  });
  const dismiss = useMutation({
    mutationFn: (p: DuplicatePair) => customersApi.dismissDuplicate(p.a.id, p.b.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: customerKeys.pairs });
      toast.success('別人として除外しました');
    },
    onError: (e) => toast.error(e),
  });

  if (!can('customer.merge'))
    return <ErrorState error={new Error('顧客統合の権限（customer.merge）が必要です')} />;

  const Side = ({ c, label }: { c: DuplicatePairCustomer; label: string }) => (
    <div className="min-w-0 rounded-xl bg-surface-2/60 p-3">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-subtle">{label}</p>
      <Link
        to={`/app/customers/${c.id}`}
        className="mt-0.5 block truncate text-sm font-semibold hover:text-primary hover:underline"
      >
        {nameOf(c)}
      </Link>
      <dl className="mt-1.5 space-y-0.5 text-xs text-muted">
        <div>フリガナ: {`${c.last_name_kana} ${c.first_name_kana}`.trim() || '—'}</div>
        <div>電話: {c.phone ?? '—'}</div>
        <div>メール: {c.email ?? '—'}</div>
        <div>生年月日: {c.birthday ? formatDate(c.birthday, tz, { weekday: false }) : '—'}</div>
        <div>
          来店 {c.visit_count}回 ・ 最終{' '}
          {c.last_visit_at ? formatDate(c.last_visit_at, tz, { weekday: false }) : '—'}
        </div>
      </dl>
    </div>
  );

  return (
    <div>
      <PageHeader
        title="名寄せ（重複顧客）"
        description="完全一致（電話・メール）と類似（氏名＋生年月日など）の候補です。自動では統合されません。内容を確認して統合するか、別人として除外してください。"
        back={
          <Link to="/app/customers" className="text-[13px] text-muted hover:text-fg">
            ← 顧客一覧
          </Link>
        }
      />
      {q.isLoading ? <InlineLoading /> : null}
      {q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : null}
      {q.data && !q.data.length ? (
        <EmptyState
          icon="check"
          title="重複候補はありません"
          description="新しい顧客が登録されると自動的にチェックされます。"
        />
      ) : null}
      <div className="grid gap-4 xl:grid-cols-2">
        {q.data?.map((p) => (
          <Card key={`${p.a.id}-${p.b.id}`} className="!p-4">
            <div className="mb-3 flex flex-wrap items-center gap-1.5">
              <Badge tone={p.strength === 'exact' ? 'danger' : 'warning'}>
                {p.strength === 'exact' ? '強い一致' : '類似'} {Math.round(p.score * 100)}%
              </Badge>
              {p.reasons.map((r) => (
                <Badge key={r} size="sm">
                  {reasonLabel(r)}
                </Badge>
              ))}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Side c={p.a} label="顧客 A" />
              <Side c={p.b} label="顧客 B" />
            </div>
            <div className="mt-3 flex flex-wrap justify-end gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => dismiss.mutate(p)}
                disabled={dismiss.isPending}
              >
                別人として除外
              </Button>
              <Button size="sm" onClick={() => setPending({ pair: p, target: p.b, source: p.a })}>
                B に統合
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={() => setPending({ pair: p, target: p.a, source: p.b })}
              >
                A に統合
              </Button>
            </div>
          </Card>
        ))}
      </div>
      <ConfirmDialog
        open={!!pending}
        onClose={() => setPending(null)}
        title="顧客を統合しますか？"
        description={
          pending
            ? `「${nameOf(pending.source)}」の予約・会計・メモ等を「${nameOf(pending.target)}」へ移動し、1人の顧客にまとめます。`
            : undefined
        }
        confirmLabel="統合する"
        reason
        reasonLabel="統合理由（任意）"
        loading={merge.isPending}
        onConfirm={(reason) =>
          pending && merge.mutate({ target: pending.target.id, source: pending.source.id, reason })
        }
      />
    </div>
  );
}
