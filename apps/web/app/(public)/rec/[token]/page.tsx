import Link from 'next/link';
import { Package, Sparkles } from 'lucide-react';
import { recommendationByToken } from '@/lib/server/commerce';
import { Avatar, Empty } from '@/components/ui';
import { yen } from '@/lib/format';
import { RecAddButton } from './RecClient';

export const metadata = { title: 'スタイリストからのおすすめ', robots: { index: false } };
export const dynamic = 'force-dynamic';

export default async function RecommendationPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const r = await recommendationByToken(token);
  if (!r) {
    return <div className="public-body" style={{ paddingTop: 32 }}><div className="card"><Empty title="ページが見つかりません">リンクの有効期限が切れているか、URLが正しくありません。</Empty></div></div>;
  }
  const { shop, staff, products, rec } = r;
  const available = products.filter((p) => p.stock > 0);
  return (
    <>
      <header className="store-head"><div className="store-head-inner"><Link href={`/store/${shop.slug}?rec=${rec.token}`} className="store-brand">{shop.name}<small>オンラインストア</small></Link></div></header>
      <main className="store-body stack">
        <div className="row"><Sparkles size={18} color="var(--accent)" /><h1 style={{ fontSize: 20 }}>あなたへのおすすめ</h1></div>
        <div className="rec-message">
          <div className="row" style={{ marginBottom: rec.message ? 8 : 0 }}>
            <Avatar name={staff?.displayName ?? 'S'} src={staff?.imageUrl} />
            <div><div style={{ fontWeight: 700 }}>{staff?.displayName ?? 'スタイリスト'}</div><div className="sub">{shop.name}</div></div>
          </div>
          {rec.message && <div style={{ whiteSpace: 'pre-wrap' }}>{rec.message}</div>}
        </div>
        {products.length === 0 ? <div className="card"><Empty title="おすすめ商品は現在販売されていません" /></div> : (
          <>
            <div className="store-grid">
              {products.map((p) => (
                <div key={p.id} className="store-card">
                  <Link href={`/store/${shop.slug}/p/${p.id}?rec=${rec.token}`} className="img">{p.imageUrl ? <img src={p.imageUrl} alt={p.name} /> : <Package size={36} />}</Link>
                  <div className="body">
                    {p.brand && <div className="sub">{p.brand}</div>}
                    <div className="name">{p.name}</div>
                    <div className="price num">{yen(p.price)}<span className="sub" style={{ fontWeight: 400 }}> 税込</span></div>
                    <RecAddButton slug={shop.slug} token={rec.token} productIds={[p.id]} label={p.stock > 0 ? 'カートに入れる' : '在庫切れ'} disabled={p.stock <= 0} />
                  </div>
                </div>
              ))}
            </div>
            {available.length > 1 && <RecAddButton slug={shop.slug} token={rec.token} productIds={available.map((p) => p.id)} label="おすすめをすべてカートに入れる" className="btn lg block" />}
          </>
        )}
      </main>
    </>
  );
}
