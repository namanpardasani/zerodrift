import type { INestApplication } from '@nestjs/common';
import { context, trace } from '@opentelemetry/api';
import { NestFactory } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';
import type { Logger } from 'pino';
import { Counter, Histogram } from 'prom-client';
import { acceptCorrelationId, runWithContext } from './context.js';
import { createLogger } from './logger.js';
import { registry } from './metrics.js';

type AppModuleRef = Parameters<typeof NestFactory.create>[0];

export const httpRequests = new Counter({
  name: 'http_requests_total',
  help: 'HTTP requests by method, route and status',
  labelNames: ['method', 'route', 'status'],
  registers: [registry],
});

/** Request latency. Buckets cover fast reads (5 ms) up to slow saga/gateway calls (10 s). */
export const httpDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

const QUIET_PATHS = new Set(['/health', '/ready', '/metrics']);

/**
 * For every request: establish the correlation id (reuse the caller's if it is safe, else mint one),
 * make it available to all code the request calls, echo it back, record count + latency metrics, and
 * write ONE structured log line when the response finishes. The line contains the ROUTE PATTERN, never
 * the query string, headers or body (those can carry PII and credentials).
 */
export function requestMiddleware(log: Logger) {
  return (req: Request, res: Response, next: NextFunction) => {
    const correlationId = acceptCorrelationId(req.headers['x-correlation-id']);
    req.headers['x-correlation-id'] = correlationId;
    res.setHeader('x-correlation-id', correlationId);
    const started = process.hrtime.bigint();
    const sc = trace.getSpan(context.active())?.spanContext();
    const traceId = sc && trace.isSpanContextValid(sc) ? sc.traceId : undefined; // lets a log line be found from a trace and vice versa

    res.on('finish', () => {
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      const route = (req.route?.path as string | undefined) ?? 'unmatched';
      const labels = { method: req.method, route, status: String(res.statusCode) };
      httpRequests.inc(labels);
      httpDuration.observe(labels, seconds);
      if (!QUIET_PATHS.has(req.path)) {
        const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
        log[level]({ correlationId, traceId, method: req.method, route, status: res.statusCode, durationMs: Math.round(seconds * 1000) }, 'request');
      }
    });
    runWithContext({ correlationId }, next);
  };
}

/** Back-compat export for services that only want the old behaviour. */
export const correlationMiddleware = requestMiddleware(createLogger('app', 'silent'));

/** Baseline hardening headers for API responses (JSON only, never rendered by browsers). */
export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.removeHeader('X-Powered-By');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store'); // API responses can contain financial data: never cache them
  next();
}

export interface BootstrapOptions {
  silent?: boolean;
  logLevel?: string;
}

/** Boot a Nest app with the shared middleware, safe server timeouts and graceful shutdown. */
export async function bootstrap(module: AppModuleRef, port: number, service: string, opts: BootstrapOptions = {}) {
  const app: INestApplication = await NestFactory.create(module, { logger: opts.silent ? false : ['error', 'warn', 'log'] });
  const log = createLogger(service, opts.silent ? 'silent' : (opts.logLevel ?? process.env.LOG_LEVEL ?? 'info'));
  app.use(securityHeaders);
  app.use(requestMiddleware(log));
  app.enableShutdownHooks(); // SIGTERM (k8s pod kill) lets in-flight requests finish
  await app.listen(port, '0.0.0.0');

  // Slowloris protection and connection reuse: slow clients cannot hold sockets open forever, and the
  // keep-alive window is longer than typical load-balancer idle timeouts (avoids resets on reused sockets).
  const server = app.getHttpServer() as import('node:http').Server;
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 65_000;

  log.info({ port }, 'listening');
  return app;
}
