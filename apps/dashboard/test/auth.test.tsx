// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';
import { ApiError, api, setUnauthorizedHandler, tokenStore } from '../src/api.js';
import { AuthProvider } from '../src/auth.js';

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
let handler: Handler;
const requests: { url: string; auth: string | null }[] = [];
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  sessionStorage.clear();
  requests.length = 0;
  handler = () => json(404, {});
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    requests.push({ url, auth: new Headers(init.headers).get('authorization') });
    return handler(url, init);
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const mount = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );

describe('api client', () => {
  it('sends the bearer token and turns error responses into ApiError with the server message', async () => {
    tokenStore.set('tok');
    handler = () => json(404, { error: { code: 'not_found', message: 'Payment x not found' } });
    await expect(api('/api/payments/x')).rejects.toMatchObject({ message: 'Payment x not found', status: 404, code: 'not_found' });
    expect(requests[0]!.auth).toBe('Bearer tok');
    handler = () => new Response('<html>proxy error</html>', { status: 502 });
    await expect(api('/api/x')).rejects.toBeInstanceOf(ApiError); // a non-JSON error body still yields a clean error
  });

  it('a 401 clears the stored token and triggers the unauthorized handler (but a failed LOGIN does not log you out)', async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    tokenStore.set('expired');
    handler = () => json(401, { error: { message: 'Session expired' } });
    await expect(api('/api/overview')).rejects.toThrow('Session expired');
    expect(tokenStore.get()).toBeNull();
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    onUnauthorized.mockClear();
    await expect(api('/auth/login', { method: 'POST', body: {} })).rejects.toThrow();
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});

describe('login flow', () => {
  it('redirects an unauthenticated visitor to the login page', async () => {
    mount('/payments');
    await screen.findByText(/Console/);
    expect(screen.getByLabelText('Password')).toBeTruthy();
    expect(requests.filter((r) => r.url.startsWith('/api/'))).toHaveLength(0); // no data was requested without a session
  });

  it('shows the server error for a wrong password and stays on the page', async () => {
    handler = (url) => (url === '/auth/login' ? json(401, { error: { code: 'invalid_credentials', message: 'Wrong username or password' } }) : json(404, {}));
    mount('/login');
    fireEvent.change(await screen.findByLabelText('Password'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByText('Sign in'));
    expect((await screen.findByRole('alert')).textContent).toContain('Wrong username or password');
    expect(tokenStore.get()).toBeNull();
  });

  it('a successful login stores the token, opens the console and sends it with data requests', async () => {
    handler = (url) => {
      if (url === '/auth/login') return json(200, { token: 'jwt-abc', user: 'admin', expiresInSeconds: 3600 });
      if (url === '/api/overview') return json(200, { services: [{ name: 'ledger', up: true, latencyMs: 4 }], payments: { byStatus: {}, last24hByStatus: { succeeded: 3 }, inFlight: { count: 0, oldestSeconds: 0 } }, webhooks: {}, reconciliation: null, ledgerInvariants: { ok: true, totalBalanceMinor: '0' } });
      return json(404, {});
    };
    mount('/login');
    fireEvent.change(await screen.findByLabelText('Password'), { target: { value: 'correct-horse' } });
    fireEvent.click(screen.getByText('Sign in'));
    await screen.findByText('Balanced'); // the overview rendered
    expect(tokenStore.get()).toBe('jwt-abc');
    expect(requests.find((r) => r.url === '/api/overview')!.auth).toBe('Bearer jwt-abc');
  });

  it('an expired session during use drops back to the login page', async () => {
    tokenStore.set('old');
    handler = (url) => (url === '/auth/me' ? json(200, { user: 'admin' }) : json(401, { error: { message: 'Session expired or invalid, log in again' } }));
    mount('/');
    await waitFor(() => expect(screen.getByLabelText('Password')).toBeTruthy());
    expect(tokenStore.get()).toBeNull();
  });
});

describe('chaos page', () => {
  it('explains that chaos is disabled (and offers no destructive buttons) when the controller reports it off', async () => {
    tokenStore.set('t');
    handler = (url) => {
      if (url === '/auth/me') return json(200, { user: 'admin' });
      if (url === '/api/chaos/status') return json(200, { enabled: false });
      return json(200, {});
    };
    mount('/chaos');
    await screen.findByText(/chaos controller is/i);
    expect(screen.queryByText('Kill')).toBeNull();
    expect(screen.queryByText('Reset everything')).toBeNull();
  });
});
