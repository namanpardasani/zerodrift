import CircuitBreaker from 'opossum';
import { Gauge, Counter } from 'prom-client';
import { correlationHeaders, registry, retry } from '@zerodrift/common';

/**
 * The gateway timed out, was unreachable, returned 5xx, or the circuit breaker is open.
 * THE OUTCOME IS UNKNOWN: the charge may or may not have happened. Callers must NOT treat this as
 * a failure; the payment stays `processing` until the recovery job learns the truth.
 */
export class GatewayUnknown extends Error {
  constructor(
    message: string,
    readonly breakerOpen = false,
  ) {
    super(message);
  }
}

export type GatewayStatus = 'succeeded' | 'failed' | 'cancelled' | 'voided';
export interface GatewayCharge {
  reference: string;
  status: GatewayStatus;
  failureCode: string | null;
  amountMinor: string;
}

export interface GatewayClientOptions {
  baseUrl: string;
  /** Where the gateway POSTs async results. Can also be set later with `setCallbackUrl`. */
  callbackUrl?: string;
  /** Per-attempt timeout. Past this we do NOT know whether the bank charged. */
  timeoutMs?: number;
  retries?: number;
  retryBaseMs?: number;
  breaker?: { errorThresholdPercentage?: number; resetTimeoutMs?: number; volumeThreshold?: number; rollingCountTimeoutMs?: number };
}

const breakerState = new Gauge({ name: 'gateway_circuit_open', help: '1 when the gateway circuit breaker is open', registers: [registry] });
const gatewayCalls = new Counter({ name: 'gateway_calls_total', help: 'Gateway calls by operation and outcome', labelNames: ['op', 'outcome'], registers: [registry] });

/**
 * Gateway client = timeout + retry (exponential backoff, full jitter) + circuit breaker.
 *
 * - Declines are NORMAL results (HTTP 200 with status 'failed'); they never trip the breaker.
 * - Retrying a charge is safe because the gateway is idempotent per `reference`.
 * - The circuit breaker (opossum) counts timeouts/5xx/network errors. When the failure rate in the
 *   rolling window passes the threshold it OPENS and calls fail instantly (no more piling onto a
 *   struggling dependency); after `resetTimeoutMs` one probe is allowed (HALF-OPEN), and success closes it.
 */
export class GatewayClient {
  private breaker: CircuitBreaker<[string, string, unknown?], { status: number; data: unknown }>;
  private readonly retries: number;
  private readonly retryBaseMs: number;
  private callbackUrl?: string;

  constructor(private readonly opts: GatewayClientOptions) {
    this.callbackUrl = opts.callbackUrl;
    this.retries = opts.retries ?? 1;
    this.retryBaseMs = opts.retryBaseMs ?? 100;
    this.breaker = this.buildBreaker();
  }

  /** Force the breaker closed and clear its statistics (tests, and manual ops after a known-good fix). */
  resetCircuit() {
    this.breaker.shutdown();
    this.breaker = this.buildBreaker(); // a fresh breaker also clears the rolling failure statistics
    breakerState.set(0);
  }

  setCallbackUrl(url: string) {
    this.callbackUrl = url;
  }

  private buildBreaker() {
    const opts = this.opts;
    const timeoutMs = opts.timeoutMs ?? 1_500;
    const breaker = new CircuitBreaker(
      async (method: string, path: string, body?: unknown) => {
        const res = await fetch(`${opts.baseUrl}${path}`, {
          method,
          headers: { 'content-type': 'application/json', ...correlationHeaders() },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status >= 500) throw new Error(`gateway HTTP ${res.status}`);
        return { status: res.status, data: await res.json().catch(() => ({})) };
      },
      {
        timeout: timeoutMs + 500, // outer guard; the fetch signal normally fires first
        errorThresholdPercentage: opts.breaker?.errorThresholdPercentage ?? 50,
        resetTimeout: opts.breaker?.resetTimeoutMs ?? 5_000,
        volumeThreshold: opts.breaker?.volumeThreshold ?? 10,
        rollingCountTimeout: opts.breaker?.rollingCountTimeoutMs ?? 10_000,
      },
    );
    breaker.on('open', () => breakerState.set(1));
    breaker.on('close', () => breakerState.set(0));
    breaker.on('halfOpen', () => breakerState.set(0.5));
    return breaker;
  }

  get circuitOpen(): boolean {
    return this.breaker.opened;
  }

  private async request(op: string, method: string, path: string, body?: unknown, retries = this.retries) {
    try {
      return await retry(
        async () => {
          try {
            return await this.breaker.fire(method, path, body);
          } catch (err) {
            const open = (err as { code?: string }).code === 'EOPENBREAKER';
            throw new GatewayUnknown(`gateway ${op} unavailable: ${(err as Error).message}`, open);
          }
        },
        {
          retries,
          baseMs: this.retryBaseMs,
          maxMs: 1_000,
          shouldRetry: (e) => e instanceof GatewayUnknown && !e.breakerOpen, // pointless to retry into an open circuit
        },
      );
    } catch (err) {
      gatewayCalls.inc({ op, outcome: 'unknown' });
      throw err;
    }
  }

  /** Idempotent per reference: safe to call again after a timeout. */
  async charge(reference: string, amountMinor: bigint, currency: string): Promise<GatewayCharge> {
    const r = await this.request('charge', 'POST', '/charges', { reference, amountMinor: amountMinor.toString(), currency, callbackUrl: this.callbackUrl });
    gatewayCalls.inc({ op: 'charge', outcome: (r.data as GatewayCharge).status });
    return r.data as GatewayCharge;
  }

  /** Ask the bank what happened; `null` means it has no record of this reference. */
  async query(reference: string): Promise<GatewayCharge | null> {
    const r = await this.request('query', 'GET', `/charges/${encodeURIComponent(reference)}`);
    if (r.status === 404) return null;
    return r.data as GatewayCharge;
  }

  /** Tombstone a reference that never reached the bank so a late duplicate cannot charge. */
  async cancel(reference: string): Promise<GatewayCharge> {
    return (await this.request('cancel', 'POST', `/charges/${encodeURIComponent(reference)}/cancel`, {})).data as GatewayCharge;
  }

  /** Reverse a charge that succeeded at the bank but must not stand. */
  async voidCharge(reference: string): Promise<GatewayCharge> {
    return (await this.request('void', 'POST', `/charges/${encodeURIComponent(reference)}/void`, {})).data as GatewayCharge;
  }

  shutdown() {
    this.breaker.shutdown();
  }
}
