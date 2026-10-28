import { Inject, Injectable } from '@nestjs/common';
import { DEFAULT_CURRENCY } from '@zerodrift/config';
import { feeFor } from '@zerodrift/money';
import { sql } from 'kysely';
import type { AccountType, OwnerType } from './db-schema.js';
import { Errors } from './errors.js';
import {
  type Db,
  type EntryInput,
  type PostResult,
  type Trx,
  type TransactionView,
  hashRequest,
  inTransaction,
  post,
} from './posting.js';
import { DB } from './tokens.js';

export interface AccountView {
  id: string;
  ownerType: OwnerType;
  ownerId: string;
  currency: string;
  type: AccountType;
  status: string;
  allowNegative: boolean;
  availableMinor: string;
  heldMinor: string;
  version: string;
  createdAt: string;
}

/** System accounts: where money enters/leaves the platform, and where fees/unresolved amounts sit. */
export const SYSTEM_ACCOUNTS: { type: AccountType; allowNegative: boolean }[] = [
  { type: 'gateway_clearing', allowNegative: true }, // goes negative as external money is topped up
  { type: 'fees', allowNegative: false },
  { type: 'suspense', allowNegative: true },
];

export interface FeeSplit {
  /** Platform fee in basis points (250 = 2.5%), rounded half up. See @zerodrift/money feeFor. */
  feeBps?: number;
  /** Where the fee is credited; defaults to the system `fees` account. */
  feeAccountId?: string;
}

/** Entries for "payer pays `amount`; payee receives amount - fee; fees account receives fee". */
export function paymentEntries(args: {
  fromAccountId: string;
  toAccountId: string;
  amountMinor: bigint;
  fromHold?: boolean;
  feeAmount: bigint;
  feeAccountId?: string;
}): EntryInput[] {
  const net = args.amountMinor - args.feeAmount;
  const entries: EntryInput[] = [
    { accountId: args.fromAccountId, direction: 'debit', amountMinor: args.amountMinor, fromHold: args.fromHold },
  ];
  if (net > 0n) entries.push({ accountId: args.toAccountId, direction: 'credit', amountMinor: net });
  if (args.feeAmount > 0n) {
    entries.push({ accountId: args.feeAccountId!, direction: 'credit', amountMinor: args.feeAmount });
  }
  return entries;
}

@Injectable()
export class LedgerService {
  constructor(@Inject(DB) private readonly db: Db) {}

  // ---------------------------------------------------------------- accounts

  /** Get-or-create: calling twice with the same owner/type/currency returns the same account. */
  async createAccount(input: {
    ownerType: OwnerType;
    ownerId: string;
    type?: AccountType;
    currency?: string;
    allowNegative?: boolean;
  }): Promise<AccountView> {
    const type = input.type ?? 'wallet';
    const currency = input.currency ?? DEFAULT_CURRENCY;
    return inTransaction(this.db, async (trx) => {
      const acc = await trx
        .insertInto('accounts')
        .values({
          owner_type: input.ownerType,
          owner_id: input.ownerId,
          type,
          currency,
          allow_negative: input.allowNegative ?? false,
        })
        // DO UPDATE (no-op assignment) so RETURNING yields the existing row on conflict.
        .onConflict((oc) =>
          oc.columns(['owner_type', 'owner_id', 'type', 'currency']).doUpdateSet({ owner_id: input.ownerId }),
        )
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('account_balances')
        .values({ account_id: acc.id })
        .onConflict((oc) => oc.column('account_id').doNothing())
        .execute();
      return this.accountView(trx, acc.id);
    });
  }

  /** Create gateway_clearing / fees / suspense accounts if missing. Called at boot. */
  async ensureSystemAccounts(currency = DEFAULT_CURRENCY): Promise<Record<AccountType, string>> {
    const out: Partial<Record<AccountType, string>> = {};
    for (const s of SYSTEM_ACCOUNTS) {
      const a = await this.createAccount({
        ownerType: 'system',
        ownerId: s.type,
        type: s.type,
        currency,
        allowNegative: s.allowNegative,
      });
      out[s.type] = a.id;
    }
    return out as Record<AccountType, string>;
  }

