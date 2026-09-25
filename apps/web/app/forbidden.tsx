import Link from 'next/link';

export default function Forbidden() {
  return (
    <div style={{ padding: 32, display: 'grid', placeItems: 'center' }}>
      <div className="card center" style={{ maxWidth: 440 }}>
        <h1>アクセスできません</h1>
        <p className="sub">このページを表示する権限がありません。必要な場合は管理者に権限の付与を依頼してください。</p>
        <Link href="/dashboard" className="btn secondary">ダッシュボードへ</Link>
      </div>
    </div>
  );
}
