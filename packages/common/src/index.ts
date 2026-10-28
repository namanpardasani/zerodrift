import 'reflect-metadata';
import { Controller, Get, Header, Module, ServiceUnavailableException, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

type AppModuleRef = Parameters<typeof NestFactory.create>[0];
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import pino, { type Logger } from 'pino';
import { Counter, Registry, collectDefaultMetrics } from 'prom-client';

export function createLogger(service: string, level = 'info'): Logger {
  return pino({
    level,
    base: { service },
    // Never log secrets or card/PII fields, even if a caller passes them by accident.
    redact: ['req.headers.authorization', 'req.headers["x-api-key"]', '*.password', '*.secret', '*.apiKey'],
  });
}

/** One Prometheus registry per process, exposed at GET /metrics. */
export const registry = new Registry();
collectDefaultMetrics({ register: registry });
export const httpRequests = new Counter({
  name: 'http_requests_total',
  help: 'HTTP requests by method, route and status',
  labelNames: ['method', 'route', 'status'],
  registers: [registry],
});

export interface HealthCheck {
  name: string;
  check: () => Promise<void>;
}

/** Build a controller exposing /health (liveness) and /ready (dependencies) plus /metrics. */
export function createHealthModule(service: string, checks: HealthCheck[] = []) {
  @Controller()
  class HealthController {
    @Get('health')
    health() {
      return { status: 'ok', service };
    }

    @Get('ready')
    async ready() {
      const results: Record<string, string> = {};
      let ok = true;
      for (const c of checks) {
        try {
          await c.check();
          results[c.name] = 'up';
        } catch (err) {
          ok = false;
          results[c.name] = `down: ${(err as Error).message}`;
        }
      }
      if (!ok) throw new ServiceUnavailableException({ status: 'unready', checks: results });
      return { status: 'ready', service, checks: results };
    }

    // Prometheus rejects scrapes that are not served as its exposition content type.
    @Get('metrics')
    @Header('Content-Type', registry.contentType)
    async metrics() {
      return registry.metrics();
    }
  }

  @Module({ controllers: [HealthController] })
  class HealthModule {}
  return HealthModule;
}

/** Attach a correlation id to every request (reuse the caller's if present). */
export function correlationMiddleware(req: Request, res: Response, next: NextFunction) {
  const id = (req.headers['x-correlation-id'] as string | undefined) ?? randomUUID();
  req.headers['x-correlation-id'] = id;
  res.setHeader('x-correlation-id', id);
  res.on('finish', () => {
    httpRequests.inc({ method: req.method, route: req.route?.path ?? 'unmatched', status: res.statusCode });
  });
  next();
}

/** Boot a Nest app with the shared middleware and graceful shutdown. */
export async function bootstrap(module: AppModuleRef, port: number, service: string) {
  const app: INestApplication = await NestFactory.create(module, { logger: ['error', 'warn', 'log'] });
  app.use(correlationMiddleware);
  app.enableShutdownHooks(); // SIGTERM (k8s pod kill) lets in-flight requests finish
  await app.listen(port, '0.0.0.0');
  createLogger(service).info({ port }, 'listening');
  return app;
}
