import { correlationHeaders, retry } from '@zerodrift/common';

/** The ledger did not answer in time / the network failed / it returned 5xx: outcome UNKNOWN. */
export class LedgerUnavailable extends Error {
  constructor(message: string) {
    super(message);
  }
}

/** The ledger answered and said no (4xx): a definitive business rejection. */
export class LedgerRejected extends Error {
  constructor(
    readonly code: string,
    readonly httpStatus: number,
    message: string,
  ) {
    super(message);
  }
}

export interface LedgerHold {
  id: string;
  accountId: string;
  amountMinor: string;
  status: 'active' | 'captured' | 'released' | 'expired';
}

export interface LedgerTransaction {
  id: string;
  type: string;
  entries: { accountId: string; direction: 'debit' | 'credit'; amountMinor: string }[];
}

export interface LedgerClientOptions {
  baseUrl: string;
  timeoutMs?: number;
  /** Retries for calls that are safe to repeat (everything here is idempotent). */
  retries?: number;
  retryBaseMs?: number;
}

/**
 * Typed HTTP client for the ledger. Every money-moving call carries a deterministic
 * Idempotency-Key, which is what makes retrying after a timeout safe: if the first attempt did
 * succeed, the retry just returns the stored result instead of moving money twice.
 */
export class LedgerClient {
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryBaseMs: number;
  private systemAccounts = new Map<string, string>();

  constructor(private readonly opts: LedgerClientOptions) {
    this.timeoutMs = opts.timeoutMs ?? 3_000;
    this.retries = opts.retries ?? 2;
    this.retryBaseMs = opts.retryBaseMs ?? 100;
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown, idempotencyKey?: string): Promise<{ status: number; data: T }> {
    return retry(
      async () => {
        let res: Response;
        try {
          res = await fetch(`${this.opts.baseUrl}${path}`, {
            method,
            headers: { 'content-type': 'application/json', ...correlationHeaders(), ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(this.timeoutMs),
          });
        } catch (err) {
          throw new LedgerUnavailable(`ledger ${method} ${path} failed: ${(err as Error).message}`);
        }
        if (res.status >= 500) throw new LedgerUnavailable(`ledger ${method} ${path} -> HTTP ${res.status}`);
        const json = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string } } & Record<string, unknown>;
        if (res.status >= 400) {
          throw new LedgerRejected(json.error?.code ?? 'ledger_error', res.status, json.error?.message ?? `HTTP ${res.status}`);
        }
        return { status: res.status, data: json as T };
      },
      {
        retries: this.retries,
        baseMs: this.retryBaseMs,
        maxMs: 1_000,
        shouldRetry: (e) => e instanceof LedgerUnavailable, // never retry a definitive rejection
      },
    );
  }

  /** Get-or-create the wallet for an owner. */
  async wallet(ownerType: 'customer' | 'merchant', ownerId: string): Promise<{ id: string; availableMinor: string; heldMinor: string }> {
    return (await this.call<{ id: string; availableMinor: string; heldMinor: string }>('POST', '/accounts', { ownerType, ownerId })).data;
  }

  async account(id: string) {
    return (await this.call<{ id: string; availableMinor: string; heldMinor: string }>('GET', `/accounts/${id}`)).data;
  }

  async systemAccountId(type: 'fees' | 'gateway_clearing' | 'suspense'): Promise<string> {
    const cached = this.systemAccounts.get(type);
    if (cached) return cached;
    const { data } = await this.call<{ accounts: { id: string; type: string }[] }>('GET', '/accounts?ownerType=system');
    for (const a of data.accounts) this.systemAccounts.set(a.type, a.id);
    const id = this.systemAccounts.get(type);
    if (!id) throw new LedgerUnavailable(`system account ${type} does not exist yet`);
    return id;
  }

  async createHold(i: { accountId: string; amountMinor: bigint; idempotencyKey: string; referenceId: string; ttlSeconds: number }): Promise<LedgerHold> {
    const { data } = await this.call<LedgerHold>(
      'POST',
      '/holds',
      { accountId: i.accountId, amountMinor: i.amountMinor.toString(), referenceId: i.referenceId, ttlSeconds: i.ttlSeconds },
      i.idempotencyKey,
    );
    return data;
  }

  async captureHold(i: { holdId: string; toAccountId: string; feeBps: number; idempotencyKey: string; referenceId: string }) {
    const { data } = await this.call<{ hold: LedgerHold; transaction: LedgerTransaction }>(
      'POST',
      `/holds/${i.holdId}/capture`,
      { toAccountId: i.toAccountId, feeBps: i.feeBps || undefined, referenceId: i.referenceId },
      i.idempotencyKey,
    );
    return data;
  }

  async releaseHold(holdId: string): Promise<LedgerHold> {
    return (await this.call<LedgerHold>('POST', `/holds/${holdId}/release`, {})).data;
  }

  async postTransaction(i: {
    type: 'refund' | 'payment' | 'transfer' | 'fee';
    referenceId: string;
    idempotencyKey: string;
    entries: { accountId: string; direction: 'debit' | 'credit'; amountMinor: bigint }[];
  }): Promise<LedgerTransaction> {
    const { data } = await this.call<LedgerTransaction>(
      'POST',
      '/transactions',
      { type: i.type, referenceId: i.referenceId, entries: i.entries.map((e) => ({ ...e, amountMinor: e.amountMinor.toString() })) },
      i.idempotencyKey,
    );
    return data;
  }

  async topUp(i: { accountId: string; amountMinor: bigint; idempotencyKey: string; referenceId?: string }) {
    return this.call<LedgerTransaction>(
      'POST',
      '/topups',
      { accountId: i.accountId, amountMinor: i.amountMinor.toString(), referenceId: i.referenceId },
      i.idempotencyKey,
    );
  }
}
