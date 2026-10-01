import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  STOCK_REASON_LABEL,
  commerceApi,
  commerceKeys,
  useStock,
  type Product,
} from '../../../api/commerce';
import {
  Alert,
  Badge,
  Button,
  Drawer,
  ErrorState,
  Field,
  InlineLoading,
  Input,
  Select,
  TBody,
  THead,
  Table,
  Td,
  Th,
  Tr,
  useToast,
} from '../../../components/ui';
import { errorMessage, isApiError, newIdempotencyKey } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { formatDateTime } from '../../../lib/format';
import { useStableKey } from '../../../lib/hooks';

type Reason = 'receive' | 'adjust' | 'transfer' | 'return';
const EC = '__ec__';

/** Stock per shop + EC warehouse, adjustments, reorder points, movement history */
export function StockDrawer({
  product,
  onClose,
}: {
  product: Product | null;
  onClose: () => void;
}) {
  const { shops, timezone: tz, can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useStock(product?.id);
  const manage = can('product.manage');
  const locationOptions = product?.shop_id ? shops.filter((s) => s.id === product.shop_id) : shops;
  const [location, setLocation] = useState<string>(product?.shop_id ?? EC);
  const [reason, setReason] = useState<Reason>('receive');
  const [delta, setDelta] = useState('');
  const [toLocation, setToLocation] = useState<string>(EC);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reorder, setReorder] = useState<Record<string, string>>({});
  const [key, regenerate] = useStableKey(newIdempotencyKey);
  const toId = (v: string) => (v === EC ? null : v);

  const adjust = async () => {
    if (!product) return;
    const n = Number(delta);
    if (!Number.isInteger(n) || n === 0) return setError('0以外の整数で数量を入力してください');
    if ((reason === 'receive' || reason === 'return' || reason === 'transfer') && n < 0)
      return setError('入荷・返品・移動は正の数量で入力してください');
    if (reason === 'transfer' && toLocation === location)
      return setError('移動先は移動元と別の場所を選んでください');
    setBusy(true);
    setError(null);
    try {
      const view = await commerceApi.adjustStock(
        product.id,
        {
          shopId: toId(location),
          delta: n,
          reason,
          ...(reason === 'transfer' ? { toShopId: toId(toLocation) } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
        },
        key,
      );
      regenerate();
      qc.setQueryData(commerceKeys.stock(product.id), view);
      void qc.invalidateQueries({ queryKey: ['commerce', 'products'] });
      void qc.invalidateQueries({ queryKey: ['commerce', 'low-stock'] });
      setDelta('');
      setNote('');
      toast.success('在庫を更新しました');
    } catch (e) {
      setError(errorMessage(e));
      if (!isApiError(e) || e.status > 0) regenerate();
    } finally {
      setBusy(false);
    }
  };

  const saveReorder = async (shopId: string | null, value: string) => {
    if (!product) return;
    const n = value === '' ? null : Number(value);
    if (n !== null && (!Number.isInteger(n) || n < 0))
      return toast.error('発注点は0以上の整数で入力してください');
    try {
      const view = await commerceApi.stockSettings(product.id, { shopId, reorderPoint: n });
      qc.setQueryData(commerceKeys.stock(product.id), view);
      void qc.invalidateQueries({ queryKey: ['commerce', 'low-stock'] });
      toast.success('発注点を保存しました');
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <Drawer
      open={!!product}
      onClose={onClose}
      width="lg"
      title={product ? `在庫: ${product.name}` : '在庫'}
      description={q.data ? `合計 ${q.data.total}` : undefined}
    >
      {q.isLoading ? <InlineLoading /> : null}
      {q.error ? <ErrorState error={q.error} /> : null}
      {q.data && !q.data.stockManaged ? (
        <Alert tone="info">この商品は在庫管理の対象外です。</Alert>
      ) : null}
      {q.data ? (
        <div className="space-y-6">
          <Table caption="保管場所別の在庫">
            <THead>
              <tr>
                <Th>保管場所</Th>
                <Th className="text-right">在庫</Th>
                <Th>発注点</Th>
              </tr>
            </THead>
            <TBody>
              {q.data.locations.map((l) => {
                const k = l.shop_id ?? EC;
                return (
                  <Tr key={k}>
                    <Td>
                      {l.location}
                      {l.low ? (
                        <Badge size="sm" tone="danger" className="ml-2">
                          在庫僅少
                        </Badge>
                      ) : null}
                    </Td>
                    <Td className="text-right text-base font-semibold tabular">{l.quantity}</Td>
                    <Td>
                      {manage ? (
                        <div className="flex items-center gap-1">
                          <Input
                            aria-label={`${l.location}の発注点`}
                            inputSize="sm"
                            className="w-20"
                            type="number"
                            min={0}
                            value={
                              reorder[k] ??
                              (l.reorder_point === null ? '' : String(l.reorder_point))
                            }
                            onChange={(e) => setReorder((r) => ({ ...r, [k]: e.target.value }))}
                          />
                          <Button
                            size="xs"
                            onClick={() =>
                              void saveReorder(
                                l.shop_id,
                                reorder[k] ??
                                  (l.reorder_point === null ? '' : String(l.reorder_point)),
                              )
                            }
                          >
                            保存
                          </Button>
                        </div>
                      ) : (
                        (l.reorder_point ?? '—')
                      )}
                    </Td>
                  </Tr>
                );
              })}
              {!q.data.locations.length ? (
                <Tr>
                  <Td colSpan={3} className="text-muted">
                    在庫の記録はまだありません
                  </Td>
                </Tr>
              ) : null}
            </TBody>
          </Table>

          {manage && q.data.stockManaged ? (
            <section className="rounded-2xl border border-border p-4">
              <h3 className="mb-3 text-sm font-semibold">在庫を調整</h3>
              {error ? (
                <Alert tone="danger" className="mb-3">
                  {error}
                </Alert>
              ) : null}
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="種類">
                  <Select value={reason} onChange={(e) => setReason(e.target.value as Reason)}>
                    <option value="receive">入荷</option>
                    <option value="adjust">棚卸調整（±）</option>
                    <option value="transfer">移動</option>
                    <option value="return">返品（戻し）</option>
                  </Select>
                </Field>
                <Field label={reason === 'transfer' ? '移動元' : '保管場所'}>
                  <Select value={location} onChange={(e) => setLocation(e.target.value)}>
                    {!product?.shop_id ? <option value={EC}>EC倉庫</option> : null}
                    {locationOptions.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                {reason === 'transfer' ? (
                  <Field label="移動先">
                    <Select value={toLocation} onChange={(e) => setToLocation(e.target.value)}>
                      {!product?.shop_id ? <option value={EC}>EC倉庫</option> : null}
                      {locationOptions.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                ) : null}
                <Field
                  label="数量"
                  hint={reason === 'adjust' ? '減らす場合はマイナス（例: -2）' : undefined}
                >
                  <Input
                    type="number"
                    value={delta}
                    onChange={(e) => setDelta(e.target.value)}
                    inputMode="numeric"
                  />
                </Field>
                <Field label="メモ" optional className="sm:col-span-2">
                  <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
                </Field>
              </div>
              <div className="mt-3 flex justify-end">
                <Button
                  variant="primary"
                  loading={busy}
                  onClick={() => void adjust()}
                  data-testid="stock-adjust-submit"
                >
                  反映する
                </Button>
              </div>
            </section>
          ) : null}

          <section>
            <h3 className="mb-2 text-sm font-semibold">入出庫履歴（直近50件）</h3>
            {q.data.movements.length ? (
              <ul className="divide-y divide-border rounded-xl border border-border text-[13px]">
                {q.data.movements.map((m) => (
                  <li key={m.id} className="flex items-center gap-3 px-3 py-2">
                    <span className="min-w-0 flex-1">
                      {STOCK_REASON_LABEL[m.reason] ?? m.reason} ・ {m.shop_name ?? 'EC倉庫'}
                      {m.note ? <span className="text-muted"> ・ {m.note}</span> : null}
                      <span className="block text-xs text-subtle">
                        {formatDateTime(m.created_at, tz)}
                      </span>
                    </span>
                    <span
                      className={`tabular font-medium ${m.delta < 0 ? 'text-danger' : 'text-success'}`}
                    >
                      {m.delta > 0 ? '+' : ''}
                      {m.delta}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-muted">履歴はありません</p>
            )}
          </section>
        </div>
      ) : null}
    </Drawer>
  );
}
