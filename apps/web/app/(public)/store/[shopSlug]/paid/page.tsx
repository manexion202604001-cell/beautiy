import Link from 'next/link';
import { CheckCircle2, XCircle } from 'lucide-react';

export const metadata = { title: 'お支払い', robots: { index: false } };

// Landing page after a POS pay-by-link payment. The ticket itself is finalized by the provider webhook.
export default async function PaidPage({ params, searchParams }: { params: Promise<{ shopSlug: string }>; searchParams: Promise<{ cancelled?: string }> }) {
  const { shopSlug } = await params;
  const { cancelled } = await searchParams;
  return (
    <div className="card center" style={{ padding: 28 }}>
      {cancelled ? <XCircle size={40} color="var(--amber)" /> : <CheckCircle2 size={40} color="var(--green)" />}
      <h1 style={{ fontSize: 20, marginTop: 8 }}>{cancelled ? 'お支払いはキャンセルされました' : 'お支払いありがとうございました'}</h1>
      <div className="sub" style={{ marginTop: 6 }}>{cancelled ? 'スタッフにお声がけください。' : 'お支払いの確認後、スタッフが会計を完了します。'}</div>
      <Link className="btn secondary" style={{ marginTop: 16 }} href={`/store/${shopSlug}`}>オンラインストアを見る</Link>
    </div>
  );
}
