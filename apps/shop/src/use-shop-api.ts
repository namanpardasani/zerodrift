import { useEffect, useRef, useState } from 'react';
import { shopApi } from './api.js';

/** Fetch `path`; poll every `pollMs`, or (pollWhile) keep polling every 1.5s only while the data says it is not final yet. */
export function useShopApi<T>(path: string, opts: { pollMs?: number; pollWhile?: (d: T) => boolean; onData?: (d: T) => void } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const onData = useRef(opts.onData);
  onData.current = opts.onData;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const d = await shopApi<T>(path);
        if (cancelled) return;
        setData(d);
        setError(null);
        onData.current?.(d);
        const again = opts.pollWhile ? opts.pollWhile(d) : Boolean(opts.pollMs);
        if (again) timer = setTimeout(load, opts.pollWhile ? 1500 : opts.pollMs);
      } catch (e) {
        if (cancelled) return;
        setError(e as Error);
        timer = setTimeout(load, 3000); // keep trying: the shop may just be restarting
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [path, opts.pollMs]);

  return { data, error };
}
