import { CanActivate, Controller, ExecutionContext, Get, HttpCode, Inject, Injectable, Param, Post, Query, Body, UseGuards, Res } from '@nestjs/common';
import { DomainError } from '@zerodrift/common';
import { z } from '@zerodrift/config';
import { timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { Reconciler } from './reconciler.service.js';

export const ADMIN_TOKEN = Symbol('RECON_ADMIN_TOKEN');

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(@Inject(ADMIN_TOKEN) private readonly token: string) {}
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const given = Buffer.from(String(req.headers['x-admin-token'] ?? ''));
    const expected = Buffer.from(this.token);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new DomainError('unauthorized', 'Admin token required', 401);
    return true;
  }
}

const runBody = z.object({
  kind: z.enum(['internal', 'external']),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});
const listQuery = z.object({ kind: z.enum(['internal', 'external']).optional(), limit: z.coerce.number().int().positive().max(200).optional() });
const uuid = z.string().uuid();

/** Operator API (the dashboard will sit on top of this with its own login in Phase 7/8). */
@Controller('v1/recon')
@UseGuards(AdminGuard)
export class ReconController {
  constructor(private readonly recon: Reconciler) {}

  /** Run now and wait for the report. 409 if a run of that kind is already in progress. */
  @Post('runs')
  @HttpCode(200)
  async run(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const b = runBody.parse(body);
    const run = await this.recon.run(b.kind, { from: b.from ? new Date(b.from) : undefined, to: b.to ? new Date(b.to) : undefined, trigger: 'manual' });
    if (!run) {
      res.status(409);
      return { error: { code: 'run_in_progress', message: `A ${b.kind} reconciliation is already running` } };
    }
    return run;
  }

  @Get('runs')
  async list(@Query() q: unknown) {
    return { runs: await this.recon.listRuns(listQuery.parse(q)) };
  }

  @Get('runs/:id')
  async get(@Param('id') id: string) {
    const parsed = uuid.parse(id);
    try {
      return await this.recon.getRun(parsed, true);
    } catch {
      throw new DomainError('not_found', `Run ${id} not found`, 404);
    }
  }

  @Get('latest')
  async latest() {
    return this.recon.latest();
  }
}
