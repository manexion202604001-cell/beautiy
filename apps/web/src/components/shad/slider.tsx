/**
 * shadcn/ui Slider (new-york), written for Tailwind 4: a single-thumb range slider
 * (role=slider) driven by pointer and keyboard.
 */
import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { cx as cn } from '../../lib/cn';

export function Slider({
  value,
  onValueChange,
  min = 0,
  max = 100,
  step = 1,
  className,
  label,
  disabled,
}: {
  value: number;
  onValueChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  className?: string;
  label?: string;
  disabled?: boolean;
}) {
  const track = useRef<HTMLSpanElement>(null);
  const dragging = useRef(false);
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const snap = (v: number) => clamp(Math.round((v - min) / step) * step + min);
  const percent = max > min ? ((clamp(value) - min) / (max - min)) * 100 : 0;

  const fromPointer = (clientX: number) => {
    const el = track.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    const next = snap(min + ((clientX - rect.left) / rect.width) * (max - min));
    if (next !== value) onValueChange(next);
  };
  const onPointerDown = (e: PointerEvent<HTMLSpanElement>) => {
    if (disabled) return;
    dragging.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    fromPointer(e.clientX);
  };
  const onPointerMove = (e: PointerEvent<HTMLSpanElement>) => {
    if (dragging.current) fromPointer(e.clientX);
  };
  const onPointerUp = () => {
    dragging.current = false;
  };
  const onKeyDown = (e: KeyboardEvent<HTMLSpanElement>) => {
    if (disabled) return;
    let next: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = snap(value + step);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = snap(value - step);
    else if (e.key === 'Home') next = min;
    else if (e.key === 'End') next = max;
    if (next === null) return;
    e.preventDefault();
    if (next !== value) onValueChange(next);
  };

  return (
    <span
      data-disabled={disabled ? '' : undefined}
      className={cn('relative flex w-full touch-none select-none items-center', className)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <span ref={track} className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-primary/20">
        <span className="absolute h-full bg-primary" style={{ left: 0, right: `${100 - percent}%` }} />
      </span>
      <span
        className="absolute"
        style={{ left: `calc(${percent}% + ${8 - (percent / 100) * 16}px)`, transform: 'translateX(-50%)' }}
      >
        <span
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-label={label}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={value}
          aria-orientation="horizontal"
          aria-disabled={disabled || undefined}
          onKeyDown={onKeyDown}
          className="block h-4 w-4 rounded-full border border-primary/50 bg-background shadow-sm transition-colors focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
        />
      </span>
    </span>
  );
}
