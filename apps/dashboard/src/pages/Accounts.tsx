import { Card, DataTable, ErrorNote, Id, KeyValue, Money, PageHeader, Select, Spinner, StatusBadge, formatTime } from '@zerodrift/ui';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useApi } from '../hooks.js';
import type { Account, Entry } from '../types.js';

export function AccountsPage() {
  const [params, setParams] = useSearchParams();
  const ownerType = params.get('ownerType') ?? '';
  const nav = useNavigate();
  const q = new URLSearchParams({ limit: '200', ...(ownerType ? { ownerType } : {}) });
  const { data, error, loading, reload } = useApi<{ accounts: Account[] }>(`/api/accounts?${q}`, { pollMs: 5000 });

  return (
    <>
      <PageHeader
        title="Accounts"
        subtitle="Wallet and system accounts with their balances. Held = reserved by active holds and not spendable."
        actions={
          <Select aria-label="Owner type" value={ownerType} onChange={(e) => setParams(e.target.value ? { ownerType: e.target.value } : {})}>
            <option value="">All owners</option>
            <option value="customer">Customers</option>
            <option value="merchant">Merchants</option>
            <option value="system">System</option>
          </Select>
        }
      />
      {error && <ErrorNote error={error} onRetry={reload} />}
      <Card>
        {loading && !data ? (
          <Spinner />
        ) : (
          <DataTable
            rows={data?.accounts ?? []}
            rowKey={(a) => a.id}
            onRowClick={(a) => nav(`/accounts/${a.id}`)}
            columns={[
              { header: 'Owner', cell: (a) => <span>{a.ownerType === 'merchant' ? <Id id={a.ownerId} /> : a.ownerId} <span className="text-xs text-muted">({a.ownerType})</span></span> },
              { header: 'Type', cell: (a) => a.type.replace(/_/g, ' ') },
              { header: 'Available', cell: (a) => <Money minor={a.availableMinor} className={BigInt(a.availableMinor) < 0n ? 'text-danger' : ''} />, className: 'text-right' },
              { header: 'Held', cell: (a) => <Money minor={a.heldMinor} />, className: 'text-right' },
              { header: 'Status', cell: (a) => <StatusBadge status={a.status === 'active' ? 'up' : a.status} /> },
            ]}
          />
        )}
      </Card>
    </>
  );
}

export function AccountDetailPage() {
  const { id } = useParams();
  const acc = useApi<Account>(`/api/accounts/${id}`, { pollMs: 4000 });
  const entries = useApi<{ entries: Entry[] }>(`/api/accounts/${id}/entries?limit=100`, { pollMs: 4000 });
  if (acc.loading && !acc.data) return <Spinner />;
  if (!acc.data) return <ErrorNote error={acc.error ?? 'Not found'} onRetry={acc.reload} />;
  const a = acc.data;

  return (
    <>
      <PageHeader title={`${a.ownerType} · ${a.type.replace(/_/g, ' ')}`} subtitle={<code className="font-mono text-xs">{a.id}</code>} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Balance">
          <KeyValue
            items={[
              ['Available', <Money key="av" minor={a.availableMinor} />],
              ['Held', <Money key="h" minor={a.heldMinor} />],
              ['Total owned', <Money key="t" minor={(BigInt(a.availableMinor) + BigInt(a.heldMinor)).toString()} />],
              ['Owner id', a.ownerId],
              ['May go negative', a.allowNegative ? 'yes (system account)' : 'no'],
              ['Opened', formatTime(a.createdAt)],
            ]}
          />
        </Card>
        <Card title="How to read this">
          <p className="text-sm text-muted">Every balance is credits minus debits from the journal, so a funded wallet is positive and the gateway clearing account (the outside world) is negative by exactly the money topped up. The sum of all balances is always zero.</p>
        </Card>
      </div>
      <Card title="Journal entries (newest first)" className="mt-4">
        {entries.error && <ErrorNote error={entries.error} onRetry={entries.reload} />}
        <DataTable
          rows={entries.data?.entries ?? []}
          rowKey={(e) => e.id}
          empty="No entries yet."
          columns={[
            { header: 'Time', cell: (e) => formatTime(e.createdAt) },
            { header: 'Direction', cell: (e) => <span className={e.direction === 'credit' ? 'text-success' : 'text-danger'}>{e.direction}</span> },
            { header: 'Amount', cell: (e) => <Money minor={e.amountMinor} />, className: 'text-right' },
            { header: 'Transaction', cell: (e) => <Link className="text-accent underline" to={`/ledger?tx=${e.transactionId}`}><Id id={e.transactionId} /></Link> },
          ]}
        />
      </Card>
    </>
  );
}
