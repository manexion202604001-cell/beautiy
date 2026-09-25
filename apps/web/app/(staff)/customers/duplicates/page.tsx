import Link from 'next/link';
import { GitMerge, CheckCircle2 } from 'lucide-react';
import { prisma } from '@/lib/server/db';
import { requirePage } from '@/lib/server/session';
import { fullName } from '@/lib/server/customers';
import { duplicateCandidates } from '@/lib/server/crm';
import { Bar, Badge, Card, Empty, PageHeader } from '@/components/ui';
import { fmtDate, yen } from '@/lib/format';

export const metadata = { title: '重複候補' };

const MAX_PAIRS = 100;

export default async function DuplicatesPage({ searchParams }: { searchParams: Promise<{ focus?: string }> }) {
  const ctx = await requirePage('customer.merge');
  const { focus } = await searchParams;
  let pairs = await duplicateCandidates(ctx.org.id);
  if (focus) pairs = pairs.filter((p) => p.a === focus || p.b === focus);
  const total = pairs.length;
  pairs = pairs.slice(0, MAX_PAIRS);
  const ids = [...new Set(pairs.flatMap((p) => [p.a, p.b]))];
  const rows = ids.length ? await prisma.customer.findMany({
    where: { id: { in: ids }, organizationId: ctx.org.id },
    select: { id: true, lastName: true, firstName: true, lastNameKana: true, firstNameKana: true, visitCount: true, totalSales: true, lastVisitAt: true, createdAt: true, birthday: true, _count: { select: { identities: true, kartes: true } } },
  }) : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const tz = ctx.shop.timezone;
  const focusName = focus ? byId.get(focus) : null;

  return (
    <>
      <PageHeader
        title="重複候補"
        back={{ href: focus ? `/customers/${focus}` : '/customers', label: focus ? '顧客詳細' : '顧客一覧' }}
        sub={focus && focusName ? `${fullName(focusName)} 様と重複の可能性がある顧客` : '電話番号・メール（暗号化インデックス）・氏名・フリガナ・生年月日の一致から候補を抽出しています。'}
        actions={focus ? <Link href="/customers/duplicates" className="btn secondary">すべての候補</Link> : undefined}
      />
      {pairs.length === 0 ? (
        <Card><Empty title="重複候補はありません" icon={<CheckCircle2 size={20} />}>{focus ? 'この顧客と重複している可能性のある顧客は見つかりませんでした。' : '現在、統合が必要そうな顧客は見つかりませんでした。'}</Empty></Card>
      ) : (
        <div className="stack">
          <div className="sub">{total}件の候補{total > MAX_PAIRS ? `（上位${MAX_PAIRS}件を表示）` : ''}</div>
          {pairs.map((p) => {
            const a = byId.get(p.a), b = byId.get(p.b);
            if (!a || !b) return null;
            return (
              <div key={`${p.a}-${p.b}`} className="card crm-dup">
                <div className="crm-dup-score">
                  <div className="sub">一致度</div>
                  <strong>{p.score}</strong>
                  <Bar value={p.score} max={100} />
                </div>
                <div className="crm-dup-pair">
                  {[a, b].map((c) => (
                    <Link key={c.id} href={`/customers/${c.id}`} className="crm-dup-card">
                      <div style={{ fontWeight: 700 }}>{fullName(c)}</div>
                      <div className="sub">{`${c.lastNameKana ?? ''} ${c.firstNameKana ?? ''}`.trim() || 'フリガナ未登録'}</div>
                      <div className="sub">来店{c.visitCount}回 ・ {yen(c.totalSales)} ・ 最終 {c.lastVisitAt ? fmtDate(c.lastVisitAt, tz) : '—'}</div>
                      <div className="sub">登録 {fmtDate(c.createdAt, tz)}{c._count.identities ? ` ・ 連携${c._count.identities}` : ''}{c._count.kartes ? ` ・ カルテ${c._count.kartes}` : ''}</div>
                    </Link>
                  ))}
                </div>
                <div className="stack-sm crm-dup-actions">
                  <div className="row-wrap" style={{ gap: 4 }}>{p.reasons.map((r) => <Badge key={r} tone={p.score >= 85 ? 'red' : 'amber'}>{r}</Badge>)}</div>
                  <Link href={`/customers/merge?a=${p.a}&b=${p.b}`} className="btn sm"><GitMerge size={14} />比較して統合</Link>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
