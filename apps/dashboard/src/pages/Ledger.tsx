import { Button, Card, DataTable, ErrorNote, Field, Id, Input, Money, PageHeader, Select, Spinner, formatTime } from '@zerodrift/ui';
import { type FormEvent, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import type { LedgerTx } from '../types.js';

const TYPES = ['', 'payment', 'transfer', 'refund', 'topup', 'reversal', 'fee'];

function Entries({ tx }: { tx: LedgerTx }) {
  return (
    <ul className="space-y-1 text-xs">
      {tx.entries.map((e, i) => (
        <li key={i} className="flex items-center gap-3">
          <span className={`w-12 font-medium ${e.direction === 'credit' ? 'text-success' : 'text-danger'}`}>{e.direction}</span>
          <Link className="text-accent underline" to={`/accounts/${e.accountId}`}><Id id={e.accountId} /></Link>
          <Money minor={e.amountMinor} />
        </li>
      ))}
    </ul>
  );
}

export function LedgerPage() {
  const [params, setParams] = useSearchParams();
  const type = params.get('type') ?? '';
  const lookup = params.get('tx') ?? '';
  const [lookupInput, setLookupInput] = useState(lookup);
  useEffect(() => setLookupInput(lookup), [lookup]);

  const q = new URLSearchParams({ limit: '25', ...(type ? { type } : {}) });
  const feed = useApi<{ transactions: LedgerTx[]; nextCursor: string | null }>(lookup ? null : `/api/ledger/transactions?${q}`, { pollMs: 4000 });
  const one = useApi<LedgerTx>(lookup ? `/api/ledger/transactions/${lookup}` : null);

  const [older, setOlder] = useState<LedgerTx[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => { setOlder([]); setCursor(null); }, [type]);
  const nextCursor = cursor ?? feed.data?.nextCursor ?? null;

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const r = await api<{ transactions: LedgerTx[]; nextCursor: string | null }>(`/api/ledger/transactions?${new URLSearchParams({ limit: '25', after: nextCursor, ...(type ? { type } : {}) })}`);
      setOlder((o) => [...o, ...r.transactions]);
      setCursor(r.nextCursor ?? '');
    } finally {
      setLoadingMore(false);
    }
  }

  const rows = lookup ? (one.data ? [one.data] : []) : [...(feed.data?.transactions ?? []), ...older];
  const expandable = (tx: LedgerTx) => <Entries tx={tx} />;

  function submit(e: FormEvent) {
    e.preventDefault();
    setParams(lookupInput.trim() ? { tx: lookupInput.trim() } : {});
  }

  return (
    <>
      <PageHeader
        title="Ledger"
        subtitle="Immutable double-entry transactions, newest first. Every transaction's debits equal its credits."
        actions={
          !lookup && (
            <Select aria-label="Transaction type" value={type} onChange={(e) => setParams(e.target.value ? { type: e.target.value } : {})}>
              {TYPES.map((t) => <option key={t} value={t}>{t || 'All types'}</option>)}
            </Select>
          )
        }
      />
      <form onSubmit={submit} className="mb-4 flex items-end gap-2">
        <div className="w-full max-w-md">
          <Field label="Look up a transaction by id">
            <Input value={lookupInput} onChange={(e) => setLookupInput(e.target.value)} placeholder="transaction id" />
          </Field>
        </div>
        <Button type="submit">Look up</Button>
        {lookup && <Button onClick={() => setParams({})}>Back to feed</Button>}
      </form>
      {(lookup ? one.error : feed.error) && <ErrorNote error={(lookup ? one.error : feed.error)!} />}
      <Card>
        {(lookup ? one.loading && !one.data : feed.loading && !feed.data) ? (
          <Spinner />
        ) : (
          <DataTable
            rows={rows}
            rowKey={(t) => t.id}
            empty="No transactions."
            columns={[
              { header: 'Transaction', cell: (t) => <Id id={t.id} /> },
              { header: 'Type', cell: (t) => t.type },
              { header: 'Reference', cell: (t) => (t.referenceId ? <Id id={t.referenceId} /> : '-') },
              { header: 'Entries', cell: expandable },
              { header: 'Time', cell: (t) => <span className="text-muted">{formatTime(t.createdAt)}</span> },
            ]}
          />
        )}
        {!lookup && nextCursor && (
          <div className="mt-3 text-center">
            <Button onClick={loadMore} disabled={loadingMore}>{loadingMore ? 'Loading…' : 'Load older'}</Button>
          </div>
        )}
      </Card>
    </>
  );
}
