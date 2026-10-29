import { context, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SpanKind, SpanStatusCode, contextFromTraceparent, currentTraceId, currentTraceparent, initTelemetry, withSpan } from './index.js';

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
beforeAll(() => provider.register());
afterAll(() => provider.shutdown());
beforeEach(() => exporter.reset());

const finished = () => exporter.getFinishedSpans();
const parentIdOf = (s: ReturnType<typeof finished>[number]) => s.parentSpanContext?.spanId;
const TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/;

describe('traceparent', () => {
  it('is only available inside a span, in W3C format, and identifies that span', async () => {
    expect(currentTraceparent()).toBeUndefined();
    expect(currentTraceId()).toBeUndefined();
    await withSpan('outer', async (span) => {
      const tp = currentTraceparent()!;
      expect(tp).toMatch(TRACEPARENT);
      expect(tp).toContain(span.spanContext().traceId);
      expect(tp).toContain(span.spanContext().spanId);
      expect(currentTraceId()).toBe(span.spanContext().traceId);
    });
  });

  it('contextFromTraceparent ignores garbage and absent values instead of throwing', () => {
    for (const bad of [undefined, '', 'garbage', '00-short-span-01']) {
      const ctx = contextFromTraceparent(bad);
      expect(trace.getSpan(ctx)?.spanContext().traceId).toBeUndefined();
    }
  });
});

describe('withSpan', () => {
  it('nests under the active span by default (same trace, parent = outer)', async () => {
    await withSpan('outer', async () => withSpan('inner', async () => undefined));
    const [inner, outer] = finished();
    expect(inner!.name).toBe('inner');
    expect(inner!.spanContext().traceId).toBe(outer!.spanContext().traceId);
    expect(parentIdOf(inner!)).toBe(outer!.spanContext().spanId);
  });

  it('with a parentTraceparent CONTINUES that trace even from a completely different call stack (the Kafka case)', async () => {
    let carried = '';
    await withSpan('http POST /payments', async () => {
      carried = currentTraceparent()!; // what emitEvent stores in the event
    });
    exporter.reset();
    // later, elsewhere, with no active span: a consumer handles the event
    expect(currentTraceparent()).toBeUndefined();
    await withSpan('consume payment.succeeded', async () => undefined, { parentTraceparent: carried, kind: SpanKind.CONSUMER });
    const [consumer] = finished();
    const original = carried.split('-');
    expect(consumer!.spanContext().traceId).toBe(original[1]); // same trace id
    expect(parentIdOf(consumer!)).toBe(original[2]); // child of the originating span
    expect(consumer!.kind).toBe(SpanKind.CONSUMER);
  });

  it('records the error, marks the span failed, rethrows, and still ends the span', async () => {
    await expect(withSpan('boom', async () => { throw new Error('kaboom'); })).rejects.toThrow('kaboom');
    const [s] = finished();
    expect(s!.status.code).toBe(SpanStatusCode.ERROR);
    expect(s!.events.some((e) => e.name === 'exception')).toBe(true);
    expect(context.active()).toBeDefined();
  });

  it('returns the function result and carries attributes', async () => {
    const r = await withSpan('calc', async () => 42, { attributes: { 'zerodrift.test': 'yes' } });
    expect(r).toBe(42);
    expect(finished()[0]!.attributes['zerodrift.test']).toBe('yes');
  });
});

describe('initTelemetry', () => {
  it('is a no-op (returns null, installs nothing) when no collector endpoint is configured', () => {
    expect(initTelemetry({ serviceName: 'x' })).toBeNull();
    expect(initTelemetry({ serviceName: 'x', endpoint: '' })).toBeNull();
  });
});
