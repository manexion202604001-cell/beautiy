import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Trash2 } from 'lucide-react';
import { prisma } from '@/lib/server/db';
import { requirePage } from '@/lib/server/session';
import { formatAnswer, parseFormFields } from '@/lib/server/karte';
import { fullName } from '@/lib/server/customers';
import { Badge, Card, Empty, PageHeader } from '@/components/ui';
import { ConfirmAction } from '@/components/client';
import { fmtDateTime } from '@/lib/format';
import { FormBuilder } from '../../_components/FormBuilder';
import { WalkInLink } from '../../_components/WalkInLink';
import { deleteFormAction } from '../../actions';

export const metadata = { title: 'カウンセリングフォーム' };

export default async function FormPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ created?: string; status?: string }> }) {
  const ctx = await requirePage('karte.read');
  const canEdit = ctx.can('karte.write');
  const { id } = await params;
  const sp = await searchParams;
  const tz = ctx.shop.timezone;

  if (id === 'new') {
    if (!canEdit) notFound();
    return (
      <div style={{ maxWidth: 900 }}>
        <PageHeader title="フォーム作成" back={{ href: '/karte/forms', label: 'カウンセリングフォーム' }} />
        <FormBuilder initial={{ name: '', description: '', fields: [], requireConsent: false, consentText: '', active: true }} />
      </div>
    );
  }

  const form = await prisma.counselingForm.findFirst({ where: { id, organizationId: ctx.org.id } });
  if (!form) notFound();
  const fields = parseFormFields(form.fields);
  const status = sp.status === 'PENDING' ? 'PENDING' : 'SUBMITTED';
  const responses = await prisma.counselingResponse.findMany({
    where: { organizationId: ctx.org.id, formId: form.id, status },
    orderBy: [{ submittedAt: 'desc' }, { createdAt: 'desc' }], take: 50,
    include: { customer: { select: { id: true, lastName: true, firstName: true } } },
  });

  return (
    <>
      <PageHeader
        title={form.name}
        back={{ href: '/karte/forms', label: 'カウンセリングフォーム' }}
        sub={<span className="row-wrap" style={{ gap: 6 }}>{form.active ? <Badge tone="green">公開中</Badge> : <Badge>非公開</Badge>}{form.requireConsent && <Badge tone="violet">同意・署名あり</Badge>}<span>{fields.length}項目</span></span>}
        actions={canEdit ? <ConfirmAction action={deleteFormAction} fields={{ id: form.id }} confirm={'このフォームを削除しますか？\n回答がある場合は削除せず非公開にします。'} className="btn danger-outline sm"><Trash2 size={14} />削除</ConfirmAction> : undefined}
      />
      {sp.created && <div className="alert success" style={{ marginBottom: 12 }}>フォームを作成しました。顧客詳細の「カウンセリング依頼」から記入リンクを送れます。</div>}
      <div className="split">
        <div>
          {canEdit ? (
            <FormBuilder initial={{
              id: form.id, name: form.name, description: form.description ?? '', requireConsent: form.requireConsent, consentText: form.consentText ?? '', active: form.active,
              fields: fields.map((f) => ({ id: f.id, label: f.label, type: f.type, options: f.options, required: f.required, help: f.help })),
            }} />
          ) : (
            <Card title="質問項目">
              <ol>{fields.map((f) => <li key={f.id}>{f.label}{f.required && <span className="sub">（必須）</span>}</li>)}</ol>
              {form.consentText && <p className="sub">{form.consentText}</p>}
            </Card>
          )}
        </div>
        <div className="stack">
          {canEdit && form.active && <Card title="記入リンク"><WalkInLink formId={form.id} /></Card>}
          <Card title="回答" flush actions={
            <div className="seg">
              <Link href={`/karte/forms/${form.id}`} className={status === 'SUBMITTED' ? 'active' : ''}>回答済</Link>
              <Link href={`/karte/forms/${form.id}?status=PENDING`} className={status === 'PENDING' ? 'active' : ''}>未回答</Link>
            </div>
          }>
            {responses.length === 0 ? <Empty title={status === 'SUBMITTED' ? 'まだ回答はありません' : '未回答のリンクはありません'} /> : (
              <div className="list" style={{ padding: '0 18px' }}>
                {responses.map((r) => {
                  const answers = (r.answers ?? {}) as Record<string, unknown>;
                  return (
                    <details key={r.id} className="list-item kt-response">
                      <summary className="between" style={{ width: '100%' }}>
                        <span>
                          <strong>{r.customer ? fullName(r.customer) : r.signedName ?? '顧客未指定'}</strong>
                          <span className="sub"> ・ {r.status === 'SUBMITTED' ? fmtDateTime(r.submittedAt, tz) : `発行 ${fmtDateTime(r.createdAt, tz)}`}</span>
                        </span>
                        {r.customer && <Link href={`/customers/${r.customer.id}?tab=counseling`} className="link sub">顧客詳細</Link>}
                      </summary>
                      {r.status === 'SUBMITTED' && (
                        <div style={{ width: '100%' }}>
                          <dl className="kv crm-answers" style={{ marginTop: 8 }}>
                            {fields.map((f) => <div key={f.id} style={{ display: 'contents' }}><dt>{f.label}</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{formatAnswer(f, answers[f.id])}</dd></div>)}
                          </dl>
                          {r.signatureData?.startsWith('data:image/png;base64,') && (
                            <div className="crm-sign"><div className="sub">署名 {r.signedName && `（${r.signedName}）`}</div><img src={r.signatureData} alt="署名" className="crm-sign-img" /></div>
                          )}
                        </div>
                      )}
                    </details>
                  );
                })}
              </div>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
