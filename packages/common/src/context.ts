import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * Per-request context carried through async calls without passing it around by hand
 * (AsyncLocalStorage). Its main job: the CORRELATION ID. One id follows a request from the edge
 * through every service it touches (HTTP header) and into the events it causes (Kafka envelope),
 * so one id finds all the logs of one business operation across the whole system.
 */
export interface RequestContext {
  correlationId: string;
}

const store = new AsyncLocalStorage<RequestContext>();

export const runWithContext = <T>(ctx: RequestContext, fn: () => T): T => store.run(ctx, fn);
export const getContext = (): RequestContext | undefined => store.getStore();
export const getCorrelationId = (): string | undefined => store.getStore()?.correlationId;

/** Headers to attach to an outgoing call so the next service continues the same correlation id. */
export function correlationHeaders(): Record<string, string> {
  const id = getCorrelationId();
  return id ? { 'x-correlation-id': id } : {};
}

const SAFE_ID = /^[A-Za-z0-9._:-]{1,100}$/;

/**
 * Accept a caller-supplied correlation id only if it is plain and short. An unchecked value would
 * be copied into logs and headers: a log-injection (newlines, fake entries) and header-injection risk.
 */
export function acceptCorrelationId(incoming: unknown): string {
  return typeof incoming === 'string' && SAFE_ID.test(incoming) ? incoming : randomUUID();
}
