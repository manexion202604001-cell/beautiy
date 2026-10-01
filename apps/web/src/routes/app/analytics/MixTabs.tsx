import { useState } from 'react';
import { analyticsApi, useReport } from '../../../api/analytics';
import { BarList, ChartCard, ShareBar, StatTile, formatDelta, formatPct } from '../../../components/charts';
import { ErrorState, InlineLoading, Segmented, TBody, THead, Table, Td, Th, Tr } from '../../../components/ui';
import { formatNumber, formatYen } from '../../../lib/format';
import { CsvButton, baseQuery, type AnalyticsFilters } from './filters';

/** メニュー構成比: category share + menu ranking */
export function MenusTab({ f }: { f: AnalyticsFilters }) {
  const [metric, setMetric] = useState<'sales' | 'count'>('sales');
  const q = baseQuery(f);
  const r = useReport('menus', q, () => analyticsApi.menus(q));
  const d = r.data;
  const fmt = metric === 'sales' ? formatYen : (n: number) => `${formatNumber(n)}件`;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          label="指標"
          value={metric}
          onChange={setMetric}
          options={[
            { value: 'sales', label: '売上' },
            { value: 'count', label: '件数' },
          ]}
        />
        <div className="flex gap-2">
          <CsvButton report="menus" query={{ ...q, csvTable: 'menu' }} label="CSV（メニュー）" />
          <CsvButton report="menus" query={{ ...q, csvTable: 'category' }} label="CSV（カテゴリ）" />
        </div>
      </div>
      {r.isLoading ? <InlineLoading /> : null}
      {r.error ? <ErrorState error={r.error} onRetry={() => void r.refetch()} /> : null}
      {d ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile label="施術売上（メニュー）" value={formatYen(d.summary.totalSales)} delta={d.comparison ? d.comparison.deltas.totalSales : undefined} deltaLabel={f.compareLabel} />
            <StatTile label="施術件数" value={`${formatNumber(d.summary.totalCount)}件`} delta={d.comparison ? d.comparison.deltas.totalCount : undefined} deltaLabel={f.compareLabel} />
          </div>
          <ChartCard
            title="カテゴリ構成比"
            loading={r.isFetching}
            chart={
              <ShareBar
                ariaLabel="カテゴリ構成比"
                parts={d.categories.map((c) => ({ key: c.categoryId ?? 'none', label: c.categoryName, value: metric === 'sales' ? c.sales : c.count }))}
                valueFormat={fmt}
              />
            }
          />
          <ChartCard
            title="メニュー別"
            loading={r.isFetching}
            chart={
              <BarList
                ariaLabel="メニュー別"
                rows={[...d.menus]
                  .sort((a, b) => (metric === 'sales' ? b.sales - a.sales : b.count - a.count))
                  .map((m) => ({
                    key: m.menuId,
                    label: m.menuName,
                    value: metric === 'sales' ? m.sales : m.count,
                    sub: `${m.categoryName} ・構成比 ${formatPct(metric === 'sales' ? m.salesShare : m.countShare)}`,
                  }))}
                valueFormat={fmt}
              />
            }
            table={
              <Table caption="メニュー別売上">
                <THead>
                  <Tr>
                    <Th>メニュー</Th>
                    <Th>カテゴリ</Th>
                    <Th className="text-right">件数</Th>
                    <Th className="text-right">件数比</Th>
                    <Th className="text-right">売上</Th>
                    <Th className="text-right">売上比</Th>
                    <Th className="text-right">平均単価</Th>
                    <Th className="text-right">売上増減</Th>
                  </Tr>
                </THead>
                <TBody>
                  {d.menus.map((m) => (
                    <Tr key={m.menuId}>
                      <Td>{m.menuName}</Td>
                      <Td>{m.categoryName}</Td>
                      <Td className="text-right tabular">{m.count}</Td>
                      <Td className="text-right tabular">{formatPct(m.countShare)}</Td>
                      <Td className="text-right tabular">{formatYen(m.sales)}</Td>
                      <Td className="text-right tabular">{formatPct(m.salesShare)}</Td>
                      <Td className="text-right tabular">{formatYen(m.avgPrice)}</Td>
                      <Td className="text-right tabular">{formatDelta(m.salesDelta)}</Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            }
          />
        </>
      ) : null}
    </div>
  );
}

/** スタッフ生産性: 売上・客数・指名率・稼働率・時間あたり売上 */
export function StaffTab({ f }: { f: AnalyticsFilters }) {
  const [metric, setMetric] = useState<'sales' | 'perHour' | 'nominated'>('sales');
  const q = baseQuery(f);
  const r = useReport('staff', q, () => analyticsApi.staff(q));
  const d = r.data;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          label="グラフの指標"
          value={metric}
          onChange={setMetric}
          options={[
            { value: 'sales', label: '売上' },
            { value: 'perHour', label: '稼働1時間あたり' },
            { value: 'nominated', label: '指名率' },
          ]}
        />
        <CsvButton report="staff" query={q} />
      </div>
      {d?.ownOnly ? <p className="text-[13px] text-muted">あなた自身の数値のみを表示しています。</p> : null}
      {r.isLoading ? <InlineLoading /> : null}
      {r.error ? <ErrorState error={r.error} onRetry={() => void r.refetch()} /> : null}
      {d ? (
        <>
          <ChartCard
            title={metric === 'sales' ? 'スタッフ別売上' : metric === 'perHour' ? '稼働1時間あたり売上' : '指名率'}
            loading={r.isFetching}
            chart={
              d.rows.length ? (
                <BarList
                  ariaLabel="スタッフ別"
                  rows={d.rows.map((s) => ({
                    key: s.staffId,
                    label: s.staffName || '（不明）',
                    value: metric === 'sales' ? s.salesTotal : metric === 'perHour' ? (s.salesPerBookedHour ?? 0) : (s.nominatedRate ?? 0),
                    sub: metric === 'sales' && s.salesDelta !== null ? `${f.compareLabel} ${formatDelta(s.salesDelta)}` : `担当 ${s.customerCount}人`,
                  }))}
                  valueFormat={metric === 'nominated' ? (n) => `${n.toFixed(1)}%` : formatYen}
                />
              ) : (
                <p className="text-[13px] text-muted">この期間のデータはありません。</p>
              )
            }
          />
          <Table caption="スタッフ生産性">
            <THead>
              <Tr>
                <Th>スタッフ</Th>
                <Th className="text-right">売上</Th>
                <Th className="text-right">担当客</Th>
                <Th className="text-right">新規</Th>
                <Th className="text-right">指名率</Th>
                <Th className="text-right">客単価</Th>
                <Th className="text-right">稼働率</Th>
                <Th className="text-right">稼働1h売上</Th>
                <Th className="text-right">勤務1h売上</Th>
                <Th className="text-right">売上増減</Th>
              </Tr>
            </THead>
            <TBody>
              {d.rows.map((s) => (
                <Tr key={s.staffId}>
                  <Td className="font-medium">{s.staffName}</Td>
                  <Td className="text-right tabular">{formatYen(s.salesTotal)}</Td>
                  <Td className="text-right tabular">{s.customerCount}</Td>
                  <Td className="text-right tabular">{s.newCustomerCount}</Td>
                  <Td className="text-right tabular">{formatPct(s.nominatedRate)}</Td>
                  <Td className="text-right tabular">{formatYen(s.avgTicket)}</Td>
                  <Td className="text-right tabular">
                    {formatPct(s.utilization)}
                    <span className="ml-1 text-xs text-subtle">({s.bookedHours}/{s.scheduledHours}h)</span>
                  </Td>
                  <Td className="text-right tabular">{formatYen(s.salesPerBookedHour)}</Td>
                  <Td className="text-right tabular">{formatYen(s.salesPerScheduledHour)}</Td>
                  <Td className="text-right tabular">{formatDelta(s.salesDelta)}</Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </>
      ) : null}
    </div>
  );
}

/** 予約経路別: appointments, completion and sales per booking source */
export function ChannelsTab({ f }: { f: AnalyticsFilters }) {
  const q = baseQuery(f);
  const r = useReport('channels', q, () => analyticsApi.channels(q));
  const d = r.data;
  return (
    <div className="space-y-5">
      <div className="flex justify-end">
        <CsvButton report="channels" query={q} />
      </div>
      {r.isLoading ? <InlineLoading /> : null}
      {r.error ? <ErrorState error={r.error} onRetry={() => void r.refetch()} /> : null}
      {d ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile label="売上合計" value={formatYen(d.summary.totalSales)} />
            <StatTile label="予約数（キャンセル含む）" value={`${formatNumber(d.summary.totalAppointments)}件`} />
          </div>
          <div className="grid gap-5 xl:grid-cols-2">
            <ChartCard
              title="経路別 売上構成比"
              loading={r.isFetching}
              chart={<ShareBar ariaLabel="経路別売上構成比" parts={d.rows.map((x) => ({ key: x.source, label: x.label, value: x.sales }))} valueFormat={formatYen} />}
            />
            <ChartCard
              title="経路別 予約数"
              loading={r.isFetching}
              chart={
                <BarList
                  ariaLabel="経路別予約数"
                  rows={d.rows
                    .filter((x) => x.source !== 'none')
                    .map((x) => ({ key: x.source, label: x.label, value: x.appointmentCount, sub: `来店完了率 ${formatPct(x.completionRate)}` }))}
                  valueFormat={(n) => `${n}件`}
                />
              }
            />
          </div>
          <Table caption="予約経路別">
            <THead>
              <Tr>
                <Th>経路</Th>
                <Th className="text-right">予約数</Th>
                <Th className="text-right">来店完了</Th>
                <Th className="text-right">完了率</Th>
                <Th className="text-right">売上</Th>
                <Th className="text-right">構成比</Th>
                <Th className="text-right">来店単価</Th>
                <Th className="text-right">売上増減</Th>
              </Tr>
            </THead>
            <TBody>
              {d.rows.map((x) => (
                <Tr key={x.source}>
                  <Td>{x.label}</Td>
                  <Td className="text-right tabular">{x.appointmentCount}</Td>
                  <Td className="text-right tabular">{x.completedCount}</Td>
                  <Td className="text-right tabular">{formatPct(x.completionRate)}</Td>
                  <Td className="text-right tabular">{formatYen(x.sales)}</Td>
                  <Td className="text-right tabular">{formatPct(x.salesShare)}</Td>
                  <Td className="text-right tabular">{formatYen(x.salesPerCompleted)}</Td>
                  <Td className="text-right tabular">{formatDelta(x.salesDelta)}</Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </>
      ) : null}
    </div>
  );
}
