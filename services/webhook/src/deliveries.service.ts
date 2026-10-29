import { Inject, Injectable } from '@nestjs/common';
import { DomainError, backoffDelayMs, registry } from '@zerodrift/common';
import type { EventEnvelope } from '@zerodrift/events';
import { SIGNATURE_HEADER, buildSignatureHeader } from '@zerodrift/webhooks';
import { type Kysely, type Transaction, sql } from 'kysely';
import { Counter, Histogram } from 'prom-client';
import type { WebhookConfig } from './config.js';
import type { DeliveryStatus, WebhookDB } from './db-schema.js';
import { EndpointsService } from './endpoints.service.js';
import { CONFIG, DB } from './tokens.js';
import { assertSafeUrl } from './url-guard.js';

const attemptsTotal = new Counter({ name: 'webhook_attempts_total', help: 'Webhook delivery attempts', labelNames: ['result'], registers: [registry] });
const deliveriesFinal = new Counter({ name: 'webhook_deliveries_final_total', help: 'Deliveries reaching a final state', labelNames: ['status'], registers: [registry] });
const attemptSeconds = new Histogram({ name: 'webhook_attempt_duration_seconds', help: 'Webhook HTTP attempt duration', buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10], registers: [registry] });

export interface AttemptView {
  attemptNo: number;
  startedAt: string;
  durationMs: number;
  responseCode: number | null;
  error: string | null;
  responseSnippet: string | null;
}

export interface DeliveryView {
  id: string;
  eventId: string;
  eventType: string;
  endpointId: string;
  endpointUrl: string;
  status: DeliveryStatus;
  attemptCount: number;
  replayCount: number;
  nextAttemptAt: string | null;
  lastResponseCode: number | null;
  lastError: string | null;
  createdAt: string;
  attempts?: AttemptView[];
}

type Db = Kysely<WebhookDB>;

