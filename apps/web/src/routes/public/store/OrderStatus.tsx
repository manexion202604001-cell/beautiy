import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { storeApi } from '../../../api/commerce';
import { publicApi } from '../../../api/public';
import { EmptyState, PageSpinner } from '../../../components/ui';
import { customerSession } from '../../../lib/session';
import { PublicShell } from '../PublicShell';
import { OrderView } from './OrderView';
import { StoreHeader } from './StoreHeader';

/**
 * /store/:shopSlug/orders/:orderId — order result. The payment is completed by the provider
 * (webhook); the page polls the order while it is waiting for payment (決済待ち).
 */
export default function OrderStatus() {
  const { shopSlug = '', orderId = '' } = useParams();
  const session = customerSession.get(shopSlug);
  const shop = useQuery({
    queryKey: ['public', 'shop', shopSlug],
    queryFn: () => publicApi.shop(shopSlug),
    retry: false,
  });
  const q = useQuery({
    queryKey: ['public', 'my-order', session?.token ?? '', orderId],
    queryFn: () => storeApi.myOrder(session!.token, orderId),
    enabled: !!session,
    refetchInterval: (query) => (query.state.data?.status === 'pending' ? 3000 : false),
  });
  const name = shop.data?.shop.name ?? 'オンラインストア';
  if (!session) {
    return (
      <PublicShell>
        <EmptyState
          className="mt-10"
          icon="lock"
          title="ログインが必要です"
          action={
            <Link className="text-primary" to={`/my/${shopSlug}?tab=orders`}>
              マイページへ
            </Link>
          }
        />
      </PublicShell>
    );
  }
  if (q.isLoading) return <PageSpinner />;
  return (
    <PublicShell header={<StoreHeader slug={shopSlug} name={name} sub="ご注文" />}>
      {q.data ? (
        <OrderView order={q.data} token={session.token} />
      ) : (
        <EmptyState className="mt-10" icon="bag" title="注文が見つかりません" />
      )}
      <div className="mt-6 flex flex-col gap-2 text-center text-[13px]">
        <Link to={`/my/${shopSlug}?tab=orders`} className="text-primary">
          注文履歴を見る
        </Link>
        <Link to={`/store/${shopSlug}`} className="text-muted">
          ストアに戻る
        </Link>
      </div>
    </PublicShell>
  );
}
