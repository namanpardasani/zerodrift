import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { api, setUnauthorizedHandler, tokenStore } from './api.js';

interface AuthState {
  user: string | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);

  const logout = useCallback(() => {
    tokenStore.clear();
    setUser(null);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(logout); // any 401 (expired/invalid token) drops back to the login page
    if (!tokenStore.get()) return setChecked(true);
    api<{ user: string }>('/auth/me')
      .then((r) => setUser(r.user))
      .catch(() => tokenStore.clear())
      .finally(() => setChecked(true));
  }, [logout]);

  const login = useCallback(async (username: string, password: string) => {
    const r = await api<{ token: string; user: string }>('/auth/login', { method: 'POST', body: { username, password } });
    tokenStore.set(r.token);
    setUser(r.user);
  }, []);

  const value = useMemo(() => ({ user, login, logout }), [user, login, logout]);
  if (!checked) return null;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const loc = useLocation();
  return user ? <>{children}</> : <Navigate to="/login" replace state={{ from: loc.pathname }} />;
}
