import { Palette, Trash2, Undo2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { Button, Label } from '../../../components/shad';
import { Slider } from '../../../components/shad/slider';
import { cx } from '../../../lib/cn';

const WIDTH = 280;
const HEIGHT = 320;
const COLORS = ['#000000', '#EF4444', '#3B82F6', '#22C55E', '#F59E0B', '#8B5CF6', '#EC4899'];

/** Face chart staff draw on: a plain front view (outline, ears, brows, eyes, nose, mouth) */
const FACE_CHART = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}">
  <rect x="112" y="250" width="56" height="70" fill="#fbeee6" stroke="#bdbdbd" stroke-width="0.8"/>
  <ellipse cx="50" cy="128" rx="9" ry="20" fill="#fbeee6" stroke="#bdbdbd" stroke-width="0.8"/>
  <ellipse cx="230" cy="128" rx="9" ry="20" fill="#fbeee6" stroke="#bdbdbd" stroke-width="0.8"/>
  <ellipse cx="140" cy="150" rx="90" ry="122" fill="#fbeee6" stroke="#bdbdbd" stroke-width="0.8"/>
  <path d="M 64 84 Q 100 34 140 32 Q 180 34 216 84" fill="none" stroke="#c4c4c4" stroke-width="0.7"/>
  <path d="M 84 100 Q 101 90 118 97" fill="none" stroke="#a8a8a8" stroke-width="1.4" stroke-linecap="round"/>
  <path d="M 162 97 Q 179 90 196 100" fill="none" stroke="#a8a8a8" stroke-width="1.4" stroke-linecap="round"/>
  <path d="M 82 118 Q 100 104 118 118 Q 100 130 82 118 Z" fill="#ffffff" stroke="#a8a8a8" stroke-width="0.8"/>
  <path d="M 162 118 Q 180 104 198 118 Q 180 130 162 118 Z" fill="#ffffff" stroke="#a8a8a8" stroke-width="0.8"/>
  <circle cx="100" cy="118" r="5.5" fill="#c9c9c9"/>
  <circle cx="180" cy="118" r="5.5" fill="#c9c9c9"/>
  <path d="M 140 128 L 140 160" fill="none" stroke="#d2d2d2" stroke-width="0.6"/>
  <path d="M 128 166 Q 140 174 152 166" fill="none" stroke="#bdbdbd" stroke-width="0.8" stroke-linecap="round"/>
  <path d="M 116 206 Q 140 196 164 206 Q 140 222 116 206 Z" fill="#f3d6cf" stroke="#c4a3a3" stroke-width="0.8"/>
  <path d="M 116 206 L 164 206" fill="none" stroke="#c4a3a3" stroke-width="0.5"/>
</svg>`;

/**
 * フェイス描画: free-hand drawing on the face chart with colour, line width, undo and clear.
 * `onChange` receives the picture (PNG data URL) after every stroke, undo and clear.
 * `initialImage` (a same-origin / blob / data URL) continues an earlier drawing.
 */
export function FaceDrawing({
  onChange,
  initialImage,
  className,
}: {
  onChange?: (dataUrl: string) => void;
  initialImage?: string;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [color, setColor] = useState(COLORS[0]!);
  const [width, setWidth] = useState(3);
  const [step, setStep] = useState(-1);
  const last = useRef<{ x: number; y: number } | null>(null);
  const history = useRef<ImageData[]>([]);
  const index = useRef(-1);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const context = () => canvasRef.current?.getContext('2d') ?? null;

  const resetHistory = useCallback((ctx: CanvasRenderingContext2D) => {
    history.current = [ctx.getImageData(0, 0, WIDTH, HEIGHT)];
    index.current = 0;
    setStep(0);
  }, []);

  const drawImage = useCallback(
    (src: string, revoke: boolean, done?: () => void) => {
      const ctx = context();
      if (!ctx) return;
      const img = new Image();
      img.onload = () => {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, WIDTH, HEIGHT);
        ctx.drawImage(img, 0, 0, WIDTH, HEIGHT);
        if (revoke) URL.revokeObjectURL(src);
        resetHistory(ctx);
        done?.();
      };
      img.onerror = () => {
        if (revoke) URL.revokeObjectURL(src);
      };
      img.src = src;
    },
    [resetHistory],
  );

  const drawChart = useCallback(
    (done?: () => void) => {
      const ctx = context();
      if (!ctx) return;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
      const url = URL.createObjectURL(new Blob([FACE_CHART], { type: 'image/svg+xml;charset=utf-8' }));
      drawImage(url, true, done);
    },
    [drawImage],
  );

  useEffect(() => {
    if (initialImage) drawImage(initialImage, false);
    else drawChart();
  }, [initialImage, drawImage, drawChart]);

  const emit = () => {
    const canvas = canvasRef.current;
    if (canvas) onChangeRef.current?.(canvas.toDataURL('image/png'));
  };

  const commit = () => {
    const ctx = context();
    if (!ctx) return;
    const next = history.current.slice(0, index.current + 1);
    next.push(ctx.getImageData(0, 0, WIDTH, HEIGHT));
    history.current = next;
    index.current = next.length - 1;
    setStep(index.current);
    emit();
  };

  const point = (e: PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (canvas.width / rect.width),
      y: (e.clientY - rect.top) * (canvas.height / rect.height),
    };
  };

  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const ctx = context();
    if (!ctx) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const p = point(e);
    last.current = p;
    ctx.beginPath();
    ctx.arc(p.x, p.y, width / 2, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();
  };

  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!last.current) return;
    e.preventDefault();
    const ctx = context();
    if (!ctx) return;
    const p = point(e);
    ctx.beginPath();
    ctx.moveTo(last.current.x, last.current.y);
    ctx.lineTo(p.x, p.y);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
    last.current = p;
  };

  const endStroke = () => {
    if (!last.current) return;
    last.current = null;
    commit();
  };

  const undo = () => {
    if (index.current <= 0) return;
    const ctx = context();
    if (!ctx) return;
    index.current -= 1;
    ctx.putImageData(history.current[index.current]!, 0, 0);
    setStep(index.current);
    emit();
  };

  const clear = () => drawChart(emit);

  return (
    <div className={cx('sy-3', className)}>
      <div className="relative overflow-hidden rounded-lg border bg-white">
        <canvas
          ref={canvasRef}
          width={WIDTH}
          height={HEIGHT}
          aria-label="フェイス描画"
          data-testid="face-drawing-canvas"
          className="w-full cursor-crosshair touch-none"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endStroke}
          onPointerLeave={endStroke}
          onPointerCancel={endStroke}
        />
      </div>
      <div className="sy-3">
        <div className="flex items-center gap-2">
          <Palette className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
          <div className="flex flex-wrap gap-1">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`色 ${c}`}
                aria-pressed={color === c}
                onClick={() => setColor(c)}
                className={cx(
                  'h-6 w-6 rounded-full border-2 transition-transform',
                  color === c ? 'scale-110 border-primary' : 'border-transparent',
                )}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Label className="w-12 text-xs text-muted-foreground">太さ</Label>
          <Slider label="太さ" value={width} onValueChange={setWidth} min={1} max={10} step={1} className="flex-1" />
          <span className="w-6 text-xs text-muted-foreground">{width}</span>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={undo} disabled={step <= 0} className="flex-1">
            <Undo2 className="mr-1 h-4 w-4" />
            戻す
          </Button>
          <Button variant="outline" size="sm" onClick={clear} className="flex-1">
            <Trash2 className="mr-1 h-4 w-4" />
            クリア
          </Button>
        </div>
      </div>
    </div>
  );
}
