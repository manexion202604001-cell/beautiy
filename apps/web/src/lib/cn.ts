import { twMerge } from 'tailwind-merge';

/** Tiny className joiner (falsy values are skipped) */
export function cn(...parts: (string | false | null | undefined | 0)[]): string {
  return parts.filter(Boolean).join(' ');
}


/**
 * className joiner that also resolves conflicting Tailwind utilities (the later one wins), as
 * shadcn/ui components expect: `cx('h-9 px-4', 'h-8')` → 'px-4 h-8'. Used by the ported screens.
 */
export function cx(...parts: (string | false | null | undefined | 0)[]): string {
  return twMerge(cn(...parts));
}
