import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { analyticsApi, type CompareTo } from '../../../api/analytics';
import { Button, Field, Input, Select, useToast } from '../../../components/ui';
import type { QueryValue } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { addDays, addMonths, startOfMonth, todayIn } from '../../../lib/time';

export type Preset = 'mtd' | 'last_month' | 'd30' | 'd90' | 'ytd' | 'custom';

export const PRESET_LABEL: Record<Preset, string> = {
  mtd: '今月',
  last_month: '先月',
  d30: '過去30日',
  d90: '過去90日',
  ytd: '今年',
  custom: '期間を指定',
};

export const COMPARE_LABEL: Record<CompareTo, string> = {
  previous_period: '前の期間と比較',
  previous_year: '前年同期と比較',
  none: '比較しない',
};

export function presetRange(p: Preset, today: string): { from: string; to: string } {
  switch (p) {
    case 'last_month': {
      const first = addMonths(startOfMonth(today), -1);
      return { from: first, to: addDays(startOfMonth(today), -1) };
    }
    case 'd30':
      return { from: addDays(today, -29), to: today };
    case 'd90':
      return { from: addDays(today, -89), to: today };
    case 'ytd':
      return { from: `${today.slice(0, 4)}-01-01`, to: today };
    default:
      return { from: startOfMonth(today), to: today };
  }
}

export interface AnalyticsFilters {
  preset: Preset;
  from: string;
  to: string;
  shopId: string | undefined;
  compareTo: CompareTo;
  /** analytics.read / sales.read (shop totals). false = stylist own-only */
  full: boolean;
  compareLabel: string;
}

/** Filters live in the URL so a view can be shared / reloaded */
export function useAnalyticsFilters(): [AnalyticsFilters, (patch: Record<string, string | null>) => void] {
  const { can, timezone: tz } = useAuth();
  const [params, setParams] = useSearchParams();
  const today = todayIn(tz);
  const preset = (params.get('period') as Preset) || 'd30';
  const custom = preset === 'custom';
  const range = custom
    ? { from: params.get('from') || startOfMonth(today), to: params.get('to') || today }
    : presetRange(preset, today);
  const compareTo = (params.get('compare') as CompareTo) || 'previous_period';
  const full = can('analytics.read');
  const shopParam = params.get('shop');
  const filters = useMemo<AnalyticsFilters>(
    () => ({
      preset,
      ...range,
      shopId: shopParam && shopParam !== 'all' ? shopParam : undefined,
      compareTo,
      full,
      compareLabel: compareTo === 'previous_year' ? '前年比' : compareTo === 'previous_period' ? '前期比' : '',
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [preset, range.from, range.to, shopParam, compareTo, full],
  );
  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: true });
  };
  return [filters, update];
}

/** One filter row above everything it scopes: period → shop → comparison */
export function FilterBar({ filters, update }: { filters: AnalyticsFilters; update: (p: Record<string, string | null>) => void }) {
  const { shops } = useAuth();
  return (
    <div className="flex flex-wrap items-end gap-3" role="group" aria-label="集計条件">
      <Field label="期間">
        <Select
          selectSize="sm"
          value={filters.preset}
          onChange={(e) => {
            const p = e.target.value as Preset;
            update(p === 'custom' ? { period: p, from: filters.from, to: filters.to } : { period: p, from: null, to: null });
          }}
        >
          {(Object.keys(PRESET_LABEL) as Preset[]).map((p) => (
            <option key={p} value={p}>
              {PRESET_LABEL[p]}
            </option>
          ))}
        </Select>
      </Field>
      {filters.preset === 'custom' ? (
        <>
          <Field label="開始日">
            <Input type="date" inputSize="sm" value={filters.from} max={filters.to} onChange={(e) => update({ from: e.target.value })} />
          </Field>
          <Field label="終了日">
            <Input type="date" inputSize="sm" value={filters.to} min={filters.from} onChange={(e) => update({ to: e.target.value })} />
          </Field>
        </>
      ) : (
        <p className="pb-1.5 text-xs text-muted tabular">
          {filters.from.replace(/-/g, '/')} 〜 {filters.to.replace(/-/g, '/')}
        </p>
      )}
      {shops.length > 1 ? (
        <Field label="店舗">
          <Select selectSize="sm" value={filters.shopId ?? 'all'} onChange={(e) => update({ shop: e.target.value })}>
            <option value="all">{filters.full ? 'すべての店舗' : '所属店舗すべて'}</option>
            {shops.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      <Field label="比較">
        <Select selectSize="sm" value={filters.compareTo} onChange={(e) => update({ compare: e.target.value })}>
          {(Object.keys(COMPARE_LABEL) as CompareTo[]).map((c) => (
            <option key={c} value={c}>
              {COMPARE_LABEL[c]}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  );
}

/** CSV export button (export.data); hidden without the permission */
export function CsvButton({ report, query, label = 'CSV出力' }: { report: string; query: Record<string, QueryValue>; label?: string }) {
  const { can } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!can('export.data')) return null;
  return (
    <Button
      size="sm"
      icon="download"
      loading={busy}
      onClick={() => {
        setBusy(true);
        analyticsApi
          .csv(report, query)
          .then(() => toast.success('CSVをダウンロードしました', '出力は監査ログに記録されます'))
          .catch((e) => toast.error(e))
          .finally(() => setBusy(false));
      }}
    >
      {label}
    </Button>
  );
}

export function baseQuery(f: AnalyticsFilters) {
  return { shopId: f.shopId, from: f.from, to: f.to, compareTo: f.compareTo };
}
