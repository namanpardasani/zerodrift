import { Registry, collectDefaultMetrics } from 'prom-client';

/** One Prometheus registry per process, exposed at GET /metrics. */
export const registry = new Registry();
collectDefaultMetrics({ register: registry });
