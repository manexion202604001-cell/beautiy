'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Eraser, Pen, Undo2, Trash2, Redo2 } from 'lucide-react';

export interface Stroke { c: string; w: number; e?: boolean; p: [number, number][] }
export interface Sketch { v: 1; bg: 'head' | 'blank'; strokes: Stroke[] }

export const EMPTY_SKETCH: Sketch = { v: 1, bg: 'head', strokes: [] };
const BASE_WIDTH = 800; // stroke widths are stored in px at this canvas width
const ASPECT = 0.62;
const COLORS = ['#1f2937', '#d6334a', '#3f63f5', '#14916a', '#e07b00', '#7a4be0'];
const WIDTHS = [2, 4, 8, 14];

function drawHead(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.save();
  ctx.strokeStyle = '#c3cadb';
  ctx.lineWidth = Math.max(1, w / 500);
  ctx.setLineDash([]);
  const views = [{ cx: 0.2, label: '正面' }, { cx: 0.5, label: '側面' }, { cx: 0.8, label: '後頭部' }];
  ctx.font = `${Math.max(10, w / 70)}px sans-serif`;
  ctx.fillStyle = '#9aa3b8';
  ctx.textAlign = 'center';
  for (const [i, v] of views.entries()) {
    const cx = v.cx * w, cy = h * 0.47, rx = w * 0.095, ry = h * 0.3;
    ctx.beginPath();
    if (i === 1) {
      // side profile: skull + face line + ear
      ctx.ellipse(cx + rx * 0.08, cy - ry * 0.12, rx * 1.02, ry * 0.86, 0, Math.PI * 0.62, Math.PI * 2.28);
      ctx.moveTo(cx - rx * 0.62, cy + ry * 0.5);
      ctx.quadraticCurveTo(cx - rx * 1.0, cy + ry * 0.18, cx - rx * 0.92, cy - ry * 0.08);
      ctx.lineTo(cx - rx * 1.08, cy + ry * 0.12);
      ctx.lineTo(cx - rx * 0.92, cy + ry * 0.2);
      ctx.quadraticCurveTo(cx - rx * 0.9, cy + ry * 0.6, cx - rx * 0.3, cy + ry * 0.78);
      ctx.moveTo(cx + rx * 0.2, cy + ry * 0.02);
      ctx.ellipse(cx + rx * 0.2, cy + ry * 0.05, rx * 0.14, ry * 0.12, 0, 0, Math.PI * 2);
      ctx.moveTo(cx - rx * 0.3, cy + ry * 0.78);
      ctx.lineTo(cx - rx * 0.25, cy + ry * 1.05);
      ctx.moveTo(cx + rx * 0.62, cy + ry * 0.55);
      ctx.lineTo(cx + rx * 0.5, cy + ry * 1.05);
    } else {
      ctx.ellipse(cx, cy - ry * 0.1, rx, ry * 0.88, 0, 0, Math.PI * 2);
      // ears
      ctx.moveTo(cx - rx * 0.98 + rx * 0.12, cy);
      ctx.ellipse(cx - rx * 0.98, cy, rx * 0.12, ry * 0.14, 0, 0, Math.PI * 2);
      ctx.moveTo(cx + rx * 0.98 + rx * 0.12, cy);
      ctx.ellipse(cx + rx * 0.98, cy, rx * 0.12, ry * 0.14, 0, 0, Math.PI * 2);
      // neck
      ctx.moveTo(cx - rx * 0.4, cy + ry * 0.72);
      ctx.lineTo(cx - rx * 0.42, cy + ry * 1.05);
      ctx.moveTo(cx + rx * 0.4, cy + ry * 0.72);
      ctx.lineTo(cx + rx * 0.42, cy + ry * 1.05);
    }
    ctx.stroke();
    if (i === 0) {
      // hairline + center parting guide
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.ellipse(cx, cy - ry * 0.1, rx * 0.78, ry * 0.62, 0, Math.PI * 1.08, Math.PI * 1.92);
      ctx.moveTo(cx, cy - ry * 0.98);
      ctx.lineTo(cx, cy - ry * 0.72);
      ctx.stroke();
      ctx.restore();
    }
    if (i === 2) {
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(cx, cy - ry * 0.98);
      ctx.lineTo(cx, cy + ry * 0.7);
      ctx.moveTo(cx - rx * 0.85, cy + ry * 0.05);
      ctx.quadraticCurveTo(cx, cy + ry * 0.2, cx + rx * 0.85, cy + ry * 0.05);
      ctx.stroke();
      ctx.restore();
    }
    ctx.fillText(v.label, cx, h * 0.96);
  }
  ctx.restore();
}

