import { useState } from 'react';
import { useProducts } from '../../../api/commerce';
import { Field, Input, TagChip } from '../../../components/ui';
import { useAuth } from '../../../lib/auth';
import { formatYen } from '../../../lib/format';
import { useDebounced } from '../../../lib/hooks';

/** Recommended homecare products (typeahead over the product master) */
export function HomecareProducts({
  shopId,
  value,
  onChange,
  disabled,
}: {
  shopId: string;
  value: { id: string; name: string }[];
  onChange: (v: { id: string; name: string }[]) => void;
  disabled?: boolean;
}) {
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 250);
  const canSearch = can('product.manage') || can('pos.read') || can('pos.operate');
  const products = useProducts(
    { shopId, q: dq || undefined, status: 'active', limit: 8 },
    canSearch && !disabled && dq.length > 0,
  );
  const list = (products.data?.pages.flatMap((p) => p.items) ?? []).filter(
    (p) => !value.some((v) => v.id === p.id),
  );

  return (
    <div>
      <p className="mb-1.5 text-[13px] font-medium">おすすめ商品</p>
      {value.length ? (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {value.map((p) => (
            <TagChip
              key={p.id}
              name={p.name}
              color="var(--primary)"
              onRemove={disabled ? undefined : () => onChange(value.filter((x) => x.id !== p.id))}
            />
          ))}
        </div>
      ) : null}
      {!disabled && canSearch ? (
        <div className="relative">
          <Field label="商品を検索して追加" labelHidden>
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="商品名・ブランドで検索"
              inputSize="sm"
            />
          </Field>
          {dq && list.length ? (
            <ul
              className="absolute inset-x-0 top-full z-10 mt-1 max-h-60 overflow-auto rounded-xl border border-border bg-surface shadow-card"
              role="listbox"
              aria-label="商品候補"
            >
              {list.map((p) => (
                <li key={p.id} role="option" aria-selected={false}>
                  <button
                    type="button"
                    className="flex w-full justify-between gap-2 px-3 py-2 text-left text-[13px] hover:bg-surface-2"
                    onClick={() => {
                      onChange([...value, { id: p.id, name: p.name }].slice(0, 20));
                      setQ('');
                    }}
                  >
                    <span className="truncate">{p.name}</span>
                    <span className="shrink-0 text-muted tabular">
                      {formatYen(p.price_inclusive)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
