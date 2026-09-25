import Link from 'next/link';
import { Plus, ClipboardCheck } from 'lucide-react';
import { prisma } from '@/lib/server/db';
import { requirePage } from '@/lib/server/session';
import { parseFormFields } from '@/lib/server/karte';
import { Badge, Card, Empty, PageHeader } from '@/components/ui';
import { fmtDate } from '@/lib/format';
import { KarteTabs } from '../_components/KarteTabs';

export const metadata = { title: 'カウンセリングフォーム' };

export default async function FormsPage() {
  const ctx = await requirePage('karte.read');
  const canEdit = ctx.can('karte.write');
  const forms = await prisma.counselingForm.findMany({ where: { organizationId: ctx.org.id }, orderBy: [{ active: 'desc' }, { createdAt: 'asc' }] });
  const counts = await prisma.counselingResponse.groupBy({ by: ['formId', 'status'], where: { organizationId: ctx.org.id }, _count: { _all: true } });
  const count = (formId: string, status: string) => counts.find((c) => c.formId === formId && c.status === status)?._count._all ?? 0;
  return (
    <>
      <PageHeader title="カルテ" sub="来店前・来店時にお客様自身が記入するカウンセリングシート／同意書を作成します。" actions={canEdit ? <Link href="/karte/forms/new" className="btn"><Plus />フォーム作成</Link> : undefined} />
      <KarteTabs active="forms" />
      {forms.length === 0 ? (
        <Card><Empty title="フォームはまだありません" icon={<ClipboardCheck size={20} />} action={canEdit ? <Link href="/karte/forms/new" className="btn sm">フォームを作成</Link> : undefined}>質問項目・同意文・電子署名を組み合わせたフォームを作成できます。</Empty></Card>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>フォーム名</th><th className="num">項目数</th><th>同意・署名</th><th className="num">回答済</th><th className="num">未回答</th><th className="hide-sm">作成日</th><th>状態</th></tr></thead>
            <tbody>
              {forms.map((f) => (
                <tr key={f.id}>
                  <td><Link className="link" href={`/karte/forms/${f.id}`} style={{ fontWeight: 700 }}>{f.name}</Link>{f.description && <div className="sub crm-clamp">{f.description}</div>}</td>
                  <td className="num">{parseFormFields(f.fields).length}</td>
                  <td>{f.requireConsent ? <Badge tone="violet">必須</Badge> : <span className="sub">—</span>}</td>
                  <td className="num">{count(f.id, 'SUBMITTED')}</td>
                  <td className="num">{count(f.id, 'PENDING')}</td>
                  <td className="hide-sm">{fmtDate(f.createdAt, ctx.shop.timezone)}</td>
                  <td>{f.active ? <Badge tone="green">公開中</Badge> : <Badge>非公開</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
