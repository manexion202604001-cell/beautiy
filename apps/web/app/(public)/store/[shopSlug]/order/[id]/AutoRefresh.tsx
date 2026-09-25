'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export function AutoRefresh({ seconds, max = 15 }: { seconds: number; max?: number }) {
  const router = useRouter();
  useEffect(() => {
    let n = 0;
    const t = setInterval(() => { if (++n > max) clearInterval(t); else router.refresh(); }, seconds * 1000);
    return () => clearInterval(t);
  }, [router, seconds, max]);
  return null;
}
