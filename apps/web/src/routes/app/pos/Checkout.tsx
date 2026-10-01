import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useStaffList } from '../../../api/org';
import {
  itemsToInputs,
  METHOD_LABEL,
  posApi,
  posKeys,
  useTransaction,
  type ItemInput,
  type Transaction,
} from '../../../api/pos';
import {
  CustomerPicker,
  type PickedCustomer,
} from '../../../components/appointments/CustomerPicker';
import {
  Alert,
  Button,
  ButtonLink,
  Card,
  CardHeader,
  Checkbox,
  ConfirmDialog,
  ErrorState,
  Field,
  Icon,
  KeyValue,
  PageHeader,
  PageSpinner,
  Select,
  useToast,
} from '../../../components/ui';
import { errorMessage, isApiError, newIdempotencyKey } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { cn } from '../../../lib/cn';
import { formatDateTime, formatYen } from '../../../lib/format';
import { useStableKey } from '../../../lib/hooks';
import { CompletedPanel } from './CompletedPanel';
import { LineEditor } from './LineEditor';
import { PaymentPanel } from './PaymentPanel';
import { TaxBreakdown, TxStatusBadge } from './shared';

export default function Checkout() {
  const { transactionId } = useParams();
  const q = useTransaction(transactionId);
  if (q.isLoading) return <PageSpinner />;
  if (q.error || !q.data) {
    return (
      <div className="mx-auto max-w-xl">
        <ErrorState
          error={q.error ?? new Error('会計が見つかりません')}
          onRetry={() => void q.refetch()}
        />
      </div>
    );
  }
  return <CheckoutView key={q.data.id} tx={q.data} />;
}

