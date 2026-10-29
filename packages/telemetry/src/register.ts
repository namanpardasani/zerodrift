import { initTelemetry } from './index.js';

/**
 * `import '@zerodrift/telemetry/register'` as the FIRST import of a service's main.ts: the
 * instrumentation must patch `http`/`pg` before anything else loads them. Configured by environment:
 *   OTEL_SERVICE_NAME            name shown in the trace UI
 *   OTEL_EXPORTER_OTLP_ENDPOINT  collector, e.g. http://jaeger:4318 (unset = tracing off)
 */
const telemetry = initTelemetry({
  serviceName: process.env.OTEL_SERVICE_NAME ?? process.env.SERVICE_NAME ?? 'zerodrift',
  endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
});

// flush buffered spans when the process is asked to stop (k8s sends SIGTERM)
if (telemetry) {
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => void telemetry.shutdown().finally(() => process.kill(process.pid, sig)));
  }
}
