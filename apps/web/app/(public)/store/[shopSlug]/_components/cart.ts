'use client';
// Cart state lives in localStorage per shop; server re-validates everything at checkout.
import { useEffect, useState } from 'react';

export interface CartItem { productId: string; quantity: number }
export interface Cart { items: CartItem[]; rec?: string | null; recAt?: number; subscribe?: boolean }

const REC_TTL = 30 * 86400000;
const EVT = 'salonos-cart';
const key = (slug: string) => `salonos-cart:${slug}`;

export function readCart(slug: string): Cart {
  try {
    const raw = window.localStorage.getItem(key(slug));
    if (!raw) return { items: [] };
    const c = JSON.parse(raw) as Cart;
    const items = Array.isArray(c.items) ? c.items.filter((i) => typeof i.productId === 'string' && Number.isInteger(i.quantity) && i.quantity > 0).map((i) => ({ productId: i.productId, quantity: Math.min(99, i.quantity) })) : [];
    const recValid = c.rec && c.recAt && Date.now() - c.recAt < REC_TTL;
    return { items, rec: recValid ? c.rec : null, recAt: recValid ? c.recAt : undefined, subscribe: !!c.subscribe };
  } catch { return { items: [] }; }
}

export function writeCart(slug: string, cart: Cart) {
  try { window.localStorage.setItem(key(slug), JSON.stringify(cart)); } catch { /* storage full / disabled */ }
  window.dispatchEvent(new CustomEvent(EVT, { detail: slug }));
}

export function addToCart(slug: string, productId: string, quantity = 1, rec?: string | null) {
  const c = readCart(slug);
  const ex = c.items.find((i) => i.productId === productId);
  if (ex) ex.quantity = Math.min(99, ex.quantity + quantity); else c.items.push({ productId, quantity: Math.min(99, quantity) });
  if (rec) { c.rec = rec; c.recAt = Date.now(); }
  writeCart(slug, c);
}

export function setRec(slug: string, rec: string) {
  const c = readCart(slug);
  writeCart(slug, { ...c, rec, recAt: Date.now() });
}

export function useCart(slug: string): [Cart | null, (c: Cart) => void] {
  const [cart, setCart] = useState<Cart | null>(null);
  useEffect(() => {
    const load = () => setCart(readCart(slug));
    load();
    const h = (e: Event) => { if ((e as CustomEvent).detail === slug) load(); };
    const s = (e: StorageEvent) => { if (e.key === key(slug)) load(); };
    window.addEventListener(EVT, h);
    window.addEventListener('storage', s);
    return () => { window.removeEventListener(EVT, h); window.removeEventListener('storage', s); };
  }, [slug]);
  return [cart, (c: Cart) => writeCart(slug, c)];
}
