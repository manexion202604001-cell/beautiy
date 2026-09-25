import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="public" style={{ display: 'grid', placeItems: 'center' }}>
      <div className="card center" style={{ maxWidth: 420 }}>
        <h1>ページが見つかりません</h1>
        <p className="sub">URLが正しいかご確認ください。リンクの有効期限が切れている可能性があります。</p>
        <Link href="/" className="btn secondary">トップへ戻る</Link>
      </div>
    </div>
  );
}
