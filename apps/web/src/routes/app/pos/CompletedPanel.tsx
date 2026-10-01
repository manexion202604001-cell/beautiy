import { useState } from 'react';
import { openAuthenticatedHtml } from '../../../api/files';
import { METHOD_LABEL, posApi, type Transaction } from '../../../api/pos';
import {
  Alert,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  Dialog,
  Field,
  Input,
  Segmented,
  Select,
  Textarea,
  useToast,
} from '../../../components/ui';
import { errorMessage, isApiError, newIdempotencyKey } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { formatDateTime, formatYen } from '../../../lib/format';
import { useStableKey } from '../../../lib/hooks';
import { parseYen } from '../../../lib/money';

/** Receipts, void and refund for a completed transaction */
export function CompletedPanel({
  tx,
  onUpdated,
}: {
  tx: Transaction;
  onUpdated: (tx: Transaction) => void;
}) {
  const { can, timezone: tz } = useAuth();
  const toast = useToast();
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [voidOpen, setVoidOpen] = useState(false);
  const [refundOpen, setRefundOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [voidKey, regenVoid] = useStableKey(newIdempotencyKey);
  const sold = ['completed', 'partially_refunded', 'refunded'].includes(tx.status);
  const refundable = Math.max(0, tx.total - tx.refunded_total);

  const doVoid = async (reason?: string) => {
    if (!reason) return;
    setBusy(true);
    try {
      const updated = await posApi.void(tx.id, reason, voidKey);
      onUpdated(updated);
      toast.success('会計を取り消しました');
      setVoidOpen(false);
    } catch (e) {
      toast.error(e);
      if (!isApiError(e) || e.status > 0) regenVoid();
      setVoidOpen(false);
    } finally {
      setBusy(false);
    }
  };

  const open = (id: string) =>
    openAuthenticatedHtml(`/receipts/${id}/html`, 'レシート').catch((e) => toast.error(e));

  return (
    <div className="space-y-5">
      {sold ? (
        <Card>
          <CardHeader
            title="レシート・領収書"
            actions={
              can('pos.operate') ? (
                <Button
                  size="sm"
                  variant="primary"
                  icon="receipt"
                  onClick={() => setReceiptOpen(true)}
                >
                  発行する
                </Button>
              ) : null
            }
          />
          {tx.receipts.length ? (
            <ul
              className="divide-y divide-border rounded-xl border border-border text-[13px]"
              data-testid="receipts"
            >
              {tx.receipts.map((r) => (
                <li key={r.id} className="flex items-center gap-2 px-3 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">
                      {r.receipt_type === 'invoice' ? '領収書' : 'レシート'}
                    </span>{' '}
                    <span className="font-mono text-xs text-muted">{r.receipt_number}</span>
                    {r.reissue_of ? (
                      <span className="ml-1 text-xs text-warning">再発行</span>
                    ) : null}
                    {r.addressee ? (
                      <span className="ml-1 text-xs text-muted">{r.addressee} 様</span>
                    ) : null}
                    <span className="block text-xs text-subtle">
                      {formatDateTime(r.issued_at, tz)}
                    </span>
                  </span>
                  <Button size="xs" icon="external" onClick={() => void open(r.id)}>
                    印刷用を開く
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-muted">まだ発行していません。</p>
          )}
        </Card>
      ) : null}

      {tx.refunds.length ? (
        <Card>
          <CardHeader title="返金履歴" />
          <ul className="divide-y divide-border text-[13px]">
            {tx.refunds.map((r) => (
              <li key={r.id} className="flex justify-between gap-2 py-2">
                <span>
                  {METHOD_LABEL[r.method]} ・ {r.reason ?? '—'}
                  <span className="block text-xs text-subtle">
                    {formatDateTime(r.created_at, tz)}
                  </span>
                </span>
                <span className="tabular text-danger">−{formatYen(r.amount)}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {sold && (can('pos.void') || can('pos.refund')) ? (
        <div className="flex flex-wrap gap-2">
          {can('pos.refund') && tx.status !== 'refunded' ? (
            <Button variant="outline" icon="undo" onClick={() => setRefundOpen(true)}>
              返金・返品
            </Button>
          ) : null}
          {can('pos.void') && tx.status === 'completed' ? (
            <Button
              variant="outline"
              className="!text-danger"
              icon="x"
              onClick={() => setVoidOpen(true)}
            >
              会計を取り消す
            </Button>
          ) : null}
        </div>
      ) : null}

      {receiptOpen ? (
        <ReceiptDialog
          tx={tx}
          onClose={() => setReceiptOpen(false)}
          onIssued={(id, updated) => {
            setReceiptOpen(false);
            if (updated) onUpdated(updated);
            void open(id);
          }}
        />
      ) : null}
      <ConfirmDialog
        open={voidOpen}
        onClose={() => setVoidOpen(false)}
        title="会計を取り消しますか？"
        description="当日またはレジ締め前のみ取り消せます。在庫・ポイント・予約ステータスも元に戻ります。"
        tone="danger"
        confirmLabel="取り消す"
        reason
        reasonRequired
        reasonLabel="取消理由"
        reasonPlaceholder="例: 金額の打ち間違い"
        loading={busy}
        onConfirm={(r) => void doVoid(r)}
      />
      {refundOpen ? (
        <RefundDialog
          tx={tx}
          max={refundable}
          onClose={() => setRefundOpen(false)}
          onDone={(updated) => {
            onUpdated(updated);
            setRefundOpen(false);
            toast.success('返金しました');
          }}
        />
      ) : null}
    </div>
  );
}

function ReceiptDialog({
  tx,
  onClose,
  onIssued,
}: {
  tx: Transaction;
  onClose: () => void;
  onIssued: (receiptId: string, updated: Transaction | null) => void;
}) {
  const [type, setType] = useState<'receipt' | 'invoice'>('receipt');
  const [addressee, setAddressee] = useState(tx.customer_name ?? '');
  const [proviso, setProviso] = useState('お品代として');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [key, regenerate] = useStableKey(newIdempotencyKey);
  const reissue = tx.receipts.some((r) => r.receipt_type === type);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await posApi.issueReceipt(
        tx.id,
        {
          type,
          ...(type === 'invoice' && addressee.trim() ? { addressee: addressee.trim() } : {}),
          ...(type === 'invoice' && proviso.trim() ? { proviso: proviso.trim() } : {}),
        },
        key,
      );
      const updated = await posApi.get(tx.id).catch(() => null);
      onIssued(r.id, updated);
    } catch (e) {
      setError(errorMessage(e));
      regenerate();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={reissue ? '再発行' : 'レシート・領収書の発行'}
      description={
        reissue ? '発行済みのため「再発行」と印字されます。' : '発行後、印刷用ページを開きます。'
      }
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
            data-testid="issue-receipt"
          >
            発行して開く
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <Segmented
          label="種類"
          value={type}
          onChange={setType}
          options={[
            { value: 'receipt', label: 'レシート' },
            { value: 'invoice', label: '領収書' },
          ]}
        />
        {type === 'invoice' ? (
          <>
            <Field label="宛名" optional>
              <Input
                value={addressee}
                onChange={(e) => setAddressee(e.target.value)}
                maxLength={100}
                trailing="様"
              />
            </Field>
            <Field label="但し書き" optional>
              <Input value={proviso} onChange={(e) => setProviso(e.target.value)} maxLength={100} />
            </Field>
          </>
        ) : null}
      </div>
    </Dialog>
  );
}

function RefundDialog({
  tx,
  max,
  onClose,
  onDone,
}: {
  tx: Transaction;
  max: number;
  onClose: () => void;
  onDone: (tx: Transaction) => void;
}) {
  const refundablePayments = tx.payments.filter(
    (p) => ['succeeded', 'partially_refunded'].includes(p.status) && p.amount > p.refunded_amount,
  );
  const productLines = tx.items.filter(
    (i) => i.item_type === 'product' && i.quantity > i.returned_quantity,
  );
  const [amount, setAmount] = useState(String(max));
  const [reason, setReason] = useState('');
  const [paymentId, setPaymentId] = useState('');
  const [restock, setRestock] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [key, regenerate] = useStableKey(newIdempotencyKey);

  const submit = async () => {
    const n = parseYen(amount);
    if (!n || n <= 0) return setError('返金額を入力してください');
    if (n > max) return setError(`返金できるのは最大 ${formatYen(max)} です`);
    if (!reason.trim()) return setError('返金理由を入力してください');
    const restockItems = Object.entries(restock)
      .map(([itemId, q]) => ({ itemId, quantity: Number(q || 0) }))
      .filter((r) => r.quantity > 0);
    setBusy(true);
    setError(null);
    try {
      onDone(
        await posApi.refund(
          tx.id,
          {
            amount: n,
            reason: reason.trim(),
            ...(paymentId ? { paymentId } : {}),
            ...(restockItems.length ? { restockItems } : {}),
          },
          key,
        ),
      );
    } catch (e) {
      setError(errorMessage(e));
      if (!isApiError(e) || e.status > 0) regenerate();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="返金・返品"
      description={`返金可能額 ${formatYen(max)}`}
      dismissable={!busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            キャンセル
          </Button>
          <Button variant="danger" loading={busy} onClick={() => void submit()}>
            返金する
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <Field label="返金額" required>
          <Input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="numeric"
            leading="¥"
            inputSize="lg"
          />
        </Field>
        <Field label="返金する支払" hint="未指定の場合は所定の順序で自動的に返金します">
          <Select value={paymentId} onChange={(e) => setPaymentId(e.target.value)}>
            <option value="">自動</option>
            {refundablePayments.map((p) => (
              <option key={p.id} value={p.id}>
                {p.method === 'custom'
                  ? (p.custom_method_name ?? '店舗独自決済')
                  : METHOD_LABEL[p.method]}{' '}
                {formatYen(p.amount - p.refunded_amount)}
              </option>
            ))}
          </Select>
        </Field>
        {productLines.length ? (
          <fieldset>
            <legend className="mb-1.5 text-[13px] font-medium">返品（在庫に戻す数量）</legend>
            <ul className="space-y-2">
              {productLines.map((l) => (
                <li key={l.id} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[13px]">{l.name}</span>
                  <Input
                    aria-label={`${l.name}の返品数量`}
                    className="w-20"
                    inputSize="sm"
                    type="number"
                    min={0}
                    max={l.quantity - l.returned_quantity}
                    value={restock[l.id] ?? ''}
                    onChange={(e) => setRestock((r) => ({ ...r, [l.id]: e.target.value }))}
                    trailing={`/ ${l.quantity - l.returned_quantity}`}
                  />
                </li>
              ))}
            </ul>
          </fieldset>
        ) : null}
        <Field label="返金理由" required>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            maxLength={500}
          />
        </Field>
      </div>
    </Dialog>
  );
}
