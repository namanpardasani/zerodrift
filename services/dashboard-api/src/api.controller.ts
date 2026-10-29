import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import { DomainError } from '@zerodrift/common';
import { z } from '@zerodrift/config';
import type { Request, Response } from 'express';
import { CONFIG, JwtGuard, LoginLimiter, TokenService, safeEqual } from './auth.js';
import { ChaosLoadService } from './chaos-load.service.js';
import type { DashboardConfig } from './config.js';
import { MetricsService } from './metrics.service.js';
import { Upstream } from './upstream.js';

const loginBody = z.object({ username: z.string().min(1).max(100), password: z.string().min(1).max(200) });
const uuid = z.string().uuid();
const loadBody = z.object({
  count: z.number().int().min(1).max(500).default(30),
  amountMinor: z.number().int().min(100).max(1_000_000).default(1_500),
  concurrency: z.number().int().min(1).max(25).default(5),
  duplicateRate: z.number().min(0).max(0.5).default(0.1),
  customers: z.number().int().min(1).max(50).default(10),
});
const runBody = z.object({ kind: z.enum(['internal', 'external']) });

/** Query string -> URLSearchParams, allowing only the listed keys (nothing else is forwarded upstream). */
function pick(q: Record<string, unknown>, allowed: string[]): string {
  const p = new URLSearchParams();
  for (const k of allowed) if (typeof q[k] === 'string' && q[k]) p.set(k, q[k] as string);
  const s = p.toString();
  return s ? `?${s}` : '';
}

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(CONFIG) private readonly config: DashboardConfig,
    private readonly tokens: TokenService,
    private readonly limiter: LoginLimiter,
  ) {}

  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: Request) {
    const ip = req.ip ?? 'unknown';
    this.limiter.assertAllowed(ip);
    const { username, password } = loginBody.parse(body);
    // evaluate BOTH comparisons so timing does not reveal whether the username was right
    const userOk = safeEqual(username, this.config.operatorUser);
    const passOk = safeEqual(password, this.config.operatorPassword);
    if (!(userOk && passOk)) {
      this.limiter.recordFailure(ip);
      throw new DomainError('invalid_credentials', 'Wrong username or password', 401);
    }
    this.limiter.clear(ip);
    return { ...(await this.tokens.issue(username)), user: username };
  }

  @Get('me')
  @UseGuards(JwtGuard)
  me(@Req() req: Request & { operator?: string }) {
    return { user: req.operator };
  }
}

/** Everything under /api needs a valid operator JWT. The BFF calls the services with their admin tokens. */
@Controller('api')
@UseGuards(JwtGuard)
export class ApiController {
  private readonly ledger: Upstream;
  private readonly payments: Upstream;
  private readonly webhook: Upstream;
  private readonly recon: Upstream;
  private readonly chaos: Upstream;
  private readonly admin: Record<string, string>;

  constructor(
    @Inject(CONFIG) private readonly config: DashboardConfig,
    private readonly metrics: MetricsService,
    private readonly load: ChaosLoadService,
  ) {
    this.admin = { 'x-admin-token': config.adminToken };
    this.ledger = new Upstream('ledger', config.upstreams.ledger);
    this.payments = new Upstream('payments', config.upstreams.payments, this.admin);
    this.webhook = new Upstream('webhook', config.upstreams.webhook, this.admin);
    this.recon = new Upstream('reconciliation', config.upstreams.reconciliation, this.admin, 60_000);
    this.chaos = new Upstream('chaos-controller', config.upstreams.chaos, this.admin);
  }

  // ------------------------------------------------------------------ overview
  @Get('overview')
  async overview() {
    const ping = async (name: string, base: string) => {
      const t0 = Date.now();
      try {
        const r = await fetch(`${base}/ready`, { signal: AbortSignal.timeout(3_000) });
        return { name, up: r.ok, latencyMs: Date.now() - t0 };
      } catch {
        return { name, up: false, latencyMs: null };
      }
    };
    const u = this.config.upstreams;
    const [services, payments, webhooks, recon, invariants] = await Promise.all([
      Promise.all([ping('ledger', u.ledger), ping('payments', u.payments), ping('webhook', u.webhook), ping('reconciliation', u.reconciliation)]),
      this.payments.request('GET', '/admin/stats').then((r) => (r.status === 200 ? r.data : null)).catch(() => null),
      this.webhook.request('GET', '/admin/webhook-stats').then((r) => (r.status === 200 ? r.data : null)).catch(() => null),
      this.recon.request('GET', '/v1/recon/latest').then((r) => (r.status === 200 ? r.data : null)).catch(() => null),
      this.ledger.request('GET', '/internal/invariants').then((r) => (r.status === 200 ? r.data : null)).catch(() => null),
    ]);
    return { services, payments, webhooks, reconciliation: recon, ledgerInvariants: invariants };
  }

