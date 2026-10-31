import { BRAND_NAME } from '@zerodrift/brand';
import { Button, Card, EmptyState, ErrorNote, Field, Id, Input, Journal, type JournalLine, PageHeader, Select, Skeleton, cx, formatClock, formatMinorPlain, formatTime } from '@zerodrift/ui';
import { type FormEvent, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAccountLabels, useMerchantNames } from '../accountLabels.js';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import type { LedgerTx } from '../types.js';

const TYPES = ['', 'payment', 'transfer', 'refund', 'topup', 'reversal', 'fee'];

/** The expanded journal of one transaction: ink rows, bracket, and the BALANCED stamp (computed from the entries). */
function TxJournal({ tx }: { tx: LedgerTx }) {
  const labels = useAccountLabels(tx.entries.map((e) => e.accountId));
  const merchants = useMerchantNames();
  const lines: JournalLine[] = tx.entries.map((e) => {
    const l = labels[e.accountId];
    const system = l?.ownerType === 'system';
    return {
      account: <Link to={`/app/accounts/${e.accountId}`} className="underline-offset-2 hover:underline">{system ? `${BRAND_NAME} ${l!.type.replace(/_/g, ' ')}` : l?.ownerType === 'merchant' ? (merchants[l.ownerId] ?? l.ownerId) : (l?.ownerId ?? <Id id={e.accountId} />)}</Link>,
      sub: l ? (system ? 'system' : `${l.ownerType} ${l.type}`) : undefined,
      direction: e.direction,
      amountMinor: e.amountMinor,
    };
  });
  return <Journal title={<>Journal <Id id={tx.id} /></>} meta={`${tx.type} · posted ${formatClock(tx.createdAt)}`} lines={lines} />;
}

function TxRow({ tx, defaultOpen }: { tx: LedgerTx; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(!!defaultOpen);
  const total = tx.entries.filter((e) => e.direction === 'debit').reduce((s, e) => s + BigInt(e.amountMinor), 0n);
  return (
    <li className="border-b border-rule last:border-0">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-[18px] py-3 text-left hover:bg-paper sm:grid-cols-[110px_90px_minmax(0,1fr)_120px_130px]">
        <span className="mono text-[13px] text-ink-2">{tx.id.slice(0, 8)}…</span>
        <span className="text-sm">{tx.type}</span>
        <span className="mono hidden truncate text-[13px] text-muted sm:block">{tx.referenceId ? tx.referenceId : ''}</span>
        <span className="mono text-right text-sm">{formatMinorPlain(total)}</span>
        <span className="mono hidden text-right text-[13px] text-muted sm:block">{formatTime(tx.createdAt)}</span>
      </button>
      {open && (
        <div className="px-[18px] pb-4 pt-1">
          <TxJournal tx={tx} />
        </div>
      )}
    </li>
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
  const loading = lookup ? one.loading && !one.data : feed.loading && !feed.data;

  function submit(e: FormEvent) {
    e.preventDefault();
    setParams(lookupInput.trim() ? { tx: lookupInput.trim() } : {});
  }

  return (
    <>
      <PageHeader
        title="Ledger"
        subtitle="Immutable double-entry transactions, newest first. Open one to see its journal: every transaction’s debits equal its credits."
        actions={
          !lookup && (
            <Select aria-label="Transaction type" value={type} onChange={(e) => setParams(e.target.value ? { type: e.target.value } : {})}>
              {TYPES.map((t) => <option key={t} value={t}>{t || 'All types'}</option>)}
            </Select>
          )
        }
      />
      <form onSubmit={submit} className="mb-4 flex flex-wrap items-end gap-2">
        <div className="w-full max-w-md">
          <Field label="Look up a transaction by id">
            <Input value={lookupInput} onChange={(e) => setLookupInput(e.target.value)} placeholder="transaction id" />
          </Field>
        </div>
        <Button type="submit" variant="primary">Look up</Button>
        {lookup && <Button onClick={() => setParams({})}>Back to feed</Button>}
      </form>
      {(lookup ? one.error : feed.error) && <ErrorNote error={(lookup ? one.error : feed.error)!} />}
      <Card className="overflow-hidden [&>div]:p-0">
        {loading ? (
          <div className="p-[18px]"><Skeleton /></div>
        ) : rows.length === 0 ? (
          <EmptyState>No transactions.</EmptyState>
        ) : (
          <>
            <div className={cx('mono hidden grid-cols-[110px_90px_minmax(0,1fr)_120px_130px] gap-3 border-b border-rule px-[18px] py-2.5 text-xs text-muted sm:grid')}>
              <span>id</span><span>type</span><span>reference</span><span className="text-right">amount</span><span className="text-right">time</span>
            </div>
            <ul>{rows.map((t) => <TxRow key={t.id} tx={t} defaultOpen={!!lookup} />)}</ul>
          </>
        )}
        {!lookup && nextCursor && (
          <div className="border-t border-rule p-3 text-center">
            <Button onClick={loadMore} disabled={loadingMore}>{loadingMore ? 'Loading…' : 'Load older'}</Button>
          </div>
        )}
      </Card>
    </>
  );
}
