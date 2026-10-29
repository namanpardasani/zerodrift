import { CanActivate, Controller, Delete, ExecutionContext, Get, HttpCode, Inject, Injectable, NotFoundException, Param, Post, Put, UseGuards, Body } from '@nestjs/common';
import { DomainError } from '@zerodrift/common';
import { z } from '@zerodrift/config';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { type GatewayControl, type ToxiproxyControl } from './clients.js';
import { CHAOS_TARGETS, CONTAINER_ACTIONS, type ContainerAction, type DockerBackend } from './docker.js';

export const CHAOS_DEPS = Symbol('CHAOS_DEPS');
export interface ChaosDeps {
  enabled: boolean;
  adminToken: string;
  docker: DockerBackend;
  gateway: GatewayControl;
  toxiproxy: ToxiproxyControl;
}

export interface ChaosEvent {
  at: string;
  action: string;
  target: string;
  detail?: unknown;
}

/** Disabled mode: every chaos route looks like it does not exist. Enabled mode: admin token required. */
@Injectable()
export class ChaosGuard implements CanActivate {
  constructor(@Inject(CHAOS_DEPS) private readonly deps: ChaosDeps) {}
  canActivate(ctx: ExecutionContext): boolean {
    if (!this.deps.enabled) throw new NotFoundException();
    const req = ctx.switchToHttp().getRequest<Request>();
    const given = Buffer.from(String(req.headers['x-admin-token'] ?? ''));
    const expected = Buffer.from(this.deps.adminToken);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new DomainError('unauthorized', 'Admin token required', 401);
    return true;
  }
}

const gatewayBody = z
  .object({
    latencyMinMs: z.number().int().min(0).max(60_000),
    latencyMaxMs: z.number().int().min(0).max(60_000),
    declineRate: z.number().min(0).max(1),
    errorRate: z.number().min(0).max(1),
    lostResponseRate: z.number().min(0).max(1),
    duplicateCallbackRate: z.number().min(0).max(1),
    callbackDropRate: z.number().min(0).max(1),
  })
  .partial()
  .strict();

const toxicBody = z.object({
  type: z.enum(['latency', 'timeout', 'bandwidth', 'slow_close', 'limit_data', 'reset_peer']),
  name: z.string().regex(/^[a-z0-9_]{1,40}$/).optional(),
  stream: z.enum(['upstream', 'downstream']).optional(),
  toxicity: z.number().min(0).max(1).optional(),
  attributes: z.record(z.string(), z.number()).default({}),
});

const enabledBody = z.object({ enabled: z.boolean() });
const serviceBody = z.object({ restartAfterSeconds: z.number().int().min(0).max(120).optional() }).default({});

/** Dev-only fault injection API, driven by the dashboard's chaos panel. */
@Controller('chaos')
@UseGuards(ChaosGuard)
export class ChaosController {
  private events: ChaosEvent[] = [];
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(@Inject(CHAOS_DEPS) private readonly deps: ChaosDeps) {}

  private log(action: string, target: string, detail?: unknown) {
    this.events.unshift({ at: new Date().toISOString(), action, target, detail });
    this.events.length = Math.min(this.events.length, 200);
  }

  @Get('status')
  async status() {
    const settle = async <T>(p: Promise<T>): Promise<T | { error: string }> => p.catch((e: Error) => ({ error: e.message }));
    const [containers, gateway, proxies] = await Promise.all([settle(this.deps.docker.list()), settle(this.deps.gateway.get()), settle(this.deps.toxiproxy.proxies())]);
    return {
      enabled: true,
      targets: CHAOS_TARGETS,
      services: Array.isArray(containers) ? containers.filter((c) => CHAOS_TARGETS.includes(c.service as never)).map(({ service, state, status }) => ({ service, state, status })) : containers,
      gateway,
      network: proxies,
    };
  }

  @Get('events')
  eventLog() {
    return { events: this.events };
  }

