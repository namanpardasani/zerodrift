import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';

/**
 * Load `path` (and optionally keep it fresh every `pollMs`). Pass null to skip. Re-fetches when the
 * path changes; in-flight requests are cancelled on change/unmount; a failed refresh keeps the last
 * good data on screen and just reports the error.
 */
export function useApi<T>(path: string | null, opts: { pollMs?: number } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [tick, setTick] = useState(0);
  const first = useRef(true);

  useEffect(() => {
    if (path === null) return;
    const ctrl = new AbortController();
    first.current = true;
    setLoading(true);
    const load = async () => {
      try {
        const r = await api<T>(path, { signal: ctrl.signal });
        if (!ctrl.signal.aborted) {
          setData(r);
          setError(null);
        }
      } catch (e) {
        if (!ctrl.signal.aborted) setError(e as Error);
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    };
    void load();
    const timer = opts.pollMs ? setInterval(() => void load(), opts.pollMs) : undefined;
    return () => {
      ctrl.abort();
      if (timer) clearInterval(timer);
    };
  }, [path, opts.pollMs, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}
