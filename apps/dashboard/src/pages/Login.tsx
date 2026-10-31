import { BRAND_TAGLINE } from '@zerodrift/brand';
import { Brand, Button, Field, Input } from '@zerodrift/ui';
import { type FormEvent, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.js';

export function LoginPage() {
  const { user, login } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dest = (loc.state as { from?: string } | null)?.from ?? '/app';

  if (user) return <Navigate to={dest} replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
      nav(dest, { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-paper p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-5 rounded-panel border border-rule bg-card p-7">
        <div>
          <Link to="/" aria-label="Home"><Brand size="lg" /></Link>
          <h1 className="mt-5 text-[22px] font-medium tracking-[-0.015em]">Operator console</h1>
          <p className="mt-1 text-sm text-muted">{BRAND_TAGLINE}</p>
        </div>
        <Field label="Username">
          <Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
        </Field>
        <Field label="Password">
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </Field>
        {error && (
          <div role="alert" className="rounded-nav border border-failed-rule bg-failed-bg px-3 py-2 text-sm text-failed-ink">
            {error}
          </div>
        )}
        <Button type="submit" variant="primary" className="w-full" size="lg" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
      <p className="mono mt-5 text-xs text-muted">test mode credentials are in the README</p>
    </div>
  );
}
