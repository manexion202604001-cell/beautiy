import { useMemo, useRef, useState } from 'react';
import { useCoupons, useMenus } from '../../../api/catalog';
import { useProducts } from '../../../api/commerce';
import {
  ITEM_TYPE_LABEL,
  ROLE_LABEL,
  type ItemInput,
  type Transaction,
  type TransactionItem,
} from '../../../api/pos';
import type { Staff } from '../../../api/types';
import {
  Alert,
  Badge,
  Button,
  Dialog,
  EmptyState,
  Field,
  IconButton,
  InlineLoading,
  Input,
  Segmented,
  Select,
} from '../../../components/ui';
import { useDebounced } from '../../../lib/hooks';
import { formatYen } from '../../../lib/format';
import { parseYen, taxRateText } from '../../../lib/money';
import { StaffShareDialog } from './StaffShareDialog';

type Picker = null | 'menu' | 'product' | 'discount' | 'coupon' | 'adjustment';

/**
 * Editable transaction lines. Every change sends the full line list (PUT /transactions/:id/items,
 * optimistic locking by version) and the API recalculates totals and taxes.
 */
export function LineEditor({
  tx,
  inputs,
  staff,
  saving,
  onChange,
}: {
  tx: Transaction;
  inputs: ItemInput[];
  staff: Staff[];
  saving: boolean;
  onChange: (next: ItemInput[]) => void;
}) {
  const [picker, setPicker] = useState<Picker>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [sharing, setSharing] = useState<number | null>(null);
  const items = useMemo(
    () => [...tx.items].sort((a, b) => a.sort_order - b.sort_order),
    [tx.items],
  );
  const defaultStaff = tx.staff_id
    ? [
        {
          staffId: tx.staff_id,
          shareBp: 10000,
          role: 'main' as const,
          isNominated: tx.is_nominated,
        },
      ]
    : undefined;

  const add = (line: ItemInput) => {
    onChange([...inputs, line]);
    setPicker(null);
  };
  const update = (i: number, patch: Partial<ItemInput>) =>
    onChange(inputs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const remove = (i: number) => onChange(inputs.filter((_, j) => j !== i));
  const hasNomination = inputs.some((i) => i.type === 'nomination_fee');

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-2" role="toolbar" aria-label="明細の追加">
        <Button size="sm" icon="scissors" onClick={() => setPicker('menu')} disabled={saving}>
          メニュー
        </Button>
        <Button size="sm" icon="bag" onClick={() => setPicker('product')} disabled={saving}>
          商品
        </Button>
        <Button size="sm" icon="tag" onClick={() => setPicker('discount')} disabled={saving}>
          値引
        </Button>
        <Button size="sm" icon="gift" onClick={() => setPicker('coupon')} disabled={saving}>
          クーポン
        </Button>
        <Button
          size="sm"
          icon="star"
          disabled={saving || !tx.staff_id || hasNomination}
          title={!tx.staff_id ? '担当スタッフを選択してください' : undefined}
          onClick={() =>
            add({
              type: 'nomination_fee',
              name: '指名料',
              quantity: 1,
              staff: [{ staffId: tx.staff_id!, shareBp: 10000, role: 'main', isNominated: true }],
            })
          }
        >
          指名料
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon="edit"
          onClick={() => setPicker('adjustment')}
          disabled={saving}
        >
          調整
        </Button>
      </div>

      {!items.length ? (
        <EmptyState
          icon="receipt"
          title="明細がありません"
          description="メニューや商品を追加してください。"
        />
      ) : (
        <ul
          className="divide-y divide-border rounded-2xl border border-border"
          data-testid="tx-lines"
        >
          {items.map((it, i) => (
            <LineRow
              key={it.id}
              item={it}
              input={inputs[i]}
              saving={saving}
              onQty={(q) => update(i, { quantity: q })}
              onEdit={() => setEditing(i)}
              onStaff={() => setSharing(i)}
              onRemove={() => remove(i)}
            />
          ))}
        </ul>
      )}

      {picker === 'menu' ? (
        <MenuPickerDialog
          shopId={tx.shop_id}
          onClose={() => setPicker(null)}
          onPick={(menuId) => add({ type: 'service', menuId, quantity: 1, staff: defaultStaff })}
        />
      ) : null}
      {picker === 'product' ? (
        <ProductPickerDialog
          shopId={tx.shop_id}
          onClose={() => setPicker(null)}
          onPick={(productId) =>
            add({ type: 'product', productId, quantity: 1, staff: defaultStaff })
          }
        />
      ) : null}
      {picker === 'discount' ? (
        <DiscountDialog onClose={() => setPicker(null)} onAdd={add} />
      ) : null}
      {picker === 'coupon' ? (
        <CouponPickerDialog
          shopId={tx.shop_id}
          used={inputs.filter((x) => x.type === 'coupon').map((x) => x.couponId!)}
          onClose={() => setPicker(null)}
          onPick={(couponId) => add({ type: 'coupon', couponId, quantity: 1 })}
        />
      ) : null}
      {picker === 'adjustment' ? (
        <AdjustmentDialog onClose={() => setPicker(null)} onAdd={add} />
      ) : null}
      {editing !== null && inputs[editing] ? (
        <LineEditDialog
          item={items[editing]!}
          input={inputs[editing]}
          onClose={() => setEditing(null)}
          onSave={(patch) => {
            update(editing, patch);
            setEditing(null);
          }}
        />
      ) : null}
      {sharing !== null && inputs[sharing] ? (
        <StaffShareDialog
          lineName={items[sharing]?.name ?? ''}
          value={inputs[sharing].staff ?? []}
          staff={staff}
          onClose={() => setSharing(null)}
          onSave={(shares) => {
            update(sharing, { staff: shares.length ? shares : undefined });
            setSharing(null);
          }}
        />
      ) : null}
    </div>
  );
}

