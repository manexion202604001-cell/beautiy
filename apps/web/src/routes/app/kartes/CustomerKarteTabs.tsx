import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import {
  FORM_KIND_LABEL,
  RESPONSE_STATUS_LABEL,
  formKeys,
  useFormResponses,
} from '../../../api/forms';
import { karteKeys, kartesApi, useKartes } from '../../../api/kartes';
import {
  Badge,
  Button,
  ButtonLink,
  EmptyState,
  ErrorState,
  InlineLoading,
  LoadMore,
  useToast,
} from '../../../components/ui';
import { useAuth } from '../../../lib/auth';
import { formatDateTime } from '../../../lib/format';
import { FormFillDialog } from './FormFillDialog';
import { FormResponseDrawer } from './FormResponseDrawer';
import { KarteCard } from './KarteCard';
import { SendFormDialog } from './SendFormDialog';

/** 顧客詳細「カルテ」タブ */
export function CustomerKartesTab({
  customerId,
  readOnly,
}: {
  customerId: string;
  readOnly?: boolean;
}) {
  const { can, timezone: tz, currentShopId } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useKartes({ customerId, limit: 20 });
  const rows = q.data?.pages.flatMap((p) => p.items) ?? [];
  const [duplicating, setDuplicating] = useState(false);
  const writable = can('karte.write') && !readOnly;

  const duplicate = async () => {
    const latest = rows[0];
    if (!latest) return;
    setDuplicating(true);
    try {
      const created = await kartesApi.duplicate(latest.id, { shopId: currentShopId ?? undefined });
      void qc.invalidateQueries({ queryKey: karteKeys.all });
      toast.success('前回カルテを複製しました');
      navigate(`/app/kartes/${created.id}`);
    } catch (e) {
      toast.error(e);
    } finally {
      setDuplicating(false);
    }
  };

  return (
    <div className="space-y-4">
      {writable ? (
        <div className="flex flex-wrap gap-2">
          <ButtonLink
            to={`/app/kartes/new?customerId=${customerId}`}
            variant="primary"
            size="sm"
            icon="plus"
          >
            新しいカルテ
          </ButtonLink>
          {rows.length ? (
            <Button size="sm" icon="copy" loading={duplicating} onClick={() => void duplicate()}>
              前回カルテを複製
            </Button>
          ) : null}
        </div>
      ) : null}
      {q.isLoading ? <InlineLoading /> : null}
      {q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : null}
      {q.data && !rows.length ? <EmptyState icon="file" title="カルテはまだありません" /> : null}
      <ul className="grid gap-3 md:grid-cols-2">
        {rows.map((k) => (
          <KarteCard key={k.id} k={k} tz={tz} showCustomer={false} />
        ))}
      </ul>
      <LoadMore
        hasMore={!!q.hasNextPage}
        loading={q.isFetchingNextPage}
        onClick={() => void q.fetchNextPage()}
      />
    </div>
  );
}

/** 顧客詳細「書類」タブ: カウンセリング・同意書・事前問診の回答 */
export function CustomerFormsTab({
  customerId,
  customerName,
  readOnly,
}: {
  customerId: string;
  customerName: string;
  readOnly?: boolean;
}) {
  const { can, timezone: tz } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useFormResponses({ customerId });
  const rows = q.data?.pages.flatMap((p) => p.items) ?? [];
  const [filling, setFilling] = useState(false);
  const [sending, setSending] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      {!readOnly ? (
        <div className="flex flex-wrap gap-2">
          {can('karte.write') ? (
            <Button variant="primary" size="sm" icon="edit" onClick={() => setFilling(true)}>
              店頭で記入・署名
            </Button>
          ) : null}
          {can('customer.write') || can('karte.write') ? (
            <Button size="sm" icon="send" onClick={() => setSending(true)}>
              リンクを送る
            </Button>
          ) : null}
        </div>
      ) : null}
      {q.isLoading ? <InlineLoading /> : null}
      {q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : null}
      {q.data && !rows.length ? (
        <EmptyState
          icon="file"
          title="書類はまだありません"
          description="カウンセリングシート・同意書・事前問診の回答が表示されます。"
        />
      ) : null}
      {rows.length ? (
        <ul className="divide-y divide-border rounded-2xl border border-border bg-surface">
          {rows.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => setOpenId(r.id)}
                className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-2/60"
              >
                <Badge size="sm">{FORM_KIND_LABEL[r.kind]}</Badge>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {r.template_name}{' '}
                    <span className="text-xs text-muted">v{r.template_version}</span>
                  </span>
                  <span className="text-xs text-muted">
                    {r.submitted_at
                      ? `提出 ${formatDateTime(r.submitted_at, tz)}`
                      : `発行 ${formatDateTime(r.created_at, tz)}`}
                    {r.signer_name ? ` ・ 署名 ${r.signer_name}` : ''}
                  </span>
                </span>
                <Badge
                  size="sm"
                  tone={
                    r.status === 'submitted'
                      ? 'success'
                      : r.status === 'voided'
                        ? 'neutral'
                        : 'warning'
                  }
                >
                  {RESPONSE_STATUS_LABEL[r.status]}
                </Badge>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <LoadMore
        hasMore={!!q.hasNextPage}
        loading={q.isFetchingNextPage}
        onClick={() => void q.fetchNextPage()}
      />
      {filling ? (
        <FormFillDialog
          customerId={customerId}
          customerName={customerName}
          defaultKind="counseling"
          onClose={() => setFilling(false)}
          onSubmitted={() => {
            setFilling(false);
            toast.success('書類を提出しました');
            void qc.invalidateQueries({ queryKey: formKeys.all });
          }}
        />
      ) : null}
      {sending ? (
        <SendFormDialog
          customerId={customerId}
          defaultKind="consent"
          onClose={() => setSending(false)}
        />
      ) : null}
      <FormResponseDrawer id={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}
