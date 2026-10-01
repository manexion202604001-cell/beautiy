import { create } from 'qrcode';
import { useMemo } from 'react';

/** QR code rendered as an SVG path (no canvas / innerHTML; prints crisply) */
export function QrCode({
  value,
  size = 176,
  label = 'QRコード',
}: {
  value: string;
  size?: number;
  label?: string;
}) {
  const path = useMemo(() => {
    try {
      const qr = create(value, { errorCorrectionLevel: 'M' });
      const n = qr.modules.size;
      const data = qr.modules.data;
      let d = '';
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
          if (data[r * n + c]) d += `M${c + 4} ${r + 4}h1v1h-1z`;
        }
      }
      return { d, n: n + 8 };
    } catch {
      return null;
    }
  }, [value]);
  if (!path) return null;
  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${path.n} ${path.n}`}
      shapeRendering="crispEdges"
      className="rounded-lg bg-white"
    >
      <rect width={path.n} height={path.n} fill="#ffffff" />
      <path d={path.d} fill="#000000" />
    </svg>
  );
}
