import { useEffect, useRef, useState } from 'react';

export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Current time that re-renders every `ms` (calendar "now" line) */
export function useNow(ms = 60_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}

/** A stable value generated once per "session" of a form; call regenerate() after success */
export function useStableKey(factory: () => string): [string, () => void] {
  const ref = useRef<string | null>(null);
  const [, force] = useState(0);
  if (ref.current === null) ref.current = factory();
  return [
    ref.current,
    () => {
      ref.current = factory();
      force((n) => n + 1);
    },
  ];
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false,
  );
  useEffect(() => {
    if (!window.matchMedia) return;
    const m = window.matchMedia(query);
    const on = () => setMatches(m.matches);
    on();
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [query]);
  return matches;
}

/** Scroll an element (e.g. an error alert at the top of a drawer) into view whenever `trigger` becomes truthy */
export function useRevealOnChange<T extends HTMLElement>(trigger: unknown) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (trigger) ref.current?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
  }, [trigger]);
  return ref;
}
