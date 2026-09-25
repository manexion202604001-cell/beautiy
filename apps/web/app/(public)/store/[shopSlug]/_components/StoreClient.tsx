'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Check, ShoppingCart } from 'lucide-react';
import { addToCart, setRec, useCart } from './cart';

/** Header cart link with item count; also captures ?rec=<token> attribution on any store page. */
export function CartLink({ slug }: { slug: string }) {
  const [cart] = useCart(slug);
  useEffect(() => {
    const rec = new URLSearchParams(window.location.search).get('rec');
    if (rec && /^[\w-]{6,64}$/.test(rec)) setRec(slug, rec);
  }, [slug]);
  const n = cart?.items.reduce((a, i) => a + i.quantity, 0) ?? 0;
  return (
    <Link href={`/store/${slug}/cart`} className="btn secondary cart-pill" aria-label={`カート（${n}点）`}>
      <ShoppingCart size={16} />カート{n > 0 && <span className="count">{n}</span>}
    </Link>
  );
}

export function AddToCartButton({ slug, productId, disabled, withQty, block, goToCart }: { slug: string; productId: string; disabled?: boolean; withQty?: boolean; block?: boolean; goToCart?: boolean }) {
  const [qty, setQty] = useState(1);
  const [done, setDone] = useState(false);
  const router = useRouter();
  const add = () => {
    addToCart(slug, productId, qty);
    setDone(true);
    setTimeout(() => setDone(false), 1400);
    if (goToCart) router.push(`/store/${slug}/cart`);
  };
  return (
    <div className="row" style={{ gap: 8 }}>
      {withQty && (
        <select className="select" style={{ width: 84 }} value={qty} onChange={(e) => setQty(Number(e.target.value))} aria-label="数量" disabled={disabled}>
          {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      )}
      <button type="button" className={`btn ${block ? 'block' : 'sm'}`} onClick={add} disabled={disabled}>
        {disabled ? '在庫切れ' : done ? <><Check size={15} />追加しました</> : 'カートに入れる'}
      </button>
    </div>
  );
}
