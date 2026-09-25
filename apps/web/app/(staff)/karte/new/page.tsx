import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ClipboardPlus } from 'lucide-react';
import { localToUtc, todayIn, addDays, toLocalParts } from '@salonos/core';
import { prisma } from '@/lib/server/db';
import { requirePage } from '@/lib/server/session';
import { liveWhere, searchCustomers } from '@/lib/server/crm';
import { fullName } from '@/lib/server/customers';
import { previousKarte } from '@/lib/server/karte';
import { Card, Empty, PageHeader, Badge } from '@/components/ui';
import { fmtDate, fmtRange } from '@/lib/format';
import { KarteEditor } from '../_components/KarteEditor';

export const metadata = { title: '新規カルテ' };

type SP = Promise<Record<string, string | undefined>>;

function localDate(d: Date, tz: string) {
  const p = toLocalParts(d, tz);
  return p.date;
}

export default async function NewKartePage({ searchParams }: { searchParams: SP }) {
  const ctx = await requirePage('karte.write');
  const sp = await searchParams;
  const tz = ctx.shop.timezone;

  // ── with appointment: one karte per appointment ──
  if (sp.appointmentId) {
    const appt = await prisma.appointment.findFirst({
      where: { id: sp.appointmentId, organizationId: ctx.org.id },
      include: { karte: { select: { id: true } }, menus: { select: { name: true } }, customer: true },
    });
    if (!appt) return <Missing message="予約が見つかりません。" />;
    if (appt.karte) redirect(`/karte/${appt.karte.id}`);
    if (!appt.customerId || !appt.customer) return <Missing message="この予約には顧客が登録されていません。予約台帳で顧客を紐づけてからカルテを作成してください。" />;
    return <Editor ctxOrg={ctx.org.id} customer={appt.customer} appointment={{ id: appt.id, label: `${fmtDate(appt.startAt, tz)} ${fmtRange(appt.startAt, appt.endAt, tz)} ${appt.menus.map((m) => m.name).join('・')}` }} visitDate={localDate(appt.startAt, tz)} />;
  }

  // ── with customer only ──
  if (sp.customerId) {
    const c = await prisma.customer.findFirst({ where: { id: sp.customerId, ...liveWhere(ctx.org.id) } });
    if (!c) return <Missing message="顧客が見つかりません。" />;
    // Prefer attaching to today's appointment for this customer when one exists without a karte.
    const today = todayIn(tz);
    const todays = await prisma.appointment.findFirst({
      where: { organizationId: ctx.org.id, customerId: c.id, karte: null, status: { notIn: ['CANCELLED', 'NO_SHOW'] }, startAt: { gte: localToUtc(today, 0, tz), lt: localToUtc(addDays(today, 1), 0, tz) } },
      include: { menus: { select: { name: true } } }, orderBy: { startAt: 'asc' },
    });
    if (todays && sp.standalone !== '1') redirect(`/karte/new?appointmentId=${todays.id}`);
    return <Editor ctxOrg={ctx.org.id} customer={c} visitDate={today} />;
  }

  // ── picker: today's appointments without karte + customer search ──
  const today = todayIn(tz);
  const [appts, found] = await Promise.all([
    prisma.appointment.findMany({
      where: { organizationId: ctx.org.id, shopId: ctx.shop.id, customerId: { not: null }, kind: { not: 'PRIVATE' }, status: { notIn: ['CANCELLED', 'NO_SHOW'] }, startAt: { gte: localToUtc(addDays(today, -1), 0, tz), lt: localToUtc(addDays(today, 1), 0, tz) } },
      include: { karte: { select: { id: true } }, menus: { select: { name: true } }, customer: { select: { lastName: true, firstName: true } } },
      orderBy: { startAt: 'asc' },
    }),
    sp.q ? searchCustomers(ctx.org.id, { q: sp.q.slice(0, 100), perPage: 20 }) : null,
  ]);
  const staffIds = [...new Set(appts.map((a) => a.staffId).filter(Boolean) as string[])];
  const staffName = new Map((await prisma.membership.findMany({ where: { organizationId: ctx.org.id, userId: { in: staffIds } }, select: { userId: true, displayName: true } })).map((m) => [m.userId, m.displayName]));

  return (
    <>
      <PageHeader title="新規カルテ" back={{ href: '/karte', label: 'カルテ履歴' }} sub="予約または顧客を選んでカルテを作成します。" />
      <div className="split">
        <Card title="昨日・今日の予約" flush>
          {appts.length === 0 ? <Empty title="対象の予約はありません">{ctx.shop.name}の昨日・今日の予約が表示されます。</Empty> : (
            <div className="list" style={{ padding: '0 18px' }}>
              {appts.map((a) => (
                <div key={a.id} className="list-item">
                  <div className="crm-date-box"><strong>{fmtRange(a.startAt, a.endAt, tz).split('–')[0]}</strong><small>{fmtDate(a.startAt, tz).slice(5)}</small></div>
                  <div className="grow">
                    <div style={{ fontWeight: 700 }}>{a.customer ? fullName(a.customer) : a.guestName} 様</div>
                    <div className="sub">{a.menus.map((m) => m.name).join('・') || 'メニュー未設定'}{a.staffId ? ` ・ ${staffName.get(a.staffId) ?? ''}` : ''}</div>
                  </div>
                  {a.karte
                    ? <Link href={`/karte/${a.karte.id}`} className="btn secondary sm">カルテを開く</Link>
                    : <Link href={`/karte/new?appointmentId=${a.id}`} className="btn sm"><ClipboardPlus size={14} />作成</Link>}
                </div>
              ))}
            </div>
          )}
        </Card>
        <Card title="顧客から作成">
          <form method="get" className="row" role="search">
            <input name="q" className="input" defaultValue={sp.q ?? ''} placeholder="氏名・フリガナ・電話番号" aria-label="顧客検索" />
            <button className="btn" type="submit">検索</button>
          </form>
          {found && (found.items.length === 0 ? <p className="sub" style={{ marginTop: 12 }}>該当する顧客がいません。</p> : (
            <div className="list section">
              {found.items.map((c) => (
                <Link key={c.id} href={`/karte/new?customerId=${c.id}`} className="list-item">
                  <div className="grow"><div style={{ fontWeight: 700 }}>{c.name}</div><div className="sub">{c.kana} {c.lastVisitAt ? `・ 最終来店 ${fmtDate(c.lastVisitAt, tz)}` : ''}</div></div>
                  <Badge tone="blue">選択</Badge>
                </Link>
              ))}
            </div>
          ))}
        </Card>
      </div>
    </>
  );
}

