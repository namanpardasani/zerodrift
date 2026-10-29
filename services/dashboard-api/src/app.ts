import 'reflect-metadata';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { type INestApplication, Module } from '@nestjs/common';
import { APP_FILTER, NestFactory } from '@nestjs/core';
import { ErrorFilter, createHealthModule, createLogger, requestMiddleware } from '@zerodrift/common';
import express, { type NextFunction, type Request, type Response } from 'express';
import { ApiController, AuthController } from './api.controller.js';
import { CONFIG, JwtGuard, LoginLimiter, TokenService } from './auth.js';
import { ChaosLoadService } from './chaos-load.service.js';
import { type DashboardConfig, DEV_DEFAULTS } from './config.js';
import { MetricsService } from './metrics.service.js';

export interface RunningDashboardApi {
  app: INestApplication;
  url: string;
  close: () => Promise<void>;
}

/** Production must not run with the well-known development secrets. */
export function assertProductionSafe(nodeEnv: string, c: DashboardConfig): void {
  if (nodeEnv !== 'production') return;
  const problems: string[] = [];
  if (c.jwtSecret === DEV_DEFAULTS.jwtSecret || c.jwtSecret.length < 32) problems.push('JWT_SECRET must be a unique secret of at least 32 characters');
  if (c.operatorPassword === DEV_DEFAULTS.operatorPassword) problems.push('DASHBOARD_PASSWORD must not be the development default');
  if (c.adminToken === DEV_DEFAULTS.adminToken) problems.push('ADMIN_TOKEN must not be the development default');
  if (problems.length) throw new Error(`Refusing to start in production: ${problems.join('; ')}`);
}

export async function startDashboardApi(opts: { port: number; config: DashboardConfig; nodeEnv?: string; logLevel?: string }): Promise<RunningDashboardApi> {
  assertProductionSafe(opts.nodeEnv ?? 'development', opts.config);
  if (opts.config.jwtSecret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');
  const log = createLogger('dashboard-api', opts.logLevel ?? 'info');

  @Module({
    imports: [createHealthModule('dashboard-api')],
    controllers: [AuthController, ApiController],
    providers: [{ provide: CONFIG, useValue: opts.config }, { provide: APP_FILTER, useClass: ErrorFilter }, TokenService, LoginLimiter, JwtGuard, MetricsService, ChaosLoadService],
  })
  class DashboardModule {}

  const app = await NestFactory.create(DashboardModule, { logger: opts.logLevel === 'silent' ? false : ['error', 'warn', 'log'] });
  const http = app.getHttpAdapter().getInstance() as express.Express;
  http.disable('x-powered-by');
  app.use(requestMiddleware(log));

  // Baseline security headers for everything we serve. CSP: only our own origin may supply scripts/styles/images/XHR.
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'");
    next();
  });

  // CORS only for explicitly allowed origins (the Vite dev server). Same-origin needs none.
  const allowed = new Set(opts.config.allowedOrigins);
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin && allowed.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      if (req.method === 'OPTIONS') return void res.status(204).end();
    }
    next();
  });
  app.enableShutdownHooks();

  // Serve the built React app (same origin as the API) with SPA fallback for client-side routes.
  if (opts.config.staticDir && existsSync(path.join(opts.config.staticDir, 'index.html'))) {
    const dir = path.resolve(opts.config.staticDir);
    app.use(express.static(dir, { index: false, maxAge: '1h' }));
    app.use((req: Request, res: Response, next: NextFunction) => {
      const isApi = req.path.startsWith('/api') || req.path.startsWith('/auth') || req.path === '/health' || req.path === '/ready' || req.path === '/metrics';
      if (req.method === 'GET' && !isApi && !/\.\w+$/.test(req.path)) return void res.sendFile(path.join(dir, 'index.html'));
      next();
    });
    log.info({ dir }, 'serving dashboard static files');
  }

  await app.listen(opts.port, '0.0.0.0');
  const port = (app.getHttpServer().address() as AddressInfo).port;
  return { app, url: `http://127.0.0.1:${port}`, close: () => app.close() };
}