  /**
   * kill (SIGKILL: a crash), restart, pause (freeze: a hang), unpause, stop, start. Only whitelisted services.
   * A single Docker host has no orchestrator to revive a crashed service (Kubernetes does, Phase 9), so
   * `restartAfterSeconds` on kill/stop emulates one: the service is started again after that delay.
   */
  @Post('services/:name/:action')
  @HttpCode(200)
  async serviceAction(@Param('name') name: string, @Param('action') action: string, @Body() body: unknown) {
    const { restartAfterSeconds } = serviceBody.parse(body ?? {});
    if (!(CHAOS_TARGETS as readonly string[]).includes(name)) throw new DomainError('target_not_allowed', `"${name}" cannot be targeted by chaos`, 403);
    if (!(CONTAINER_ACTIONS as readonly string[]).includes(action)) throw new DomainError('unknown_action', `unknown action "${action}"`, 400);
    try {
      await this.deps.docker.act(name, action as ContainerAction);
    } catch (err) {
      throw new DomainError('chaos_failed', (err as Error).message, 502);
    }
    this.log(action, name, restartAfterSeconds ? { restartAfterSeconds } : undefined);
    if (restartAfterSeconds && (action === 'kill' || action === 'stop')) {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        this.deps.docker
          .act(name, 'start')
          .then(() => this.log('auto_restart', name))
          .catch((e: Error) => this.log('auto_restart_failed', name, { error: e.message }));
      }, restartAfterSeconds * 1000);
      timer.unref();
      this.timers.add(timer);
    }
    return { ok: true, service: name, action, ...(restartAfterSeconds ? { restartsInSeconds: restartAfterSeconds } : {}) };
  }

  @Put('gateway')
  async setGateway(@Body() body: unknown) {
    const faults = gatewayBody.parse(body);
    const r = await this.deps.gateway.set(faults);
    if (r.status !== 200) throw new DomainError('chaos_failed', 'mock gateway rejected the settings', 502, { response: r.data as Record<string, unknown> });
    this.log('gateway_faults', 'mock-gateway', faults);
    return r.data;
  }

  @Post('gateway/reset')
  @HttpCode(200)
  async resetGateway() {
    this.log('gateway_faults_reset', 'mock-gateway');
    return this.deps.gateway.reset();
  }

  @Post('network/:proxy/toxics')
  @HttpCode(200)
  async addToxic(@Param('proxy') proxy: string, @Body() body: unknown) {
    const t = toxicBody.parse(body);
    const r = await this.deps.toxiproxy.addToxic(proxy, t);
    if (r.status >= 400) throw new DomainError('chaos_failed', 'toxiproxy rejected the toxic', 502, { response: r.data as Record<string, unknown> });
    this.log('toxic_added', proxy, t);
    return r.data;
  }

  @Delete('network/:proxy/toxics/:toxic')
  @HttpCode(204)
  async removeToxic(@Param('proxy') proxy: string, @Param('toxic') toxic: string) {
    const status = await this.deps.toxiproxy.removeToxic(proxy, toxic);
    if (status >= 400 && status !== 404) throw new DomainError('chaos_failed', 'toxiproxy could not remove the toxic', 502);
    this.log('toxic_removed', proxy, { toxic });
  }

  /** Disable a proxy = a hard network partition for the traffic that flows through it. */
  @Post('network/:proxy/enabled')
  @HttpCode(200)
  async setProxyEnabled(@Param('proxy') proxy: string, @Body() body: unknown) {
    const { enabled } = enabledBody.parse(body);
    const r = await this.deps.toxiproxy.setEnabled(proxy, enabled);
    if (r.status >= 400) throw new DomainError('chaos_failed', 'toxiproxy rejected the change', 502);
    this.log(enabled ? 'proxy_enabled' : 'proxy_disabled', proxy);
    return r.data;
  }

  /** Put everything back to normal: gateway faults off, toxics removed, frozen/stopped services resumed. */
  @Post('reset')
  @HttpCode(200)
  async reset() {
    for (const t of this.timers) clearTimeout(t); // pending auto-restarts are moot: reset starts everything itself
    this.timers.clear();
    const errors: string[] = [];
    await this.deps.gateway.reset().catch((e: Error) => errors.push(`gateway: ${e.message}`));
    await this.deps.toxiproxy.reset().catch((e: Error) => errors.push(`toxiproxy: ${e.message}`));
    const containers = await this.deps.docker.list().catch((e: Error) => {
      errors.push(`docker: ${e.message}`);
      return [];
    });
    for (const c of containers.filter((c) => CHAOS_TARGETS.includes(c.service as never))) {
      if (c.state === 'paused') await this.deps.docker.act(c.service, 'unpause').catch((e: Error) => errors.push(e.message));
      else if (c.state === 'exited' || c.state === 'created') await this.deps.docker.act(c.service, 'start').catch((e: Error) => errors.push(e.message));
    }
    this.log('reset', 'all', { errors });
    return { ok: errors.length === 0, errors };
  }
}
