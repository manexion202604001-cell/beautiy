export default function Loading() {
  return (
    <div className="stack" aria-busy="true" aria-label="読み込み中">
      <div className="skeleton" style={{ height: 34, width: 200 }} />
      <div className="skeleton" style={{ height: 44 }} />
      <div className="skeleton" style={{ height: 480 }} />
    </div>
  );
}