  // ------------------------------------------------------------------ accounts & ledger
  @Get('accounts')
  async accounts(@Query() q: Record<string, string>) {
    return this.ledger.ok('GET', `/accounts${pick(q, ['ownerType', 'ownerId', 'limit'])}`);
  }

  @Get('accounts/:id')
  async account(@Param('id') id: string) {
    return this.ledger.ok('GET', `/accounts/${uuid.parse(id)}`);
  }

  @Get('accounts/:id/entries')
  async entries(@Param('id') id: string, @Query() q: Record<string, string>) {
    return this.ledger.ok('GET', `/accounts/${uuid.parse(id)}/entries${pick(q, ['limit', 'before'])}`);
  }

  @Get('ledger/transactions')
  async transactions(@Query() q: Record<string, string>) {
    return this.ledger.ok('GET', `/internal/transactions${pick({ order: 'desc', limit: '50', ...q }, ['type', 'limit', 'after', 'order'])}`);
  }

  @Get('ledger/transactions/:id')
  async transaction(@Param('id') id: string) {
    return this.ledger.ok('GET', `/transactions/${uuid.parse(id)}`);
  }

  @Get('ledger/invariants')
  async invariants() {
    return this.ledger.ok('GET', '/internal/invariants');
  }

  // ------------------------------------------------------------------ payments
  @Get('merchants')
  async merchants() {
    return this.payments.ok('GET', '/admin/merchants');
  }

  @Get('payments')
  async paymentsList(@Query() q: Record<string, string>) {
    return this.payments.ok('GET', `/admin/payments${pick(q, ['status', 'merchantId', 'limit', 'before'])}`);
  }

  @Get('payments/:id')
  async payment(@Param('id') id: string) {
    return this.payments.ok('GET', `/admin/payments/${uuid.parse(id)}`);
  }

  @Post('recovery/run')
  @HttpCode(200)
  async runRecovery() {
    return this.payments.ok('POST', '/internal/recovery/run', {});
  }

  // ------------------------------------------------------------------ webhooks
  @Get('webhooks/deliveries')
  async deliveries(@Query() q: Record<string, string>) {
    return this.webhook.ok('GET', `/admin/webhook-deliveries${pick(q, ['status', 'endpointId', 'eventId', 'limit'])}`);
  }

  @Get('webhooks/deliveries/:id')
  async delivery(@Param('id') id: string) {
    return this.webhook.ok('GET', `/admin/webhook-deliveries/${uuid.parse(id)}`);
  }

  @Post('webhooks/deliveries/:id/replay')
  @HttpCode(200)
  async replay(@Param('id') id: string) {
    return this.webhook.ok('POST', `/admin/webhook-deliveries/${uuid.parse(id)}/replay`, {});
  }

  @Get('webhooks/endpoints')
  async endpoints(@Query() q: Record<string, string>) {
    return this.webhook.ok('GET', `/admin/webhook-endpoints${pick(q, ['merchantId'])}`);
  }

  @Get('webhooks/stats')
  async webhookStats() {
    return this.webhook.ok('GET', '/admin/webhook-stats');
  }

  // ------------------------------------------------------------------ reconciliation
  @Get('recon/latest')
  async reconLatest() {
    return this.recon.ok('GET', '/v1/recon/latest');
  }

  @Get('recon/runs')
  async reconRuns(@Query() q: Record<string, string>) {
    return this.recon.ok('GET', `/v1/recon/runs${pick(q, ['kind', 'limit'])}`);
  }

  @Get('recon/runs/:id')
  async reconRun(@Param('id') id: string) {
    return this.recon.ok('GET', `/v1/recon/runs/${uuid.parse(id)}`);
  }

  @Post('recon/runs')
  @HttpCode(200)
  async reconStart(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.recon.request('POST', '/v1/recon/runs', runBody.parse(body));
    res.status(r.status);
    return r.data;
  }

