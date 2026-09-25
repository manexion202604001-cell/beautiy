import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { CheckCircle2 } from 'lucide-react';
import { getCounselingByToken } from '@/lib/server/karte';
import { fmtDateTime } from '@/lib/format';
import { CounselingEntry } from './CounselingEntry';

export const metadata: Metadata = { title: 'カウンセリングシート', robots: { index: false, follow: false }, referrer: 'no-referrer' };
export const dynamic = 'force-dynamic';

export default async function CounselingPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const v = await getCounselingByToken(token);
  if (!v) notFound();
  const shopName = v.shopName ?? v.orgName;
  return (
    <>
      <header className="public-head">
        <div>
          <div style={{ fontWeight: 800, fontSize: 16 }}>{shopName}</div>
          <div className="sub">{v.form.name}</div>
        </div>
      </header>
      <main className="public-body">
        {v.status === 'SUBMITTED' ? (
          <section className="card center" style={{ padding: '36px 20px' }}>
            <CheckCircle2 size={40} color="var(--green)" />
            <h1 style={{ fontSize: 20, margin: '10px 0 6px' }}>ご回答済みです</h1>
            <p className="sub">{v.submittedAt ? `${fmtDateTime(v.submittedAt, v.timezone)} に送信されました。` : ''}内容を変更したい場合は、ご来店時にスタッフへお申し付けください。</p>
          </section>
        ) : (
          <CounselingEntry
            token={token}
            form={v.form}
            intro={v.appointmentAt ? `ご予約日時: ${fmtDateTime(v.appointmentAt, v.timezone)}` : null}
          />
        )}
      </main>
    </>
  );
}
