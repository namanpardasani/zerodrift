import { Inject, Injectable } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { type Kysely, sql } from 'kysely';
import type { FaultSettings } from './faults.js';

export interface GatewayDB {
  gateway_charges: {
    reference: string;
    amount_minor: bigint | string;
    currency: string;
    status: 'succeeded' | 'failed' | 'cancelled' | 'voided';
    failure_code: string | null;
    created_at: Date;
    updated_at: Date;
  };
}

export const GATEWAY_DB = Symbol('GATEWAY_DB');
export const FAULTS = Symbol('FAULTS');
export const CALLBACK_SECRET = Symbol('CALLBACK_SECRET');

export interface ChargeView {
  reference: string;
  status: 'succeeded' | 'failed' | 'cancelled' | 'voided';
  failureCode: string | null;
  amountMinor: string;
  currency: string;
}

/** Thrown to make the controller answer HTTP 500 (an injected infrastructure error). */
export class InjectedError extends Error {}
/** Returned to tell the controller to never answer (lost response). */
export const LOST = Symbol('lost-response');

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

@Injectable()
export class GatewayService {
  constructor(
    @Inject(GATEWAY_DB) private readonly db: Kysely<GatewayDB>,
    @Inject(FAULTS) private readonly faults: FaultSettings,
    @Inject(CALLBACK_SECRET) private readonly callbackSecret: string,
  ) {}

  /** Latency + random 5xx, applied to every request before any work happens. */
  private async injectBefore(): Promise<void> {
    const f = this.faults.get();
    if (f.latencyMaxMs > 0) {
      await sleep(f.latencyMinMs + Math.random() * (f.latencyMaxMs - f.latencyMinMs));
    }
    if (Math.random() < f.errorRate) throw new InjectedError('injected gateway error');
  }

  /**
   * Charge `reference`. Idempotent: the decision (success/decline) is made once, stored, and every
   * later call with the same reference returns the same decision.
   */
  async charge(input: {
    reference: string;
    amountMinor: bigint;
    currency: string;
    callbackUrl?: string;
  }): Promise<ChargeView | typeof LOST> {
    await this.injectBefore();
    const f = this.faults.get();

    const declined = Math.random() < f.declineRate;
    const inserted = await this.db
      .insertInto('gateway_charges')
      .values({
        reference: input.reference,
        amount_minor: input.amountMinor,
        currency: input.currency,
        status: declined ? 'failed' : 'succeeded',
        failure_code: declined ? 'declined_by_bank' : null,
        created_at: sql`now()` as never,
        updated_at: sql`now()` as never,
      })
      .onConflict((oc) => oc.column('reference').doNothing())
      .returningAll()
      .executeTakeFirst();

    const row =
      inserted ??
      (await this.db.selectFrom('gateway_charges').selectAll().where('reference', '=', input.reference).executeTakeFirstOrThrow());

    // Only the call that actually created the decision triggers the async callbacks.
    if (inserted && input.callbackUrl) this.scheduleCallbacks(input.callbackUrl, this.view(row));

    if (Math.random() < f.lostResponseRate) return LOST; // processed and recorded, but never answered
    return this.view(row);
  }

  async get(reference: string): Promise<ChargeView | null> {
    await this.injectBefore();
    const row = await this.db.selectFrom('gateway_charges').selectAll().where('reference', '=', reference).executeTakeFirst();
    return row ? this.view(row) : null;
  }

  /**
   * Cancel a charge that has not been decided yet: records a tombstone so a delayed/duplicate
   * charge request that arrives later is refused. If the charge already succeeded it stays
   * succeeded (the caller must then capture, or void it explicitly).
   */
  async cancel(reference: string): Promise<ChargeView> {
    await this.injectBefore();
    await this.db
      .insertInto('gateway_charges')
      .values({
        reference,
        amount_minor: 1n, // placeholder amount for a tombstone (CHECK > 0)
        currency: 'INR',
        status: 'cancelled',
        failure_code: 'cancelled',
        created_at: sql`now()` as never,
        updated_at: sql`now()` as never,
      })
      .onConflict((oc) => oc.column('reference').doNothing())
      .execute();
    return this.view(await this.db.selectFrom('gateway_charges').selectAll().where('reference', '=', reference).executeTakeFirstOrThrow());
  }

  /** Reverse a charge that succeeded at the bank but must not stand (e.g. the hold expired). */
  async voidCharge(reference: string): Promise<ChargeView> {
    await this.injectBefore();
    const cancelled = await this.cancel(reference);
    if (cancelled.status !== 'succeeded') return cancelled;
    const row = await this.db
      .updateTable('gateway_charges')
      .set({ status: 'voided', updated_at: sql`now()` as never })
      .where('reference', '=', reference)
      .returningAll()
      .executeTakeFirstOrThrow();
    return this.view(row);
  }

  /** Daily settlement: every charge that succeeded on `date` (UTC) and was not voided. */
  async settlement(date: string) {
    const rows = await this.db
      .selectFrom('gateway_charges')
      .selectAll()
      .where('status', '=', 'succeeded')
      .where(sql<boolean>`(created_at AT TIME ZONE 'UTC')::date = ${date}::date`)
      .orderBy('created_at')
      .orderBy('reference')
      .execute();
    return {
      date,
      generatedAt: new Date().toISOString(),
      charges: rows.map((r) => ({
        reference: r.reference,
        amountMinor: r.amount_minor.toString(),
        currency: r.currency.trim(),
        status: r.status,
        createdAt: r.created_at.toISOString(),
      })),
    };
  }

  private view(r: GatewayDB['gateway_charges']): ChargeView {
    return {
      reference: r.reference,
      status: r.status,
      failureCode: r.failure_code,
      amountMinor: r.amount_minor.toString(),
      currency: r.currency.trim(),
    };
  }

  /**
   * Fire-and-forget async notification, like a bank webhook. Delivery is NOT retried (real
   * gateways do retry, but ours deliberately does not, so the payments recovery job is what is
   * proven to close the gap). May be duplicated or dropped according to the fault settings.
   */
  private scheduleCallbacks(url: string, charge: ChargeView) {
    const f = this.faults.get();
    if (Math.random() < f.callbackDropRate) return;
    const copies = 1 + (Math.random() < f.duplicateCallbackRate ? 1 + Math.floor(Math.random() * 2) : 0);
    const body = JSON.stringify(charge);
    const signature = createHmac('sha256', this.callbackSecret).update(body).digest('hex');
    for (let i = 0; i < copies; i++) {
      setTimeout(() => {
        fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-gateway-signature': signature },
          body,
          signal: AbortSignal.timeout(2_000),
        }).catch(() => {
          /* the receiver may be down; that is exactly the scenario recovery exists for */
        });
      }, 50 + Math.random() * 450).unref();
    }
  }
}
