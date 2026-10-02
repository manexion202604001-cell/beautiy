import { useRef, useCallback } from "react";

const MIN_SWIPE_DISTANCE = 50;

export function useSwipeNavigation(onNavigate: (direction: number) => void) {
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    touchStartRef.current = { x: touch.clientX, y: touch.clientY };
  }, []);

  const onTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      if (!touchStartRef.current) return;
      const touch = e.changedTouches[0];
      const dx = touch.clientX - touchStartRef.current.x;
      const dy = touch.clientY - touchStartRef.current.y;
      touchStartRef.current = null;

      // Ignore if vertical movement is larger (scrolling)
      if (Math.abs(dy) > Math.abs(dx)) return;
      if (Math.abs(dx) < MIN_SWIPE_DISTANCE) return;

      onNavigate(dx < 0 ? 1 : -1);
    },
    [onNavigate]
  );

  return { onTouchStart, onTouchEnd };
}
