"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import { Undo2, Trash2, Palette } from "lucide-react";
import { cn } from "@/lib/utils";

type FaceCanvasProps = {
  onSave?: (dataUrl: string) => void;
  initialImage?: string;
  className?: string;
};

const COLORS = [
  "#000000", // Black
  "#EF4444", // Red
  "#3B82F6", // Blue
  "#22C55E", // Green
  "#F59E0B", // Orange
  "#8B5CF6", // Purple
  "#EC4899", // Pink
];

// Face chart SVG - salon/beauty style
const FACE_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 280 320" width="280" height="320">
  <!-- Plain outline template: face contour and neck only. Facial features and skin fill are
       intentionally omitted so the drawing itself carries all the information. -->

  <!-- Neck -->
  <path d="M 114 254 L 114 320" fill="none" stroke="#c9beb5" stroke-width="1.4" stroke-linecap="round"/>
  <path d="M 166 254 L 166 320" fill="none" stroke="#c9beb5" stroke-width="1.4" stroke-linecap="round"/>

  <!-- Face outline -->
  <path d="M 140 40 C 196 40, 232 84, 232 136 C 232 180, 218 216, 196 238 C 180 254, 160 262, 140 262 C 120 262, 100 254, 84 238 C 62 216, 48 180, 48 136 C 48 84, 84 40, 140 40 Z" fill="none" stroke="#c9beb5" stroke-width="1.6"/>

  <!-- Nose: kept as the single feature so eye/lash placement has a reference point -->
  <path d="M 140 132 L 140 162 C 140 167, 135 169, 131 166" fill="none" stroke="#cfc4bb" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`;

export function FaceCanvas({ onSave, initialImage, className }: FaceCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [color, setColor] = useState("#000000");
  const [brushSize, setBrushSize] = useState(3);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const lastPosRef = useRef<{ x: number; y: number } | null>(null);
  const isDrawingRef = useRef(false);
  const historyRef = useRef<ImageData[]>([]);
  const historyIndexRef = useRef(-1);
  const colorRef = useRef(color);
  const brushSizeRef = useRef(brushSize);
  const onSaveRef = useRef(onSave);

  // Keep refs in sync
  colorRef.current = color;
  brushSizeRef.current = brushSize;
  onSaveRef.current = onSave;

  const saveHistory = useCallback((canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) => {
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const newHistory = historyRef.current.slice(0, historyIndexRef.current + 1);
    newHistory.push(imageData);
    historyRef.current = newHistory;
    historyIndexRef.current = newHistory.length - 1;
    setHistoryIndex(historyIndexRef.current);

    if (onSaveRef.current) {
      onSaveRef.current(canvas.toDataURL("image/png"));
    }
  }, []);

  // Initialize canvas with face image
  const initCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const img = new Image();
    const svgBlob = new Blob([FACE_SVG], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(svgBlob);

    img.onload = () => {
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);

      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      historyRef.current = [imageData];
      historyIndexRef.current = 0;
      setHistoryIndex(0);
    };

    img.src = url;
  }, []);

  // Load initial image if provided
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    if (initialImage) {
      const img = new Image();
      img.onload = () => {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0);

        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        historyRef.current = [imageData];
        historyIndexRef.current = 0;
        setHistoryIndex(0);
      };
      img.src = initialImage;
    } else {
      initCanvas();
    }
  }, [initialImage, initCanvas]);

  // Add native touch event listeners with passive: false
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleTouchStart = (e: TouchEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const touch = e.touches[0];
      const pos = {
        x: (touch.clientX - rect.left) * scaleX,
        y: (touch.clientY - rect.top) * scaleY,
      };

      isDrawingRef.current = true;
      lastPosRef.current = pos;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      ctx.beginPath();
      ctx.arc(pos.x, pos.y, brushSizeRef.current / 2, 0, Math.PI * 2);
      ctx.fillStyle = colorRef.current;
      ctx.fill();
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (!lastPosRef.current) return;
      e.preventDefault();

      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const touch = e.touches[0];
      const pos = {
        x: (touch.clientX - rect.left) * scaleX,
        y: (touch.clientY - rect.top) * scaleY,
      };

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      ctx.beginPath();
      ctx.moveTo(lastPosRef.current.x, lastPosRef.current.y);
      ctx.lineTo(pos.x, pos.y);
      ctx.strokeStyle = colorRef.current;
      ctx.lineWidth = brushSizeRef.current;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke();

      lastPosRef.current = pos;
    };

    const handleTouchEnd = () => {
      if (!lastPosRef.current) return;
      isDrawingRef.current = false;
      lastPosRef.current = null;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      saveHistory(canvas, ctx);
    };

    canvas.addEventListener("touchstart", handleTouchStart, { passive: false });
    canvas.addEventListener("touchmove", handleTouchMove, { passive: false });
    canvas.addEventListener("touchend", handleTouchEnd);

    return () => {
      canvas.removeEventListener("touchstart", handleTouchStart);
      canvas.removeEventListener("touchmove", handleTouchMove);
      canvas.removeEventListener("touchend", handleTouchEnd);
    };
  }, [saveHistory]);

  // Get position from mouse event
  const getPosition = (e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  };

  const startDrawing = (e: React.MouseEvent) => {
    e.preventDefault();
    const pos = getPosition(e);
    if (!pos) return;

    isDrawingRef.current = true;
    lastPosRef.current = pos;

    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!ctx) return;

    ctx.beginPath();
    ctx.arc(pos.x, pos.y, brushSize / 2, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  };

  const draw = (e: React.MouseEvent) => {
    if (!isDrawingRef.current) return;
    e.preventDefault();

    const pos = getPosition(e);
    if (!pos || !lastPosRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!ctx) return;

    ctx.beginPath();
    ctx.moveTo(lastPosRef.current.x, lastPosRef.current.y);
    ctx.lineTo(pos.x, pos.y);
    ctx.strokeStyle = color;
    ctx.lineWidth = brushSize;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();

    lastPosRef.current = pos;
  };

  const stopDrawing = () => {
    if (!isDrawingRef.current) return;
    isDrawingRef.current = false;
    lastPosRef.current = null;

    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!ctx || !canvas) return;

    saveHistory(canvas, ctx);
  };

  const undo = () => {
    if (historyIndexRef.current <= 0) return;

    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!ctx) return;

    const newIndex = historyIndexRef.current - 1;
    ctx.putImageData(historyRef.current[newIndex], 0, 0);
    historyIndexRef.current = newIndex;
    setHistoryIndex(newIndex);

    if (onSave && canvas) {
      onSave(canvas.toDataURL("image/png"));
    }
  };

  const clear = () => {
    initCanvas();
    if (onSave) {
      const canvas = canvasRef.current;
      if (canvas) {
        setTimeout(() => {
          onSave(canvas.toDataURL("image/png"));
        }, 100);
      }
    }
  };

  return (
    <div className={cn("space-y-3", className)}>
      {/* Canvas */}
      <div className="relative border rounded-lg overflow-hidden bg-white">
        <canvas
          ref={canvasRef}
          width={280}
          height={320}
          className="w-full touch-none cursor-crosshair"
          onMouseDown={startDrawing}
          onMouseMove={draw}
          onMouseUp={stopDrawing}
          onMouseLeave={stopDrawing}
        />
      </div>

      {/* Controls */}
      <div className="space-y-3">
        {/* Color picker */}
        <div className="flex items-center gap-2">
          <Palette className="h-4 w-4 text-muted-foreground flex-shrink-0" />
          <div className="flex gap-1 flex-wrap">
            {COLORS.map((c) => (
              <button
                key={c}
                onClick={() => setColor(c)}
                className={cn(
                  "w-6 h-6 rounded-full border-2 transition-transform",
                  color === c ? "border-primary scale-110" : "border-transparent"
                )}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </div>

        {/* Brush size */}
        <div className="flex items-center gap-3">
          <Label className="text-xs text-muted-foreground w-12">太さ</Label>
          <Slider
            value={[brushSize]}
            onValueChange={(v: number[]) => setBrushSize(v[0])}
            min={1}
            max={10}
            step={1}
            className="flex-1"
          />
          <span className="text-xs text-muted-foreground w-6">{brushSize}</span>
        </div>

        {/* Action buttons */}
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={undo}
            disabled={historyIndex <= 0}
            className="flex-1"
          >
            <Undo2 className="h-4 w-4 mr-1" />
            戻す
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={clear}
            className="flex-1"
          >
            <Trash2 className="h-4 w-4 mr-1" />
            クリア
          </Button>
        </div>
      </div>
    </div>
  );
}
