'use client';
import { useTransition } from 'react';
import { useRouter } from 'next/navigation';

export function ShopSwitcher({ shops, current, action }: { shops: { id: string; name: string }[]; current: string; action: (shopId: string) => Promise<void> }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  if (shops.length <= 1) return <span className="badge blue">{shops[0]?.name}</span>;
  return (
    <select
      className="select sm" style={{ width: 'auto', minWidth: 140 }} value={current} disabled={pending} aria-label="店舗切替"
      onChange={(e) => start(async () => { await action(e.target.value); router.refresh(); })}
    >
      {shops.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
    </select>
  );
}
