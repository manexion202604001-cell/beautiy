'use client';

export default function ReservationsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const forbidden = error.message?.includes('権限');
  return (
    <div className="card center" style={{ maxWidth: 520, margin: '40px auto' }}>
      <h2 style={{ marginBottom: 6 }}>{forbidden ? 'アクセスできません' : '予約台帳を表示できませんでした'}</h2>
      <p className="sub">{forbidden ? error.message : '通信状況を確認のうえ、もう一度お試しください。'}</p>
      {error.digest && <p className="sub mono">ref: {error.digest}</p>}
      <button type="button" className="btn" onClick={reset}>再読み込み</button>
    </div>
  );
}
