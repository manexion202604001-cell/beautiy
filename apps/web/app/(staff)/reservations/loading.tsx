export default function Loading() {
  return (
    <div className="stack" aria-busy="true" aria-label="読み込み中">
      <div className="skeleton" style={{ height: 34, width: 220 }} />
      <div className="skeleton" style={{ height: 36, width: 320 }} />
      <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
        <div className="skeleton" style={{ height: 34, width: 360 }} />
        <div className="skeleton" style={{ height: 34, width: 220 }} />
      </div>
      <div className="skeleton" style={{ height: 'calc(100vh - 280px)', minHeight: 360 }} />
    </div>
  );
}
