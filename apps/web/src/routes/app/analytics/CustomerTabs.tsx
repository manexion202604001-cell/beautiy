import { useState } from 'react';
import { Link } from 'react-router';
import { SOURCE_LABEL, analyticsApi, useReport } from '../../../api/analytics';
import {
  BarList,
  ChartCard,
  ColumnChart,
  StatTile,
  compactYen,
  formatPct,
} from '../../../components/charts';
import {
  Checkbox,
  ErrorState,
  Field,
  InlineLoading,
  Input,
  Segmented,
  TBody,
  THead,
  Table,
  Td,
  Th,
  Tr,
} from '../../../components/ui';
import { useAuth } from '../../../lib/auth';
import { formatDate, formatNumber, formatYen } from '../../../lib/format';
import { CsvButton, baseQuery, type AnalyticsFilters } from './filters';
import { periodLabel } from './SalesTab';

/** 顧客: 新規/再来/失客 + visit-cycle distribution */
export function CustomersTab({ f }: { f: AnalyticsFilters }) {
  const [groupBy, setGroupBy] = useState<'day' | 'week' | 'month'>('month');
  const [lostDays, setLostDays] = useState(90);
  const q = { ...baseQuery(f), groupBy, lostThresholdDays: lostDays };
  const r = useReport('customers', q, () => analyticsApi.customers(q));
  const d = r.data;
  const dl = d?.comparison?.deltas ?? {};
  const has = !!d?.comparison;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <Segmented
            label="集計単位"
            value={groupBy}
            onChange={setGroupBy}
            options={[
              { value: 'day', label: '日' },
              { value: 'week', label: '週' },
              { value: 'month', label: '月' },
            ]}
          />
          <Field label="失客とみなす日数" hint="最終来店からこの日数を超えて再来なし">
            <Input
              type="number"
              inputSize="sm"
              className="w-24!"
              min={14}
              max={730}
              value={lostDays}
              onChange={(e) => setLostDays(Math.min(730, Math.max(14, Number(e.target.value) || 90)))}
            />
          </Field>
        </div>
        <CsvButton report="customers" query={q} />
      </div>
      {r.isLoading ? <InlineLoading /> : null}
      {r.error ? <ErrorState error={r.error} onRetry={() => void r.refetch()} /> : null}
      {d ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <StatTile label="来店客数（実人数）" value={`${formatNumber(d.summary.visitors)}人`} delta={has ? dl.visitors : undefined} deltaLabel={f.compareLabel} />
            <StatTile label="新規" value={`${formatNumber(d.summary.newCustomers)}人`} delta={has ? dl.newCustomers : undefined} deltaLabel={f.compareLabel} />
            <StatTile label="再来" value={`${formatNumber(d.summary.repeatCustomers)}人`} delta={has ? dl.repeatCustomers : undefined} deltaLabel={f.compareLabel} />
            <StatTile label="失客" value={`${formatNumber(d.summary.lostCustomers)}人`} delta={has ? dl.lostCustomers : undefined} deltaLabel={f.compareLabel} upIsGood={false} sub={`最終来店 ${d.lostWindow.from}〜${d.lostWindow.to}`} />
            <StatTile label="再来率" value={formatPct(d.summary.repeatRate)} delta={has ? dl.repeatRate : undefined} deltaLabel={f.compareLabel} />
          </div>
          <div className="grid gap-5 xl:grid-cols-2">
            <ChartCard
              title="新規・再来の来店数（延べ）"
              loading={r.isFetching}
              chart={
                <ColumnChart
                  ariaLabel="新規・再来の来店数"
                  labels={d.rows.map((x) => x.period)}
                  xFormat={(k) => periodLabel(k, groupBy)}
                  series={[
                    { key: 'new', label: '新規', values: d.rows.map((x) => x.newCustomerVisits) },
                    { key: 'repeat', label: '再来', values: d.rows.map((x) => x.repeatCustomerVisits) },
                  ]}
                  valueFormat={(n) => `${n}人`}
                />
              }
              table={
                <Table caption="新規・再来の来店数">
                  <THead>
                    <Tr>
                      <Th>期間</Th>
                      <Th className="text-right">新規</Th>
                      <Th className="text-right">再来</Th>
                      <Th className="text-right">延べ客数</Th>
                    </Tr>
                  </THead>
                  <TBody>
                    {d.rows.map((x) => (
                      <Tr key={x.period}>
                        <Td>{periodLabel(x.period, groupBy)}</Td>
                        <Td className="text-right tabular">{x.newCustomerVisits}</Td>
                        <Td className="text-right tabular">{x.repeatCustomerVisits}</Td>
                        <Td className="text-right tabular">{x.customerVisits}</Td>
                      </Tr>
                    ))}
                  </TBody>
                </Table>
              }
            />
            <ChartCard
              title="来店周期の分布"
              description={`平均 ${d.visitCycle.avgCycleDays ?? '—'}日 ・中央値 ${d.visitCycle.medianCycleDays ?? '—'}日 ・来店1回のみ ${d.visitCycle.singleVisitCustomers}人`}
              loading={r.isFetching}
              chart={
                <ColumnChart
                  ariaLabel="来店周期の分布"
                  labels={d.visitCycle.buckets.map((b) => b.label)}
                  series={[{ key: 'count', label: '顧客数', values: d.visitCycle.buckets.map((b) => b.count) }]}
                  valueFormat={(n) => `${n}人`}
                />
              }
              table={
                <Table caption="来店周期の分布">
                  <THead>
                    <Tr>
                      <Th>来店周期</Th>
                      <Th className="text-right">顧客数</Th>
                      <Th className="text-right">構成比</Th>
                    </Tr>
                  </THead>
                  <TBody>
                    {d.visitCycle.buckets.map((b) => (
                      <Tr key={b.key}>
                        <Td>{b.label}</Td>
                        <Td className="text-right tabular">{b.count}</Td>
                        <Td className="text-right tabular">{formatPct(b.share)}</Td>
                      </Tr>
                    ))}
                  </TBody>
                </Table>
              }
            />
          </div>
        </>
      ) : null}
    </div>
  );
}

