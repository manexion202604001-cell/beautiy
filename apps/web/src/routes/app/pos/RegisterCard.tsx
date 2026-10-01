import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import {
  posApi,
  posKeys,
  useCurrentRegister,
  METHOD_LABEL,
  type RegisterSession,
} from '../../../api/pos';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  Dialog,
  ErrorState,
  Field,
  InlineLoading,
  Input,
  KeyValue,
  Segmented,
  Textarea,
  useToast,
} from '../../../components/ui';
import { errorMessage, newIdempotencyKey } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { cn } from '../../../lib/cn';
import { formatDateTime, formatYen } from '../../../lib/format';
import { useStableKey } from '../../../lib/hooks';
import {
  DENOMINATIONS,
  cleanBreakdown,
  denominationLabel,
  parseYen,
  sumDenominations,
} from '../../../lib/money';

/** レジ: open / cash in-out / close with denomination counting */
export function RegisterCard({ shopId }: { shopId: string }) {
  const { can, timezone: tz } = useAuth();
  const q = useCurrentRegister(shopId);
  const [dialog, setDialog] = useState<null | 'open' | 'pay_in' | 'pay_out' | 'close'>(null);
  const [closed, setClosed] = useState<RegisterSession | null>(null);
  const session = q.data?.session ?? null;
  const manage = can('register.manage');

  return (
    <Card>
      <CardHeader
        title="レジ"
        description={session ? `開局 ${formatDateTime(session.opened_at, tz)}` : '現在のレジの状態'}
        actions={
          session ? (
            <Badge tone="success" dot>
              開局中
            </Badge>
          ) : (
            <Badge tone="neutral">未開局</Badge>
          )
        }
      />
      {q.isLoading ? <InlineLoading /> : null}
      {q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : null}
      {closed ? (
        <Alert
          tone={closed.difference === 0 ? 'success' : 'warning'}
          title="レジを締めました"
          className="mb-4"
          action={
            <Button size="xs" variant="ghost" onClick={() => setClosed(null)}>
              閉じる
            </Button>
          }
        >
          想定 {formatYen(closed.expected_cash)} / 実査 {formatYen(closed.counted_cash)} / 差額{' '}
          <span className={cn('font-semibold', closed.difference ? 'text-danger' : 'text-success')}>
            {formatYen(closed.difference)}
          </span>
        </Alert>
      ) : null}
      {q.data && !session ? (
        <div className="space-y-3">
          <p className="text-[13px] text-muted">
            開局すると現金売上・入出金を集計し、締め時に想定残高と実査額の差額を確認できます。
          </p>
          {manage ? (
            <Button
              variant="primary"
              icon="key"
              onClick={() => setDialog('open')}
              className="w-full sm:w-auto"
            >
              レジを開局する
            </Button>
          ) : (
            <p className="text-xs text-subtle">レジの開局には「レジ開局・締め」権限が必要です。</p>
          )}
        </div>
      ) : null}
      {session ? (
        <div className="space-y-4">
          <div className="rounded-xl bg-surface-2 p-4">
            <p className="text-xs text-muted">現在の想定現金残高</p>
            <p className="text-2xl font-semibold tabular" data-testid="expected-cash">
              {formatYen(session.expected_cash)}
            </p>
          </div>
          {session.summary ? (
            <KeyValue
              items={[
                { label: '釣銭準備金', value: formatYen(session.summary.openingCash) },
                { label: '現金売上', value: formatYen(session.summary.cashSales) },
                {
                  label: '入金 / 出金',
                  value: `${formatYen(session.summary.payIn)} / ${formatYen(session.summary.payOut)}`,
                },
                { label: '現金返金', value: formatYen(session.summary.cashRefunds) },
                {
                  label: '売上合計',
                  value: `${formatYen(session.summary.sales)}（${session.summary.transactionCount}件）`,
                },
                ...Object.entries(session.summary.byMethod)
                  .filter(([m]) => m !== 'cash')
                  .map(([m, v]) => ({ label: METHOD_LABEL[m] ?? m, value: formatYen(v) })),
              ]}
            />
          ) : null}
          {session.summary && session.summary.openDrafts > 0 ? (
            <Alert tone="warning">
              会計中（未確定）の会計が {session.summary.openDrafts} 件あります。
            </Alert>
          ) : null}
          {session.movements?.length ? (
            <div>
              <p className="mb-1 text-xs font-medium text-muted">入出金</p>
              <ul className="divide-y divide-border rounded-xl border border-border text-[13px]">
                {session.movements.map((m) => (
                  <li key={m.id} className="flex items-center justify-between gap-2 px-3 py-2">
                    <span className="min-w-0 truncate">
                      <Badge size="sm" tone={m.movement_type === 'pay_in' ? 'info' : 'warning'}>
                        {m.movement_type === 'pay_in' ? '入金' : '出金'}
                      </Badge>{' '}
                      {m.reason}
                    </span>
                    <span className="shrink-0 tabular">{formatYen(m.amount)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {manage ? (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" icon="plus" onClick={() => setDialog('pay_in')}>
                入金
              </Button>
              <Button size="sm" icon="download" onClick={() => setDialog('pay_out')}>
                出金
              </Button>
              <Button
                size="sm"
                variant="primary"
                icon="lock"
                onClick={() => setDialog('close')}
                className="ml-auto"
              >
                レジ締め
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {dialog === 'open' ? <OpenDialog shopId={shopId} onClose={() => setDialog(null)} /> : null}
      {(dialog === 'pay_in' || dialog === 'pay_out') && session ? (
        <MovementDialog
          shopId={shopId}
          session={session}
          type={dialog}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === 'close' && session ? (
        <CloseDialog
          session={session}
          onClose={() => setDialog(null)}
          onClosed={(s) => {
            setDialog(null);
            setClosed(s);
          }}
        />
      ) : null}
    </Card>
  );
}

function DenominationGrid({
  counts,
  onChange,
}: {
  counts: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
      {DENOMINATIONS.map((d) => {
        const n = Number(counts[d] || 0);
        return (
          <div key={d} className="flex items-center gap-2">
            <label htmlFor={`denom-${d}`} className="w-[4.5rem] shrink-0 text-[13px] text-muted">
              {denominationLabel(d)}
            </label>
            <div className="min-w-0 flex-1">
              <Input
                id={`denom-${d}`}
                type="number"
                inputMode="numeric"
                min={0}
                inputSize="sm"
                value={counts[d] ?? ''}
                onChange={(e) => onChange({ ...counts, [d]: e.target.value.replace(/[^\d]/g, '') })}
                trailing="枚"
                aria-label={`${denominationLabel(d)}の枚数`}
              />
            </div>
            <span className="w-16 shrink-0 text-right text-xs text-subtle tabular">
              {formatYen(d * n)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function OpenDialog({ shopId, onClose }: { shopId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [mode, setMode] = useState<'amount' | 'count'>('amount');
  const [amount, setAmount] = useState('30000');
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [key, regenerate] = useStableKey(newIdempotencyKey);
  const opening = mode === 'amount' ? parseYen(amount) : sumDenominations(counts);

  const submit = async () => {
    if (opening === null || opening < 0) {
      setError('釣銭準備金を入力してください');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await posApi.openRegister(
        { shopId, openingCash: opening, ...(note.trim() ? { note: note.trim() } : {}) },
        key,
      );
      void qc.invalidateQueries({ queryKey: posKeys.register(shopId) });
      toast.success('レジを開局しました');
      onClose();
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
      title="レジ開局"
      description="釣銭準備金（開局時の現金）を入力します。"
      dismissable={!busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            キャンセル
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            開局する
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <Segmented
          label="入力方法"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'amount', label: '金額で入力' },
            { value: 'count', label: '金種で数える' },
          ]}
        />
        {mode === 'amount' ? (
          <Field label="釣銭準備金">
            <Input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="numeric"
              leading="¥"
              inputSize="lg"
            />
          </Field>
        ) : (
          <>
            <DenominationGrid counts={counts} onChange={setCounts} />
            <p className="text-right text-sm">
              合計 <span className="text-lg font-semibold tabular">{formatYen(opening)}</span>
            </p>
          </>
        )}
        <Field label="メモ" optional>
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            maxLength={500}
          />
        </Field>
      </div>
    </Dialog>
  );
}

function MovementDialog({
  shopId,
  session,
  type,
  onClose,
}: {
  shopId: string;
  session: RegisterSession;
  type: 'pay_in' | 'pay_out';
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [key, regenerate] = useStableKey(newIdempotencyKey);
  const label = type === 'pay_in' ? '入金' : '出金';

  const submit = async () => {
    const n = parseYen(amount);
    if (!n || n <= 0) return setError('金額を入力してください');
    if (!reason.trim()) return setError('理由を入力してください');
    setBusy(true);
    setError(null);
    try {
      await posApi.cashMovement(session.id, { type, amount: n, reason: reason.trim() }, key);
      void qc.invalidateQueries({ queryKey: posKeys.register(shopId) });
      toast.success(`${label}を記録しました`);
      onClose();
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
      title={`${label}を記録`}
      description={type === 'pay_in' ? '両替・釣銭補充など' : '小口経費・銀行預け入れなど'}
      dismissable={!busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            キャンセル
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            記録する
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <Field label="金額" required>
          <Input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="numeric"
            leading="¥"
            inputSize="lg"
          />
        </Field>
        <Field label="理由" required>
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={200}
            placeholder={type === 'pay_in' ? '例: 両替（千円札20枚）' : '例: 備品購入（タオル）'}
          />
        </Field>
      </div>
    </Dialog>
  );
}

function CloseDialog({
  session,
  onClose,
  onClosed,
}: {
  session: RegisterSession;
  onClose: () => void;
  onClosed: (s: RegisterSession) => void;
}) {
  const qc = useQueryClient();
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [key, regenerate] = useStableKey(newIdempotencyKey);
  const counted = useMemo(() => sumDenominations(counts), [counts]);
  const expected = session.expected_cash ?? 0;
  const diff = counted - expected;
  const touched = Object.values(counts).some((v) => v !== '');

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const breakdown = cleanBreakdown(counts);
      const res = await posApi.closeRegister(
        session.id,
        {
          ...(Object.keys(breakdown).length ? { cashBreakdown: breakdown } : { countedCash: 0 }),
          ...(note.trim() ? { note: note.trim() } : {}),
        },
        key,
      );
      void qc.invalidateQueries({ queryKey: posKeys.all });
      onClosed(res);
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
      size="lg"
      title="レジ締め"
      description="ドロワー内の現金を金種ごとに数えて入力してください。"
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
            disabled={!touched}
          >
            締めを確定する
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error ? <Alert tone="danger">{error}</Alert> : null}
        {session.summary && session.summary.openDrafts > 0 ? (
          <Alert tone="warning">
            未確定の会計が {session.summary.openDrafts}{' '}
            件あります。締め後の確定は翌レジに計上されます。
          </Alert>
        ) : null}
        <DenominationGrid counts={counts} onChange={setCounts} />
        <div
          className="grid grid-cols-3 gap-2 rounded-xl bg-surface-2 p-4 text-center"
          aria-live="polite"
        >
          <div>
            <p className="text-xs text-muted">想定残高</p>
            <p className="text-lg font-semibold tabular">{formatYen(expected)}</p>
          </div>
          <div>
            <p className="text-xs text-muted">実査合計</p>
            <p className="text-lg font-semibold tabular" data-testid="counted-cash">
              {formatYen(counted)}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted">差額</p>
            <p
              className={cn(
                'text-lg font-semibold tabular',
                !touched ? 'text-muted' : diff === 0 ? 'text-success' : 'text-danger',
              )}
              data-testid="cash-difference"
            >
              {diff > 0 ? '+' : ''}
              {formatYen(diff)}
            </p>
          </div>
        </div>
        <Field label="メモ（差額の理由など）" optional>
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            maxLength={500}
          />
        </Field>
      </div>
    </Dialog>
  );
}
