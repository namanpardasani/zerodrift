import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { type CartLine, addItem, itemCount, removeItem, setQty } from './cart.js';
import { type Product, shopApi } from './api.js';

const CUSTOMER_KEY = 'demo-shop.customer';
const CART_KEY = 'demo-shop.cart';

const read = <T,>(key: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
};
const write = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: state just will not persist */
  }
};

interface ShopState {
  customerId: string;
  setCustomerId: (id: string) => void;
  products: Product[];
  prices: Record<string, number>;
  cart: CartLine[];
  add: (productId: string) => void;
  setQuantity: (productId: string, qty: number) => void;
  remove: (productId: string) => void;
  clearCart: () => void;
  cartCount: number;
  balance: { availableMinor: string; heldMinor: string } | null;
  refreshBalance: () => void;
}

const Ctx = createContext<ShopState | null>(null);

export function ShopProvider({ children }: { children: ReactNode }) {
  const [customerId, setCustomer] = useState<string>(() => read(CUSTOMER_KEY, '') || `guest-${Math.random().toString(36).slice(2, 8)}`);
  const [cart, setCart] = useState<CartLine[]>(() => read<CartLine[]>(CART_KEY, []));
  const [products, setProducts] = useState<Product[]>([]);
  const [balance, setBalance] = useState<ShopState['balance']>(null);

  useEffect(() => write(CUSTOMER_KEY, customerId), [customerId]);
  useEffect(() => write(CART_KEY, cart), [cart]);
  useEffect(() => {
    shopApi<{ products: Product[] }>('/api/products').then((r) => setProducts(r.products)).catch(() => setProducts([]));
  }, []);

  const refreshBalance = useCallback(() => {
    shopApi<{ balance: { availableMinor: string; heldMinor: string } }>(`/api/customers/${encodeURIComponent(customerId)}`)
      .then((r) => setBalance(r.balance))
      .catch(() => setBalance(null));
  }, [customerId]);
  useEffect(refreshBalance, [refreshBalance]);

  const prices = useMemo(() => Object.fromEntries(products.map((p) => [p.id, p.priceMinor])), [products]);
  const value: ShopState = {
    customerId,
    setCustomerId: (id) => {
      setCustomer(id);
      setBalance(null);
    },
    products,
    prices,
    cart,
    add: (id) => setCart((c) => addItem(c, id)),
    setQuantity: (id, q) => setCart((c) => setQty(c, id, q)),
    remove: (id) => setCart((c) => removeItem(c, id)),
    clearCart: () => setCart([]),
    cartCount: itemCount(cart),
    balance,
    refreshBalance,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useShop(): ShopState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useShop outside ShopProvider');
  return v;
}