/** リピート率: 30/60/90-day new-customer repeat by first-visit cohort */
export function RepeatTab({ f }: { f: AnalyticsFilters }) {
  const [groupBy, setGroupBy] = useState<'month' | 'week'>('month');
  const q = { ...baseQuery(f), groupBy };
  const r = useReport('repeat', q, () => analyticsApi.repeatRate(q));
  const d = r.data;
  const prev = d?.comparison?.summary;
  const deltaPt = (cur: number | null | undefined, p: number | null | undefined) =>
    cur === null || cur === undefined || p === null || p === undefined ? null : Math.round((cur - p) * 10) / 10;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          label="コホート単位"
          value={groupBy}
          onChange={setGroupBy}
          options={[
            { value: 'month', label: '初回来店月' },
            { value: 'week', label: '初回来店週' },
          ]}
        />
        <CsvButton report="repeat-rate" query={q} />
      </div>
      {r.isLoading ? <InlineLoading /> : null}
      {r.error ? <ErrorState error={r.error} onRetry={() => void r.refetch()} /> : null}
      {d ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <StatTile label="新規客（コホート）" value={`${d.summary.cohortSize}人`} />
            {(['d30', 'd60', 'd90'] as const).map((k) => (
              <StatTile
                key={k}
                label={`${k.slice(1)}日リピート率`}
                value={formatPct(d.summary.windows[k].rate)}
                sub={`対象 ${d.summary.windows[k].eligible}人中 ${d.summary.windows[k].returned}人${prev ? ` ・比較 ${formatPct(prev.windows[k].rate)}` : ''}`}
              />
            ))}
            <StatTile
              label="再来率（全体）"
              value={formatPct(d.overallRepeatRate.rate)}
              sub={`2回目来店あり ${formatPct(d.summary.returnedEverRate)}${prev ? ` ・差 ${deltaPt(d.summary.returnedEverRate, prev.returnedEverRate) ?? '—'}pt` : ''}`}
            />
          </div>
          <ChartCard
            title="コホート別リピート率"
            description="初回来店からN日以内に2回目の来店があった割合（観測期間を満了した顧客のみ）"
            loading={r.isFetching}
            chart={
              <ColumnChart
                ariaLabel="コホート別リピート率"
                labels={d.cohorts.map((c) => c.cohort)}
                xFormat={(k) => periodLabel(k, groupBy)}
                series={(['d30', 'd60', 'd90'] as const).map((k) => ({
                  key: k,
                  label: `${k.slice(1)}日`,
                  values: d.cohorts.map((c) => c.windows[k].rate ?? 0),
                }))}
                yFormat={(n) => `${n}%`}
                valueFormat={(n) => `${n.toFixed(1)}%`}
              />
            }
            table={
              <Table caption="コホート別リピート率">
                <THead>
                  <Tr>
                    <Th>コホート</Th>
                    <Th className="text-right">新規客</Th>
                    <Th className="text-right">30日</Th>
                    <Th className="text-right">60日</Th>
                    <Th className="text-right">90日</Th>
                    <Th className="text-right">再来あり</Th>
                  </Tr>
                </THead>
                <TBody>
                  {d.cohorts.map((c) => (
                    <Tr key={c.cohort}>
                      <Td>{periodLabel(c.cohort, groupBy)}</Td>
                      <Td className="text-right tabular">{c.cohortSize}</Td>
                      {(['d30', 'd60', 'd90'] as const).map((k) => (
                        <Td key={k} className="text-right tabular">
                          {formatPct(c.windows[k].rate)}
                          <span className="ml-1 text-xs text-subtle">({c.windows[k].returned}/{c.windows[k].eligible})</span>
                        </Td>
                      ))}
                      <Td className="text-right tabular">{formatPct(c.returnedEverRate)}</Td>
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

/** LTV: by acquisition source / shop / first-visit cohort + top customers */
export function LtvTab({ f }: { f: AnalyticsFilters }) {
  const { timezone: tz, shops } = useAuth();
  const [byRange, setByRange] = useState(false);
  const q = { shopId: f.shopId, top: 20, ...(byRange ? { from: f.from, to: f.to } : {}) };
  const r = useReport('ltv', q, () => analyticsApi.ltv(q));
  const d = r.data;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Checkbox
          label="初回来店日を上の期間で絞り込む"
          description="オフ: すべての顧客（獲得店舗＝初回来店店舗）"
          checked={byRange}
          onChange={(e) => setByRange(e.target.checked)}
        />
        <div className="flex flex-wrap gap-2">
          <CsvButton report="ltv" query={{ ...q, csvTable: 'source' }} label="CSV（経路別）" />
          <CsvButton report="ltv" query={{ ...q, csvTable: 'top' }} label="CSV（上位顧客）" />
        </div>
      </div>
      {r.isLoading ? <InlineLoading /> : null}
      {r.error ? <ErrorState error={r.error} onRetry={() => void r.refetch()} /> : null}
      {d ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile label="LTV（累計）" value={formatYen(d.summary.ltvAllTime)} sub={`顧客 ${formatNumber(d.summary.customers)}人`} />
            <StatTile label="LTV（初回から12ヶ月）" value={formatYen(d.summary.ltv12m)} sub={`満了顧客 ${formatNumber(d.summary.maturedCustomers)}人`} />
            <StatTile label="平均来店回数" value={d.summary.avgVisits === null ? '—' : `${d.summary.avgVisits}回`} />
            <StatTile label="客単価（累計）" value={formatYen(d.summary.avgTicket)} />
          </div>
          <div className="grid gap-5 xl:grid-cols-2">
            <ChartCard
              title="来店きっかけ別 LTV"
              loading={r.isFetching}
              chart={
                <BarList
                  ariaLabel="来店きっかけ別LTV"
                  rows={d.bySource.map((s) => ({ key: s.source, label: SOURCE_LABEL[s.source] ?? s.source, value: s.ltvAllTime ?? 0, sub: `${s.customers}人 ・12ヶ月 ${formatYen(s.ltv12m)}` }))}
                  valueFormat={formatYen}
                />
              }
              table={<LtvTable rows={d.bySource.map((s) => ({ key: s.source, label: SOURCE_LABEL[s.source] ?? s.source, ...s }))} />}
            />
            <ChartCard
              title="初回来店月別 LTV"
              loading={r.isFetching}
              chart={
                <ColumnChart
                  ariaLabel="初回来店月別LTV"
                  labels={d.byCohort.map((c) => c.cohort)}
                  xFormat={(k) => periodLabel(k, 'month')}
                  series={[{ key: 'ltv', label: 'LTV（累計）', values: d.byCohort.map((c) => c.ltvAllTime ?? 0) }]}
                  yFormat={compactYen}
                  valueFormat={formatYen}
                />
              }
              table={<LtvTable rows={d.byCohort.map((c) => ({ key: c.cohort, label: c.cohort, ...c }))} />}
            />
          </div>
          {shops.length > 1 ? (
            <ChartCard
              title="獲得店舗別 LTV"
              chart={
                <BarList
                  ariaLabel="獲得店舗別LTV"
                  rows={d.byShop.map((s) => ({ key: s.shopId, label: s.shopName, value: s.ltvAllTime ?? 0, sub: `${s.customers}人` }))}
                  valueFormat={formatYen}
                />
              }
              table={<LtvTable rows={d.byShop.map((s) => ({ key: s.shopId, label: s.shopName, ...s }))} />}
            />
          ) : null}
          <section className="space-y-2">
            <h2 className="text-[15px] font-semibold">累計売上の上位顧客</h2>
            <Table caption="累計売上の上位顧客">
              <THead>
                <Tr>
                  <Th>顧客</Th>
                  <Th className="text-right">累計売上</Th>
                  <Th className="hidden text-right sm:table-cell">12ヶ月</Th>
                  <Th className="text-right">来店</Th>
                  <Th className="hidden md:table-cell">初回 / 最終来店</Th>
                  <Th className="hidden lg:table-cell">きっかけ</Th>
                </Tr>
              </THead>
              <TBody>
                {d.topCustomers.map((c) => (
                  <Tr key={c.customerId}>
                    <Td>
                      <Link to={`/app/customers/${c.customerId}`} className="font-medium text-primary hover:underline">
                        {c.customerName || '（氏名未登録）'}
                      </Link>
                    </Td>
                    <Td className="text-right tabular">{formatYen(c.totalSales)}</Td>
                    <Td className="hidden text-right tabular sm:table-cell">{formatYen(c.sales12m)}</Td>
                    <Td className="text-right tabular">{c.visits}回</Td>
                    <Td className="hidden text-xs md:table-cell">
                      {formatDate(c.firstVisitAt, tz, { weekday: false })} / {formatDate(c.lastVisitAt, tz, { weekday: false })}
                    </Td>
                    <Td className="hidden lg:table-cell">{c.acquisitionSource ? (SOURCE_LABEL[c.acquisitionSource] ?? c.acquisitionSource) : '—'}</Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </section>
        </>
      ) : null}
    </div>
  );
}

function LtvTable({
  rows,
}: {
  rows: { key: string; label: string; customers: number; ltvAllTime: number | null; ltv12m: number | null; avgVisits: number | null; avgTicket: number | null }[];
}) {
  return (
    <Table caption="LTV">
      <THead>
        <Tr>
          <Th>区分</Th>
          <Th className="text-right">顧客数</Th>
          <Th className="text-right">LTV累計</Th>
          <Th className="text-right">LTV12ヶ月</Th>
          <Th className="text-right">平均来店</Th>
          <Th className="text-right">客単価</Th>
        </Tr>
      </THead>
      <TBody>
        {rows.map((r) => (
          <Tr key={r.key}>
            <Td>{r.label}</Td>
            <Td className="text-right tabular">{r.customers}</Td>
            <Td className="text-right tabular">{formatYen(r.ltvAllTime)}</Td>
            <Td className="text-right tabular">{formatYen(r.ltv12m)}</Td>
            <Td className="text-right tabular">{r.avgVisits ?? '—'}</Td>
            <Td className="text-right tabular">{formatYen(r.avgTicket)}</Td>
          </Tr>
        ))}
      </TBody>
    </Table>
  );
}
