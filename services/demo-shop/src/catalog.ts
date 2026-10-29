/**
 * The shop's product catalogue. Prices live HERE, on the server: the browser only ever sends
 * product ids and quantities, so a customer can never choose their own price.
 * Amounts are integer paise (minor units), like everywhere else in Zerodrift.
 */
export interface Product {
  id: string;
  name: string;
  description: string;
  priceMinor: number;
}

export const PRODUCTS: readonly Product[] = [
  { id: 'kurta-cotton', name: 'Cotton Kurta', description: 'Hand-block printed, breathable summer cotton.', priceMinor: 149_900 },
  { id: 'chai-tin', name: 'Assam Chai, 250 g', description: 'Single-estate CTC, packed in a reusable tin.', priceMinor: 34_900 },
  { id: 'notebook-set', name: 'Notebook Set (3)', description: 'Recycled paper, stitched binding, dot grid.', priceMinor: 59_900 },
  { id: 'brass-diya', name: 'Brass Diya Pair', description: 'Cast brass, polished finish.', priceMinor: 79_900 },
  { id: 'jute-bag', name: 'Jute Tote Bag', description: 'Reinforced handles, cotton lining.', priceMinor: 44_900 },
  { id: 'spice-box', name: 'Masala Dabba', description: 'Seven-compartment steel box with spoon.', priceMinor: 119_900 },
];

export interface OrderLine {
  productId: string;
  name: string;
  qty: number;
  unitPriceMinor: number;
}

export class CartError extends Error {}

/** Price a cart from the catalogue (never from client-supplied prices). */
export function priceCart(items: { productId: string; qty: number }[]): { lines: OrderLine[]; totalMinor: number } {
  if (!Array.isArray(items) || items.length === 0) throw new CartError('Cart is empty');
  if (items.length > 20) throw new CartError('Too many different items');
  const lines: OrderLine[] = [];
  let total = 0;
  for (const it of items) {
    const p = PRODUCTS.find((x) => x.id === it.productId);
    if (!p) throw new CartError(`Unknown product "${String(it.productId)}"`);
    if (!Number.isInteger(it.qty) || it.qty < 1 || it.qty > 10) throw new CartError('Quantity must be a whole number from 1 to 10');
    lines.push({ productId: p.id, name: p.name, qty: it.qty, unitPriceMinor: p.priceMinor });
    total += p.priceMinor * it.qty;
  }
  return { lines, totalMinor: total };
}
