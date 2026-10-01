import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import {
  ORDER_STATUS_LABEL,
  ORDER_STATUS_TONE,
  commerceApi,
  commerceKeys,
  type OrderDetail,
} from '../../../api/commerce';
import { posApi } from '../../../api/pos';
import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  Drawer,
  ErrorState,
  Field,
  InlineLoading,
  Input,
  KeyValue,
  Select,
  useToast,
} from '../../../components/ui';
import { errorMessage } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { formatDateTime, formatYen } from '../../../lib/format';
import { TaxBreakdown } from '../pos/shared';

const PAYMENT_STATUS: Record<string, string> = {
  pending: '処理中',
  requires_action: '決済待ち',
  succeeded: '成功',
  failed: '失敗',
  cancelled: '取消',
  refunded: '返金済',
  partially_refunded: '一部返金',
};

const CARRIERS = ['ヤマト運輸', '佐川急便', '日本郵便', '西濃運輸', 'その他'];

/** EC order detail: process → ship (carrier / tracking) → deliver, cancel with refund */
export function OrderDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { timezone: tz } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: commerceKeys.order(id ?? ''),
    queryFn: () => commerceApi.order(id!),
    enabled: !!id,
  });
  const [shipping, setShipping] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const o = q.data;

  const run = async (label: string, fn: () => Promise<OrderDetail | unknown>) => {
    setBusy(label);
    try {
      const res = await fn();
      if (res && typeof res === 'object' && 'order_number' in res)
        qc.setQueryData(commerceKeys.order(id!), res);
      else void q.refetch();
      void qc.invalidateQueries({ queryKey: ['commerce', 'orders'] });
      toast.success(label);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  const pendingMock = o?.payments.find(
    (p) => p.provider === 'mock' && ['pending', 'requires_action'].includes(p.status),
  );
  const address = o?.shipping_address;
  const breakdown = o
    ? o.items.reduce<Record<string, { taxable: number; tax: number }>>((acc, i) => {
        const k = String(i.tax_rate_bp);
        acc[k] ??= { taxable: 0, tax: 0 };
        acc[k].taxable += i.amount;
        acc[k].tax += i.tax_amount;
        return acc;
      }, {})
    : null;

  return (
    <Drawer
      open={!!id}
      onClose={onClose}
      width="lg"
      title={o ? `注文 ${o.order_number}` : '注文'}
      description={
        o ? (
          <span className="flex items-center gap-2">
            <Badge size="sm" tone={ORDER_STATUS_TONE[o.status]}>
              {ORDER_STATUS_LABEL[o.status]}
            </Badge>
            {formatDateTime(o.created_at, tz)}
          </span>
        ) : undefined
      }
      footer={
        o ? (
          <>
            {['pending', 'paid', 'processing'].includes(o.status) ? (
              <Button
                variant="ghost"
                className="mr-auto !text-danger"
                onClick={() => setCancelling(true)}
              >
                キャンセル
              </Button>
            ) : null}
            {o.status === 'paid' ? (
              <Button
                loading={busy === '出荷準備中にしました'}
                onClick={() =>
                  void run('出荷準備中にしました', () => commerceApi.processOrder(o.id))
                }
              >
                出荷準備中にする
              </Button>
            ) : null}
            {o.status === 'paid' || o.status === 'processing' ? (
              <Button
                variant="primary"
                icon="send"
                onClick={() => setShipping(true)}
                data-testid="ship-order"
              >
                発送する
              </Button>
            ) : null}
            {o.status === 'shipped' ? (
              <Button
                variant="primary"
                loading={busy === '配達完了にしました'}
                onClick={() => void run('配達完了にしました', () => commerceApi.deliverOrder(o.id))}
              >
                配達完了にする
              </Button>
            ) : null}
          </>
        ) : undefined
      }
    >
      {q.isLoading ? <InlineLoading /> : null}
      {q.error ? <ErrorState error={q.error} /> : null}
      {o ? (
        <div className="space-y-5">
          {o.status === 'pending' ? (
            <Alert
              tone="warning"
              title="決済待ちです"
              action={
                import.meta.env.DEV && pendingMock ? (
                  <Button
                    size="xs"
                    variant="secondary"
                    loading={busy === 'モック決済を完了しました'}
                    onClick={() =>
                      void run('モック決済を完了しました', () =>
                        posApi.mockCompletePayment(pendingMock.id),
                      )
                    }
                    data-testid="mock-complete-payment"
                  >
                    モック決済を完了（開発用）
                  </Button>
                ) : undefined
              }
            >
              {o.expires_at
                ? `お支払い期限 ${formatDateTime(o.expires_at, tz)}（期限を過ぎると自動キャンセル）`
                : null}
            </Alert>
          ) : null}
          {o.cancel_reason ? (
            <Alert tone="info" title="キャンセル理由">
              {o.cancel_reason}
            </Alert>
          ) : null}
          <ul className="divide-y divide-border rounded-xl border border-border text-sm">
            {o.items.map((i) => (
              <li key={i.product_id} className="flex justify-between gap-3 px-3 py-2">
                <span>
                  {i.name}
                  {i.tax_rate_bp === 800 ? (
                    <span className="ml-1 text-xs text-muted">※軽減</span>
                  ) : null}
                  <span className="block text-xs text-muted">
                    {formatYen(i.unit_price)} × {i.quantity}
                  </span>
                </span>
                <span className="tabular">{formatYen(i.amount)}</span>
              </li>
            ))}
            <li className="flex justify-between px-3 py-2 text-muted">
              <span>送料</span>
              <span className="tabular">{formatYen(o.shipping_fee)}</span>
            </li>
            <li className="flex justify-between px-3 py-2 font-semibold">
              <span>合計（税込）</span>
              <span className="tabular">{formatYen(o.total)}</span>
            </li>
          </ul>
          <div>
            <p className="text-xs text-muted">
              内消費税 {formatYen(o.tax_total)}（送料の税を含む）
            </p>
            <TaxBreakdown breakdown={breakdown} />
          </div>
          <KeyValue
            items={[
              {
                label: 'お客様',
                value: o.customer ? (
                  <Link
                    to={`/app/customers/${o.customer.id}`}
                    className="text-primary hover:underline"
                  >
                    {o.customer.display_name}
                  </Link>
                ) : (
                  '—'
                ),
              },
              { label: '紹介スタッフ', value: o.attributed_staff?.display_name ?? '—' },
              {
                label: 'お届け先',
                value: address ? (
                  <span className="whitespace-pre-line">
                    {`〒${address.postalCode} ${address.prefecture}${address.city}${address.line1}${address.line2 ? ` ${address.line2}` : ''}\n${address.name} 様 ${address.phone}`}
                  </span>
                ) : (
                  '—'
                ),
              },
              { label: '連絡先メール', value: o.contact_email ?? '—' },
              { label: '配送', value: o.carrier ? `${o.carrier} ${o.tracking_number ?? ''}` : '—' },
              { label: '支払日時', value: formatDateTime(o.paid_at, tz) },
              { label: '発送日時', value: formatDateTime(o.shipped_at, tz) },
              ...(o.refunded_amount
                ? [{ label: '返金額', value: formatYen(o.refunded_amount) }]
                : []),
              ...(o.note ? [{ label: '備考', value: o.note }] : []),
            ]}
          />
          <section>
            <h3 className="mb-2 text-[13px] font-semibold">決済</h3>
            <ul className="divide-y divide-border rounded-xl border border-border text-[13px]">
              {o.payments.map((p) => (
                <li key={p.id} className="flex justify-between gap-2 px-3 py-2">
                  <span>
                    {p.provider === 'mock'
                      ? 'オンライン決済（モック）'
                      : p.provider === 'stripe'
                        ? 'カード（Stripe）'
                        : (p.provider ?? p.method)}{' '}
                    ・ {PAYMENT_STATUS[p.status] ?? p.status}
                    {p.failure_code ? (
                      <span className="text-danger"> ({p.failure_code})</span>
                    ) : null}
                  </span>
                  <span className="tabular">{formatYen(p.amount)}</span>
                </li>
              ))}
              {!o.payments.length ? (
                <li className="px-3 py-2 text-muted">決済はありません</li>
              ) : null}
            </ul>
          </section>
        </div>
      ) : null}
      {shipping && o ? (
        <ShipDialog
          onClose={() => setShipping(false)}
          onSubmit={async (carrier, tracking) => {
            try {
              const res = await commerceApi.shipOrder(o.id, { carrier, trackingNumber: tracking });
              qc.setQueryData(commerceKeys.order(o.id), res);
              void qc.invalidateQueries({ queryKey: ['commerce', 'orders'] });
              toast.success('発送済みにしました', 'お客様へ発送通知を送信します');
              setShipping(false);
              return null;
            } catch (e) {
              return errorMessage(e);
            }
          }}
        />
      ) : null}
      <ConfirmDialog
        open={cancelling}
        onClose={() => setCancelling(false)}
        title="注文をキャンセルしますか？"
        description="支払済みの場合は返金し、在庫を戻します。"
        tone="danger"
        confirmLabel="キャンセルする"
        reason
        reasonRequired
        reasonLabel="キャンセル理由"
        loading={busy === '注文をキャンセルしました'}
        onConfirm={(reason) => {
          if (!o || !reason) return;
          setCancelling(false);
          void run('注文をキャンセルしました', () => commerceApi.cancelOrder(o.id, reason));
        }}
      />
    </Drawer>
  );
}

function ShipDialog({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (carrier: string, tracking: string) => Promise<string | null>;
}) {
  const [carrier, setCarrier] = useState(CARRIERS[0]!);
  const [other, setOther] = useState('');
  const [tracking, setTracking] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const c = carrier === 'その他' ? other.trim() : carrier;
    if (!c) return setError('配送業者を入力してください');
    if (!tracking.trim()) return setError('伝票番号を入力してください');
    setBusy(true);
    setError(await onSubmit(c, tracking.trim()));
    setBusy(false);
  };
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title="発送情報"
      dismissable={!busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            キャンセル
          </Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={() => void submit()}
            data-testid="ship-submit"
          >
            発送済みにする
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <Field label="配送業者">
          <Select value={carrier} onChange={(e) => setCarrier(e.target.value)}>
            {CARRIERS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </Field>
        {carrier === 'その他' ? (
          <Field label="配送業者名">
            <Input value={other} onChange={(e) => setOther(e.target.value)} maxLength={50} />
          </Field>
        ) : null}
        <Field label="伝票番号">
          <Input
            value={tracking}
            onChange={(e) => setTracking(e.target.value)}
            maxLength={100}
            inputMode="numeric"
            className="font-mono"
          />
        </Field>
      </div>
    </Dialog>
  );
}
