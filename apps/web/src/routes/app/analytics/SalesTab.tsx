import { useState } from 'react';
import { analyticsApi, useReport, type SalesGroupBy, type SalesReport } from '../../../api/analytics';
import {
  BarList,
  ChartCard,
  ColumnChart,
  LineChart,
  StatTile,
  compactYen,
  formatDelta,
  formatPct,
  shortPeriod,
} from '../../../components/charts';
import { ErrorState, InlineLoading, Segmented, TBody, THead, Table, Td, Th, Tr } from '../../../components/ui';
import { useAuth } from '../../../lib/auth';
import { formatNumber, formatYen } from '../../../lib/format';
import { CsvButton, baseQuery, type AnalyticsFilters } from './filters';

const GROUPS: { value: SalesGroupBy; label: string }[] = [
  { value: 'day', label: '日' },
  { value: 'week', label: '週' },
  { value: 'month', label: '月' },
  { value: 'shop', label: '店舗' },
  { value: 'staff', label: 'スタッフ' },
];

export function periodLabel(key: string, groupBy: string) {
  if (groupBy === 'week') return `${shortPeriod(key)}週`;
  return shortPeriod(key);
}

/** 売上: summary tiles with deltas, trend (day/week/month) or ranking (shop/staff) */
export function SalesTab({ f }: { f: AnalyticsFilters }) {
  const { can } = useAuth();
  const full = can('analytics.read') || can('sales.read');
  const [groupBy, setGroupBy] = useState<SalesGroupBy>('day');
  const q = { ...baseQuery(f), groupBy };
  const r = useReport('sales', q, () => analyticsApi.sales(q));
  const d = r.data;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          label="集計単位"
          value={groupBy}
          onChange={setGroupBy}
          options={GROUPS.map((g) => ({ ...g, disabled: !full && g.value === 'shop' }))}
        />
        <CsvButton report="sales" query={q} />
      </div>
      {!full ? (
        <p className="text-[13px] text-muted">あなたの担当売上のみを表示しています（店舗全体の数値は表示されません）。</p>
      ) : null}
      {r.isLoading ? <InlineLoading /> : null}
      {r.error ? <ErrorState error={r.error} onRetry={() => void r.refetch()} /> : null}
      {d ? <SalesBody d={d} f={f} loading={r.isFetching} /> : null}
    </div>
  );
}

