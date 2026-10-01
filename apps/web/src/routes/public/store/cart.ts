import { useCallback, useEffect, useState } from 'react';
import { storageGet, storageGetJson, storageSet, storageSetJson } from '../../../lib/storage';

/**
 * EC cart persisted per shop in localStorage (all access wrapped in try/catch by lib/storage —
 * private mode / LINE in-app browser fall back to an in-memory cart for the page lifetime).
 */
export interface CartItem {
  productId: string;
  name: string;
  /** tax-inclusive unit price at the time it was added (the API re-prices on order) */
  price: number;
  image?: string | null;
  quantity: number;
}

export interface Cart {
  items: CartItem[];
  /** Idempotency key of an order being placed (kept across reloads to avoid duplicate orders) */
  pendingOrderKey?: string | null;
}

export const MAX_QTY = 99;
export const MAX_LINES = 50;

const key = (slug: string) => `salon.cart.${slug}`;
const memory = new Map<string, Cart>();

export function emptyCart(): Cart {
  return { items: [], pendingOrderKey: null };
}

function sanitize(raw: unknown): Cart {
  const c = (raw ?? {}) as Partial<Cart>;
  const items = Array.isArray(c.items)
    ? c.items
        .filter(
          (i): i is CartItem =>
            !!i && typeof i.productId === 'string' && typeof i.name === 'string',
        )
        .map((i) => ({
          productId: i.productId,
          name: i.name,
          price: Number.isFinite(i.price) ? Math.max(0, Math.round(i.price)) : 0,
          image: i.image ?? null,
          quantity: Math.min(MAX_QTY, Math.max(1, Math.floor(Number(i.quantity) || 1))),
        }))
        .slice(0, MAX_LINES)
    : [];
  return {
    items,
    pendingOrderKey: typeof c.pendingOrderKey === 'string' ? c.pendingOrderKey : null,
  };
}

export function loadCart(slug: string): Cart {
  const stored = storageGetJson<Cart>(key(slug));
  if (stored) return sanitize(stored);
  return memory.get(slug) ?? emptyCart();
}

export function saveCart(slug: string, cart: Cart): void {
  memory.set(slug, cart);
  storageSetJson(key(slug), cart.items.length || cart.pendingOrderKey ? cart : null);
  window.dispatchEvent(new CustomEvent('salon-cart', { detail: slug }));
}

export function addItem(cart: Cart, item: Omit<CartItem, 'quantity'>, quantity = 1): Cart {
  const existing = cart.items.find((i) => i.productId === item.productId);
  if (existing) {
    return {
      ...cart,
      items: cart.items.map((i) =>
        i.productId === item.productId
          ? { ...i, ...item, quantity: Math.min(MAX_QTY, i.quantity + quantity) }
          : i,
      ),
    };
  }
  if (cart.items.length >= MAX_LINES) return cart;
  return {
    ...cart,
    items: [...cart.items, { ...item, quantity: Math.min(MAX_QTY, Math.max(1, quantity)) }],
  };
}

export function setQuantity(cart: Cart, productId: string, quantity: number): Cart {
  if (quantity <= 0) return removeItem(cart, productId);
  return {
    ...cart,
    items: cart.items.map((i) =>
      i.productId === productId ? { ...i, quantity: Math.min(MAX_QTY, Math.floor(quantity)) } : i,
    ),
  };
}

export function removeItem(cart: Cart, productId: string): Cart {
  return { ...cart, items: cart.items.filter((i) => i.productId !== productId) };
}

export function cartCount(cart: Cart): number {
  return cart.items.reduce((s, i) => s + i.quantity, 0);
}

/** Item subtotal (tax-inclusive; shipping is calculated by the API when the order is placed) */
export function cartSubtotal(cart: Cart): number {
  return cart.items.reduce((s, i) => s + i.price * i.quantity, 0);
}

export function orderItems(cart: Cart): { productId: string; quantity: number }[] {
  return cart.items.map((i) => ({ productId: i.productId, quantity: i.quantity }));
}

// ------------------------------------------------------------ store context (slug / referral)

const LAST_STORE = 'salon.lastStoreSlug';
const REF = 'salon.storeRef';

export function rememberStore(slug: string) {
  storageSet(LAST_STORE, slug);
}

export function lastStore(): string | null {
  return storageGet(LAST_STORE);
}

/** Referral code from a shared product link (?ref=CODE), kept for attribution at checkout */
export function captureRef(search: string) {
  try {
    const ref = new URLSearchParams(search).get('ref');
    if (ref && /^[A-Za-z0-9_-]{4,50}$/.test(ref)) storageSet(REF, ref);
  } catch {
    /* ignore */
  }
}

export function storedRef(): string | null {
  return storageGet(REF);
}

export function clearRef() {
  storageSet(REF, null);
}

/** React hook: cart state for a shop, synced across components / tabs */
export function useCart(slug: string) {
  const [cart, setCart] = useState<Cart>(() => (slug ? loadCart(slug) : emptyCart()));
  useEffect(() => {
    if (!slug) return;
    setCart(loadCart(slug));
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      if (!detail || detail === slug) setCart(loadCart(slug));
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === key(slug)) setCart(loadCart(slug));
    };
    window.addEventListener('salon-cart', onChange);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('salon-cart', onChange);
      window.removeEventListener('storage', onStorage);
    };
  }, [slug]);
  const update = useCallback(
    (fn: (c: Cart) => Cart) => {
      const next = fn(loadCart(slug));
      saveCart(slug, next);
      setCart(next);
    },
    [slug],
  );
  return { cart, update };
}
