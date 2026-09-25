import Link from 'next/link';
import type { Prisma } from '@salonos/db';
import { ClipboardPlus, ClipboardList } from 'lucide-react';
import { localToUtc, isDateStr, addDays } from '@salonos/core';
import { prisma } from '@/lib/server/db';
import { requirePage } from '@/lib/server/session';
import { customerWhere, staffOptions } from '@/lib/server/crm';
import { fullName } from '@/lib/server/customers';
import { Badge, Empty, PageHeader } from '@/components/ui';
import { fmtDate } from '@/lib/format';
import { KarteTabs } from './_components/KarteTabs';

export const metadata = { title: 'カルテ' };

const PER_PAGE = 30;
type SP = Promise<Record<string, string | undefined>>;

export default async function KarteHistoryPage({ searchParams }: { searchParams: SP }) {
  const ctx = await requirePage('karte.read');
  const sp = await searchParams;
  const tz = ctx.shop.timezone;
  const page = Math.max(1, Math.floor(Number(sp.page) || 1));
  const allShops = sp.shop === 'all';
  const where: Prisma.KarteWhereInput = {
    organizationId: ctx.org.id,
    shopId: allShops ? { in: ctx.shops.map((s) => s.id) } : ctx.shop.id,
  };
  const and: Prisma.KarteWhereInput[] = [];
  if (sp.q?.trim()) and.push({ customer: customerWhere(ctx.org.id, { q: sp.q.slice(0, 100) }).where });
  if (sp.customerId) and.push({ customerId: sp.customerId });
  if (sp.staff) and.push({ authorId: sp.staff });
  if (sp.from && isDateStr(sp.from)) and.push({ visitDate: { gte: localToUtc(sp.from, 0, tz) } });
  if (sp.to && isDateStr(sp.to)) and.push({ visitDate: { lt: localToUtc(addDays(sp.to, 1), 0, tz) } });
  if (sp.shared === '1') and.push({ shareEnabled: true });
  if (and.length) where.AND = and;

  const [total, kartes, staff, focusCustomer] = await Promise.all([
    prisma.karte.count({ where }),
    prisma.karte.findMany({
      where, orderBy: [{ visitDate: 'desc' }, { createdAt: 'desc' }], skip: (page - 1) * PER_PAGE, take: PER_PAGE,
      include: {
        customer: { select: { id: true, lastName: true, firstName: true, lastNameKana: true, firstNameKana: true } },
        appointment: { select: { menus: { select: { name: true } } } },
        _count: { select: { photos: true } },
      },
    }),
    staffOptions(ctx.org.id),
    sp.customerId ? prisma.customer.findFirst({ where: { id: sp.customerId, organizationId: ctx.org.id }, select: { lastName: true, firstName: true } }) : null,
  ]);
  const staffName = new Map(staff.map((s) => [s.userId, s.displayName]));
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  const qs = (patch: Record<string, string | null>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) if (v) u.set(k, v);
    for (const [k, v] of Object.entries(patch)) (v ? u.set(k, v) : u.delete(k));
    const s = u.toString();
    return s ? `?${s}` : '';
  };
  const filtered = !!(sp.q || sp.customerId || sp.staff || sp.from || sp.to || sp.shared);

  return (
    <>
      <PageHeader
        title="カルテ"
        sub={`${allShops ? '全店舗' : ctx.shop.name} ・ ${total.toLocaleString('ja-JP')}件${focusCustomer ? ` ・ ${fullName(focusCustomer)} 様` : ''}`}
        actions={ctx.can('karte.write') ? <Link href="/karte/new" className="btn"><ClipboardPlus />新規カルテ</Link> : undefined}
      />
      <KarteTabs active="history" />
      <form className="card kt-filter" method="get" role="search">
        {sp.customerId && <input type="hidden" name="customerId" value={sp.customerId} />}
        <div className="field"><label htmlFor="kq">顧客</label><input id="kq" name="q" className="input sm" defaultValue={sp.q ?? ''} placeholder="氏名・フリガナ・電話" /></div>
        <div className="field">
          <label htmlFor="kstaff">担当</label>
          <select id="kstaff" name="staff" className="select sm" defaultValue={sp.staff ?? ''}>
            <option value="">すべて</option>
            {staff.map((s) => <option key={s.userId} value={s.userId}>{s.displayName}</option>)}
          </select>
        </div>
        <div className="field"><label htmlFor="kfrom">来店日（から）</label><input id="kfrom" name="from" type="date" className="input sm" defaultValue={sp.from ?? ''} /></div>
        <div className="field"><label htmlFor="kto">（まで）</label><input id="kto" name="to" type="date" className="input sm" defaultValue={sp.to ?? ''} /></div>
        {ctx.shops.length > 1 && (
          <div className="field">
            <label htmlFor="kshop">店舗</label>
            <select id="kshop" name="shop" className="select sm" defaultValue={allShops ? 'all' : ''}><option value="">{ctx.shop.name}</option><option value="all">全店舗</option></select>
          </div>
        )}
        <label className="checkbox" style={{ alignSelf: 'end', paddingBottom: 6 }}><input type="checkbox" name="shared" value="1" defaultChecked={sp.shared === '1'} />共有中のみ</label>
        <div className="row" style={{ alignSelf: 'end' }}>
          <button className="btn sm" type="submit">絞り込む</button>
          {filtered && <Link href="/karte" className="btn ghost sm">クリア</Link>}
        </div>
      </form>

      {kartes.length === 0 ? (
        <div className="card section">
          <Empty title={filtered ? '該当するカルテがありません' : 'カルテはまだありません'} icon={<ClipboardList size={20} />}
            action={ctx.can('karte.write') ? <Link href="/karte/new" className="btn sm">カルテを作成</Link> : undefined}>
            {filtered ? '条件を変えてお試しください。' : '予約の施術後に、施術内容・薬剤・写真を記録しましょう。'}
          </Empty>
        </div>
      ) : (
        <div className="table-wrap section">
          <table className="table">
            <thead><tr><th>来店日</th><th>顧客</th><th>メニュー / 施術内容</th><th className="hide-sm">担当</th><th>状態</th></tr></thead>
            <tbody>
              {kartes.map((k) => (
                <tr key={k.id}>
                  <td className="nowrap"><Link className="link" href={`/karte/${k.id}`}>{fmtDate(k.visitDate, tz)}</Link></td>
                  <td>
                    <Link href={`/customers/${k.customer.id}?tab=karte`} className="crm-name">
                      <span>{fullName(k.customer)}</span>
                      {(k.customer.lastNameKana || k.customer.firstNameKana) && <small>{`${k.customer.lastNameKana ?? ''} ${k.customer.firstNameKana ?? ''}`.trim()}</small>}
                    </Link>
                  </td>
                  <td style={{ maxWidth: 420 }}>
                    <Link href={`/karte/${k.id}`} style={{ display: 'block' }}>
                      <div style={{ fontWeight: 600 }}>{k.appointment?.menus.map((m) => m.name).join('・') || '施術記録'}</div>
                      <div className="sub crm-clamp">{k.treatmentNote || k.careMemo || '（記入なし）'}</div>
                    </Link>
                  </td>
                  <td className="hide-sm nowrap">{staffName.get(k.authorId) ?? '—'}</td>
                  <td><div className="row-wrap" style={{ gap: 4 }}>
                    {k._count.photos > 0 && <Badge tone="violet">写真{k._count.photos}</Badge>}
                    {k.shareEnabled && <Badge tone="green">共有中</Badge>}
                    {k.formulaNote && <Badge>薬剤</Badge>}
                  </div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pages > 1 && (
        <nav className="crm-pager" aria-label="ページ送り">
          {page > 1 ? <Link className="btn secondary sm" href={`/karte${qs({ page: String(page - 1) })}`}>← 前へ</Link> : <span className="btn secondary sm" aria-disabled="true">← 前へ</span>}
          <span className="sub">{page} / {pages} ページ</span>
          {page < pages ? <Link className="btn secondary sm" href={`/karte${qs({ page: String(page + 1) })}`}>次へ →</Link> : <span className="btn secondary sm" aria-disabled="true">次へ →</span>}
        </nav>
      )}
    </>
  );
}
