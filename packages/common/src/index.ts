import 'reflect-metadata';
import { type ArgumentsHost, Catch, Controller, type ExceptionFilter, Get, Header, HttpException, Logger as NestLogger, Module, ServiceUnavailableException, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

type AppModuleRef = Parameters<typeof NestFactory.create>[0];
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
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

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/** Domain errors carry a stable machine-readable `code` and the HTTP status they map to. */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** One error shape for every service: { error: { code, message, details? } }. */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly log = new NestLogger('ErrorFilter');

  catch(err: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (err instanceof DomainError) {
      if (err.status === 429 && typeof err.details?.retryAfterSeconds === 'number') {
        res.setHeader('Retry-After', String(err.details.retryAfterSeconds));
      }
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof ZodError) {
      return res.status(400).json({
        error: {
          code: 'validation_error',
          message: 'Invalid request',
          details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      });
    }
    if (err instanceof HttpException) {
      return res.status(err.getStatus()).json({ error: { code: 'http_error', message: err.message } });
    }
    this.log.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    return res.status(500).json({ error: { code: 'internal_error', message: 'Internal server error' } });
  }
}

// ---------------------------------------------------------------------------------------------
// Retry with exponential backoff + full jitter
// ---------------------------------------------------------------------------------------------

export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  /** Injectable for tests; defaults to Math.random. */
  random?: () => number;
}

/**
 * Delay before retry number `attempt` (0-based): a random value in [0, min(maxMs, baseMs * 2^attempt)].
 * "Full jitter": the exponential term spreads load as failures persist, and the randomness stops a
 * crowd of clients that failed together from retrying together (a thundering herd).
 */
export function backoffDelayMs(attempt: number, { baseMs, maxMs, random = Math.random }: BackoffOptions): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.min(ceiling, Math.floor(random() * (ceiling + 1)));
}

export interface RetryOptions extends BackoffOptions {
  /** Number of RETRIES after the first attempt (total attempts = retries + 1). */
  retries: number;
  /** Return false for errors that can never succeed on retry (e.g. validation). Default: retry all. */
  shouldRetry?: (err: unknown) => boolean;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  sleep?: (ms: number) => Promise<void>;
}

export async function retry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= opts.retries || (opts.shouldRetry && !opts.shouldRetry(err))) throw err;
      const delay = backoffDelayMs(attempt, opts);
      opts.onRetry?.(err, attempt + 1, delay);
      await sleep(delay);
    }
  }
}