function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke, w: number, h: number) {
  const scale = w / BASE_WIDTH;
  ctx.save();
  ctx.globalCompositeOperation = s.e ? 'destination-out' : 'source-over';
  ctx.strokeStyle = s.c;
  ctx.fillStyle = s.c;
  ctx.lineWidth = Math.max(0.5, s.w * scale);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (s.p.length === 1) {
    ctx.beginPath();
    ctx.arc(s.p[0][0] * w, s.p[0][1] * h, ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.moveTo(s.p[0][0] * w, s.p[0][1] * h);
    for (let i = 1; i < s.p.length - 1; i++) {
      const mx = ((s.p[i][0] + s.p[i + 1][0]) / 2) * w, my = ((s.p[i][1] + s.p[i + 1][1]) / 2) * h;
      ctx.quadraticCurveTo(s.p[i][0] * w, s.p[i][1] * h, mx, my);
    }
    const last = s.p[s.p.length - 1];
    ctx.lineTo(last[0] * w, last[1] * h);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Sketch canvas for hair/head drawings. Pointer events (mouse, touch, Apple Pencil);
 * strokes are stored normalized (0..1) so the drawing re-renders at any size.
 */
export function SketchCanvas({ value, onChange, readOnly }: { value: Sketch; onChange?: (v: Sketch) => void; readOnly?: boolean }) {
  const wrap = useRef<HTMLDivElement>(null);
  const bgRef = useRef<HTMLCanvasElement>(null);
  const inkRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [color, setColor] = useState(COLORS[0]);
  const [width, setWidth] = useState(WIDTHS[1]);
  const [eraser, setEraser] = useState(false);
  const [redo, setRedo] = useState<Stroke[]>([]);
  const current = useRef<Stroke | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      setSize({ w, h: Math.round(w * ASPECT) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const redraw = useCallback(() => {
    const dpr = window.devicePixelRatio || 1;
    for (const [ref, fn] of [[bgRef, 'bg'], [inkRef, 'ink']] as const) {
      const cv = ref.current;
      if (!cv || !size.w) continue;
      cv.width = Math.round(size.w * dpr);
      cv.height = Math.round(size.h * dpr);
      const ctx = cv.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size.w, size.h);
      if (fn === 'bg') { if (value.bg === 'head') drawHead(ctx, size.w, size.h); }
      else for (const s of value.strokes) drawStroke(ctx, s, size.w, size.h);
    }
  }, [size, value]);
  useEffect(() => { redraw(); }, [redraw]);

  const pt = (e: React.PointerEvent | PointerEvent): [number, number] => {
    const r = inkRef.current!.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  };

  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (readOnly || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    current.current = { c: color, w: eraser ? width * 3 : width, e: eraser || undefined, p: [pt(e)] };
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const s = current.current;
    if (!s) return;
    const events = (e.nativeEvent as PointerEvent).getCoalescedEvents?.() ?? [e.nativeEvent];
    const ctx = inkRef.current!.getContext('2d')!;
    for (const ev of events) {
      const p = pt(ev);
      const prev = s.p[s.p.length - 1];
      if (Math.abs(p[0] - prev[0]) + Math.abs(p[1] - prev[1]) < 0.0015) continue;
      s.p.push(p);
      if (s.p.length > 5000) break;
      drawStroke(ctx, { ...s, p: [prev, p] }, size.w, size.h);
    }
  };
  const up = () => {
    const s = current.current;
    current.current = null;
    if (!s) return;
    setRedo([]);
    onChange?.({ ...value, strokes: [...value.strokes, s] });
  };

  const undo = () => {
    if (!value.strokes.length) return;
    setRedo((r) => [...r, value.strokes[value.strokes.length - 1]]);
    onChange?.({ ...value, strokes: value.strokes.slice(0, -1) });
  };
  const redoOne = () => {
    const s = redo[redo.length - 1];
    if (!s) return;
    setRedo((r) => r.slice(0, -1));
    onChange?.({ ...value, strokes: [...value.strokes, s] });
  };

  return (
    <div className="kt-sketch">
      {!readOnly && (
        <div className="kt-sketch-tools" role="toolbar" aria-label="スケッチツール">
          <div className="seg">
            <button type="button" className={!eraser ? 'active' : ''} onClick={() => setEraser(false)} aria-pressed={!eraser} title="ペン"><Pen size={14} /></button>
            <button type="button" className={eraser ? 'active' : ''} onClick={() => setEraser(true)} aria-pressed={eraser} title="消しゴム"><Eraser size={14} /></button>
          </div>
          <div className="row" style={{ gap: 4 }}>
            {COLORS.map((c) => (
              <button key={c} type="button" className={`kt-swatch ${color === c && !eraser ? 'on' : ''}`} style={{ background: c }} onClick={() => { setColor(c); setEraser(false); }} aria-label={`色 ${c}`} />
            ))}
          </div>
          <div className="row" style={{ gap: 4 }}>
            {WIDTHS.map((w) => (
              <button key={w} type="button" className={`kt-width ${width === w ? 'on' : ''}`} onClick={() => setWidth(w)} aria-label={`太さ ${w}`}><span style={{ width: Math.min(16, w + 2), height: Math.min(16, w + 2) }} /></button>
            ))}
          </div>
          <span className="spacer" />
          <button type="button" className="icon-btn" onClick={undo} disabled={!value.strokes.length} title="元に戻す" aria-label="元に戻す"><Undo2 size={15} /></button>
          <button type="button" className="icon-btn" onClick={redoOne} disabled={!redo.length} title="やり直す" aria-label="やり直す"><Redo2 size={15} /></button>
          <button type="button" className="icon-btn" onClick={() => { if (value.strokes.length && window.confirm('スケッチをすべて消去しますか？')) { setRedo([]); onChange?.({ ...value, strokes: [] }); } }} title="全消去" aria-label="全消去"><Trash2 size={15} /></button>
          <select className="select sm" value={value.bg} onChange={(e) => onChange?.({ ...value, bg: e.target.value as Sketch['bg'] })} style={{ width: 'auto' }} aria-label="下絵">
            <option value="head">頭部の下絵</option>
            <option value="blank">白紙</option>
          </select>
        </div>
      )}
      <div ref={wrap} className="kt-sketch-stage" style={{ height: size.h || undefined }}>
        <canvas ref={bgRef} style={{ width: size.w, height: size.h }} aria-hidden />
        <canvas
          ref={inkRef}
          className="canvas-box"
          style={{ width: size.w, height: size.h, cursor: readOnly ? 'default' : eraser ? 'cell' : 'crosshair' }}
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onLostPointerCapture={up}
          role="img" aria-label="施術スケッチ"
        />
      </div>
    </div>
  );
}
