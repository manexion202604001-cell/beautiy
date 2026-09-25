import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getSharedKarte } from '@/lib/server/karte';
import { fileUrl } from '@/lib/server/storage';
import { fmtDate } from '@/lib/format';

// Customer-facing shared karte. Only the care memo, shareable photos, visit date,
// shop and stylist name are exposed — never internal notes or customer PII.
export const metadata: Metadata = { title: '施術記録', robots: { index: false, follow: false }, referrer: 'no-referrer' };
export const dynamic = 'force-dynamic';

const KIND_LABEL: Record<string, string> = { BEFORE: 'Before', AFTER: 'After', OTHER: '' };

export default async function SharedKartePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const k = await getSharedKarte(token);
  if (!k) notFound();
  const tz = k.shop?.timezone ?? 'Asia/Tokyo';
  const before = k.photos.filter((p) => p.kind === 'BEFORE');
  const after = k.photos.filter((p) => p.kind === 'AFTER');
  const other = k.photos.filter((p) => p.kind !== 'BEFORE' && p.kind !== 'AFTER');
  const ordered = [...before, ...after, ...other];
  return (
    <>
      <header className="public-head">
        <div>
          <div style={{ fontWeight: 800, fontSize: 16 }}>{k.shop?.name ?? k.orgName}</div>
          <div className="sub">施術記録のご案内</div>
        </div>
      </header>
      <main className="public-body stack">
        <section className="card kt-share-hero">
          <div className="sub">ご来店日</div>
          <div className="kt-share-date">{fmtDate(k.visitDate, tz)}</div>
          {k.stylist && (
            <div className="row" style={{ marginTop: 12 }}>
              <span className="avatar">{k.stylist.imageUrl ? <img src={k.stylist.imageUrl} alt="" /> : k.stylist.name.slice(0, 1)}</span>
              <div><div className="sub">担当スタイリスト</div><div style={{ fontWeight: 700 }}>{k.stylist.name}</div></div>
            </div>
          )}
        </section>

        {ordered.length > 0 && (
          <section className="card">
            <h2 style={{ marginBottom: 12 }}>仕上がり</h2>
            <div className="kt-share-photos">
              {ordered.map((p) => (
                <figure key={p.id}>
                  <div className="photo">
                    <img src={fileUrl(p.storageKey, k.token)} alt={p.caption ?? KIND_LABEL[p.kind] ?? '施術写真'} loading="lazy" />
                    {KIND_LABEL[p.kind] && <span className={`badge tag ${p.kind === 'AFTER' ? 'blue' : ''}`}>{KIND_LABEL[p.kind]}</span>}
                  </div>
                  {p.caption && <figcaption className="sub">{p.caption}</figcaption>}
                </figure>
              ))}
            </div>
          </section>
        )}

        {k.careMemo && (
          <section className="card">
            <h2 style={{ marginBottom: 8 }}>ご自宅でのケアについて</h2>
            <div className="kt-share-memo">{k.careMemo}</div>
          </section>
        )}

        {!k.careMemo && ordered.length === 0 && (
          <section className="card center"><p className="sub" style={{ margin: 0 }}>表示できる内容はまだありません。</p></section>
        )}

        <div className="stack-sm center">
          {k.shop?.slug && <a href={`/book/${k.shop.slug}`} className="btn lg block">次回のご予約はこちら</a>}
          <p className="sub" style={{ marginTop: 8 }}>このページはお客様専用のリンクです。第三者と共有しないようご注意ください。</p>
        </div>
      </main>
    </>
  );
}
