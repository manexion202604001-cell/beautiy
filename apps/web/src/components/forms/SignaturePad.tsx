import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../ui';

/**
 * Canvas signature pad (pointer events: finger / Apple Pencil / mouse).
 * Calls onChange with a PNG data URL (white background) after every stroke, or null when cleared.
 */
export function SignaturePad({
  onChange,
  label = '署名欄',
  height = 180,
  disabled,
}: {
  onChange: (dataUrl: string | null) => void;
  label?: string;
  height?: number;
  disabled?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [empty, setEmpty] = useState(true);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const setup = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ratio = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const rect = c.getBoundingClientRect();
    c.width = Math.max(1, Math.round(rect.width * ratio));
    c.height = Math.max(1, Math.round(height * ratio));
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, rect.width, height);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#111111';
    ctx.lineWidth = 2.4;
  }, [height]);

  useEffect(() => {
    setup();
  }, [setup]);

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const emit = () => {
    const c = canvasRef.current;
    if (!c) return;
    try {
      onChangeRef.current(c.toDataURL('image/png'));
    } catch {
      onChangeRef.current(null);
    }
  };

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (disabled) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drawing.current = true;
    const p = point(e);
    last.current = p;
    const ctx = e.currentTarget.getContext('2d');
    if (ctx) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.2, 0, Math.PI * 2);
      ctx.fillStyle = '#111111';
      ctx.fill();
    }
  };
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current || disabled) return;
    e.preventDefault();
    const ctx = e.currentTarget.getContext('2d');
    const p = point(e);
    if (ctx && last.current) {
      ctx.beginPath();
      ctx.moveTo(last.current.x, last.current.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
    last.current = p;
  };
  const onUp = () => {
    if (!drawing.current) return;
    drawing.current = false;
    last.current = null;
    setEmpty(false);
    emit();
  };

  const clear = () => {
    setup();
    setEmpty(true);
    onChangeRef.current(null);
  };

  return (
    <div>
      <div className="relative overflow-hidden rounded-xl border border-border-strong bg-white">
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={`${label}（指またはペンで署名してください）`}
          data-testid="signature-pad"
          style={{ height, width: '100%', touchAction: 'none', display: 'block' }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerLeave={onUp}
          onPointerCancel={onUp}
        />
        {empty ? (
          <span className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 text-center text-sm text-neutral-400">
            ここに署名してください
          </span>
        ) : null}
        <span className="pointer-events-none absolute bottom-6 left-6 right-6 border-b border-dashed border-neutral-300" />
      </div>
      <div className="mt-2 flex justify-end">
        <Button size="sm" variant="ghost" icon="undo" onClick={clear} disabled={disabled || empty}>
          書き直す
        </Button>
      </div>
    </div>
  );
}
