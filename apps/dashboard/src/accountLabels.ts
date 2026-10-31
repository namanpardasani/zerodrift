import { useEffect, useState } from 'react';
import { api } from './api.js';
import type { Account } from './types.js';

const cache = new Map<string, Account>();

/** Look up the accounts behind journal entries (owner and type), so a journal can say "Riya · customer wallet" instead of a uuid. */
export function useAccountLabels(ids: string[]): Record<string, Account | undefined> {
  const key = [...new Set(ids)].sort().join(',');
  const [, bump] = useState(0);
  useEffect(() => {
    const missing = key ? key.split(',').filter((id) => !cache.has(id)) : [];
    if (missing.length === 0) return;
    let live = true;
    void Promise.all(missing.map((id) => api<Account>(`/api/accounts/${id}`).then((a) => cache.set(id, a)).catch(() => undefined))).then(() => live && bump((n) => n + 1));
    return () => {
      live = false;
    };
  }, [key]);
  return Object.fromEntries((key ? key.split(',') : []).map((id) => [id, cache.get(id)]));
}

const merchantNames = new Map<string, string>();
let merchantsLoaded = false;

/** merchant id -> name, so a merchant wallet in a journal reads "Café Aman" and not a uuid. Loaded once. */
export function useMerchantNames(): Record<string, string> {
  const [, bump] = useState(0);
  useEffect(() => {
    if (merchantsLoaded) return;
    merchantsLoaded = true;
    void api<{ merchants: { id: string; name: string }[] }>('/api/merchants')
      .then((r) => {
        for (const m of r.merchants) merchantNames.set(m.id, m.name);
        bump((n) => n + 1);
      })
      .catch(() => {
        merchantsLoaded = false; // try again next time
      });
  }, []);
  return Object.fromEntries(merchantNames);
}
