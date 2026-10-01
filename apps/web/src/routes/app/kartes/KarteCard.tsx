import { Link } from 'react-router';
import type { KarteListItem } from '../../../api/kartes';
import { Badge, Icon } from '../../../components/ui';
import { formatDate } from '../../../lib/format';

export function KarteCard({
  k,
  tz,
  showCustomer = true,
}: {
  k: KarteListItem;
  tz: string;
  showCustomer?: boolean;
}) {
  return (
    <li className="rounded-2xl border border-border bg-surface shadow-card transition-colors hover:border-border-strong">
      <Link
        to={`/app/kartes/${k.id}`}
        className="block p-4"
        aria-label={`${formatDate(k.visit_date, tz)}のカルテを開く`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold">{formatDate(k.visit_date, tz)}</p>
            <p className="text-xs text-muted">
              {k.template_name ?? '自由記入'} ・ {k.staff_name ?? '—'}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {k.asset_count ? (
              <Badge size="sm">
                <Icon name="layers" size={12} /> {k.asset_count}
              </Badge>
            ) : null}
            {k.shared_with_customer ? (
              <Badge size="sm" tone="primary">
                共有中
              </Badge>
            ) : null}
          </div>
        </div>
        {k.note ? <p className="mt-2 line-clamp-2 text-[13px] text-muted">{k.note}</p> : null}
      </Link>
      {showCustomer ? (
        <div className="border-t border-border px-4 py-2">
          <Link
            to={`/app/customers/${k.customer_id}?tab=kartes`}
            className="text-xs text-primary hover:underline"
          >
            お客様の詳細・カルテ履歴
          </Link>
        </div>
      ) : null}
    </li>
  );
}
