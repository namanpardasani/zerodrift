import { Inject, Injectable, Logger } from '@nestjs/common';
import { type GatewayCharge, GatewayClient, GatewayUnknown } from './clients/gateway.client.js';
import { LedgerClient, LedgerRejected, LedgerUnavailable } from './clients/ledger.client.js';
import { IdempotencyService } from './idempotency.service.js';
import { MerchantsService } from './merchants.service.js';
import { type PaymentRow, PaymentsRepo, toView } from './payments.repo.js';
import { isSettled } from './state-machine.js';
import { CONFIG, GATEWAY, LEDGER, type PaymentsConfig } from './tokens.js';

/** `request`: the live HTTP request drives the saga. `recovery`: the job/callback resumes it. */
export type SagaMode = 'request' | 'recovery';

type GatewayOutcome = { kind: 'succeeded' } | { kind: 'failed'; reason: string } | { kind: 'unknown' };

/**
 * The payment saga:  HOLD funds -> call the GATEWAY -> CAPTURE (success) or RELEASE (failure).
 *
 * Why a saga: three systems (ledger, gateway, our DB) cannot share one transaction. Instead each
 * step is idempotent, its progress is recorded, and a failure at any point has a defined
 * compensation, so the whole thing can be resumed from any step by anyone (request or recovery).
 *
 *   step                 idempotency                       compensation
 *   1 hold               ledger key  hold:<payment>        release the hold
 *   2 gateway charge     gateway reference = payment id    (void if it must not stand)
 *   3 capture            ledger key  capture:<payment>     (none: it is the commit point)
 *
 * THE RULE: a timeout / network error / 5xx / open circuit is an UNKNOWN outcome, never a failure.
 * On unknown we simply return and leave the payment `processing` with the funds still held.
 * Only a definitive answer (a decline, a ledger rejection) moves it to `failed`.
 */
@Injectable()
export class SagaService {
  private readonly log = new Logger('Saga');