  // ------------------------------------------------------------------ audit trail
  /** Both services' append-only audit trails merged, newest first. A service being down only hides ITS entries. */
  @Get('audit')
  async audit(@Query() q: Record<string, string>) {
    const qs = pick(q, ['merchantId', 'action', 'limit']);
    const [payments, webhook] = await Promise.all([
      this.payments.request<{ logs: Record<string, unknown>[] }>('GET', `/admin/audit-logs${qs}`).then((r) => (r.status === 200 ? r.data.logs : null)).catch(() => null),
      this.webhook.request<{ logs: Record<string, unknown>[] }>('GET', `/admin/audit-logs${qs}`).then((r) => (r.status === 200 ? r.data.logs : null)).catch(() => null),
    ]);
    const tag = (rows: Record<string, unknown>[] | null, source: string) => (rows ?? []).map((l) => ({ ...l, source, at: String(l.at ?? '') }));
    const logs = [...tag(payments, 'payments'), ...tag(webhook, 'webhook')].sort((a, b) => b.at.localeCompare(a.at));
    return { logs: logs.slice(0, Math.min(Number(q.limit) || 100, 500)), unavailable: [...(payments ? [] : ['payments']), ...(webhook ? [] : ['webhook'])] };
  }

  // ------------------------------------------------------------------ metrics
  @Get('metrics/summary')
  async metricsSummary() {
    return this.metrics.summary();
  }

  @Get('metrics/range/:name')
  async metricsRange(@Param('name') name: string, @Query('minutes') minutes?: string) {
    const r = await this.metrics.range(name, Math.min(Math.max(Number(minutes) || 15, 1), 120));
    if (!r) throw new DomainError('not_found', `Unknown metric "${name}"`, 404);
    return r;
  }

  // ------------------------------------------------------------------ chaos (proxied; the controller is dev-only)
  @Get('chaos/status')
  async chaosStatus() {
    // 404 means "chaos is switched off here" (the controller hides itself). A controller that is merely
    // unreachable is NOT the same thing: let that surface as an error instead of claiming it is disabled.
    const r = await this.chaos.request('GET', '/chaos/status');
    if (r.status === 404) return { enabled: false };
    if (r.status >= 400) throw new DomainError('upstream_error', `chaos-controller answered HTTP ${r.status}`, 502);
    return r.data;
  }

  @Get('chaos/events')
  async chaosEvents() {
    const r = await this.chaos.request('GET', '/chaos/events').catch(() => null);
    return r && r.status === 200 ? r.data : { events: [] };
  }

  @Post('chaos/services/:name/:action')
  @HttpCode(200)
  async chaosService(@Param('name') name: string, @Param('action') action: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.chaos.request('POST', `/chaos/services/${encodeURIComponent(name)}/${encodeURIComponent(action)}`, body ?? {});
    res.status(r.status);
    return r.data;
  }

  @Put('chaos/gateway')
  async chaosGateway(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.chaos.request('PUT', '/chaos/gateway', body);
    res.status(r.status);
    return r.data;
  }

  @Post('chaos/gateway/reset')
  @HttpCode(200)
  async chaosGatewayReset() {
    return this.chaos.ok('POST', '/chaos/gateway/reset', {});
  }

  @Post('chaos/network/:proxy/toxics')
  @HttpCode(200)
  async chaosToxic(@Param('proxy') proxy: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.chaos.request('POST', `/chaos/network/${encodeURIComponent(proxy)}/toxics`, body);
    res.status(r.status);
    return r.data;
  }

  @Delete('chaos/network/:proxy/toxics/:toxic')
  @HttpCode(204)
  async chaosToxicRemove(@Param('proxy') proxy: string, @Param('toxic') toxic: string) {
    await this.chaos.request('DELETE', `/chaos/network/${encodeURIComponent(proxy)}/toxics/${encodeURIComponent(toxic)}`);
  }

  @Post('chaos/network/:proxy/enabled')
  @HttpCode(200)
  async chaosProxyEnabled(@Param('proxy') proxy: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.chaos.request('POST', `/chaos/network/${encodeURIComponent(proxy)}/enabled`, body);
    res.status(r.status);
    return r.data;
  }

  @Post('chaos/reset')
  @HttpCode(200)
  async chaosReset() {
    return this.chaos.ok('POST', '/chaos/reset', {});
  }

  /** Fire demo payments (with some deliberate duplicates) so recovery can be watched while faults are active. */
  @Post('chaos/load')
  @HttpCode(200)
  async chaosLoad(@Body() body: unknown) {
    return this.load.run(loadBody.parse(body ?? {}));
  }

  @Get('chaos/load/last')
  chaosLoadLast() {
    return { last: this.load.last };
  }
}
