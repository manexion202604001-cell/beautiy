import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { ORDER_STATUS_LABEL, storeApi } from '../../../api/commerce';
import { Badge, Button, EmptyState, ErrorState, InlineLoading } from '../../../components/ui';
import { formatDateTime, formatYen } from '../../../lib/format';
import { OrderView } from './OrderView';

/** マイページ「ご注文」: my EC orders + detail */
export function MyOrders({ slug, token }: { slug: string; token: string }) {
  const q = useQuery({
    queryKey: ['public', 'my-orders', token],
    queryFn: () => storeApi.myOrders(token),
  });
  const [openId, setOpenId] = useState<string | null>(null);
  const open = q.data?.find((o) => o.id === openId);
  if (q.isLoading) return <InlineLoading />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (open) {
    return (
      <div className="space-y-3">
        <Button size="sm" variant="ghost" icon="chevron-left" onClick={() => setOpenId(null)}>
          注文一覧に戻る
        </Button>
        <OrderView order={open} token={token} />
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {!q.data?.length ? (
        <EmptyState
          icon="bag"
          title="ご注文はまだありません"
          action={
            <Link to={`/store/${slug}`} className="text-[13px] font-medium text-primary">
              オンラインストアを見る ›
            </Link>
          }
        />
      ) : (
        <ul className="space-y-2.5" data-testid="my-orders">
          {q.data.map((o) => (
            <li key={o.id}>
              <button
                type="button"
                onClick={() => setOpenId(o.id)}
                className="w-full rounded-2xl border border-border bg-surface p-4 text-left hover:border-border-strong"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[15px] font-semibold tabular">{formatYen(o.total)}</p>
                    <p className="text-xs text-muted">
                      {o.orderNumber} ・ {formatDateTime(o.createdAt)}
                    </p>
                  </div>
                  <Badge
                    size="sm"
                    tone={
                      o.status === 'pending'
                        ? 'warning'
                        : o.status === 'cancelled'
                          ? 'neutral'
                          : 'success'
                    }
                  >
                    {ORDER_STATUS_LABEL[o.status]}
                  </Badge>
                </div>
                <p className="mt-2 truncate text-[13px]">
                  {o.items.map((i) => `${i.name}×${i.quantity}`).join('、')}
                </p>
              </button>
            </li>
          ))}
        </ul>
      )}
      <Link to={`/store/${slug}`} className="block text-center text-[13px] text-primary">
        オンラインストアへ ›
      </Link>
    </div>
  );
}