function LineRow({
  item,
  input,
  saving,
  onQty,
  onEdit,
  onStaff,
  onRemove,
}: {
  item: TransactionItem;
  input: ItemInput | undefined;
  saving: boolean;
  onQty: (q: number) => void;
  onEdit: () => void;
  onStaff: () => void;
  onRemove: () => void;
}) {
  const positive =
    ['service', 'product', 'nomination_fee'].includes(item.item_type) ||
    (item.item_type === 'adjustment' && item.amount > 0);
  const qtyEditable = item.item_type === 'service' || item.item_type === 'product';
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3" data-testid="tx-line">
      <div className="min-w-0 flex-1 basis-48">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge size="sm" tone={positive ? 'neutral' : 'warning'}>
            {ITEM_TYPE_LABEL[item.item_type]}
          </Badge>
          <span className="truncate text-sm font-medium">{item.name}</span>
        </div>
        <p className="mt-0.5 text-xs text-muted">
          {positive ? (
            <>
              {formatYen(item.unit_price)} × {item.quantity} ・ 税{taxRateText(item.tax_rate_bp)}
              {item.line_discount ? (
                <span className="text-warning"> ・ 値引 −{formatYen(item.line_discount)}</span>
              ) : null}
              {item.allocated_discount ? (
                <span> ・ 按分値引 −{formatYen(item.allocated_discount)}</span>
              ) : null}
            </>
          ) : item.item_type === 'discount' && item.details?.percent ? (
            `${String(item.details.percent)}% 値引`
          ) : (
            '会計全体から値引'
          )}
        </p>
        {positive && item.staff.length ? (
          <button
            type="button"
            onClick={onStaff}
            disabled={saving}
            className="mt-1 flex flex-wrap gap-1 text-left"
            aria-label={`${item.name}の担当者配分を編集`}
          >
            {item.staff.map((s) => (
              <span
                key={s.id}
                className="rounded-full bg-primary-soft px-2 py-0.5 text-[11px] text-primary"
              >
                {s.staff_name} {s.share_bp / 100}%
                {s.role !== 'main' ? `（${ROLE_LABEL[s.role]}）` : ''}
                {s.is_nominated ? '・指名' : ''}
              </span>
            ))}
          </button>
        ) : positive ? (
          <button
            type="button"
            onClick={onStaff}
            disabled={saving}
            className="mt-1 text-[11px] text-primary underline"
          >
            担当者を設定
          </button>
        ) : null}
      </div>
      {qtyEditable ? (
        <div className="flex items-center gap-1" role="group" aria-label={`${item.name}の数量`}>
          <IconButton
            icon="chevron-down"
            label="数量を減らす"
            size="sm"
            variant="outline"
            disabled={saving || item.quantity <= 1}
            onClick={() => onQty(item.quantity - 1)}
          />
          <span className="w-7 text-center text-sm tabular" aria-live="polite">
            {item.quantity}
          </span>
          <IconButton
            icon="chevron-up"
            label="数量を増やす"
            size="sm"
            variant="outline"
            disabled={saving || item.quantity >= 999}
            onClick={() => onQty(item.quantity + 1)}
          />
        </div>
      ) : null}
      <span
        className={`w-24 text-right text-sm font-semibold tabular ${item.amount < 0 ? 'text-danger' : ''}`}
      >
        {formatYen(item.amount)}
      </span>
      <div className="flex items-center">
        {positive && input ? (
          <IconButton
            icon="edit"
            label={`${item.name}を編集`}
            size="sm"
            onClick={onEdit}
            disabled={saving}
          />
        ) : null}
        <IconButton
          icon="trash"
          label={`${item.name}を削除`}
          size="sm"
          onClick={onRemove}
          disabled={saving}
        />
      </div>
    </li>
  );
}