function SalesBody({ d, f, loading }: { d: SalesReport; f: AnalyticsFilters; loading: boolean }) {
  const s = d.summary;
  const dl = d.comparison?.deltas ?? {};
  const cmp = f.compareLabel;
  const staffLevel = d.level === 'staff';
  const trend = d.groupBy === 'day' || d.groupBy === 'week' || d.groupBy === 'month';
  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="sales-tiles">
        <StatTile label="純売上" value={formatYen(s.salesTotal)} delta={d.comparison ? dl.salesTotal : undefined} deltaLabel={cmp} sub={d.comparison ? `比較期間 ${formatYen(d.comparison.summary.salesTotal)}` : undefined} />
        <StatTile label="客単価" value={formatYen(s.avgTicket)} delta={d.comparison ? dl.avgTicket : undefined} deltaLabel={cmp} />
        <StatTile label={staffLevel ? '担当客数' : '延べ客数'} value={`${formatNumber(s.customerCount)}人`} delta={d.comparison ? dl.customerCount : undefined} deltaLabel={cmp} sub={`新規 ${formatNumber(s.newCustomerCount)}人`} />
        <StatTile label="指名率" value={formatPct(s.nominatedRate)} delta={d.comparison ? dl.nominatedRate : undefined} deltaLabel={cmp} sub={`指名 ${formatNumber(s.nominatedCount)}件`} />
        <StatTile label="施術売上" value={formatYen(s.serviceSales)} delta={d.comparison ? dl.serviceSales : undefined} deltaLabel={cmp} />
        <StatTile label="店販売上" value={formatYen(s.productSales)} delta={d.comparison ? dl.productSales : undefined} deltaLabel={cmp} />
        {staffLevel ? (
          <>
            <StatTile label="稼働率" value={formatPct(s.utilization)} sub={`予約 ${s.bookedHours ?? 0}h / 勤務 ${s.scheduledHours ?? 0}h`} />
            <StatTile label="稼働1時間あたり売上" value={formatYen(s.salesPerBookedHour)} />
          </>
        ) : (
          <>
            <StatTile label="会計件数" value={`${formatNumber(s.transactionCount)}件`} delta={d.comparison ? dl.transactionCount : undefined} deltaLabel={cmp} />
            <StatTile label="値引・返金" value={formatYen((s.discountTotal ?? 0) + (s.refundTotal ?? 0))} sub={`値引 ${formatYen(s.discountTotal)} / 返金 ${formatYen(s.refundTotal)}`} />
          </>
        )}
      </div>
      {trend ? (
        <div className="grid gap-5 xl:grid-cols-2">
          <ChartCard
            title="売上の推移"
            description={`${d.range.from} 〜 ${d.range.to}（税込）`}
            loading={loading}
            chart={
              <div data-testid="sales-line-chart">
                <LineChart
                  ariaLabel="売上の推移"
                  labels={d.rows.map((r) => r.key)}
                  xFormat={(k) => periodLabel(k, d.groupBy)}
                  series={[{ key: 'sales', label: '純売上', values: d.rows.map((r) => r.salesTotal), area: true }]}
                  yFormat={compactYen}
                  valueFormat={formatYen}
                />
              </div>
            }
            table={<SalesTable d={d} />}
          />
          <ChartCard
            title="施術・店販の内訳"
            loading={loading}
            chart={
              <div data-testid="sales-bar-chart">
                <ColumnChart
                  ariaLabel="施術・店販売上の推移"
                  labels={d.rows.map((r) => r.key)}
                  xFormat={(k) => periodLabel(k, d.groupBy)}
                  series={[
                    { key: 'service', label: '施術売上', values: d.rows.map((r) => r.serviceSales) },
                    { key: 'product', label: '店販売上', values: d.rows.map((r) => r.productSales) },
                  ]}
                  yFormat={compactYen}
                  valueFormat={formatYen}
                />
              </div>
            }
            table={<SalesTable d={d} />}
          />
        </div>
      ) : (
        <ChartCard
          title={d.groupBy === 'shop' ? '店舗別売上' : 'スタッフ別売上'}
          loading={loading}
          chart={
            <BarList
              ariaLabel={d.groupBy === 'shop' ? '店舗別売上' : 'スタッフ別売上'}
              rows={d.rows.map((r) => ({
                key: r.key,
                label: r.label || '（不明）',
                value: r.salesTotal,
                sub: r.salesDelta !== undefined && r.salesDelta !== null ? `${f.compareLabel} ${formatDelta(r.salesDelta)}` : `客数 ${r.customerCount}人`,
              }))}
              valueFormat={formatYen}
            />
          }
          table={<SalesTable d={d} />}
        />
      )}
    </>
  );
}

function SalesTable({ d }: { d: SalesReport }) {
  const trend = d.groupBy === 'day' || d.groupBy === 'week' || d.groupBy === 'month';
  return (
    <Table caption="売上の内訳">
      <THead>
        <Tr>
          <Th>{trend ? '期間' : d.groupBy === 'shop' ? '店舗' : 'スタッフ'}</Th>
          <Th className="text-right">純売上</Th>
          <Th className="text-right">施術</Th>
          <Th className="text-right">店販</Th>
          <Th className="text-right">客数</Th>
          <Th className="text-right">客単価</Th>
          <Th className="text-right">指名率</Th>
          {!trend ? <Th className="text-right">増減</Th> : null}
        </Tr>
      </THead>
      <TBody>
        {d.rows.map((r) => (
          <Tr key={r.key}>
            <Td>{trend ? periodLabel(r.key, d.groupBy) : r.label}</Td>
            <Td className="text-right tabular">{formatYen(r.salesTotal)}</Td>
            <Td className="text-right tabular">{formatYen(r.serviceSales)}</Td>
            <Td className="text-right tabular">{formatYen(r.productSales)}</Td>
            <Td className="text-right tabular">{formatNumber(r.customerCount)}</Td>
            <Td className="text-right tabular">{formatYen(r.avgTicket)}</Td>
            <Td className="text-right tabular">{formatPct(r.nominatedRate)}</Td>
            {!trend ? <Td className="text-right tabular">{formatDelta(r.salesDelta)}</Td> : null}
          </Tr>
        ))}
      </TBody>
    </Table>
  );
}
