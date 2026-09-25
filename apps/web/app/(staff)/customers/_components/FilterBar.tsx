'use client';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { Search, X } from 'lucide-react';

export interface FilterOptions {
  tags: { id: string; name: string }[];
  staff: { userId: string; displayName: string }[];
  shops: { id: string; name: string }[];
  lifecycles: { value: string; label: string }[];
}

/** URL-driven filter bar for the customer list (search is applied on submit, selects immediately). */
export function FilterBar({ options }: { options: FilterOptions }) {
  const router = useRouter();
  const path = usePathname();
  const sp = useSearchParams();
  const [q, setQ] = useState(sp.get('q') ?? '');
  const [pending, start] = useTransition();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => setQ(sp.get('q') ?? ''), [sp]);

  const push = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) (v ? next.set(k, v) : next.delete(k));
    next.delete('page');
    start(() => router.push(`${path}?${next.toString()}`));
  };
  const sel = (key: string, label: string, items: { value: string; label: string }[]) => (
    <select className="select sm" aria-label={label} value={sp.get(key) ?? ''} onChange={(e) => push({ [key]: e.target.value || null })} style={{ width: 'auto', minWidth: 120 }}>
      <option value="">{label}</option>
      {items.map((i) => <option key={i.value} value={i.value}>{i.label}</option>)}
    </select>
  );
  const active = ['q', 'tag', 'staff', 'lc', 'fav', 'shop'].some((k) => sp.get(k));

  return (
    <div className="crm-filter" aria-busy={pending}>
      <form className="crm-search" onSubmit={(e) => { e.preventDefault(); push({ q: q.trim() || null }); }} role="search">
        <Search size={16} aria-hidden />
        <input ref={input} className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="氏名・フリガナ・電話番号・メールで検索" aria-label="顧客検索" enterKeyHint="search" />
        {q && <button type="button" className="icon-btn" aria-label="クリア" onClick={() => { setQ(''); push({ q: null }); }}><X size={14} /></button>}
        <button className="btn sm" type="submit">検索</button>
      </form>
      <div className="row-wrap">
        {sel('lc', 'ステータス', options.lifecycles)}
        {sel('tag', 'タグ', options.tags.map((t) => ({ value: t.id, label: t.name })))}
        {sel('staff', '担当者', [{ value: 'none', label: '担当なし' }, ...options.staff.map((s) => ({ value: s.userId, label: s.displayName }))])}
        {options.shops.length > 1 && sel('shop', '主店舗', options.shops.map((s) => ({ value: s.id, label: s.name })))}
        <label className="checkbox"><input type="checkbox" checked={sp.get('fav') === '1'} onChange={(e) => push({ fav: e.target.checked ? '1' : null })} />お気に入り</label>
        <span className="spacer" />
        <select className="select sm" aria-label="並び順" value={sp.get('sort') ?? 'lastVisit'} onChange={(e) => push({ sort: e.target.value === 'lastVisit' ? null : e.target.value })} style={{ width: 'auto' }}>
          <option value="lastVisit">最終来店が新しい順</option>
          <option value="ltv">累計売上（LTV）順</option>
          <option value="visits">来店回数順</option>
          <option value="name">フリガナ順</option>
          <option value="created">登録が新しい順</option>
        </select>
        {active && <button type="button" className="btn ghost sm" onClick={() => { setQ(''); start(() => router.push(path)); }}>条件をクリア</button>}
        {pending && <span className="spinner" aria-label="読み込み中" />}
      </div>
    </div>
  );
}
