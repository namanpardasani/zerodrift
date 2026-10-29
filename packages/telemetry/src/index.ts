import { type Attributes, type Context, ROOT_CONTEXT, type Span, SpanKind, SpanStatusCode, context, propagation, trace } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

export { SpanKind, SpanStatusCode };

/**
 * Distributed tracing with OpenTelemetry.
 *
 * A TRACE is the whole story of one operation (e.g. "customer paid"); a SPAN is one step in it
 * (an HTTP request, a SQL query, a Kafka message handled). Automatic instrumentation covers HTTP
 * (server and fetch client), Express routes and PostgreSQL, and the W3C `traceparent` header carries
 * the trace between services. Kafka has no such automatic carrier here, so we carry `traceparent`
 * INSIDE the event envelope (see emitEvent / the consumer): the asynchronous half of a payment then
 * shows up in the SAME trace as the request that caused it.
 *
 * Tracing is OFF unless OTEL_EXPORTER_OTLP_ENDPOINT is set: no overhead, no dependency on a collector.
 */
export interface TelemetryOptions {
  serviceName: string;
  /** e.g. http://jaeger:4318 (OTLP over HTTP). */
  endpoint?: string;
}

const QUIET = new Set(['/health', '/ready', '/metrics']);

export function initTelemetry(opts: TelemetryOptions): { shutdown: () => Promise<void> } | null {
  if (!opts.endpoint) return null;
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: opts.serviceName }),
    traceExporter: new OTLPTraceExporter({ url: `${opts.endpoint.replace(/\/$/, '')}/v1/traces` }),
    instrumentations: [
      // health checks and Prometheus scrapes every few seconds would drown the interesting traces
      new HttpInstrumentation({ ignoreIncomingRequestHook: (req) => QUIET.has((req.url ?? '').split('?')[0] ?? '') }),
      new ExpressInstrumentation(),
      new PgInstrumentation(),
      new UndiciInstrumentation(),
    ],
  });
  sdk.start();
  return { shutdown: () => sdk.shutdown() };
}

const tracer = () => trace.getTracer('zerodrift');

/** The W3C traceparent of the currently active span (`00-<traceId>-<spanId>-<flags>`), if tracing is on. */
export function currentTraceparent(): string | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent;
}

export function currentTraceId(): string | undefined {
  const sc = trace.getSpan(context.active())?.spanContext();
  return sc && trace.isSpanContextValid(sc) ? sc.traceId : undefined;
}

/** Rebuild a context from a stored traceparent so new spans become children of the original operation. */
export function contextFromTraceparent(traceparent: string | undefined): Context {
  if (!traceparent) return ROOT_CONTEXT;
  return propagation.extract(ROOT_CONTEXT, { traceparent });
}

/**
 * Run `fn` inside a new span. With `parentTraceparent` the span continues THAT trace (used for the
 * asynchronous steps: Kafka consumers, webhook delivery); otherwise it nests under whatever is active.
 * Errors are recorded on the span and rethrown; the span always ends.
 */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  opts: { parentTraceparent?: string; kind?: SpanKind; attributes?: Attributes } = {},
): Promise<T> {
  const parent = opts.parentTraceparent ? contextFromTraceparent(opts.parentTraceparent) : context.active();
  const span = tracer().startSpan(name, { kind: opts.kind ?? SpanKind.INTERNAL, attributes: opts.attributes }, parent);
  try {
    return await context.with(trace.setSpan(parent, span), () => fn(span));
  } catch (err) {
    span.recordException(err as Error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
    throw err;
  } finally {
    span.end();
  }
}