function LineEditDialog({
  item,
  input,
  onClose,
  onSave,
}: {
  item: TransactionItem;
  input: ItemInput;
  onClose: () => void;
  onSave: (patch: Partial<ItemInput>) => void;
}) {
  const [price, setPrice] = useState(String(input.unitPrice ?? item.unit_price));
  const [qty, setQty] = useState(String(input.quantity ?? item.quantity));
  const [discountYen, setDiscountYen] = useState(
    input.lineDiscount ? String(input.lineDiscount) : '',
  );
  const [discountPct, setDiscountPct] = useState(
    input.lineDiscountPercent ? String(input.lineDiscountPercent) : '',
  );
  const [tax, setTax] = useState(String(input.taxRateBp ?? item.tax_rate_bp));
  const [error, setError] = useState<string | null>(null);
  const qtyEditable = item.item_type === 'service' || item.item_type === 'product';

  const save = () => {
    const p = parseYen(price);
    const q = Number(qty);
    const dy = discountYen ? parseYen(discountYen) : 0;
    const dp = discountPct ? Number(discountPct) : 0;
    if (p === null || p < 0) return setError('単価は0以上の金額で入力してください');
    if (!Number.isInteger(q) || q < 1 || q > 999) return setError('数量は1〜999で入力してください');
    if (dy === null || dy < 0) return setError('値引額は0以上で入力してください');
    if (!Number.isInteger(dp) || dp < 0 || dp > 100)
      return setError('値引率は0〜100%で入力してください');
    onSave({
      unitPrice: p,
      quantity: q,
      taxRateBp: Number(tax),
      lineDiscount: dy || undefined,
      lineDiscountPercent: dp || undefined,
    });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`${item.name}を編集`}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            キャンセル
          </Button>
          <Button variant="primary" onClick={save}>
            適用する
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <div className="grid grid-cols-2 gap-3">
          <Field label="単価（税込）">
            <Input
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              inputMode="numeric"
              leading="¥"
            />
          </Field>
          <Field label="数量">
            <Input
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              inputMode="numeric"
              disabled={!qtyEditable}
            />
          </Field>
          <Field label="値引額">
            <Input
              value={discountYen}
              onChange={(e) => setDiscountYen(e.target.value)}
              inputMode="numeric"
              leading="¥"
              placeholder="0"
            />
          </Field>
          <Field label="値引率">
            <Input
              value={discountPct}
              onChange={(e) => setDiscountPct(e.target.value)}
              inputMode="numeric"
              trailing="%"
              placeholder="0"
            />
          </Field>
        </div>
        <Field label="税率">
          <Select value={tax} onChange={(e) => setTax(e.target.value)}>
            <option value="1000">10%（標準税率）</option>
            <option value="800">8%（軽減税率）</option>
            <option value="0">非課税</option>
          </Select>
        </Field>
      </div>
    </Dialog>
  );
}

