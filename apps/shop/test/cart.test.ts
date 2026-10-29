import { describe, expect, it } from 'vitest';
import { MAX_QTY, addItem, itemCount, removeItem, setQty, totalMinor } from '../src/cart.js';

describe('cart', () => {
  it('adds items, merges duplicates and caps the quantity', () => {
    let c = addItem([], 'a');
    c = addItem(c, 'b');
    c = addItem(c, 'a');
    expect(c).toEqual([{ productId: 'a', qty: 2 }, { productId: 'b', qty: 1 }]);
    for (let i = 0; i < 30; i++) c = addItem(c, 'a');
    expect(c.find((l) => l.productId === 'a')!.qty).toBe(MAX_QTY);
  });

  it('setQty clamps, floors and removes at zero or below', () => {
    const c = [{ productId: 'a', qty: 3 }];
    expect(setQty(c, 'a', 5)).toEqual([{ productId: 'a', qty: 5 }]);
    expect(setQty(c, 'a', 99)[0]!.qty).toBe(MAX_QTY);
    expect(setQty(c, 'a', 2.9)[0]!.qty).toBe(2);
    expect(setQty(c, 'a', 0)).toEqual([]);
    expect(setQty(c, 'a', -1)).toEqual([]);
    expect(removeItem(c, 'a')).toEqual([]);
  });

  it('totals use integer paise and ignore unknown products', () => {
    const cart = [{ productId: 'a', qty: 2 }, { productId: 'b', qty: 1 }, { productId: 'ghost', qty: 5 }];
    expect(totalMinor(cart, { a: 149_900, b: 34_900 })).toBe(149_900 * 2 + 34_900);
    expect(itemCount(cart)).toBe(8);
    expect(Number.isInteger(totalMinor(cart, { a: 149_900, b: 34_900 }))).toBe(true);
  });
});
