import { Inject, Injectable } from '@nestjs/common';
import { feeFor } from '@zerodrift/money';
import { makeEvent } from '@zerodrift/events';
import { GatewayClient } from './clients/gateway.client.js';
import { LedgerClient, LedgerUnavailable } from './clients/ledger.client.js';
import { Errors } from './errors.js';
import { IdempotencyService, hashRequest } from './idempotency.service.js';
import type { Merchant } from './merchants.service.js';
import { emit } from './outbox.js';
import { type Db, type PaymentView, PaymentsRepo, paymentEventBase, toView } from './payments.repo.js';
import { SagaService } from './saga.service.js';
import { isSettled } from './state-machine.js';
import { DB, GATEWAY, LEDGER } from './tokens.js';

export interface CreatePaymentInput {
  customerId: string;
  amountMinor: bigint;
  currency: 'INR';
  reference?: string;
  description?: string;
}

export interface ApiResult<T> {
  status: number;
  body: T;
  replayed: boolean;
}

@Injectable()
export class PaymentsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(LEDGER) private readonly ledger: LedgerClient,
    @Inject(GATEWAY) _gateway: GatewayClient,
    private readonly repo: PaymentsRepo,
    private readonly saga: SagaService,
    private readonly idempotency: IdempotencyService,
  ) {}

  /**
   * Create a payment and drive it to a result.
   *  201 + final payment      -> succeeded / failed (a decline is a normal result, not an HTTP error)
   *  202 + `processing`       -> outcome not known yet (timeout etc.); poll GET or wait for the webhook
   * Replays of the same Idempotency-Key never re-execute anything.
   */
  async create(merchant: Merchant, input: CreatePaymentInput, key: string): Promise<ApiResult<PaymentView>> {
    const requestHash = hashRequest('payment.create', { c: input.customerId, a: input.amountMinor, cur: input.currency, r: input.reference, d: input.description });

    // Resolve the customer's wallet BEFORE claiming the key: if the ledger is down nothing has been
    // created yet, so the client can simply retry with the same key.
    let wallet;
    try {
      wallet = await this.ledger.wallet('customer', input.customerId);
    } catch (err) {
      if (err instanceof LedgerUnavailable) throw Errors.ledgerUnavailable();
      throw err;
    }

    const fee = feeFor(input.amountMinor, merchant.fee_bps);
    const created = await this.db.transaction().execute(async (trx) => {
      // 1. claim the idempotency key (blocks concurrent duplicates until we commit)
      const begin = await this.idempotency.begin(trx, merchant.id, key, requestHash, 'payment');
      if (begin.kind === 'replay') return { kind: 'replay' as const, replay: begin };

      // 2. create the payment, its first timeline row and the payment.created event, atomically
      const payment = await trx
        .insertInto('payments')
        .values({
          merchant_id: merchant.id,
          customer_id: input.customerId,
          customer_account_id: wallet.id,
          amount_minor: input.amountMinor,
          currency: input.currency,
          status: 'created',
          reference: input.reference ?? null,
          description: input.description ?? null,
          gateway_ref: null,
          idempotency_key: key,
          failure_reason: null,
          hold_id: null,
          ledger_tx_id: null,
          fee_bps: merchant.fee_bps,
          fee_minor: fee,
          lease_until: null,
          updated_at: new Date(),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await trx.insertInto('payment_events').values({ payment_id: payment.id, from_status: null, to_status: 'created', reason: 'payment_created' }).execute();
      await emit(trx, makeEvent('payment.created', 'payment', payment.id, paymentEventBase(payment)));
      await this.idempotency.attach(trx, merchant.id, key, payment.id);
      return { kind: 'created' as const, payment };
    });

    if (created.kind === 'replay') return this.replay(merchant, created.replay);

    // 3. run the saga outside any DB transaction (it makes network calls)
    const settled = await this.saga.run(created.payment.id, 'request');
    const body = toView(settled);
    const status = isSettled(settled.status) ? 201 : 202;
    await this.idempotency.complete(merchant.id, key, status, body);
    return { status, body, replayed: false };
  }

  /**
   * Replay of a finished request returns the stored response verbatim. If the stored response was
   * "202 processing" the payment has probably moved on, so return its CURRENT state instead of a
   * stale snapshot (still no re-execution).
   */
  private async replay(merchant: Merchant, begin: { status: number; body: unknown }): Promise<ApiResult<PaymentView>> {
    const stored = begin.body as PaymentView;
    if (begin.status === 202 || !isSettled(stored.status)) {
      const fresh = await this.repo.load(stored.id);
      if (fresh.merchant_id !== merchant.id) throw Errors.notFound('Payment', stored.id);
      return { status: 200, body: toView(fresh), replayed: true };
    }
    return { status: begin.status, body: stored, replayed: true };
  }

  async get(merchant: Merchant, id: string): Promise<PaymentView> {
    const p = await this.repo.load(id);
    if (p.merchant_id !== merchant.id) throw Errors.notFound('Payment', id); // 404, never reveal other merchants' ids
    return { ...toView(p), events: await this.repo.events(id), refunds: await this.repo.refundsFor(id) };
  }

  async list(merchant: Merchant, q: { status?: string; limit?: number; before?: string }): Promise<PaymentView[]> {
    let query = this.db.selectFrom('payments').selectAll().where('merchant_id', '=', merchant.id).orderBy('created_at', 'desc').orderBy('id', 'desc').limit(Math.min(q.limit ?? 50, 200));
    if (q.status) query = query.where('status', '=', q.status as never);
    if (q.before) query = query.where('created_at', '<', new Date(q.before));
    return (await query.execute()).map(toView);
  }
}
