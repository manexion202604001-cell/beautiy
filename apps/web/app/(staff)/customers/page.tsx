import Link from 'next/link';
import { Star, UserPlus, Upload, Download, GitMerge, Users } from 'lucide-react';
import { LIFECYCLE_LABEL } from '@salonos/core';
import { requirePage } from '@/lib/server/session';
import { LIFECYCLES, LIFECYCLE_TONE, parseCustomerQuery, searchCustomers, staffOptions, tagOptions } from '@/lib/server/crm';
import { PageHeader, Badge, Empty } from '@/components/ui';
import { fmtDate, yen } from '@/lib/format';
import { FilterBar } from './_components/FilterBar';

export const metadata = { title: '顧客' };

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function CustomersPage({ searchParams }: { searchParams: SP }) {
  const ctx = await requirePage('customer.read');
  const sp = await searchParams;
  const query = parseCustomerQuery(sp);
  const [result, tags, staff] = await Promise.all([searchCustomers(ctx.org.id, query), tagOptions(ctx.org.id), staffOptions(ctx.org.id)]);
  const tz = ctx.shop.timezone;
  const qs = (patch: Record<string, string | null>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) if (typeof v === 'string' && v) u.set(k, v);
    for (const [k, v] of Object.entries(patch)) (v ? u.set(k, v) : u.delete(k));
    const s = u.toString();
    return s ? `?${s}` : '';
  };
  const filtered = !!(query.q || query.tagId || query.staffId || query.lifecycle || query.favorite || query.shopId);

  return (
    <>
      <PageHeader
        title="顧客"
        sub={`${result.total.toLocaleString('ja-JP')}名${filtered ? '（絞り込み中）' : ''}`}
        actions={<>
          {ctx.can('customer.merge') && <Link href="/customers/duplicates" className="btn secondary"><GitMerge />重複候補</Link>}
          {ctx.can('customer.import') && <Link href="/customers/import" className="btn secondary"><Upload />インポート</Link>}
          {ctx.can('customer.export') && <a href={`/customers/export${qs({ page: null })}`} className="btn secondary"><Download />CSV出力</a>}
          {ctx.can('customer.write') && <Link href="/customers/new" className="btn"><UserPlus />新規顧客</Link>}
        </>}
      />
      {sp.deleted && <div className="alert success" style={{ marginBottom: 12 }}>顧客を削除しました。</div>}
      {typeof sp.error === 'string' && <div className="alert error" style={{ marginBottom: 12 }}>{sp.error}</div>}

      <FilterBar options={{
        tags, staff, shops: ctx.shops.map((s) => ({ id: s.id, name: s.name })),
        lifecycles: LIFECYCLES.map((l) => ({ value: l, label: LIFECYCLE_LABEL[l] })),
      }} />
      {result.mode === 'phone' && <div className="sub" style={{ margin: '-4px 0 10px' }}>電話番号は完全一致で検索しています（個人情報保護のため部分一致はできません）。</div>}
      {result.mode === 'email' && <div className="sub" style={{ margin: '-4px 0 10px' }}>メールアドレスは完全一致で検索しています。</div>}

      {result.items.length === 0 ? (
        <div className="card">
          {filtered
            ? <Empty title="該当する顧客がいません" icon={<Users size={20} />} action={<Link href="/customers" className="btn secondary sm">条件をクリア</Link>}>検索条件を変更してお試しください。</Empty>
            : <Empty title="まだ顧客が登録されていません" icon={<Users size={20} />} action={ctx.can('customer.write') ? <Link href="/customers/new" className="btn sm">最初の顧客を登録</Link> : undefined}>予約・会計・LINE連携から自動で登録されるほか、手動登録やCSVインポートもできます。</Empty>}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table crm-table">
            <thead>
              <tr>
                <th>顧客</th>
                <th className="hide-sm">電話番号</th>
                <th>最終来店</th>
                <th className="num">来店</th>
                <th className="num">LTV</th>
                <th className="num hide-sm">平均周期</th>
                <th className="hide-sm">担当</th>
                <th className="hide-sm">タグ</th>
                <th>状態</th>
              </tr>
            </thead>
            <tbody>
              {result.items.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link href={`/customers/${c.id}`} className="crm-name">
                      <span>{c.favorite && <Star size={13} className="crm-fav" aria-label="お気に入り" />}{c.name || '（名前未登録）'}</span>
                      {c.kana && <small>{c.kana}</small>}
                    </Link>
                  </td>
                  <td className="hide-sm mono">{c.phone || <span className="sub">—</span>}</td>
                  <td className="nowrap">{c.lastVisitAt ? fmtDate(c.lastVisitAt, tz) : <span className="sub">—</span>}</td>
                  <td className="num">{c.visitCount}</td>
                  <td className="num">{yen(c.totalSales)}</td>
                  <td className="num hide-sm">{c.avgIntervalDays !== null ? `${Math.round(c.avgIntervalDays)}日` : <span className="sub">—</span>}</td>
                  <td className="hide-sm">{c.assignedStaffName ?? <span className="sub">—</span>}</td>
                  <td className="hide-sm">
                    <div className="row-wrap" style={{ gap: 4 }}>
                      {c.tags.slice(0, 3).map((t) => <span key={t.id} className="crm-tag" style={{ ['--tag' as string]: t.color }}>{t.name}</span>)}
                      {c.tags.length > 3 && <span className="sub">+{c.tags.length - 3}</span>}
                    </div>
                  </td>
                  <td><Badge tone={LIFECYCLE_TONE[c.lifecycle]}>{LIFECYCLE_LABEL[c.lifecycle]}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {result.pages > 1 && (
        <nav className="crm-pager" aria-label="ページ送り">
          {result.page > 1 ? <Link className="btn secondary sm" href={`/customers${qs({ page: String(result.page - 1) })}`}>← 前へ</Link> : <span className="btn secondary sm" aria-disabled="true">← 前へ</span>}
          <span className="sub">{result.page} / {result.pages} ページ（{((result.page - 1) * result.perPage + 1).toLocaleString()}–{Math.min(result.page * result.perPage, result.total).toLocaleString()}件）</span>
          {result.page < result.pages ? <Link className="btn secondary sm" href={`/customers${qs({ page: String(result.page + 1) })}`}>次へ →</Link> : <span className="btn secondary sm" aria-disabled="true">次へ →</span>}
        </nav>
      )}
    </>
  );
}
