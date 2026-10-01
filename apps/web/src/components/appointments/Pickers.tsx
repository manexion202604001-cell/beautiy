import { useMemo } from 'react';
import type { AvailabilitySlot, EffectiveMenu } from '../../api/types';
import { cn } from '../../lib/cn';
import { formatDuration, formatYen } from '../../lib/format';
import { zonedParts } from '../../lib/time';
import { Badge, Icon } from '../ui';

/** Multi-select menu list grouped by category (selection order = service order) */
export function MenuPicker({
  menus,
  value,
  onChange,
  max = 5,
  error,
}: {
  menus: EffectiveMenu[];
  value: string[];
  onChange: (ids: string[]) => void;
  max?: number;
  error?: string;
}) {
  const groups = useMemo(() => {
    const map = new Map<string, EffectiveMenu[]>();
    for (const m of menus) {
      const key = m.categoryName ?? 'その他';
      map.set(key, [...(map.get(key) ?? []), m]);
    }
    return [...map.entries()];
  }, [menus]);
  const selected = value
    .map((id) => menus.find((m) => m.id === id))
    .filter((m): m is EffectiveMenu => !!m);
  const total = selected.reduce((s, m) => s + m.price, 0);
  const duration = selected.reduce((s, m) => s + m.durationMin, 0);

  const toggle = (id: string) => {
    if (value.includes(id)) onChange(value.filter((x) => x !== id));
    else if (value.length < max) onChange([...value, id]);
  };

  return (
    <div>
      <div
        className={cn(
          'max-h-72 overflow-y-auto rounded-xl border',
          error ? 'border-danger' : 'border-border',
        )}
      >
        {groups.map(([cat, items]) => (
          <fieldset key={cat} className="border-b border-border last:border-b-0">
            <legend className="sr-only">{cat}</legend>
            <p className="sticky top-0 bg-surface-2 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
              {cat}
            </p>
            {items.map((m) => {
              const checked = value.includes(m.id);
              const disabled = !checked && value.length >= max;
              return (
                <label
                  key={m.id}
                  className={cn(
                    'flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-surface-2/60',
                    checked && 'bg-primary-soft/50',
                    disabled && 'cursor-not-allowed opacity-50',
                  )}
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-[var(--primary)]"
                    checked={checked}
                    disabled={disabled}
                    onChange={() => toggle(m.id)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-fg">
                      {m.name}
                      {m.isConsultation ? (
                        <Badge size="sm" tone="info" className="ml-1.5">
                          相談
                        </Badge>
                      ) : null}
                      {m.resourceRequirements.length ? (
                        <Badge size="sm" tone="neutral" className="ml-1.5">
                          設備
                        </Badge>
                      ) : null}
                    </span>
                    <span className="block text-xs text-muted">
                      {formatDuration(m.durationMin)}
                    </span>
                  </span>
                  <span className="text-[13px] font-medium tabular text-fg">
                    {formatYen(m.price)}
                  </span>
                </label>
              );
            })}
          </fieldset>
        ))}
        {menus.length === 0 ? (
          <p className="px-3 py-4 text-[13px] text-muted">メニューが登録されていません</p>
        ) : null}
      </div>
      {error ? <p className="mt-1 text-xs font-medium text-danger">{error}</p> : null}
      {selected.length ? (
        <p className="mt-2 text-[13px] text-muted">
          {selected.length}件選択 ・ 所要{' '}
          <span className="font-medium text-fg">{formatDuration(duration)}</span> ・ 目安{' '}
          <span className="font-medium text-fg tabular">{formatYen(total)}</span>
        </p>
      ) : null}
    </div>
  );
}

/** Time slot chips for one day */
export function SlotPicker({
  slots,
  value,
  onChange,
  tz,
  loading,
  emptyText = 'この日は空き枠がありません',
  size = 'md',
}: {
  slots: AvailabilitySlot[];
  value: string | null;
  onChange: (startIso: string, slot: AvailabilitySlot) => void;
  tz: string;
  loading?: boolean;
  emptyText?: string;
  size?: 'md' | 'lg';
}) {
  if (loading) {
    return (
      <div className="grid grid-cols-4 gap-2 sm:grid-cols-6" aria-busy>
        {Array.from({ length: 12 }, (_, i) => (
          <div
            key={i}
            className={cn('animate-pulse rounded-lg bg-surface-2', size === 'lg' ? 'h-11' : 'h-9')}
          />
        ))}
      </div>
    );
  }
  if (!slots.length) {
    return (
      <p className="flex items-center gap-2 rounded-xl bg-surface-2 px-3 py-3 text-[13px] text-muted">
        <Icon name="info" size={16} />
        {emptyText}
      </p>
    );
  }
  return (
    <div
      role="radiogroup"
      aria-label="開始時刻"
      className={cn(
        'grid gap-2',
        size === 'lg' ? 'grid-cols-3 sm:grid-cols-5' : 'grid-cols-4 sm:grid-cols-6',
      )}
    >
      {slots.map((s) => {
        const t = zonedParts(s.start, tz).time;
        const selected = value === s.start;
        return (
          <button
            key={s.start}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(s.start, s)}
            className={cn(
              'rounded-lg border font-medium tabular transition-colors',
              size === 'lg' ? 'h-11 text-[15px]' : 'h-9 text-[13px]',
              selected
                ? 'border-primary bg-primary text-primary-fg'
                : 'border-border bg-surface text-fg hover:border-primary hover:text-primary',
            )}
          >
            {t}
          </button>
        );
      })}
    </div>
  );
}
