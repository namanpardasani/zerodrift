import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { type INestApplication, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ErrorFilter, bootstrap, createHealthModule } from '@zerodrift/common';
import { GatewayControl, ToxiproxyControl } from './clients.js';
import { CHAOS_DEPS, ChaosController, ChaosGuard } from './chaos.controller.js';
import { DockerBackend } from './docker.js';

export interface ChaosAppOptions {
  port: number;
  nodeEnv: string;
  /** Explicit opt-in. Chaos is OFF unless this is true AND the environment is not production. */
  chaosEnabled: boolean;
  adminToken: string;
  dockerSocketPath: string;
  composeProject: string;
  gatewayUrl: string;
  toxiproxyUrl: string;
  logLevel?: string;
}

export interface RunningChaos {
  app: INestApplication;
  url: string;
  close: () => Promise<void>;
}

export async function startChaos(opts: ChaosAppOptions): Promise<RunningChaos> {
  // Fault injection must never exist in production. Refuse to even boot rather than trust a flag.
  if (opts.nodeEnv === 'production' && opts.chaosEnabled) {
    throw new Error('CHAOS_ENABLED=true is not allowed when NODE_ENV=production: refusing to start the chaos controller');
  }
  const enabled = opts.chaosEnabled && opts.nodeEnv !== 'production';

  @Module({
    imports: [createHealthModule('chaos-controller')],
    controllers: [ChaosController],
    providers: [
      {
        provide: CHAOS_DEPS,
        useValue: { enabled, adminToken: opts.adminToken, docker: new DockerBackend(opts.dockerSocketPath, opts.composeProject), gateway: new GatewayControl(opts.gatewayUrl), toxiproxy: new ToxiproxyControl(opts.toxiproxyUrl) },
      },
      { provide: APP_FILTER, useClass: ErrorFilter },
      ChaosGuard,
    ],
  })
  class ChaosModule {}

  const app = await bootstrap(ChaosModule, opts.port, 'chaos-controller', { silent: opts.logLevel === 'silent' });
  const port = (app.getHttpServer().address() as AddressInfo).port;
  return { app, url: `http://127.0.0.1:${port}`, close: () => app.close() };
}
