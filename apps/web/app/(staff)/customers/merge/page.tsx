import Link from 'next/link';
import type { ReactNode } from 'react';
import { prisma } from '@/lib/server/db';
import { requirePage } from '@/lib/server/session';
import { maskedContact } from '@/lib/server/pii';
import { fullName } from '@/lib/server/customers';
import { liveWhere } from '@/lib/server/crm';
import { Card, Empty, PageHeader, Badge } from '@/components/ui';
import { ActionForm, SubmitButton } from '@/components/client';
import { fmtDate, yen } from '@/lib/format';
import { mergeCustomersAction } from '../actions';

export const metadata = { title: '顧客の統合' };

export default async function MergePage({ searchParams }: { searchParams: Promise<{ a?: string; b?: string }> }) {
  const ctx = await requirePage('customer.merge');
  const { a, b } = await searchParams;
  const load = (id?: string) => id ? prisma.customer.findFirst({
    where: { id, ...liveWhere(ctx.org.id) },
    include: {
      tags: { include: { tag: true } }, identities: true,
      _count: { select: { appointments: true, kartes: true, transactions: true, messages: true, counseling: true } },
    },
  }) : Promise.resolve(null);
  const [ca, cb] = await Promise.all([load(a), load(b)]);
  if (!ca || !cb || ca.id === cb.id) {
    return (
      <>
        <PageHeader title="顧客の統合" back={{ href: '/customers/duplicates', label: '重複候補' }} />
        <Card><Empty title="統合する顧客を選択してください" action={<Link href="/customers/duplicates" className="btn sm">重複候補を見る</Link>}>顧客が見つからないか、すでに統合・削除されています。</Empty></Card>
      </>
    );
  }
  const tz = ctx.shop.timezone;
  const staffIds = [ca.assignedStaffId, cb.assignedStaffId].filter(Boolean) as string[];
  const staff = new Map((await prisma.membership.findMany({ where: { organizationId: ctx.org.id, userId: { in: staffIds } }, select: { userId: true, displayName: true } })).map((s) => [s.userId, s.displayName]));
  const ma = maskedContact(ca), mb = maskedContact(cb);
  // default survivor: more history, then older record
  const score = (c: typeof ca) => c._count.appointments + c._count.transactions * 2 + c._count.kartes + c.identities.length;
  const defaultSurvivor = score(ca) > score(cb) || (score(ca) === score(cb) && ca.createdAt <= cb.createdAt) ? ca.id : cb.id;
  const same = (x: unknown, y: unknown) => x !== null && x !== undefined && x !== '' && x === y;

  const rows: { label: string; a: ReactNode; b: ReactNode; match?: boolean }[] = [
    { label: '氏名', a: fullName(ca), b: fullName(cb), match: fullName(ca).replace(/\s/g, '') === fullName(cb).replace(/\s/g, '') },
    { label: 'フリガナ', a: `${ca.lastNameKana ?? ''} ${ca.firstNameKana ?? ''}`.trim() || '—', b: `${cb.lastNameKana ?? ''} ${cb.firstNameKana ?? ''}`.trim() || '—' },
    { label: '電話番号', a: ma.phone || '—', b: mb.phone || '—', match: same(ca.phoneHash, cb.phoneHash) },
    { label: 'メール', a: ma.email || '—', b: mb.email || '—', match: same(ca.emailHash, cb.emailHash) },
    { label: '誕生日', a: ca.birthday ?? '—', b: cb.birthday ?? '—', match: same(ca.birthday, cb.birthday) },
    { label: '性別', a: ca.gender ?? '—', b: cb.gender ?? '—' },
    { label: '担当', a: ca.assignedStaffId ? staff.get(ca.assignedStaffId) ?? '—' : '—', b: cb.assignedStaffId ? staff.get(cb.assignedStaffId) ?? '—' : '—' },
    { label: '来店回数 / LTV', a: `${ca.visitCount}回 / ${yen(ca.totalSales)}`, b: `${cb.visitCount}回 / ${yen(cb.totalSales)}` },
    { label: '最終来店', a: ca.lastVisitAt ? fmtDate(ca.lastVisitAt, tz) : '—', b: cb.lastVisitAt ? fmtDate(cb.lastVisitAt, tz) : '—' },
    { label: '予約 / 会計 / カルテ', a: `${ca._count.appointments} / ${ca._count.transactions} / ${ca._count.kartes}`, b: `${cb._count.appointments} / ${cb._count.transactions} / ${cb._count.kartes}` },
    { label: 'メッセージ / カウンセリング', a: `${ca._count.messages} / ${ca._count.counseling}`, b: `${cb._count.messages} / ${cb._count.counseling}` },
    { label: '外部連携', a: ca.identities.map((i) => i.provider).join('、') || '—', b: cb.identities.map((i) => i.provider).join('、') || '—' },
    { label: 'タグ', a: ca.tags.map((t) => t.tag.name).join('、') || '—', b: cb.tags.map((t) => t.tag.name).join('、') || '—' },
    { label: 'メモ', a: <span className="crm-clamp">{ca.notes ?? '—'}</span>, b: <span className="crm-clamp">{cb.notes ?? '—'}</span> },
    { label: '登録日', a: fmtDate(ca.createdAt, tz), b: fmtDate(cb.createdAt, tz) },
  ];

  return (
    <>
      <PageHeader title="顧客の統合" back={{ href: '/customers/duplicates', label: '重複候補' }} sub="残す顧客を選んでください。もう一方の履歴はすべて残す顧客に移動します。" />
      <ActionForm action={mergeCustomersAction}>
        <div className="table-wrap">
          <table className="table crm-merge">
            <thead>
              <tr>
                <th style={{ width: 170 }}>項目</th>
                {[ca, cb].map((c) => (
                  <th key={c.id}>
                    <label className="crm-merge-pick">
                      <input type="radio" name="survivorId" value={c.id} defaultChecked={c.id === defaultSurvivor} required />
                      <span><strong>{fullName(c)}</strong> を残す<br /><Link href={`/customers/${c.id}`} className="link" target="_blank">詳細を開く</Link></span>
                    </label>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.label}>
                  <th scope="row">{r.label}{r.match && <> <Badge tone="green">一致</Badge></>}</th>
                  <td>{r.a}</td>
                  <td>{r.b}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <input type="hidden" name="pair" value={`${ca.id}|${cb.id}`} />
        <Card className="section">
          <ul className="sub" style={{ margin: '0 0 12px', paddingLeft: 18 }}>
            <li>予約・会計・カルテ・メッセージ・ポイント・口コミ・カウンセリング・外部連携（LINE等）・タグが、残す顧客に集約されます。</li>
            <li>残す顧客の空欄項目（フリガナ・電話・メール・誕生日など）は、統合される顧客の値で補完されます。メモは追記されます。</li>
            <li>統合される顧客は一覧から消え、元に戻すことはできません（統合前の内容は監査用に保存されます）。</li>
          </ul>
          <div className="between">
            <label className="checkbox"><input type="checkbox" name="confirm" required />内容を確認しました</label>
            <SubmitButton pendingText="統合中…" className="btn danger">統合する</SubmitButton>
          </div>
        </Card>
      </ActionForm>
    </>
  );
}