function Missing({ message }: { message: string }) {
  return (
    <>
      <PageHeader title="新規カルテ" back={{ href: '/karte', label: 'カルテ履歴' }} />
      <Card><Empty title="カルテを作成できません" action={<Link href="/karte/new" className="btn secondary sm">予約・顧客を選び直す</Link>}>{message}</Empty></Card>
    </>
  );
}

async function Editor({ ctxOrg, customer, appointment, visitDate }: {
  ctxOrg: string; customer: { id: string; lastName: string; firstName: string; notes: string | null }; appointment?: { id: string; label: string }; visitDate: string;
}) {
  const [templates, prev] = await Promise.all([
    prisma.karteTemplate.findMany({ where: { organizationId: ctxOrg }, orderBy: { name: 'asc' }, select: { id: true, name: true, treatmentNote: true, formulaNote: true, careMemo: true } }),
    previousKarte(ctxOrg, customer.id),
  ]);
  return (
    <>
      <PageHeader
        title={`${fullName(customer)} 様の新規カルテ`}
        back={{ href: `/customers/${customer.id}?tab=karte`, label: '顧客詳細' }}
        sub={appointment ? `予約: ${appointment.label}` : '予約に紐づかないカルテとして作成します'}
        actions={appointment ? <Link href={`/karte/new?customerId=${customer.id}&standalone=1`} className="btn ghost sm">予約に紐づけずに作成</Link> : undefined}
      />
      {customer.notes && <div className="alert warn" style={{ marginBottom: 12 }}><strong>顧客メモ:</strong> {customer.notes}</div>}
      <KarteEditor
        customerId={customer.id} appointmentId={appointment?.id ?? null} visitDate={visitDate}
        initial={{ treatmentNote: '', formulaNote: '', assistantNote: '', careMemo: '' }} sketch={null} templates={templates}
        previous={prev ? { ...prev, visitDate: fmtDate(prev.visitDate) } : null}
      />
      <p className="sub section">写真の追加・お客様への共有は、カルテ作成後に行えます。</p>
    </>
  );
}
