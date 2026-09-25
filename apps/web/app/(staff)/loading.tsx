export default function Loading() {
  return (
    <div className="stack" aria-busy="true" aria-label="読み込み中">
      <div className="skeleton" style={{ height: 34, width: 260 }} />
      <div className="grid-4">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 96 }} />)}</div>
      <div className="skeleton" style={{ height: 320 }} />
    </div>
  );
}
