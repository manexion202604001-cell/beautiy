import { useCallback, useState } from 'react';
import { storageGet, storageSet } from './storage';

export type ThemePref = 'system' | 'light' | 'dark';
const KEY = 'salon.theme';

function apply(pref: ThemePref) {
  const root = document.documentElement;
  if (pref === 'system') delete root.dataset.theme;
  else root.dataset.theme = pref;
}

export function useTheme() {
  const [pref, setPref] = useState<ThemePref>(() => {
    const v = storageGet(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  });
  const set = useCallback((p: ThemePref) => {
    setPref(p);
    storageSet(KEY, p === 'system' ? null : p);
    apply(p);
  }, []);
  const isDark =
    pref === 'dark' ||
    (pref === 'system' &&
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  return { pref, set, isDark };
}
