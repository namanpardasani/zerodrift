/** Pure cart logic (no React) so it is trivial to test. Prices shown here are for display only: the server prices the order. */
export interface CartLine {
  productId: string;
  qty: number;
}

export const MAX_QTY = 10;

export function addItem(cart: CartLine[], productId: string): CartLine[] {
  const existing = cart.find((l) => l.productId === productId);
  if (!existing) return [...cart, { productId, qty: 1 }];
  return cart.map((l) => (l.productId === productId ? { ...l, qty: Math.min(MAX_QTY, l.qty + 1) } : l));
}

export function setQty(cart: CartLine[], productId: string, qty: number): CartLine[] {
  if (qty <= 0) return cart.filter((l) => l.productId !== productId);
  return cart.map((l) => (l.productId === productId ? { ...l, qty: Math.min(MAX_QTY, Math.floor(qty)) } : l));
}

export const removeItem = (cart: CartLine[], productId: string): CartLine[] => cart.filter((l) => l.productId !== productId);

export function totalMinor(cart: CartLine[], prices: Record<string, number>): number {
  return cart.reduce((sum, l) => sum + (prices[l.productId] ?? 0) * l.qty, 0);
}

export const itemCount = (cart: CartLine[]): number => cart.reduce((n, l) => n + l.qty, 0);
