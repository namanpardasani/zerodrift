import { z } from '@zerodrift/config';

/**
 * Fault knobs, changeable at runtime (the chaos panel / chaos-controller PUTs them).
 * Rates are probabilities in [0, 1].
 */
export const faultSchema = z.object({
  /** Added latency per request, uniformly between min and max milliseconds. */
  latencyMinMs: z.number().int().min(0).max(60_000).default(0),
  latencyMaxMs: z.number().int().min(0).max(60_000).default(0),
  /** The bank declines the charge (a definitive FAILURE, decided once per reference). */
  declineRate: z.number().min(0).max(1).default(0),
  /** HTTP 500 before doing anything: the outcome is UNKNOWN to the caller only if it times out. */
  errorRate: z.number().min(0).max(1).default(0),
  /** Charge is processed and recorded but the response is never sent (the worst case). */
  lostResponseRate: z.number().min(0).max(1).default(0),
  /** After a decision, the async callback is delivered more than once. */
  duplicateCallbackRate: z.number().min(0).max(1).default(0),
  /** The async callback is never sent at all. */
  callbackDropRate: z.number().min(0).max(1).default(0),
});

export type Faults = z.infer<typeof faultSchema>;

export const NO_FAULTS: Faults = faultSchema.parse({});

export class FaultSettings {
  private current: Faults = { ...NO_FAULTS };

  get(): Faults {
    return { ...this.current };
  }

  set(next: unknown): Faults {
    const parsed = faultSchema.parse(next);
    if (parsed.latencyMaxMs < parsed.latencyMinMs) parsed.latencyMaxMs = parsed.latencyMinMs;
    this.current = parsed;
    return this.get();
  }

  reset(): Faults {
    this.current = { ...NO_FAULTS };
    return this.get();
  }
}