  constructor(
    private readonly repo: PaymentsRepo,
    @Inject(LEDGER) private readonly ledger: LedgerClient,
    @Inject(GATEWAY) private readonly gateway: GatewayClient,
    @Inject(CONFIG) private readonly config: PaymentsConfig,
    private readonly merchants: MerchantsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  /** Advance one payment as far as currently possible. Safe to call repeatedly and concurrently. */
  async run(paymentId: string, mode: SagaMode): Promise<PaymentRow> {
    const leased = await this.repo.acquireLease(paymentId, this.config.leaseSeconds);
    if (!leased) return this.repo.load(paymentId); // settled already, or another worker holds the lease
    try {
      const result = await this.advance(leased, mode);
      if (isSettled(result.status)) await this.completeIdempotency(result);
      return result;
    } finally {
      await this.repo.releaseLease(paymentId);
    }
  }

  private async advance(start: PaymentRow, mode: SagaMode): Promise<PaymentRow> {
    let p = start;
    if (p.status === 'created') {
      p = await this.repo.transition(p, 'processing', 'saga_started');
      if (isSettled(p.status)) return p;
    }

    // ---- step 1: hold the customer's funds
    if (!p.hold_id) {
      try {
        const hold = await this.ledger.createHold({
          accountId: p.customer_account_id,
          amountMinor: p.amount_minor,
          idempotencyKey: `hold:${p.id}`,
          referenceId: p.id,
          ttlSeconds: this.config.holdTtlSeconds,
        });
        p = await this.repo.patch(p.id, { hold_id: hold.id });
      } catch (err) {
        if (err instanceof LedgerUnavailable) return p; // UNKNOWN: a retry with the same key is safe
        if (err instanceof LedgerRejected) return this.fail(p, err.code); // e.g. insufficient_funds: nothing was held
        throw err;
      }
    }

    // ---- step 2: ask the gateway
    const outcome = await this.resolveGateway(p, mode);
    if (outcome.kind === 'unknown') return p; // stays `processing`, funds stay held
    if (outcome.kind === 'failed') return this.releaseAndFail(p, outcome.reason);

    // ---- step 3: the bank said yes, so capture the held funds to the merchant (the commit point)
    return this.capture(p);
  }

  /**
   * request mode  -> charge (idempotent per reference, so retrying after a timeout is safe).
   * recovery mode -> QUERY first. If the bank has a record, believe it. If it has never heard of
   *   this payment: a young payment is simply charged now (still idempotent); an old one is
   *   abandoned (cancel writes a tombstone so a late duplicate cannot charge afterwards) and failed.
   */
  private async resolveGateway(p: PaymentRow, mode: SagaMode): Promise<GatewayOutcome> {
    try {
      if (mode === 'request') return this.interpret(await this.gateway.charge(p.id, p.amount_minor, p.currency.trim()));

      const known = await this.gateway.query(p.id);
      if (known) return this.interpret(known);
      const ageSeconds = (Date.now() - p.created_at.getTime()) / 1000;
      if (ageSeconds >= this.config.recoveryAbandonAfterSeconds) return this.interpret(await this.gateway.cancel(p.id));
      return this.interpret(await this.gateway.charge(p.id, p.amount_minor, p.currency.trim()));
    } catch (err) {
      if (err instanceof GatewayUnknown) return { kind: 'unknown' };
      throw err;
    }
  }

  private interpret(c: GatewayCharge): GatewayOutcome {
    if (c.status === 'succeeded') return { kind: 'succeeded' };
    return { kind: 'failed', reason: c.failureCode ?? c.status };
  }

  private async capture(p: PaymentRow): Promise<PaymentRow> {
    const merchant = await this.merchants.get(p.merchant_id);
    try {
      const { transaction } = await this.ledger.captureHold({
        holdId: p.hold_id!,
        toAccountId: merchant.ledger_account_id,
        feeBps: p.fee_bps,
        idempotencyKey: `capture:${p.id}`,
        referenceId: p.id,
      });
      return await this.repo.transition(p, 'succeeded', 'captured', { ledger_tx_id: transaction.id, gateway_ref: p.id });
    } catch (err) {
      if (err instanceof LedgerUnavailable) return p; // UNKNOWN: capture is idempotent, retry later
      if (err instanceof LedgerRejected && (err.code === 'hold_expired' || err.code === 'invalid_hold_state')) {
        // The bank charged the customer but we can no longer take the money from their wallet
        // (the hold lapsed). Compensate: void the bank charge, then fail the payment.
        try {
          await this.gateway.voidCharge(p.id);
        } catch (e) {
          if (e instanceof GatewayUnknown) return p; // could not void yet; recovery will try again
          throw e;
        }
        return this.repo.transition(p, 'failed', 'hold_lost_gateway_voided', { failure_reason: err.code });
      }
      this.log.error(`capture of payment ${p.id} rejected: ${(err as Error).message}`);
      return p; // unexpected: leave for recovery/ops rather than guess
    }
  }

  /** Definitive failure after the hold exists: give the money back FIRST, then mark failed. */
  private async releaseAndFail(p: PaymentRow, reason: string): Promise<PaymentRow> {
    if (p.hold_id) {
      try {
        await this.ledger.releaseHold(p.hold_id);
      } catch (err) {
        if (err instanceof LedgerUnavailable) return p; // not failed until the funds are actually released
        // already released/expired is fine; anything else is unexpected
        if (!(err instanceof LedgerRejected && err.code === 'invalid_hold_state')) throw err;
      }
    }
    return this.fail(p, reason);
  }

  private fail(p: PaymentRow, reason: string): Promise<PaymentRow> {
    return this.repo.transition(p, 'failed', reason, { failure_reason: reason });
  }

  /** Close the merchant's idempotency record once the payment is settled (covers crashed requests). */
  private async completeIdempotency(p: PaymentRow): Promise<void> {
    await this.idempotency.completeByPayment(p, toView(p));
  }
}
