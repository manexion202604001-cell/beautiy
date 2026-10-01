import { useState } from 'react';
import {
  METHOD_LABEL,
  posApi,
  useCustomMethods,
  type AddPaymentInput,
  type Transaction,
} from '../../../api/pos';
import {
  Alert,
  Badge,
  Button,
  Dialog,
  Field,
  IconButton,
  Input,
  Select,
} from '../../../components/ui';
import { errorMessage, isApiError, newIdempotencyKey } from '../../../lib/api';
import { cn } from '../../../lib/cn';
import { formatYen } from '../../../lib/format';
import { useStableKey } from '../../../lib/hooks';
import { appliedCash, changeFor, parseYen, tenderSuggestions } from '../../../lib/money';

type Method = Exclude<AddPaymentInput['method'], 'point'>;

const METHOD_BUTTONS: { method: Method; label: string }[] = [
  { method: 'cash', label: '現金' },
  { method: 'card', label: 'カード' },
  { method: 'emoney', label: '電子マネー' },
  { method: 'qr', label: 'QR決済' },
];

/** Payments on a draft: list, split payments by method, points, remove */
export function PaymentPanel({
  tx,
  disabled,
  onUpdated,
  onChange,
}: {
  tx: Transaction;
  disabled: boolean;
  onUpdated: (tx: Transaction) => void;
  onChange: (change: number | null) => void;
}) {
  const custom = useCustomMethods(tx.shop_id);
  const [method, setMethod] = useState<Method | null>(null);
  const [points, setPoints] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = tx.payments.filter((p) => !['cancelled', 'failed'].includes(p.status));
  const outstanding = tx.outstanding;

  const remove = async (paymentId: string) => {
    setRemoving(paymentId);
    setError(null);
    try {
      onUpdated(await posApi.removePayment(tx.id, paymentId));
      onChange(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setRemoving(null);
    }
  };

  return (
    <div className="space-y-3">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {active.length ? (
        <ul
          className="divide-y divide-border rounded-xl border border-border text-[13px]"
          aria-label="お支払い"
        >
          {active.map((p) => (
            <li key={p.id} className="flex items-center gap-2 px-3 py-2">
              <span className="min-w-0 flex-1">
                <span className="font-medium">
                  {p.method === 'custom'
                    ? (p.custom_method_name ?? METHOD_LABEL.custom)
                    : METHOD_LABEL[p.method]}
                </span>
                {p.method === 'cash' && p.tendered_amount ? (
                  <span className="ml-2 text-xs text-muted">
                    預り {formatYen(p.tendered_amount)} / 釣り {formatYen(p.change_amount)}
                  </span>
                ) : null}
                {p.status !== 'succeeded' ? (
                  <Badge size="sm" tone="warning" className="ml-2">
                    {p.status === 'requires_action' || p.status === 'pending' ? '処理中' : p.status}
                  </Badge>
                ) : null}
              </span>
              <span className="tabular">{formatYen(p.amount)}</span>
              {tx.status === 'draft' ? (
                <IconButton
                  icon="x"
                  size="xs"
                  label={`${METHOD_LABEL[p.method]} ${formatYen(p.amount)} を取り消す`}
                  disabled={disabled || removing === p.id}
                  onClick={() => (p.method === 'point' ? setPoints(true) : void remove(p.id))}
                />
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      <div
        className="flex items-center justify-between rounded-xl bg-surface-2 px-4 py-3"
        aria-live="polite"
      >
        <span className="text-[13px] text-muted">未払い残高</span>
        <span
          className={cn(
            'text-xl font-semibold tabular',
            outstanding === 0 ? 'text-success' : 'text-fg',
          )}
          data-testid="outstanding"
        >
          {formatYen(outstanding)}
        </span>
      </div>

      {tx.status === 'draft' ? (
        <>
          <div className="grid grid-cols-2 gap-2" role="group" aria-label="支払方法">
            {METHOD_BUTTONS.map((m) => (
              <Button
                key={m.method}
                size="lg"
                variant={m.method === 'cash' ? 'primary' : 'secondary'}
                disabled={disabled || outstanding <= 0}
                onClick={() => setMethod(m.method)}
              >
                {m.label}
              </Button>
            ))}
            {custom.data?.length ? (
              <Button
                size="md"
                disabled={disabled || outstanding <= 0}
                onClick={() => setMethod('custom')}
              >
                店舗独自決済
              </Button>
            ) : null}
            {tx.customer_id ? (
              <Button size="md" variant="soft" disabled={disabled} onClick={() => setPoints(true)}>
                ポイント利用{tx.point_used ? `（${tx.point_used}pt）` : ''}
              </Button>
            ) : null}
          </div>
        </>
      ) : null}

      {method ? (
        <PaymentDialog
          tx={tx}
          method={method}
          customMethods={custom.data ?? []}
          onClose={() => setMethod(null)}
          onPaid={(updated, change) => {
            onUpdated(updated);
            onChange(change);
            setMethod(null);
          }}
        />
      ) : null}
      {points ? (
        <PointsDialog
          tx={tx}
          onClose={() => setPoints(false)}
          onDone={(updated) => {
            onUpdated(updated);
            setPoints(false);
          }}
        />
      ) : null}
    </div>
  );
}

function PaymentDialog({
  tx,
  method,
  customMethods,
  onClose,
  onPaid,
}: {
  tx: Transaction;
  method: Method;
  customMethods: { id: string; name: string }[];
  onClose: () => void;
  onPaid: (tx: Transaction, change: number | null) => void;
}) {
  const due = tx.outstanding;
  const [tendered, setTendered] = useState('');
  const [amount, setAmount] = useState(String(due));
  const [customId, setCustomId] = useState(customMethods[0]?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [key, regenerate] = useStableKey(newIdempotencyKey);
  const tenderedN = Number(tendered || 0);
  const isCash = method === 'cash';
  const label = method === 'custom' ? '店舗独自決済' : METHOD_LABEL[method];

  const press = (k: string) => {
    if (k === 'C') return setTendered('');
    if (k === 'BS') return setTendered((t) => t.slice(0, -1));
    setTendered((t) => (t + k).replace(/^0+/, '').slice(0, 8));
  };

  const submit = async () => {
    setError(null);
    let input: AddPaymentInput;
    if (isCash) {
      if (tenderedN <= 0) return setError('お預かり金額を入力してください');
      input = { method: 'cash', tenderedAmount: tenderedN, amount: appliedCash(tenderedN, due) };
    } else {
      const n = parseYen(amount);
      if (!n || n <= 0) return setError('金額を入力してください');
      if (n > due) return setError('未払い残高を超えています');
      if (method === 'custom' && !customId) return setError('決済の種類を選択してください');
      input = { method, amount: n, ...(method === 'custom' ? { customMethodId: customId } : {}) };
    }
    setBusy(true);
    try {
      const res = await posApi.addPayment(tx.id, input, key);
      onPaid(res.transaction, isCash ? (res.change ?? changeFor(tenderedN, due)) : null);
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
      size="md"
      title={`${label}でお支払い`}
      description={`未払い残高 ${formatYen(due)}`}
      dismissable={!busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            キャンセル
          </Button>
          <Button
            variant="primary"
            size="lg"
            loading={busy}
            onClick={() => void submit()}
            data-testid="confirm-payment"
          >
            {isCash ? 'お預かりする' : '支払を記録'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error ? <Alert tone="danger">{error}</Alert> : null}
        {isCash ? (
          <>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-xl bg-surface-2 p-3">
                <p className="text-xs text-muted">ご請求</p>
                <p className="text-lg font-semibold tabular">{formatYen(due)}</p>
              </div>
              <div className="rounded-xl border-2 border-primary p-3">
                <p className="text-xs text-muted">お預かり</p>
                <p
                  className="text-lg font-semibold tabular"
                  data-testid="tendered"
                  aria-live="polite"
                >
                  {formatYen(tenderedN)}
                </p>
              </div>
              <div className="rounded-xl bg-surface-2 p-3">
                <p className="text-xs text-muted">お釣り</p>
                <p
                  className="text-lg font-semibold tabular text-primary"
                  data-testid="change"
                  aria-live="polite"
                >
                  {formatYen(changeFor(tenderedN, due))}
                </p>
              </div>
            </div>
            {tenderedN > 0 && tenderedN < due ? (
              <p className="text-xs text-warning">
                残り {formatYen(due - tenderedN)} は別の方法でお支払いいただけます（分割払い）。
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2" aria-label="お預かり金額の候補">
              {tenderSuggestions(due).map((n) => (
                <Button key={n} size="sm" variant="soft" onClick={() => setTendered(String(n))}>
                  {n === due ? 'ちょうど' : formatYen(n)}
                </Button>
              ))}
            </div>
            <div className="grid grid-cols-3 gap-2" role="group" aria-label="テンキー">
              {['7', '8', '9', '4', '5', '6', '1', '2', '3', '0', '00', 'BS'].map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => press(k)}
                  aria-label={k === 'BS' ? '1文字消す' : k}
                  className="h-14 rounded-xl border border-border bg-surface text-xl font-semibold tabular hover:bg-surface-2 active:bg-surface-3"
                >
                  {k === 'BS' ? '⌫' : k}
                </button>
              ))}
              <button
                type="button"
                onClick={() => press('C')}
                className="col-span-3 h-11 rounded-xl border border-border bg-surface text-sm font-medium text-muted hover:bg-surface-2"
              >
                クリア
              </button>
            </div>
            <Field label="お預かり金額（直接入力）" labelHidden>
              <Input
                value={tendered}
                onChange={(e) => setTendered(e.target.value.replace(/[^\d]/g, ''))}
                inputMode="numeric"
                placeholder="お預かり金額"
                aria-label="お預かり金額"
                leading="¥"
              />
            </Field>
          </>
        ) : (
          <>
            {method === 'custom' ? (
              <Field label="決済の種類">
                <Select value={customId} onChange={(e) => setCustomId(e.target.value)}>
                  {customMethods.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            <Field label="金額" hint="分割払いの場合は金額を変更してください">
              <Input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                inputMode="numeric"
                leading="¥"
                inputSize="lg"
              />
            </Field>
          </>
        )}
      </div>
    </Dialog>
  );
}

function PointsDialog({
  tx,
  onClose,
  onDone,
}: {
  tx: Transaction;
  onClose: () => void;
  onDone: (tx: Transaction) => void;
}) {
  const balance = tx.customer_point_balance ?? 0;
  const max = Math.min(balance, tx.outstanding + tx.point_used);
  const [use, setUse] = useState(String(tx.point_used || ''));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const n = Number(use || 0);
    if (!Number.isInteger(n) || n < 0) return setError('0以上の整数で入力してください');
    if (n > max) return setError(`利用できるのは最大 ${max.toLocaleString('ja-JP')}pt です`);
    setBusy(true);
    setError(null);
    try {
      onDone(await posApi.setPoints(tx.id, n));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title="ポイント利用"
      description={`保有 ${balance.toLocaleString('ja-JP')}pt（1pt = 1円）`}
      dismissable={!busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            キャンセル
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            適用する
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <Field label="利用ポイント">
          <Input
            value={use}
            onChange={(e) => setUse(e.target.value.replace(/[^\d]/g, ''))}
            inputMode="numeric"
            trailing="pt"
            inputSize="lg"
          />
        </Field>
        <div className="flex gap-2">
          <Button size="sm" variant="soft" onClick={() => setUse(String(max))} disabled={max <= 0}>
            最大（{max.toLocaleString('ja-JP')}pt）
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setUse('0')}>
            利用しない
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
