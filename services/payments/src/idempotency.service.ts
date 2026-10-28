import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { Errors } from './errors.js';
import type { Db, Trx } from './payments.repo.js';
import { DB } from './tokens.js';

const TTL_HOURS = 24;

export function hashRequest(operation: string, params: unknown): string {
  const canonical = JSON.stringify(params, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  return createHash('sha256').update(`${operation}:${canonical}`).digest('hex');
}

export type Begin = { kind: 'claimed' } | { kind: 'replay'; status: number; body: unknown };

/**
 * Merchant-level idempotency (table `idempotency_keys`, UNIQUE(merchant_id, key)).
 *
 *   same key + same request, finished        -> replay the stored response
 *   same key + same request, still running   -> 409 request_in_progress (never executes twice)
 *   same key + DIFFERENT request             -> 422 idempotency_key_reuse
 *
 * `begin` runs INSIDE the same DB transaction that creates the resource. The unique index makes a
 * concurrent duplicate BLOCK until the first transaction commits; it then finds the claimed row and
 * gets "in progress" or the stored response. Because the claim and the resource commit atomically,
 * there is no window where a key is claimed but nothing was created (or the reverse).
 */
@Injectable()
export class IdempotencyService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async begin(trx: Trx, merchantId: string, key: string, requestHash: string, resourceType: 'payment' | 'refund'): Promise<Begin> {
    // An expired key no longer constrains the client: drop it so the key can be reused.
    await trx.deleteFrom('idempotency_keys').where('merchant_id', '=', merchantId).where('key', '=', key).where('expires_at', '<', sql<Date>`now()`).execute();

    const claimed = await trx
      .insertInto('idempotency_keys')
      .values({
        merchant_id: merchantId,
        key,
        request_hash: requestHash,
        status: 'in_progress',
        resource_type: resourceType,
        resource_id: null,
        response_status: null,
        response_snapshot: null,
        expires_at: sql<Date>`now() + make_interval(hours => ${TTL_HOURS})`,
      })
      .onConflict((oc) => oc.columns(['merchant_id', 'key']).doNothing())
      .returning('key')
      .executeTakeFirst();
    if (claimed) return { kind: 'claimed' };

    const existing = await trx.selectFrom('idempotency_keys').selectAll().where('merchant_id', '=', merchantId).where('key', '=', key).executeTakeFirstOrThrow();
    if (existing.request_hash !== requestHash) throw Errors.idempotencyMismatch(key);
    if (existing.status === 'completed') return { kind: 'replay', status: existing.response_status!, body: existing.response_snapshot };
    throw Errors.requestInProgress();
  }

  async attach(trx: Trx, merchantId: string, key: string, resourceId: string): Promise<void> {
    await trx.updateTable('idempotency_keys').set({ resource_id: resourceId }).where('merchant_id', '=', merchantId).where('key', '=', key).execute();
  }

  /**
   * Finish the key of a payment that just settled. Covers the case where the request that created
   * it died before answering: the stored response then becomes the final payment, so a client
   * retrying with the same key gets the real outcome.
   */
  async completeByPayment(p: { id: string; merchant_id: string }, body: unknown): Promise<void> {
    await this.db
      .updateTable('idempotency_keys')
      .set({ status: 'completed', response_status: 201, response_snapshot: JSON.stringify(body) })
      .where('merchant_id', '=', p.merchant_id)
      .where('resource_type', '=', 'payment')
      .where('resource_id', '=', p.id)
      .where('status', '=', 'in_progress')
      .execute();
  }

  /** Store the response. Only the first completion wins (`status = in_progress` guard). */
  async complete(merchantId: string, key: string, status: number, body: unknown): Promise<void> {
    await this.db
      .updateTable('idempotency_keys')
      .set({ status: 'completed', response_status: status, response_snapshot: JSON.stringify(body) })
      .where('merchant_id', '=', merchantId)
      .where('key', '=', key)
      .where('status', '=', 'in_progress')
      .execute();
  }
}