function MenuPickerDialog({
  shopId,
  onClose,
  onPick,
}: {
  shopId: string;
  onClose: () => void;
  onPick: (menuId: string) => void;
}) {
  const menus = useMenus(shopId);
  const [q, setQ] = useState('');
  const active = (menus.data ?? []).filter(
    (m) =>
      m.status === 'active' && (!q || m.name.includes(q) || (m.categoryName ?? '').includes(q)),
  );
  const groups = new Map<string, typeof active>();
  for (const m of active) {
    const k = m.categoryName ?? 'その他';
    groups.set(k, [...(groups.get(k) ?? []), m]);
  }
  return (
    <Dialog open onClose={onClose} title="メニューを追加" size="lg">
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="メニュー名で絞り込み"
        aria-label="メニューを検索"
        leading={
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            aria-hidden
          >
            <path d="M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-3.5-3.5" />
          </svg>
        }
      />
      {menus.isLoading ? <InlineLoading /> : null}
      <div className="mt-4 space-y-4">
        {[...groups.entries()].map(([cat, list]) => (
          <section key={cat}>
            <h3 className="mb-1.5 text-xs font-semibold text-muted">{cat}</h3>
            <ul className="grid gap-2 sm:grid-cols-2">
              {list.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => onPick(m.id)}
                    className="flex w-full items-center justify-between gap-3 rounded-xl border border-border bg-surface px-3 py-2.5 text-left hover:border-primary"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{m.name}</span>
                      <span className="text-xs text-muted">{m.durationMin}分</span>
                    </span>
                    <span className="shrink-0 text-sm tabular">
                      {formatYen(
                        m.priceTaxIncluded
                          ? m.price
                          : Math.floor((m.price * (10000 + m.taxRateBp)) / 10000),
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {menus.data && !active.length ? (
          <p className="text-[13px] text-muted">該当するメニューがありません</p>
        ) : null}
      </div>
    </Dialog>
  );
}

function ProductPickerDialog({
  shopId,
  onClose,
  onPick,
}: {
  shopId: string;
  onClose: () => void;
  onPick: (productId: string) => void;
}) {
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 250);
  const products = useProducts({ shopId, q: dq || undefined, status: 'active', limit: 30 });
  const list = products.data?.pages.flatMap((p) => p.items) ?? [];
  const inputRef = useRef<HTMLInputElement>(null);

  const onEnter = () => {
    const term = q.trim();
    if (!term) return;
    // barcode scanners type the code + Enter: pick an exact barcode / SKU match immediately
    const exact = list.find((p) => p.barcode === term || p.sku === term);
    if (exact) onPick(exact.id);
    else if (list.length === 1 && dq === term) onPick(list[0]!.id);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="商品を追加"
      size="lg"
      description="商品名・SKUで検索、またはバーコードをスキャンしてください。"
    >
      <Input
        ref={inputRef}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onEnter();
          }
        }}
        placeholder="商品名 / SKU / バーコード"
        aria-label="商品を検索（バーコード可）"
        inputSize="lg"
        data-autofocus
      />
      {products.isLoading ? <InlineLoading /> : null}
      <ul className="mt-4 divide-y divide-border rounded-xl border border-border">
        {list.map((p) => {
          const stock = p.stocks.find((s) => s.shop_id === shopId);
          return (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => onPick(p.id)}
                className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-surface-2"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{p.name}</span>
                  <span className="text-xs text-muted">
                    {[p.brand, p.sku ? `SKU ${p.sku}` : null, p.barcode]
                      .filter(Boolean)
                      .join(' ・ ')}
                    {p.stock_managed ? ` ・ 在庫 ${stock?.quantity ?? 0}` : ''}
                  </span>
                </span>
                <span className="shrink-0 text-sm tabular">{formatYen(p.price_inclusive)}</span>
              </button>
            </li>
          );
        })}
        {products.data && !list.length ? (
          <li className="px-3 py-4 text-[13px] text-muted">該当する商品がありません</li>
        ) : null}
      </ul>
    </Dialog>
  );
}