@Injectable()
export class DeliveriesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: WebhookConfig,
    private readonly endpoints: EndpointsService,
  ) {}

  /**
   * Turn one Kafka event into delivery rows: one per matching, active endpoint of the event's
   * merchant. Runs inside the consumer's inbox transaction, so "event handled" and "deliveries
   * planned" commit together; UNIQUE(event_id, endpoint_id) makes it safe even if it ever ran twice.
   * An endpoint created AFTER the event happened does not receive it (it did not exist yet).
   */
  async enqueueForEvent(trx: Transaction<WebhookDB>, envelope: EventEnvelope, merchantId: string): Promise<number> {
    await trx
      .insertInto('webhook_events')
      .values({ event_id: envelope.eventId, merchant_id: merchantId, event_type: envelope.eventType, payload: JSON.stringify(envelope) })
      .onConflict((oc) => oc.column('event_id').doNothing())
      .execute();

    const targets = await trx
      .selectFrom('webhook_endpoints')
      .select('id')
      .where('merchant_id', '=', merchantId)
      .where('active', '=', true)
      .where(sql<boolean>`('*' = ANY(event_types) OR ${envelope.eventType} = ANY(event_types))`)
      // only endpoints that already existed when the event happened (1s tolerance for clock skew)
      .where('created_at', '<=', new Date(new Date(envelope.occurredAt).getTime() + 1_000))
      .execute();
    if (targets.length === 0) return 0;

    const inserted = await trx
      .insertInto('webhook_deliveries')
      .values(targets.map((t) => ({ event_id: envelope.eventId, endpoint_id: t.id, next_attempt_at: new Date(), updated_at: new Date() })))
      .onConflict((oc) => oc.columns(['event_id', 'endpoint_id']).doNothing())
      .returning('id')
      .execute();
    return inserted.length;
  }

  /**
   * Claim due deliveries for this worker. `FOR UPDATE SKIP LOCKED` lets several workers (replicas)
   * pull from the same table without blocking or double-claiming; the claim pushes next_attempt_at
   * forward by the lease, so if the worker dies mid-attempt the delivery simply becomes due again.
   */
  async claimDue(limit: number): Promise<string[]> {
    const rows = await sql<{ id: string }>`
      UPDATE webhook_deliveries SET next_attempt_at = now() + make_interval(secs => ${this.config.leaseSeconds}), updated_at = now()
      WHERE id IN (
        SELECT id FROM webhook_deliveries WHERE status = 'pending' AND next_attempt_at <= now()
        ORDER BY next_attempt_at LIMIT ${limit} FOR UPDATE SKIP LOCKED
      ) RETURNING id`.execute(this.db);
    return rows.rows.map((r) => r.id);
  }

  /** Make one HTTP attempt for a claimed delivery, then record the outcome. */
  async attempt(deliveryId: string): Promise<'succeeded' | 'retry' | 'dead' | 'skipped'> {
    const d = await this.db
      .selectFrom('webhook_deliveries as d')
      .innerJoin('webhook_events as e', 'e.event_id', 'd.event_id')
      .innerJoin('webhook_endpoints as ep', 'ep.id', 'd.endpoint_id')
      .select(['d.id', 'd.status', 'd.attempt_count', 'e.event_id', 'e.event_type', 'e.payload', 'ep.id as endpoint_id', 'ep.url', 'ep.active'])
      .where('d.id', '=', deliveryId)
      .executeTakeFirst();
    if (!d || d.status !== 'pending') return 'skipped';

    const ep = await this.db.selectFrom('webhook_endpoints').selectAll().where('id', '=', d.endpoint_id).executeTakeFirstOrThrow();
    if (!d.active) {
      await this.recordOutcome(deliveryId, { started: new Date(), durationMs: 0, code: null, error: 'endpoint_disabled', snippet: null }, 'dead');
      return 'dead';
    }

    const envelope = d.payload as EventEnvelope;
    const body = JSON.stringify({ id: envelope.eventId, type: envelope.eventType, createdAt: envelope.occurredAt, data: envelope.payload });
    const attemptNo = d.attempt_count + 1;

    const started = new Date();
    const t0 = performance.now();
    let code: number | null = null;
    let error: string | null = null;
    let snippet: string | null = null;
    try {
      await assertSafeUrl(d.url, { allowPrivate: this.config.allowPrivateUrls }); // re-checked every time: DNS can change
      const res = await fetch(d.url, {
        method: 'POST',
        redirect: 'manual', // never follow redirects: they could bounce us to an internal address
        headers: {
          'content-type': 'application/json',
          'user-agent': 'Zerodrift-Webhooks/1.0',
          [SIGNATURE_HEADER]: buildSignatureHeader(this.endpoints.secretsFor(ep), body),
          'zerodrift-event-id': envelope.eventId,
          'zerodrift-event-type': envelope.eventType,
          'zerodrift-delivery-id': deliveryId,
          'zerodrift-attempt': String(attemptNo),
        },
        body,
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
      code = res.status;
      snippet = (await res.text().catch(() => '')).slice(0, 500);
    } catch (err) {
      const e = err as Error;
      error = e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timeout' : e instanceof DomainError ? e.code : e.message.slice(0, 300);
    }
    const durationMs = Math.round(performance.now() - t0);
    attemptSeconds.observe(durationMs / 1000);

    const ok = code !== null && code >= 200 && code < 300;
    attemptsTotal.inc({ result: ok ? 'success' : 'failure' });
    return this.recordOutcome(deliveryId, { started, durationMs, code, error, snippet }, ok ? 'succeeded' : 'retry');
  }

  /** Write the attempt to the delivery log and move the delivery to its next state, atomically. */
  private async recordOutcome(
    deliveryId: string,
    r: { started: Date; durationMs: number; code: number | null; error: string | null; snippet: string | null },
    outcome: 'succeeded' | 'retry' | 'dead',
  ): Promise<'succeeded' | 'retry' | 'dead'> {
    return this.db.transaction().execute(async (trx) => {
      const d = await trx.selectFrom('webhook_deliveries').selectAll().where('id', '=', deliveryId).forUpdate().executeTakeFirstOrThrow();
      const attemptNo = d.attempt_count + 1;
      await trx
        .insertInto('webhook_attempts')
        .values({ delivery_id: deliveryId, attempt_no: attemptNo, started_at: r.started, duration_ms: r.durationMs, response_code: r.code, error: r.error, response_snippet: r.snippet })
        .execute();

      let status: DeliveryStatus = 'pending';
      let nextDelayMs = 0;
      let result: 'succeeded' | 'retry' | 'dead' = outcome;
      if (outcome === 'succeeded') {
        status = 'succeeded';
      } else if (outcome === 'dead' || d.cycle_attempts + 1 >= this.config.maxAttempts) {
        status = 'dead'; // retries exhausted: dead-letter (visible in the log, replayable by hand)
        result = 'dead';
      } else {
        // exponential backoff + full jitter, with a floor so we never retry (near-)instantly
        nextDelayMs = Math.max(this.config.backoffMinMs, backoffDelayMs(d.cycle_attempts, { baseMs: this.config.backoffBaseMs, maxMs: this.config.backoffMaxMs }));
      }
      await trx
        .updateTable('webhook_deliveries')
        .set({
          status,
          attempt_count: attemptNo,
          cycle_attempts: d.cycle_attempts + 1,
          last_response_code: r.code,
          last_error: r.error,
          next_attempt_at: status === 'pending' ? (sql`now() + make_interval(secs => ${nextDelayMs / 1000})` as never) : d.next_attempt_at,
          updated_at: sql`now()` as never,
        })
        .where('id', '=', deliveryId)
        .execute();
      if (status !== 'pending') deliveriesFinal.inc({ status });
      return result;
    });
  }

  // ------------------------------------------------------------------ queries & replay

  private baseQuery() {
    return this.db
      .selectFrom('webhook_deliveries as d')
      .innerJoin('webhook_events as e', 'e.event_id', 'd.event_id')
      .innerJoin('webhook_endpoints as ep', 'ep.id', 'd.endpoint_id')
      .select(['d.id', 'd.event_id', 'e.event_type', 'd.endpoint_id', 'ep.url', 'ep.merchant_id', 'd.status', 'd.attempt_count', 'd.replay_count', 'd.next_attempt_at', 'd.last_response_code', 'd.last_error', 'd.created_at']);
  }

  private toView(r: Awaited<ReturnType<ReturnType<DeliveriesService['baseQuery']>['execute']>>[number]): DeliveryView {
    return {
      id: r.id,
      eventId: r.event_id,
      eventType: r.event_type,
      endpointId: r.endpoint_id,
      endpointUrl: r.url,
      status: r.status,
      attemptCount: r.attempt_count,
      replayCount: r.replay_count,
      nextAttemptAt: r.status === 'pending' ? r.next_attempt_at.toISOString() : null,
      lastResponseCode: r.last_response_code,
      lastError: r.last_error,
      createdAt: r.created_at.toISOString(),
    };
  }

  async list(filter: { merchantId?: string; status?: DeliveryStatus; endpointId?: string; eventId?: string; limit?: number }): Promise<DeliveryView[]> {
    let q = this.baseQuery().orderBy('d.created_at', 'desc').orderBy('d.id', 'desc').limit(Math.min(filter.limit ?? 50, 500));
    if (filter.merchantId) q = q.where('ep.merchant_id', '=', filter.merchantId);
    if (filter.status) q = q.where('d.status', '=', filter.status);
    if (filter.endpointId) q = q.where('d.endpoint_id', '=', filter.endpointId);
    if (filter.eventId) q = q.where('d.event_id', '=', filter.eventId);
    return (await q.execute()).map((r) => this.toView(r));
  }

  /** `merchantId` scopes the lookup to one merchant; omit it for the operator view. */
  async getOwned(merchantId: string | undefined, id: string): Promise<DeliveryView> {
    let q = this.baseQuery().where('d.id', '=', id);
    if (merchantId) q = q.where('ep.merchant_id', '=', merchantId);
    const r = await q.executeTakeFirst();
    if (!r) throw new DomainError('not_found', `Webhook delivery ${id} not found`, 404);
    const attempts = await this.db.selectFrom('webhook_attempts').selectAll().where('delivery_id', '=', id).orderBy('attempt_no').execute();
    return {
      ...this.toView(r),
      attempts: attempts.map((a) => ({ attemptNo: a.attempt_no, startedAt: a.started_at.toISOString(), durationMs: a.duration_ms, responseCode: a.response_code, error: a.error, responseSnippet: a.response_snippet })),
    };
  }

  /**
   * Manual replay: send the SAME event again to the same endpoint (e.g. the merchant fixed their
   * server after a dead-letter, or lost the data). History is kept: attempts continue numbering and
   * a new retry cycle starts. Replaying an already-successful delivery is allowed on purpose
   * (receivers dedupe on the event id header).
   */
  async replay(merchantId: string | undefined, id: string): Promise<DeliveryView> {
    await this.getOwned(merchantId, id);
    await this.db
      .updateTable('webhook_deliveries')
      .set({ status: 'pending', cycle_attempts: 0, replay_count: sql`replay_count + 1` as never, next_attempt_at: sql`now()` as never, updated_at: sql`now()` as never })
      .where('id', '=', id)
      .execute();
    return this.getOwned(merchantId, id);
  }

  /** Replay every delivery of one event (all endpoints). */
  async replayEvent(merchantId: string, eventId: string): Promise<DeliveryView[]> {
    const ds = await this.list({ merchantId, eventId, limit: 500 });
    if (ds.length === 0) throw new DomainError('not_found', `No deliveries for event ${eventId}`, 404);
    return Promise.all(ds.map((d) => this.replay(merchantId, d.id)));
  }

  async stats(): Promise<Record<string, number>> {
    const rows = await sql<{ status: string; n: string }>`SELECT status, count(*)::text AS n FROM webhook_deliveries GROUP BY status`.execute(this.db);
    return Object.fromEntries(rows.rows.map((r) => [r.status, Number(r.n)]));
  }
}
