import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { METHOD_LABEL, useDailyReport, type DailyReportStaffRow } from '../../../api/pos';
import {
  Card,
  CardHeader,
  DateNav,
  EmptyState,
  ErrorState,
  Icon,
  InlineLoading,
  PageHeader,
  Stat,
  TBody,
  THead,
  Table,
  Td,
  Th,
  Tr,
} from '../../../components/ui';
import { useAuth } from '../../../lib/auth';
import { cn } from '../../../lib/cn';
import { formatTime, formatYen } from '../../../lib/format';
import { taxBreakdownRows } from '../../../lib/money';
import { todayIn } from '../../../lib/time';

export default function DailyReport() {
  const { currentShopId: shopId, timezone: tz } = useAuth();
  const today = todayIn(tz);
  const [params, setParams] = useSearchParams();
  const [date, setDateState] = useState(params.get('date') ?? today);
  const setDate = (d: string) => {
    setDateState(d);
    setParams({ date: d }, { replace: true });
  };
  const q = useDailyReport(shopId, date);
  const r = q.data;

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
        title="日報"
        actions={<DateNav value={date} onChange={setDate} today={today} />}
      />
      {q.isLoading ? <InlineLoading /> : null}
      {q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : null}
      {r && r.scope === 'own' ? (
        <Card>
          <CardHeader title="あなたの売上" description="担当者配分に基づく売上です" />
          <StaffTable rows={r.byStaff} />
        </Card>
      ) : null}
      {r && r.scope === 'shop' ? (
        <div className="space-y-5">
          <Card>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-6">
              <Stat
                label="純売上"
                value={formatYen(r.totals.netSales)}
                sub={`総売上 ${formatYen(r.totals.grossSales)}`}
              />
              <Stat label="会計件数" value={`${r.totals.transactionCount}件`} />
              <Stat label="客単価" value={formatYen(r.totals.averageSpend)} />
              <Stat label="値引合計" value={formatYen(r.totals.discountTotal)} />
              <Stat
                label="返金"
                value={formatYen(r.totals.refundTotal)}
                sub={`取消 ${r.voided.count}件 ${formatYen(r.voided.amount)}`}
              />
              <Stat
                label="ポイント"
                value={`${r.totals.pointsUsed}pt利用`}
                sub={`${r.totals.pointsEarned}pt付与`}
              />
            </div>
          </Card>
          <div className="grid gap-5 lg:grid-cols-2">
            <Card>
              <CardHeader title="支払方法別" />
              {r.byMethod.length ? (
                <ul className="divide-y divide-border text-sm" data-testid="report-by-method">
                  {r.byMethod.map((m) => (
                    <li key={`${m.method}-${m.label}`} className="flex justify-between py-2">
                      <span>
                        {m.label} <span className="text-xs text-muted">{m.count}件</span>
                      </span>
                      <span className="tabular">{formatYen(m.amount)}</span>
                    </li>
                  ))}
                  {r.refunds.map((x) => (
                    <li
                      key={`refund-${x.method}`}
                      className="flex justify-between py-2 text-danger"
                    >
                      <span>返金（{METHOD_LABEL[x.method] ?? x.method}）</span>
                      <span className="tabular">−{formatYen(x.amount)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[13px] text-muted">この日の支払はありません。</p>
              )}
            </Card>
            <Card>
              <CardHeader title="お客様の内訳" />
              <div className="grid grid-cols-4 gap-3 text-center">
                {[
                  ['新規', r.customers.new],
                  ['再来', r.customers.repeat],
                  ['未登録', r.customers.walkIn],
                  ['指名', r.customers.nominated],
                ].map(([label, n]) => (
                  <div key={label} className="rounded-xl bg-surface-2 p-3">
                    <p className="text-xs text-muted">{label}</p>
                    <p className="text-xl font-semibold tabular">{n}</p>
                  </div>
                ))}
              </div>
              <div className="mt-4">
                <p className="mb-1 text-xs font-medium text-muted">税率別</p>
                {taxBreakdownRows(r.taxByRate).map((t) => (
                  <p key={t.rateBp} className="flex justify-between text-[13px]">
                    <span>{t.label}</span>
                    <span className="tabular">
                      {formatYen(t.taxable)}（内税 {formatYen(t.tax)}）
                    </span>
                  </p>
                ))}
              </div>
            </Card>
          </div>
          <Card>
            <CardHeader title="担当者別" />
            <StaffTable rows={r.byStaff} />
          </Card>
          <Card>
            <CardHeader
              title="レジ"
              description="開局〜締めの想定残高と実査額"
              actions={
                <span
                  className={cn(
                    'text-sm font-semibold tabular',
                    r.registerDifference ? 'text-danger' : 'text-success',
                  )}
                >
                  差額合計 {formatYen(r.registerDifference)}
                </span>
              }
            />
            {r.register.length ? (
              <Table caption="レジセッション">
                <THead>
                  <tr>
                    <Th>開局</Th>
                    <Th>締め</Th>
                    <Th className="text-right">準備金</Th>
                    <Th className="text-right">想定残高</Th>
                    <Th className="text-right">実査</Th>
                    <Th className="text-right">差額</Th>
                  </tr>
                </THead>
                <TBody>
                  {r.register.map((s) => (
                    <Tr key={s.id}>
                      <Td className="tabular">{formatTime(s.opened_at, tz)}</Td>
                      <Td className="tabular">
                        {s.closed_at ? formatTime(s.closed_at, tz) : '開局中'}
                      </Td>
                      <Td className="text-right tabular">{formatYen(s.opening_cash)}</Td>
                      <Td className="text-right tabular">{formatYen(s.expected_cash)}</Td>
                      <Td className="text-right tabular">{formatYen(s.counted_cash)}</Td>
                      <Td className={cn('text-right tabular', s.difference ? 'text-danger' : '')}>
                        {formatYen(s.difference)}
                      </Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            ) : (
              <p className="text-[13px] text-muted">この日のレジ記録はありません。</p>
            )}
          </Card>
        </div>
      ) : null}
      {r && r.scope === 'shop' && r.totals.transactionCount === 0 && !r.register.length ? (
        <EmptyState className="mt-5" icon="chart" title="この日の会計はありません" />
      ) : null}
    </div>
  );
}

function StaffTable({ rows }: { rows: DailyReportStaffRow[] }) {
  if (!rows.length) return <p className="text-[13px] text-muted">売上はありません。</p>;
  return (
    <Table caption="担当者別売上">
      <THead>
        <tr>
          <Th>担当</Th>
          <Th className="text-right">売上</Th>
          <Th className="hidden text-right sm:table-cell">施術</Th>
          <Th className="hidden text-right sm:table-cell">店販</Th>
          <Th className="text-right">客数</Th>
          <Th className="hidden text-right md:table-cell">指名</Th>
          <Th className="hidden text-right md:table-cell">新規</Th>
        </tr>
      </THead>
      <TBody>
        {rows.map((s) => (
          <Tr key={s.staffId}>
            <Td>{s.name}</Td>
            <Td className="text-right font-medium tabular">{formatYen(s.sales)}</Td>
            <Td className="hidden text-right tabular sm:table-cell">{formatYen(s.serviceSales)}</Td>
            <Td className="hidden text-right tabular sm:table-cell">{formatYen(s.productSales)}</Td>
            <Td className="text-right tabular">{s.transactions}</Td>
            <Td className="hidden text-right tabular md:table-cell">{s.nominatedCount}</Td>
            <Td className="hidden text-right tabular md:table-cell">{s.newCustomers}</Td>
          </Tr>
        ))}
      </TBody>
    </Table>
  );
}