  async getAccount(id: string): Promise<AccountView> {
    return this.accountView(this.db, id);
  }

  async listAccounts(filter: { ownerType?: OwnerType; ownerId?: string; limit?: number }): Promise<AccountView[]> {
    let q = this.db.selectFrom('accounts').select('id').orderBy('created_at', 'desc').orderBy('id');
    if (filter.ownerType) q = q.where('owner_type', '=', filter.ownerType);
    if (filter.ownerId) q = q.where('owner_id', '=', filter.ownerId);
    const ids = await q.limit(Math.min(filter.limit ?? 100, 500)).execute();
    return Promise.all(ids.map((r) => this.accountView(this.db, r.id)));
  }

  async listEntries(accountId: string, opts: { limit?: number; before?: string }) {
    await this.accountView(this.db, accountId); // 404 if missing
    let q = this.db
      .selectFrom('journal_entries')
      .select(['id', 'transaction_id', 'direction', 'amount_minor', 'currency', 'created_at'])
      .where('account_id', '=', accountId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(Math.min(opts.limit ?? 50, 500));
    if (opts.before) q = q.where('created_at', '<', new Date(opts.before));
    const rows = await q.execute();
    return rows.map((r) => ({
      id: r.id,
      transactionId: r.transaction_id,
      direction: r.direction,
      amountMinor: r.amount_minor.toString(),
      currency: r.currency.trim(),
      createdAt: r.created_at.toISOString(),
    }));
  }

  private async accountView(q: Db | Trx, id: string): Promise<AccountView> {
    const r = await q
      .selectFrom('accounts as a')
      .innerJoin('account_balances as b', 'b.account_id', 'a.id')
      .selectAll('a')
      .select(['b.available_minor', 'b.held_minor', 'b.version'])
      .where('a.id', '=', id)
      .executeTakeFirst();
    if (!r) throw Errors.notFound('Account', id);
    return {
      id: r.id,
      ownerType: r.owner_type,
      ownerId: r.owner_id,
      currency: r.currency.trim(),
      type: r.type,
      status: r.status,
      allowNegative: r.allow_negative,
      availableMinor: r.available_minor.toString(),
      heldMinor: r.held_minor.toString(),
      version: r.version.toString(),
      createdAt: r.created_at.toISOString(),
    };
  }

  // ------------------------------------------------------ top-ups & transfers

  /** External money enters the platform: debit gateway clearing, credit the wallet. */
  async topUp(input: {
    accountId: string;
    amountMinor: bigint;
    idempotencyKey: string;
    referenceId?: string;
  }): Promise<PostResult> {
    const requestHash = hashRequest('topup', { a: input.accountId, m: input.amountMinor, r: input.referenceId });
    return inTransaction(this.db, async (trx) => {
      const clearing = await this.systemAccountId(trx, 'gateway_clearing');
      return post(trx, {
        type: 'topup',
        referenceId: input.referenceId,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        entries: [
          { accountId: clearing, direction: 'debit', amountMinor: input.amountMinor },
          { accountId: input.accountId, direction: 'credit', amountMinor: input.amountMinor },
        ],
      });
    });
  }

  /** Wallet-to-wallet transfer with an optional platform fee taken from the amount. */
  async transfer(
    input: {
      fromAccountId: string;
      toAccountId: string;
      amountMinor: bigint;
      idempotencyKey: string;
      referenceId?: string;
    } & FeeSplit,
  ): Promise<PostResult> {
    if (input.fromAccountId === input.toAccountId) throw Errors.validation('Cannot transfer to the same account');
    const requestHash = hashRequest('transfer', {
      f: input.fromAccountId,
      t: input.toAccountId,
      m: input.amountMinor,
      b: input.feeBps ?? 0,
      fa: input.feeAccountId,
      r: input.referenceId,
    });
    return inTransaction(this.db, async (trx) => {
      const fee = input.feeBps ? feeFor(input.amountMinor, input.feeBps) : 0n;
      const feeAccountId = fee > 0n ? (input.feeAccountId ?? (await this.systemAccountId(trx, 'fees'))) : undefined;
      return post(trx, {
        type: 'transfer',
        referenceId: input.referenceId,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        entries: paymentEntries({
          fromAccountId: input.fromAccountId,
          toAccountId: input.toAccountId,
          amountMinor: input.amountMinor,
          feeAmount: fee,
          feeAccountId,
        }),
      });
    });
  }

  /**
   * Generic balanced posting for callers that need an entry shape the dedicated endpoints do not
   * cover (e.g. a refund that is funded partly by the merchant and partly by the fees account).
   * Same guarantees as everything else: balanced, locked in order, idempotent, no overdraft.
   */
  async postTransaction(input: {
    type: 'payment' | 'transfer' | 'refund' | 'fee';
    referenceId?: string;
    idempotencyKey: string;
    entries: { accountId: string; direction: 'debit' | 'credit'; amountMinor: bigint }[];
  }): Promise<PostResult> {
    const requestHash = hashRequest('post', { t: input.type, r: input.referenceId, e: input.entries });
    return inTransaction(this.db, (trx) =>
      post(trx, {
        type: input.type,
        referenceId: input.referenceId,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        entries: input.entries,
      }),
    );
  }

  /**
   * Reverse a whole transaction by posting the mirror image (every debit becomes a credit and vice
   * versa). The original rows are never touched. A second reversal of the same transaction is
   * rejected by the UNIQUE(reverses_transaction_id) index, even under concurrency.
   * Fails with insufficient_funds if the money has already been spent: the ledger will not go
   * negative to honour a reversal.
   */
  async reverse(input: { transactionId: string; idempotencyKey: string; referenceId?: string }): Promise<PostResult> {
    const requestHash = hashRequest('reverse', { t: input.transactionId, r: input.referenceId });
    return inTransaction(this.db, async (trx) => {
      const original = await trx
        .selectFrom('ledger_transactions')
        .select(['id', 'type', 'reverses_transaction_id'])
        .where('id', '=', input.transactionId)
        .executeTakeFirst();
      if (!original) throw Errors.notFound('Transaction', input.transactionId);
      if (original.type === 'reversal') throw Errors.notReversible(original.id, 'is itself a reversal');
      const rows = await trx
        .selectFrom('journal_entries')
        .select(['account_id', 'direction', 'amount_minor'])
        .where('transaction_id', '=', original.id)
        .execute();
      return post(trx, {
        type: 'reversal',
        referenceId: input.referenceId ?? original.id,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        reversesTransactionId: original.id,
        entries: rows.map((r) => ({
          accountId: r.account_id,
          direction: r.direction === 'debit' ? 'credit' : 'debit',
          amountMinor: r.amount_minor,
        })),
      });
    });
  }

  async getTransaction(id: string): Promise<TransactionView> {
    const r = await this.db
      .selectFrom('ledger_transactions')
      .select(['response'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!r) throw Errors.notFound('Transaction', id);
    return r.response as TransactionView;
  }

  /** Look up a system account id, creating the standard set lazily if the service just started. */
  async systemAccountId(q: Db | Trx, type: AccountType, currency = DEFAULT_CURRENCY): Promise<string> {
    const row = await q
      .selectFrom('accounts')
      .select('id')
      .where('owner_type', '=', 'system')
      .where('type', '=', type)
      .where('currency', '=', currency)
      .executeTakeFirst();
    if (row) return row.id;
    throw Errors.notFound('System account', `${type}/${currency}`);
  }

  /** Test/ops helper: server time, to avoid clock skew between app and DB in expiry logic. */
  async dbNow(): Promise<Date> {
    const r = await sql<{ now: Date }>`select now() as now`.execute(this.db);
    return r.rows[0]!.now;
  }
}
