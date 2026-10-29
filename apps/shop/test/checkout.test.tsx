// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CartPage } from '../src/pages/Cart.js';
import { ShopProvider } from '../src/shop-context.js';

const PRODUCTS = [{ id: 'chai-tin', name: 'Assam Chai', description: 'tea', priceMinor: 34_900 }];
const calls: { url: string; method: string; key: string | null; body: any }[] = [];
let orderResponses: (() => Response | Promise<Response>)[] = [];

beforeEach(() => {
  calls.length = 0;
  localStorage.clear();
  localStorage.setItem('demo-shop.customer', JSON.stringify('tester'));
  localStorage.setItem('demo-shop.cart', JSON.stringify([{ productId: 'chai-tin', qty: 2 }]));
  vi.stubGlobal('crypto', { randomUUID: (() => { let n = 0; return () => `uuid-${++n}`; })() });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    calls.push({ url, method: init.method ?? 'GET', key: headers.get('idempotency-key'), body: init.body ? JSON.parse(init.body as string) : null });
    if (url === '/api/products') return new Response(JSON.stringify({ products: PRODUCTS }), { status: 200 });
    if (url.startsWith('/api/customers/')) return new Response(JSON.stringify({ balance: { availableMinor: '100000', heldMinor: '0' } }), { status: 200 });
    if (url === '/api/orders') return (orderResponses.shift() ?? (() => new Response(JSON.stringify({ id: 'order-1', status: 'paid' }), { status: 201 })))();
    return new Response('{}', { status: 404 });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const mount = () =>
  render(
    <MemoryRouter initialEntries={['/cart']}>
      <ShopProvider>
        <Routes>
          <Route path="/cart" element={<CartPage />} />
          <Route path="/orders/:id" element={<div>order page</div>} />
        </Routes>
      </ShopProvider>
    </MemoryRouter>,
  );
const orderCalls = () => calls.filter((c) => c.url === '/api/orders');

describe('checkout', () => {
  it('sends only product ids and quantities (never prices) with an Idempotency-Key, then goes to the order page', async () => {
    mount();
    await screen.findByText('Assam Chai');
    fireEvent.click(screen.getByText('Pay from wallet'));
    await screen.findByText('order page');
    expect(orderCalls()).toHaveLength(1);
    expect(orderCalls()[0]!.body).toEqual({ customerId: 'tester', items: [{ productId: 'chai-tin', qty: 2 }] });
    expect(orderCalls()[0]!.key).toMatch(/^checkout-/);
    expect(localStorage.getItem('demo-shop.cart')).toBe('[]'); // cart cleared after success
  });

  it('a FAILED attempt retried by pressing Pay again reuses the SAME Idempotency-Key (so it can never double-charge)', async () => {
    orderResponses = [() => { throw new TypeError('network down'); }];
    mount();
    await screen.findByText('Assam Chai');
    fireEvent.click(screen.getByText('Pay from wallet'));
    await screen.findByRole('alert'); // the error is shown, the cart is still there
    expect(screen.getByText('Assam Chai')).toBeTruthy();
    fireEvent.click(screen.getByText('Pay from wallet'));
    await screen.findByText('order page');
    const [first, second] = orderCalls();
    expect(first!.key).toBe(second!.key);
  });

  it('changing the cart between attempts starts a NEW attempt with a new key', async () => {
    orderResponses = [() => new Response(JSON.stringify({ error: 'Payments are busy' }), { status: 503 })];
    mount();
    await screen.findByText('Assam Chai');
    fireEvent.click(screen.getByText('Pay from wallet'));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByLabelText('More Assam Chai'));
    await waitFor(() => expect(screen.getByLabelText('Quantity').textContent).toBe('3'));
    fireEvent.click(screen.getByText('Pay from wallet'));
    await screen.findByText('order page');
    const [first, second] = orderCalls();
    expect(first!.key).not.toBe(second!.key);
    expect(second!.body.items[0].qty).toBe(3);
  });

  it('shows an empty cart state without calling the API', async () => {
    localStorage.setItem('demo-shop.cart', '[]');
    mount();
    await screen.findByText(/Your cart is empty/);
    expect(orderCalls()).toHaveLength(0);
  });
});