function CheckoutView({ tx }: { tx: Transaction }) {
  const { can, timezone: tz } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const staffQ = useStaffList({ shopId: tx.shop_id });
  const staff = useMemo(
    () => (staffQ.data ?? []).filter((s) => s.status === 'active'),
    [staffQ.data],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [warnings, setWarnings] = useState<string[]>(tx.warnings ?? []);
  const [change, setChange] = useState<number | null>(null);
  const [completeKey, regenComplete] = useStableKey(newIdempotencyKey);
  const [completing, setCompleting] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const inputs = useMemo(() => itemsToInputs(tx.items), [tx.items]);
  const draft = tx.status === 'draft';
  const operate = can('pos.operate');
  const [customer, setCustomer] = useState<PickedCustomer | null>(
    tx.customer_id ? { id: tx.customer_id, name: tx.customer_name ?? '' } : null,
  );

  useEffect(() => {
    setCustomer(tx.customer_id ? { id: tx.customer_id, name: tx.customer_name ?? '' } : null);
  }, [tx.customer_id, tx.customer_name]);

  const put = (updated: Transaction) => {
    qc.setQueryData(posKeys.detail(updated.id), updated);
    void qc.invalidateQueries({ queryKey: ['pos', 'transactions'] });
  };

  const save = async (patch: {
    items?: ItemInput[];
    staffId?: string | null;
    isNominated?: boolean;
    customerId?: string | null;
  }) => {
    setSaving(true);
    setError(null);
    try {
      const updated = await posApi.replaceItems(tx.id, {
        version: tx.version,
        items: patch.items ?? inputs,
        ...patch,
      });
      setWarnings(updated.warnings ?? []);
      put(updated);
    } catch (e) {
      setError(e);
      if (isApiError(e) && e.code === 'VERSION_CONFLICT')
        void qc.invalidateQueries({ queryKey: posKeys.detail(tx.id) });
    } finally {
      setSaving(false);
    }
  };

  const complete = async () => {
    setCompleting(true);
    setError(null);
    try {
      const done = await posApi.complete(tx.id, completeKey);
      put(done);
      void qc.invalidateQueries({ queryKey: posKeys.all });
      void qc.invalidateQueries({ queryKey: ['appointments'] });
      if (done.customer_id) void qc.invalidateQueries({ queryKey: ['customers'] });
      toast.success(
        '会計が完了しました',
        done.transaction_number ? `会計番号 ${done.transaction_number}` : undefined,
      );
      if (done.stockWarnings?.length)
        toast.info(
          '在庫がマイナスになった商品があります',
          done.stockWarnings.map((w) => w.name).join('、'),
        );
      regenComplete();
    } catch (e) {
      setError(e);
      if (!isApiError(e) || e.status > 0) regenComplete();
    } finally {
      setCompleting(false);
    }
  };

  const discard = async (reason?: string) => {
    try {
      await posApi.void(tx.id, reason || '会計の破棄');
      void qc.invalidateQueries({ queryKey: posKeys.all });
      toast.success('会計を破棄しました');
      navigate('/app/pos');
    } catch (e) {
      toast.error(e);
    } finally {
      setDiscardOpen(false);
    }
  };

  const canComplete =
    draft && operate && tx.items.length > 0 && tx.outstanding === 0 && tx.total === tx.paid_total;

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
        title={
          <span className="flex flex-wrap items-center gap-2">
            {draft ? 'お会計' : `会計 ${tx.transaction_number ?? ''}`}
            <TxStatusBadge status={tx.status} />
          </span>
        }
        description={
          tx.completed_at
            ? `確定 ${formatDateTime(tx.completed_at, tz)}`
            : `作成 ${formatDateTime(tx.created_at, tz)}${tx.appointment_id ? ' ・ 予約から作成' : ' ・ 予約なし'}`
        }
        actions={
          draft && operate ? (
            <Button
              size="sm"
              variant="ghost"
              className="!text-danger"
              icon="trash"
              onClick={() => setDiscardOpen(true)}
            >
              破棄
            </Button>
          ) : null
        }
      />

      {error ? (
        <Alert
          tone="danger"
          className="mb-4"
          title={
            isApiError(error) && error.code === 'VERSION_CONFLICT'
              ? '他の端末で会計が更新されました'
              : '操作に失敗しました'
          }
        >
          {isApiError(error) && error.code === 'VERSION_CONFLICT' ? (
            '最新の内容を読み込みました。もう一度操作してください。'
          ) : isApiError(error) && error.code === 'REGISTER_NOT_OPEN' ? (
            <>
              レジが開局されていません。
              <Link className="underline" to="/app/pos">
                会計トップ
              </Link>
              でレジを開局してください。
            </>
          ) : (
            errorMessage(error)
          )}
        </Alert>
      ) : null}
      {warnings.length ? (
        <Alert tone="warning" className="mb-4" title="ご確認ください">
          {warnings.join(' / ')}
        </Alert>
      ) : null}
      {change !== null && change > 0 ? (
        <Alert tone="success" className="mb-4" title={`お釣り ${formatYen(change)}`}>
          {draft
            ? 'お客様にお釣りをお渡しください。'
            : '会計が完了しました。お釣りのお渡しをお忘れなく。'}
        </Alert>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_400px]">
        <div className="min-w-0 space-y-5">
          <Card>
            <CardHeader title="お客様・担当" />
            {draft && operate ? (
              <div className="grid gap-4 sm:grid-cols-2">
                {tx.appointment_id ? (
                  <KeyValue
                    items={[{ label: 'お客様', value: tx.customer_name ?? '顧客未登録' }]}
                  />
                ) : (
                  <CustomerPicker
                    value={customer}
                    onChange={(c) => {
                      setCustomer(c);
                      void save({ customerId: c?.id ?? null });
                    }}
                  />
                )}
                <div className="space-y-2">
                  <Field label="主担当">
                    <Select
                      value={tx.staff_id ?? ''}
                      disabled={saving}
                      onChange={(e) => void save({ staffId: e.target.value || null })}
                    >
                      <option value="">担当なし</option>
                      {staff.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.display_name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Checkbox
                    label="指名あり"
                    checked={tx.is_nominated}
                    disabled={saving}
                    onChange={(e) => void save({ isNominated: e.target.checked })}
                  />
                </div>
              </div>
            ) : (
              <KeyValue
                items={[
                  {
                    label: 'お客様',
                    value: tx.customer_id ? (
                      <Link
                        className="text-primary hover:underline"
                        to={`/app/customers/${tx.customer_id}`}
                      >
                        {tx.customer_name}
                      </Link>
                    ) : (
                      '顧客未登録'
                    ),
                  },
                  {
                    label: '主担当',
                    value: `${tx.staff_name ?? '—'}${tx.is_nominated ? '（指名）' : ''}`,
                  },
                  ...(tx.is_new_customer !== null
                    ? [{ label: '区分', value: tx.is_new_customer ? '新規' : '再来' }]
                    : []),
                  ...(tx.void_reason ? [{ label: '取消理由', value: tx.void_reason }] : []),
                ]}
              />
            )}
          </Card>

          <Card>
            <CardHeader
              title="明細"
              description={draft ? '金額は税込です。変更すると自動で再計算します。' : undefined}
            />
            {draft && operate ? (
              <LineEditor
                tx={tx}
                inputs={inputs}
                staff={staff}
                saving={saving}
                onChange={(items) => void save({ items })}
              />
            ) : (
              <ReadOnlyLines tx={tx} />
            )}
          </Card>
        </div>

        <div className="min-w-0 space-y-5 lg:sticky lg:top-4 lg:self-start">
          <Card>
            <CardHeader title="合計" />
            <dl className="space-y-1.5 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted">小計</dt>
                <dd className="tabular">{formatYen(tx.subtotal)}</dd>
              </div>
              {tx.discount_total ? (
                <div className="flex justify-between">
                  <dt className="text-muted">値引・クーポン</dt>
                  <dd className="tabular text-danger">−{formatYen(tx.discount_total)}</dd>
                </div>
              ) : null}
              <div className="flex items-baseline justify-between border-t border-border pt-2">
                <dt className="font-semibold">合計（税込）</dt>
                <dd className="text-2xl font-semibold tabular" data-testid="tx-total">
                  {formatYen(tx.total)}
                </dd>
              </div>
              <div className="flex justify-between text-xs text-muted">
                <dt>内消費税</dt>
                <dd className="tabular">{formatYen(tx.tax_total)}</dd>
              </div>
            </dl>
            <div className="mt-2">
              <TaxBreakdown breakdown={tx.tax_breakdown} />
            </div>
            {tx.point_used || tx.point_earned ? (
              <p className="mt-2 text-xs text-muted">
                {tx.point_used ? `ポイント利用 ${tx.point_used}pt` : ''}
                {tx.point_used && tx.point_earned ? ' ・ ' : ''}
                {tx.point_earned ? `付与 ${tx.point_earned}pt` : ''}
              </p>
            ) : null}
            {tx.customer_point_balance !== null && draft ? (
              <p className="mt-1 text-xs text-subtle">
                保有ポイント {tx.customer_point_balance.toLocaleString('ja-JP')}pt
              </p>
            ) : null}
          </Card>

          <Card>
            <CardHeader title="お支払い" />
            <PaymentPanel
              tx={tx}
              disabled={saving || completing || !operate}
              onUpdated={put}
              onChange={setChange}
            />
            {draft && operate ? (
              <Button
                variant="primary"
                size="lg"
                className="mt-4 w-full"
                icon="check"
                disabled={!canComplete || saving}
                loading={completing}
                onClick={() => void complete()}
                data-testid="complete-transaction"
              >
                会計を確定する
              </Button>
            ) : null}
            {!draft && tx.change_total ? (
              <p className={cn('mt-3 text-sm')}>
                お釣り <span className="font-semibold tabular">{formatYen(tx.change_total)}</span>
              </p>
            ) : null}
          </Card>

          {!draft ? <CompletedPanel tx={tx} onUpdated={put} /> : null}
          {!draft && tx.status !== 'voided' ? (
            <ButtonLink to="/app/pos" variant="secondary" className="w-full">
              会計トップに戻る
            </ButtonLink>
          ) : null}
        </div>
      </div>

      <ConfirmDialog
        open={discardOpen}
        onClose={() => setDiscardOpen(false)}
        title="この会計を破棄しますか？"
        description="受け取った支払は取り消されます。"
        tone="danger"
        confirmLabel="破棄する"
        reason
        reasonLabel="理由（任意）"
        onConfirm={(r) => void discard(r)}
      />
    </div>
  );
}

function ReadOnlyLines({ tx }: { tx: Transaction }) {
  const items = [...tx.items].sort((a, b) => a.sort_order - b.sort_order);
  return (
    <ul className="divide-y divide-border text-sm">
      {items.map((i) => (
        <li key={i.id} className="flex items-start justify-between gap-3 py-2.5">
          <div className="min-w-0">
            <p className="font-medium">
              {i.name}
              {i.tax_rate_bp === 800 ? (
                <span className="ml-1 text-xs text-muted">※軽減</span>
              ) : null}
            </p>
            <p className="text-xs text-muted">
              {i.amount >= 0 ? `${formatYen(i.unit_price)} × ${i.quantity}` : '値引'}
              {i.returned_quantity ? ` ・ 返品 ${i.returned_quantity}` : ''}
              {i.staff.length
                ? ` ・ ${i.staff.map((s) => `${s.staff_name} ${s.share_bp / 100}%`).join(' / ')}`
                : ''}
            </p>
          </div>
          <span className={cn('tabular', i.amount < 0 && 'text-danger')}>
            {formatYen(i.amount)}
          </span>
        </li>
      ))}
      {tx.payments
        .filter((p) => ['succeeded', 'partially_refunded', 'refunded'].includes(p.status))
        .map((p) => (
          <li key={p.id} className="flex justify-between gap-3 py-2 text-xs text-muted">
            <span>
              {p.method === 'custom'
                ? (p.custom_method_name ?? METHOD_LABEL.custom)
                : METHOD_LABEL[p.method]}
            </span>
            <span className="tabular">{formatYen(p.amount)}</span>
          </li>
        ))}
    </ul>
  );
}
