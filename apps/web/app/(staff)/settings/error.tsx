'use client';
import Link from 'next/link';

export default function SectionError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const forbidden = error.message?.includes('権限');
  return (
    <div className="card" role="alert" style={{ maxWidth: 560 }}>
      <h2>{forbidden ? 'アクセスできません' : '読み込みに失敗しました'}</h2>
      <p className="sub" style={{ margin: '6px 0 12px' }}>{forbidden ? error.message : '一時的な問題の可能性があります。再試行しても解決しない場合は管理者にお問い合わせください。'}</p>
      {error.digest && <p className="sub mono">ref: {error.digest}</p>}
      <div className="row"><button className="btn" onClick={reset}>再試行</button><Link className="btn secondary" href="/dashboard">ダッシュボードへ</Link></div>
    </div>
  );
}
