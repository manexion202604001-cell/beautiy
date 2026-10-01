import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_QTY,
  addItem,
  captureRef,
  cartCount,
  cartSubtotal,
  emptyCart,
  loadCart,
  orderItems,
  removeItem,
  saveCart,
  setQuantity,
  storedRef,
} from './cart';

const shampoo = { productId: 'p1', name: 'シャンプー', price: 3300 };
const oil = { productId: 'p2', name: 'ヘアオイル', price: 2750 };

describe('cart operations', () => {
  it('adds, merges and caps quantities', () => {
    let c = addItem(emptyCart(), shampoo);
    c = addItem(c, oil, 2);
    c = addItem(c, shampoo, 2);
    expect(c.items).toHaveLength(2);
    expect(c.items[0]!.quantity).toBe(3);
    expect(cartCount(c)).toBe(5);
    expect(cartSubtotal(c)).toBe(3300 * 3 + 2750 * 2);
    c = addItem(c, shampoo, 500);
    expect(c.items[0]!.quantity).toBe(MAX_QTY);
  });

  it('sets quantity and removes at zero', () => {
    let c = addItem(addItem(emptyCart(), shampoo), oil);
    c = setQuantity(c, 'p2', 4);
    expect(c.items.find((i) => i.productId === 'p2')!.quantity).toBe(4);
    c = setQuantity(c, 'p2', 0);
    expect(c.items.map((i) => i.productId)).toEqual(['p1']);
    c = removeItem(c, 'p1');
    expect(c.items).toEqual([]);
  });

  it('builds the order payload', () => {
    const c = addItem(addItem(emptyCart(), shampoo, 2), oil);
    expect(orderItems(c)).toEqual([
      { productId: 'p1', quantity: 2 },
      { productId: 'p2', quantity: 1 },
    ]);
  });
});

describe('cart persistence', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('round-trips through localStorage per shop', () => {
    saveCart('shibuya', { ...addItem(emptyCart(), shampoo, 2), pendingOrderKey: 'k-123' });
    expect(loadCart('shibuya')).toEqual({
      items: [{ ...shampoo, image: null, quantity: 2 }],
      pendingOrderKey: 'k-123',
    });
    expect(loadCart('omotesando').items).toEqual([]);
  });

  it('sanitizes corrupted data', () => {
    window.localStorage.setItem(
      'salon.cart.x',
      JSON.stringify({
        items: [{ productId: 'a', name: 'A', price: -5, quantity: 1000 }, { bogus: true }],
      }),
    );
    expect(loadCart('x').items).toEqual([
      { productId: 'a', name: 'A', price: 0, image: null, quantity: MAX_QTY },
    ]);
    window.localStorage.setItem('salon.cart.y', '{not json');
    expect(loadCart('y')).toEqual(emptyCart());
  });

  it('falls back to memory when localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(() => saveCart('mem', addItem(emptyCart(), oil))).not.toThrow();
    expect(loadCart('mem').items[0]!.productId).toBe('p2');
  });

  it('captures referral codes from the query string', () => {
    captureRef('?ref=ABCD1234&utm_source=line');
    expect(storedRef()).toBe('ABCD1234');
    captureRef('?ref=<script>');
    expect(storedRef()).toBe('ABCD1234');
  });
});
