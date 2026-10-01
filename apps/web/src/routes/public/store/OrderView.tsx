import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ORDER_STATUS_LABEL, storeApi, type CustomerOrder } from '../../../api/commerce';
import { Alert, Badge, Button, Icon, Spinner, useToast } from '../../../components/ui';
import { formatDateTime, formatYen } from '../../../lib/format';

/** Customer order detail (status, items, shipping, payment state) */
export function OrderView({ order: o, token }: { order: CustomerOrder; token: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [retrying, setRetrying] = useState(false);
  const retry = async () => {
    setRetrying(true);
    try {
      await storeApi.retryPayment(token, o.id);
      toast.success('お支払いを再開しました');
      void qc.invalidateQueries({ queryKey: ['public', 'my-order'] });
    } catch (e) {
      toast.error(e);
    } finally {
      setRetrying(false);
    }
  };
  const addr = o.shippingAddress;
  return (
    <div className="space-y-4" data-testid="order-view">
      {o.status === 'pending' ? (
        o.paymentFailed ? (
          <Alert
            tone="danger"
            title="お支払いが完了しませんでした"
            action={
              <Button size="sm" loading={retrying} onClick={() => void retry()}>
                再試行
              </Button>
            }
          >
            カード情報をご確認のうえ、もう一度お試しください。
          </Alert>
        ) : (
          <div
            className="flex flex-col items-center rounded-2xl border border-border bg-surface p-6 text-center"
            role="status"
            aria-live="polite"
          >
            <Spinner size={28} className="text-primary" />
            <p className="mt-3 text-base font-semibold">決済待ち</p>
            <p className="mt-1 text-[13px] text-muted">
              お支払いの完了を確認しています。このままお待ちください。
            </p>
            {o.expiresAt ? (
              <p className="mt-1 text-xs text-subtle">お支払い期限 {formatDateTime(o.expiresAt)}</p>
            ) : null}
            {import.meta.env.DEV ? (
              <p className="mt-3 rounded-lg bg-info-soft px-3 py-2 text-left text-xs text-info">
                開発環境: 決済プロバイダはモックです。スタッフ画面「商品・EC →
                EC注文」の注文詳細で「モック決済を完了」を押すと支払済になります。
              </p>
            ) : null}
          </div>
        )
      ) : o.status === 'cancelled' || o.status === 'refunded' ? (
        <Alert tone="warning" title={`この注文は${ORDER_STATUS_LABEL[o.status]}です`}>
          {o.refundedAmount ? `返金額 ${formatYen(o.refundedAmount)}` : null}
        </Alert>
      ) : (
        <div className="flex flex-col items-center rounded-2xl border border-border bg-surface p-6 text-center">
          <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-success-soft text-success">
            <Icon name="check" size={24} />
          </span>
          <p className="text-base font-semibold">ご注文ありがとうございます</p>
          <p className="mt-1 text-[13px] text-muted">
            {o.status === 'paid'
              ? 'お支払いを確認しました。発送までしばらくお待ちください。'
              : ORDER_STATUS_LABEL[o.status]}
          </p>
        </div>
      )}
      <section className="rounded-2xl border border-border bg-surface p-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold">注文番号 {o.orderNumber}</h2>
          <Badge
            size="sm"
            tone={
              o.status === 'pending' ? 'warning' : o.status === 'cancelled' ? 'neutral' : 'success'
            }
          >
            {ORDER_STATUS_LABEL[o.status]}
          </Badge>
        </div>
        <ul className="divide-y divide-border text-[13px]">
          {o.items.map((i) => (
            <li key={i.productId} className="flex justify-between gap-3 py-1.5">
              <span>
                {i.name} × {i.quantity}
              </span>
              <span className="tabular">{formatYen(i.amount)}</span>
            </li>
          ))}
          <li className="flex justify-between py-1.5 text-muted">
            <span>送料</span>
            <span className="tabular">{formatYen(o.shippingFee)}</span>
          </li>
          <li className="flex justify-between py-1.5 font-semibold">
            <span>お支払い金額（税込）</span>
            <span className="tabular" data-testid="order-total">
              {formatYen(o.total)}
            </span>
          </li>
        </ul>
        <p className="mt-1 text-xs text-muted">うち消費税 {formatYen(o.taxTotal)}</p>
        {addr ? (
          <p className="mt-3 whitespace-pre-line text-xs text-muted">
            {`お届け先: 〒${addr.postalCode} ${addr.prefecture}${addr.city}${addr.line1}${addr.line2 ? ` ${addr.line2}` : ''}\n${addr.name} 様`}
          </p>
        ) : null}
        {o.carrier ? (
          <p className="mt-2 text-xs">
            配送: {o.carrier} {o.trackingNumber}
          </p>
        ) : null}
        <p className="mt-2 text-xs text-subtle">ご注文日時 {formatDateTime(o.createdAt)}</p>
      </section>
    </div>
  );
}
