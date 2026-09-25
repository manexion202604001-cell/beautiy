'use client';

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const forbidden = error.message?.includes('権限');
  return (
    <div style={{ padding: 32, display: 'grid', placeItems: 'center' }}>
      <div className="card center" style={{ maxWidth: 480 }}>
        <h1>{forbidden ? 'アクセスできません' : 'エラーが発生しました'}</h1>
        <p className="sub">{forbidden ? error.message : '一時的な問題の可能性があります。再試行してください。'}</p>
        {error.digest && <p className="sub mono">ref: {error.digest}</p>}
        <button className="btn" onClick={reset}>再試行</button>
      </div>
    </div>
  );
}
