import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useStaffList } from '../../../api/org';
import {
  posApi,
  TX_STATUS_LABEL,
  useTransactions,
  type TransactionQuery,
  type TransactionStatus,
} from '../../../api/pos';
import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  InlineLoading,
  Input,
  LoadMore,
  PageHeader,
  Select,
  TBody,
  THead,
  Table,
  Td,
  Th,
  Tr,
  useToast,
} from '../../../components/ui';
import { useAuth } from '../../../lib/auth';
import { formatDateTime, formatYen } from '../../../lib/format';
import { addDays, todayIn } from '../../../lib/time';
import { TxStatusBadge } from './shared';

export default function TransactionHistory() {
  const { currentShopId: shopId, timezone: tz, can } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const today = todayIn(tz);
  const [from, setFrom] = useState(addDays(today, -6));
  const [to, setTo] = useState(today);
  const [status, setStatus] = useState<TransactionStatus | ''>('');
  const [staffId, setStaffId] = useState('');
  const [exporting, setExporting] = useState<null | 'transactions' | 'items'>(null);
  const staff = useStaffList({ shopId: shopId ?? undefined });
  const query: TransactionQuery = useMemo(
    () => ({
      shopId: shopId ?? undefined,
      from: from || undefined,
      to: to || undefined,
      status: status || undefined,
      staffId: staffId || undefined,
      limit: 50,
    }),
    [shopId, from, to, status, staffId],
  );
  const q = useTransactions(query, !!shopId);
  const rows = q.data?.pages.flatMap((p) => p.items) ?? [];
  const canExport = can('export.data');

  const exportCsv = async (kind: 'transactions' | 'items') => {
    setExporting(kind);
    try {
      await posApi.exportCsv(query, kind);
    } catch (e) {
      toast.error(e);
    } finally {
      setExporting(null);
    }
  };

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        back={
          <Link
            to="/app/pos"
            className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-fg"
          >
            <Icon name="chevron-left" size={16} /> 会計
          </Link>
        }
        title="会計履歴"
        actions={
          canExport ? (
            <>
              <Button
                size="sm"
                icon="download"
                loading={exporting === 'transactions'}
                onClick={() => void exportCsv('transactions')}
              >
                会計CSV
              </Button>
              <Button
                size="sm"
                icon="download"
                loading={exporting === 'items'}
                onClick={() => void exportCsv('items')}
              >
                明細CSV
              </Button>
            </>
          ) : null
        }
      />
      <div
        className="mb-4 grid grid-cols-2 gap-3 rounded-2xl border border-border bg-surface p-4 sm:grid-cols-4"
        role="search"
        aria-label="会計の絞り込み"
      >
        <Field label="開始日">
          <Input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            max={to || undefined}
          />
        </Field>
        <Field label="終了日">
          <Input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            min={from || undefined}
          />
        </Field>
        <Field label="状態">
          <Select
            value={status}
            onChange={(e) => setStatus(e.target.value as TransactionStatus | '')}
          >
            <option value="">すべて</option>
            {(Object.keys(TX_STATUS_LABEL) as TransactionStatus[]).map((s) => (
              <option key={s} value={s}>
                {TX_STATUS_LABEL[s]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="担当">
          <Select value={staffId} onChange={(e) => setStaffId(e.target.value)}>
            <option value="">すべて</option>
            {(staff.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.display_name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {q.isLoading ? <InlineLoading /> : null}
      {q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : null}
      {q.data && !rows.length ? (
        <EmptyState icon="receipt" title="該当する会計はありません" />
      ) : null}
      {rows.length ? (
        <Table caption="会計履歴">
          <THead>
            <tr>
              <Th>日時</Th>
              <Th>会計番号</Th>
              <Th>お客様</Th>
              <Th className="hidden md:table-cell">担当</Th>
              <Th className="text-right">合計</Th>
              <Th className="hidden text-right sm:table-cell">返金</Th>
              <Th>状態</Th>
            </tr>
          </THead>
          <TBody>
            {rows.map((t) => (
              <Tr key={t.id} interactive onClick={() => navigate(`/app/pos/checkout/${t.id}`)}>
                <Td className="whitespace-nowrap tabular">
                  {formatDateTime(t.completed_at ?? t.created_at, tz)}
                </Td>
                <Td className="font-mono text-xs">
                  <Link
                    to={`/app/pos/checkout/${t.id}`}
                    className="hover:underline"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {t.transaction_number ?? '—'}
                  </Link>
                </Td>
                <Td>
                  {t.customer_name ?? 'お客様（未登録）'}
                  {t.is_new_customer ? <span className="ml-1 text-xs text-info">新規</span> : null}
                </Td>
                <Td className="hidden md:table-cell">{t.staff_name ?? '—'}</Td>
                <Td className="text-right tabular">{formatYen(t.total)}</Td>
                <Td className="hidden text-right tabular sm:table-cell">
                  {t.refunded_total ? `−${formatYen(t.refunded_total)}` : '—'}
                </Td>
                <Td>
                  <TxStatusBadge status={t.status} />
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      ) : null}
      <LoadMore
        hasMore={!!q.hasNextPage}
        loading={q.isFetchingNextPage}
        onClick={() => void q.fetchNextPage()}
      />
    </div>
  );
}
