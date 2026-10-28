import { Body, Controller, Get, Header, HttpCode, Inject, Param, Post, Put, Query, Res } from '@nestjs/common';
import { DomainError } from '@zerodrift/common';
import { z } from '@zerodrift/config';
import type { Response } from 'express';
import { FaultSettings } from './faults.js';
import { FAULTS, GatewayService, InjectedError, LOST } from './gateway.service.js';

const chargeBody = z.object({
  reference: z.string().min(1).max(100),
  amountMinor: z.union([z.string().regex(/^\d+$/), z.number().int().safe()]).transform((v) => BigInt(v)).refine((v) => v > 0n),
  currency: z.string().length(3).default('INR'),
  callbackUrl: z.string().url().optional(),
});

/** Run a gateway operation, turning injected faults into HTTP 500 and lost responses into silence. */
async function guarded<T>(res: Response, fn: () => Promise<T | typeof LOST>): Promise<T | undefined> {
  try {
    const out = await fn();
    if (out === LOST) {
      // Never answer. The caller's timeout fires; we free the socket when it gives up.
      res.req.on('close', () => res.end());
      return undefined;
    }
    return out;
  } catch (err) {
    if (err instanceof InjectedError) {
      res.status(500).json({ error: { code: 'gateway_error', message: err.message } });
      return undefined;
    }
    throw err;
  }
}

@Controller()
export class GatewayController {
  constructor(
    private readonly gateway: GatewayService,
    @Inject(FAULTS) private readonly faults: FaultSettings,
  ) {}

  @Post('charges')
  @HttpCode(200)
  async charge(@Body() body: unknown, @Res() res: Response) {
    const input = chargeBody.parse(body);
    const out = await guarded(res, () => this.gateway.charge(input));
    if (out) res.json(out);
  }

  @Get('charges/:reference')
  async get(@Param('reference') reference: string, @Res() res: Response) {
    const out = await guarded(res, async () => {
      const c = await this.gateway.get(reference);
      if (!c) throw new DomainError('not_found', `No charge ${reference}`, 404);
      return c;
    });
    if (out) res.json(out);
  }

  @Post('charges/:reference/cancel')
  @HttpCode(200)
  async cancel(@Param('reference') reference: string, @Res() res: Response) {
    const out = await guarded(res, () => this.gateway.cancel(reference));
    if (out) res.json(out);
  }

  @Post('charges/:reference/void')
  @HttpCode(200)
  async void(@Param('reference') reference: string, @Res() res: Response) {
    const out = await guarded(res, () => this.gateway.voidCharge(reference));
    if (out) res.json(out);
  }

  /** The daily settlement file the reconciliation service compares against (JSON or CSV). */
  @Get('settlement')
  @Header('Cache-Control', 'no-store')
  async settlement(@Query('date') date: string | undefined, @Query('format') format: string | undefined, @Res() res: Response) {
    const d = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).parse(date);
    const file = await this.gateway.settlement(d);
    if (format === 'csv') {
      const lines = ['reference,amount_minor,currency,status,created_at', ...file.charges.map((c) => `${c.reference},${c.amountMinor},${c.currency},${c.status},${c.createdAt}`)];
      res.type('text/csv').send(lines.join('\n') + '\n');
      return;
    }
    res.json(file);
  }

  // ---- fault control (dev only; the chaos-controller / dashboard use these)
  @Get('admin/faults')
  getFaults() {
    return this.faults.get();
  }

  @Put('admin/faults')
  setFaults(@Body() body: unknown) {
    return this.faults.set(body);
  }

  @Post('admin/faults/reset')
  @HttpCode(200)
  resetFaults() {
    return this.faults.reset();
  }
}
