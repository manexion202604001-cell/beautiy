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
  <!-- Skin base -->
  <path d="M 140 28 C 190 28, 225 65, 228 115 C 230 150, 225 180, 210 210 C 200 230, 180 252, 165 262 C 155 268, 148 270, 140 270 C 132 270, 125 268, 115 262 C 100 252, 80 230, 70 210 C 55 180, 50 150, 52 115 C 55 65, 90 28, 140 28 Z" fill="#fdf0e8" stroke="#bbb" stroke-width="0.8"/>

  <!-- Neck -->
  <path d="M 112 268 C 112 280, 108 295, 105 310" fill="none" stroke="#bbb" stroke-width="0.8"/>
  <path d="M 168 268 C 168 280, 172 295, 175 310" fill="none" stroke="#bbb" stroke-width="0.8"/>
  <path d="M 105 310 L 175 310" fill="#fdf0e8" stroke="none"/>
  <rect x="105" y="268" width="70" height="52" fill="#fdf0e8" stroke="none"/>

  <!-- Ears -->
  <path d="M 52 110 C 42 100, 38 110, 38 120 C 38 130, 40 140, 48 145 C 50 140, 52 135, 52 130" fill="#fdf0e8" stroke="#bbb" stroke-width="0.8"/>
  <path d="M 228 110 C 238 100, 242 110, 242 120 C 242 130, 240 140, 232 145 C 230 140, 228 135, 228 130" fill="#fdf0e8" stroke="#bbb" stroke-width="0.8"/>

  <!-- Hair wisps -->
  <path d="M 80 38 C 85 28, 100 18, 120 20 C 125 20, 130 22, 135 25" fill="none" stroke="#c0c0c0" stroke-width="0.6"/>
  <path d="M 70 48 C 78 32, 95 22, 115 22" fill="none" stroke="#c0c0c0" stroke-width="0.6"/>
  <path d="M 200 38 C 195 28, 180 18, 160 20 C 155 20, 150 22, 145 25" fill="none" stroke="#c0c0c0" stroke-width="0.6"/>
  <path d="M 210 48 C 202 32, 185 22, 165 22" fill="none" stroke="#c0c0c0" stroke-width="0.6"/>
  <path d="M 62 62 C 68 42, 82 30, 100 26" fill="none" stroke="#c0c0c0" stroke-width="0.6"/>
  <path d="M 218 62 C 212 42, 198 30, 180 26" fill="none" stroke="#c0c0c0" stroke-width="0.6"/>

  <!-- Eyebrows -->
  <path d="M 82 95 C 88 88, 98 86, 108 87 C 112 88, 115 89, 118 91" fill="none" stroke="#aaa" stroke-width="1.2" stroke-linecap="round"/>
  <path d="M 198 95 C 192 88, 182 86, 172 87 C 168 88, 165 89, 162 91" fill="none" stroke="#aaa" stroke-width="1.2" stroke-linecap="round"/>

  <!-- Eyes - left -->
  <path d="M 82 112 C 86 104, 96 100, 106 102 C 112 103, 117 107, 118 112" fill="none" stroke="#aaa" stroke-width="0.8"/>
  <path d="M 82 112 C 86 118, 96 122, 106 120 C 112 119, 117 116, 118 112" fill="none" stroke="#aaa" stroke-width="0.8"/>
  <circle cx="100" cy="112" r="6" fill="#d5d5d5" stroke="#aaa" stroke-width="0.5"/>
  <circle cx="100" cy="112" r="3.5" fill="#bbb"/>
  <circle cx="101.5" cy="110" r="1.2" fill="white" opacity="0.7"/>
  <!-- Left eyelashes -->
  <path d="M 84 108 C 82 104, 80 102, 78 101" fill="none" stroke="#aaa" stroke-width="0.6" stroke-linecap="round"/>
  <path d="M 87 106 C 86 102, 84 99, 82 97" fill="none" stroke="#aaa" stroke-width="0.6" stroke-linecap="round"/>
  <path d="M 91 104 C 90 100, 89 97, 88 95" fill="none" stroke="#aaa" stroke-width="0.6" stroke-linecap="round"/>
  <path d="M 96 102 C 96 98, 96 95, 95 93" fill="none" stroke="#aaa" stroke-width="0.6" stroke-linecap="round"/>
  <path d="M 102 101 C 103 97, 104 94, 104 92" fill="none" stroke="#aaa" stroke-width="0.6" stroke-linecap="round"/>
  <path d="M 108 102 C 110 98, 112 96, 113 94" fill="none" stroke="#aaa" stroke-width="0.6" stroke-linecap="round"/>
  <path d="M 113 105 C 116 102, 118 100, 120 98" fill="none" stroke="#aaa" stroke-width="0.6" stroke-linecap="round"/>
  <path d="M 116 108 C 119 106, 122 104, 124 103" fill="none" stroke="#aaa" stroke-width="0.6" stroke-linecap="round"/>

  <!-- Eyes - right -->
  <path d="M 162 112 C 163 104, 173 100, 183 102 C 189 103, 194 107, 198 112" fill="none" stroke="#aaa" stroke-width="0.8"/>
  <path d="M 162 112 C 163 118, 173 122, 183 120 C 189 119, 194 116, 198 112" fill="none" stroke="#aaa" stroke-width="0.8"/>
  <circle cx="180" cy="112" r="6" fill="#d5d5d5" stroke="#aaa" stroke-width="0.5"/>
  <circle cx="180" cy="112" r="3.5" fill="#bbb"/>
  <circle cx="181.5" cy="110" r="1.2" fill="white" opacity="0.7"/>
  <!-- Right eyelashes -->
  <path d="M 196 108 C 198 104, 200 102, 202 101" fill="none" stroke="#aaa" stroke-width="0.6" stroke-linecap="round"/>
  <path d="M 193 106 C 194 102, 196 99, 198 97" fill="none" stroke="#aaa" stroke-width="0.6" stroke-linecap="round"/>
  <path d="M 189 104 C 190 100, 191 97, 192 95" fill="none" stroke="#aaa" stroke-width="0.6" stroke-linecap="round"/>
  <path d="M 184 102 C 184 98, 184 95, 185 93" fill="none" stroke="#aaa" stroke-width="0.6" stroke-linecap="round"/>
  <path d="M 178 101 C 177 97, 176 94, 176 92" fill="none" stroke="#aaa" stroke-width="0.6" stroke-linecap="round"/>
  <path d="M 172 102 C 170 98, 168 96, 167 94" fill="none" stroke="#aaa" stroke-width="0.6" stroke-linecap="round"/>
  <path d="M 167 105 C 164 102, 162 100, 160 98" fill="none" stroke="#aaa" stroke-width="0.6" stroke-linecap="round"/>
  <path d="M 164 108 C 161 106, 158 104, 156 103" fill="none" stroke="#aaa" stroke-width="0.6" stroke-linecap="round"/>

  <!-- Nose -->
  <path d="M 136 148 C 134 150, 132 151, 130 150" fill="none" stroke="#bbb" stroke-width="0.7" stroke-linecap="round"/>
  <path d="M 144 148 C 146 150, 148 151, 150 150" fill="none" stroke="#bbb" stroke-width="0.7" stroke-linecap="round"/>

  <!-- Lips -->
  <path d="M 118 192 C 122 186, 130 182, 140 182 C 150 182, 158 186, 162 192" fill="#f5ddd5" stroke="#c0a0a0" stroke-width="0.7"/>
  <path d="M 118 192 C 122 200, 130 204, 140 204 C 150 204, 158 200, 162 192" fill="#f0d0c8" stroke="#c0a0a0" stroke-width="0.7"/>
  <path d="M 118 192 L 162 192" fill="none" stroke="#c0a0a0" stroke-width="0.5"/>
  <!-- Cupid's bow -->
  <path d="M 130 182 C 133 179, 137 178, 140 180 C 143 178, 147 179, 150 182" fill="none" stroke="#c0a0a0" stroke-width="0.5"/>
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
            onValueChange={(v) => setBrushSize(v[0])}
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
