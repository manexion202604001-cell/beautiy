import Link from 'next/link';
import { Download } from 'lucide-react';
import { RANGE_LABEL, type RangeKey } from '@/lib/server/analytics';
import { qs, type ReportScope, type SP } from './scope';

const PRESETS: RangeKey[] = ['today', '7d', '30d', 'thisMonth', 'lastMonth', '3m', '6m', '12m'];

export function ReportTabs({ active, sp }: { active: 'sales' | 'staff' | 'customers' | 'menus'; sp: SP }) {
  const keep = qs(sp, { page: undefined, lc: undefined });
  const items = [
    { key: 'sales', href: `/reports${keep}`, label: '売上' },
    { key: 'staff', href: `/reports/staff${keep}`, label: 'スタッフ' },
    { key: 'customers', href: `/reports/customers${keep}`, label: '顧客・LTV' },
    { key: 'menus', href: `/reports/menus${keep}`, label: 'メニュー' },
  ];
  return (
    <nav className="tabs" aria-label="レポート">
      {items.map((i) => <Link key={i.key} href={i.href} className={i.key === active ? 'active' : ''} aria-current={i.key === active ? 'page' : undefined}>{i.label}</Link>)}
    </nav>
  );
}

export function ReportFilters({ path, sp, scope, showPeriod = true, showGran = false, showScope = true, compare = true }: {
  path: string; sp: SP; scope: ReportScope; showPeriod?: boolean; showGran?: boolean; showScope?: boolean; compare?: boolean;
}) {
  const p = scope.period;
  return (
    <div className="report-filters no-print">
      {showPeriod && (
        <>
          <div className="seg" role="group" aria-label="期間">
            {PRESETS.map((r) => (
              <Link key={r} href={`${path}${qs(sp, { range: r, from: undefined, to: undefined, gran: undefined })}`} className={p.range === r ? 'active' : ''}>{RANGE_LABEL[r]}</Link>
            ))}
          </div>
          <form method="get" action={path} className="row-wrap report-custom">
            {Object.entries(sp).filter(([k]) => !['range', 'from', 'to', 'page'].includes(k)).map(([k, v]) => <input key={k} type="hidden" name={k} value={String(Array.isArray(v) ? v[0] : v ?? '')} />)}
            <input type="hidden" name="range" value="custom" />
            <label className="sr-only" htmlFor="rf-from">開始日</label>
            <input id="rf-from" type="date" name="from" className="input sm" defaultValue={p.fromDate} required />
            <span className="sub">〜</span>
            <label className="sr-only" htmlFor="rf-to">終了日</label>
            <input id="rf-to" type="date" name="to" className="input sm" defaultValue={p.toDate} required />
            <button className="btn secondary sm" type="submit">表示</button>
          </form>
        </>
      )}
      <div className="row-wrap">
        {showScope && scope.multi && (
          <div className="seg" role="group" aria-label="店舗範囲">
            <Link href={`${path}${qs(sp, { scope: undefined })}`} className={scope.mode === 'shop' ? 'active' : ''}>選択中の店舗</Link>
            <Link href={`${path}${qs(sp, { scope: 'all' })}`} className={scope.mode === 'all' ? 'active' : ''}>全店舗合計</Link>
            {compare && <Link href={`${path}${qs(sp, { scope: 'compare' })}`} className={scope.mode === 'compare' ? 'active' : ''}>店舗別比較</Link>}
          </div>
        )}
        {showGran && (
          <div className="seg" role="group" aria-label="集計単位">
            <Link href={`${path}${qs(sp, { gran: 'day' })}`} className={scope.gran === 'day' ? 'active' : ''}>日別</Link>
            <Link href={`${path}${qs(sp, { gran: 'month' })}`} className={scope.gran === 'month' ? 'active' : ''}>月別</Link>
          </div>
        )}
      </div>
    </div>
  );
}

export function ExportLink({ kind, sp, label, enabled }: { kind: string; sp: SP; label: string; enabled: boolean }) {
  if (!enabled) return null;
  return (
    <a className="btn secondary sm" href={`/reports/export/${kind}${qs(sp, { page: undefined })}`} download>
      <Download size={14} />{label}
    </a>
  );
}

export function periodText(scope: ReportScope) {
  const p = scope.period;
  return p.fromDate === p.toDate ? p.fromDate.replaceAll('-', '/') : `${p.fromDate.replaceAll('-', '/')} 〜 ${p.toDate.replaceAll('-', '/')}（${p.days}日間）`;
}
