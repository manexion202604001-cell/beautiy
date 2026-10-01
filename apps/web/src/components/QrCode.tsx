import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { Spinner } from './ui';

/** QR code image for a URL (rendered locally — the URL never leaves the browser) */
export function QrCode({ value, size = 180, label }: { value: string; size?: number; label: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(value, { width: size * 2, margin: 1, errorCorrectionLevel: 'M' })
      .then((url) => {
        if (!cancelled) setSrc(url);
      })
      .catch(() => {
        if (!cancelled) setSrc(null);
      });
    return () => {
      cancelled = true;
    };
  }, [value, size]);
  return (
    <div
      className="inline-flex items-center justify-center rounded-xl border border-border bg-white p-2"
      style={{ width: size + 16, height: size + 16 }}
    >
      {src ? <img src={src} width={size} height={size} alt={label} /> : <Spinner />}
    </div>
  );
}

/** Copy text to the clipboard with a textarea fallback (older in-app browsers) */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}
