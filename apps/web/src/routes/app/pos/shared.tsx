import { TX_STATUS_LABEL, TX_STATUS_TONE, type TransactionStatus } from '../../../api/pos';
import { Badge } from '../../../components/ui';
import { formatYen } from '../../../lib/format';
import { taxBreakdownRows, type TaxBucket } from '../../../lib/money';

export function TxStatusBadge({ status }: { status: TransactionStatus }) {
  return (
    <Badge size="sm" tone={TX_STATUS_TONE[status]}>
      {TX_STATUS_LABEL[status]}
    </Badge>
  );
}

/** 税率別内訳 (per-rate taxable amount and included tax) */
export function TaxBreakdown({
  breakdown,
}: {
  breakdown: Record<string, TaxBucket> | null | undefined;
}) {
  const rows = taxBreakdownRows(breakdown);
  if (!rows.length) return null;
  return (
    <dl className="space-y-0.5 text-xs text-muted" data-testid="tax-breakdown">
      {rows.map((r) => (
        <div key={r.rateBp} className="flex justify-between gap-3">
          <dt>
            {r.label} {formatYen(r.taxable)}
          </dt>
          <dd className="tabular">（内消費税 {formatYen(r.tax)}）</dd>
        </div>
      ))}
    </dl>
  );
}
