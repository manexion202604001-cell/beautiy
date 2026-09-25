'use client';

export default function ReviewsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="card center" style={{ maxWidth: 520, margin: '40px auto' }}>
      <h2>口コミ・プロフィール画面を表示できませんでした</h2>
      <p className="sub">{error.message?.includes('権限') ? error.message : '一時的な問題の可能性があります。再試行してください。'}</p>
      {error.digest && <p className="sub mono">ref: {error.digest}</p>}
      <button className="btn" onClick={reset}>再試行</button>
    </div>
  );
}