function DiscountDialog({
  onClose,
  onAdd,
}: {
  onClose: () => void;
  onAdd: (l: ItemInput) => void;
}) {
  const [kind, setKind] = useState<'amount' | 'percent'>('amount');
  const [value, setValue] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = () => {
    const n = kind === 'amount' ? parseYen(value) : Number(value);
    if (n === null || !Number.isInteger(n) || n <= 0)
      return setError('1以上の整数で入力してください');
    if (kind === 'percent' && n > 100) return setError('値引率は100%以下で入力してください');
    onAdd({
      type: 'discount',
      ...(name.trim() ? { name: name.trim() } : {}),
      ...(kind === 'amount' ? { amount: n } : { percent: n }),
    });
  };
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title="値引を追加"
      description="会計全体に対する値引（各明細に按分されます）"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            キャンセル
          </Button>
          <Button variant="primary" onClick={save}>
            追加する
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <Segmented
          label="値引の種類"
          value={kind}
          onChange={setKind}
          options={[
            { value: 'amount', label: '金額' },
            { value: 'percent', label: '割合' },
          ]}
        />
        <Field label={kind === 'amount' ? '値引額' : '値引率'}>
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            inputMode="numeric"
            leading={kind === 'amount' ? '¥' : undefined}
            trailing={kind === 'percent' ? '%' : undefined}
            inputSize="lg"
          />
        </Field>
        <Field label="名称" optional>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例: 誕生月割引"
            maxLength={200}
          />
        </Field>
      </div>
    </Dialog>
  );
}

function AdjustmentDialog({
  onClose,
  onAdd,
}: {
  onClose: () => void;
  onAdd: (l: ItemInput) => void;
}) {
  const [sign, setSign] = useState<'plus' | 'minus'>('minus');
  const [value, setValue] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = () => {
    const n = parseYen(value);
    if (n === null || n <= 0) return setError('1以上の金額で入力してください');
    onAdd({
      type: 'adjustment',
      name: name.trim() || (sign === 'plus' ? '追加料金' : '端数調整'),
      quantity: 1,
      unitPrice: sign === 'plus' ? n : -n,
      ...(sign === 'plus' ? { taxRateBp: 1000 } : {}),
    });
  };
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title="金額を調整"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            キャンセル
          </Button>
          <Button variant="primary" onClick={save}>
            追加する
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <Segmented
          label="調整の種類"
          value={sign}
          onChange={setSign}
          options={[
            { value: 'minus', label: '減額' },
            { value: 'plus', label: '加算' },
          ]}
        />
        <Field label="金額（税込）">
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            inputMode="numeric"
            leading="¥"
          />
        </Field>
        <Field label="名称" optional>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
        </Field>
      </div>
    </Dialog>
  );
}

function CouponPickerDialog({
  shopId,
  used,
  onClose,
  onPick,
}: {
  shopId: string;
  used: string[];
  onClose: () => void;
  onPick: (couponId: string) => void;
}) {
  const coupons = useCoupons(shopId);
  const [code, setCode] = useState('');
  const now = Date.now();
  const list = (coupons.data ?? []).filter(
    (c) =>
      c.status === 'active' &&
      !used.includes(c.id) &&
      (!c.valid_until || new Date(c.valid_until).getTime() > now) &&
      (!c.valid_from || new Date(c.valid_from).getTime() <= now),
  );
  const byCode = code.trim()
    ? list.find((c) => c.code?.toLowerCase() === code.trim().toLowerCase())
    : undefined;
  return (
    <Dialog open onClose={onClose} title="クーポンを適用" size="md">
      <div className="mb-4 flex gap-2">
        <Input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="クーポンコード"
          aria-label="クーポンコード"
        />
        <Button variant="primary" disabled={!byCode} onClick={() => byCode && onPick(byCode.id)}>
          適用
        </Button>
      </div>
      {coupons.isLoading ? <InlineLoading /> : null}
      <ul className="space-y-2">
        {list.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              onClick={() => onPick(c.id)}
              className="flex w-full items-center justify-between gap-3 rounded-xl border border-border px-3 py-2.5 text-left hover:border-primary"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{c.name}</span>
                <span className="text-xs text-muted">
                  {c.discount_type === 'percent'
                    ? `${c.discount_value}%OFF`
                    : c.discount_type === 'fixed_price'
                      ? `特別価格 ${formatYen(c.discount_value)}`
                      : `${formatYen(c.discount_value)}引き`}
                  {c.min_amount ? ` ・ ${formatYen(c.min_amount)}以上` : ''}
                  {c.new_customer_only ? ' ・ 新規限定' : ''}
                </span>
              </span>
              {c.code ? <Badge size="sm">{c.code}</Badge> : null}
            </button>
          </li>
        ))}
        {coupons.data && !list.length ? (
          <li className="text-[13px] text-muted">利用できるクーポンがありません</li>
        ) : null}
      </ul>
    </Dialog>
  );
}
