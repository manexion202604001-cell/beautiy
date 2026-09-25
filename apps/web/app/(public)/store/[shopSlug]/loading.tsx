export default function Loading() {
  return (
    <div className="stack" aria-busy="true" aria-label="読み込み中">
      <div className="skeleton" style={{ height: 28, width: 220 }} />
      <div className="store-grid">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ aspectRatio: '3 / 4' }} />)}</div>
    </div>
  );
}
