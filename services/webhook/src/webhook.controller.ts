import { Body, Controller, Delete, Get, HttpCode, Ip, Param, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import type { ZodType } from 'zod';
import { AdminGuard, MerchantGuard, MerchantId } from './auth.js';
import { AuditService } from './audit.service.js';
import { DeliveriesService } from './deliveries.service.js';
import { EndpointsService } from './endpoints.service.js';
import * as s from './http.schemas.js';

const parse = <T>(schema: ZodType<T>, v: unknown): T => schema.parse(v); // ZodError -> 400 via the shared ErrorFilter

/** Merchant-facing API: manage endpoints, inspect the delivery log, replay. */
@Controller('v1')
@UseGuards(MerchantGuard)
export class WebhookController {
  constructor(
    private readonly endpoints: EndpointsService,
    private readonly deliveries: DeliveriesService,
  ) {}

  /** The response contains the signing secret exactly once: it cannot be retrieved later. */
  @Post('webhook-endpoints')
  async create(@MerchantId() m: string, @Body() body: unknown, @Ip() ip: string, @Res({ passthrough: true }) res: Response) {
    res.status(201);
    return this.endpoints.create(m, parse(s.createEndpointBody, body), ip);
  }

  @Get('webhook-endpoints')
  async list(@MerchantId() m: string) {
    return { endpoints: await this.endpoints.list(m) };
  }

  @Get('webhook-endpoints/:id')
  async get(@MerchantId() m: string, @Param('id') id: string) {
    return this.endpoints.get(m, parse(s.uuid, id));
  }

  @Patch('webhook-endpoints/:id')
  async update(@MerchantId() m: string, @Param('id') id: string, @Body() body: unknown, @Ip() ip: string) {
    return this.endpoints.update(m, parse(s.uuid, id), parse(s.updateEndpointBody, body), ip);
  }

  /** Disables the endpoint (history is kept). */
  @Delete('webhook-endpoints/:id')
  @HttpCode(204)
  async remove(@MerchantId() m: string, @Param('id') id: string, @Ip() ip: string) {
    await this.endpoints.disable(m, parse(s.uuid, id), ip);
  }

  @Post('webhook-endpoints/:id/rotate-secret')
  @HttpCode(200)
  async rotate(@MerchantId() m: string, @Param('id') id: string, @Ip() ip: string) {
    return this.endpoints.rotateSecret(m, parse(s.uuid, id), ip);
  }

  @Get('webhook-deliveries')
  async listDeliveries(@MerchantId() m: string, @Query() q: unknown) {
    return { deliveries: await this.deliveries.list({ ...parse(s.listDeliveriesQuery, q), merchantId: m }) };
  }

  @Get('webhook-deliveries/:id')
  async getDelivery(@MerchantId() m: string, @Param('id') id: string) {
    return this.deliveries.getOwned(m, parse(s.uuid, id));
  }

  @Post('webhook-deliveries/:id/replay')
  @HttpCode(200)
  async replay(@MerchantId() m: string, @Param('id') id: string, @Ip() ip: string) {
    return this.deliveries.replay(m, parse(s.uuid, id), ip);
  }

  @Post('webhook-events/:eventId/replay')
  @HttpCode(200)
  async replayEvent(@MerchantId() m: string, @Param('eventId') eventId: string, @Ip() ip: string) {
    return { deliveries: await this.deliveries.replayEvent(m, parse(s.uuid, eventId), ip) };
  }
}

/** Operator view across all merchants (used by the dashboard). */
@Controller('admin')
@UseGuards(AdminGuard)
export class WebhookAdminController {
  constructor(
    private readonly deliveries: DeliveriesService,
    private readonly endpointsSvc: EndpointsService,
    private readonly audit: AuditService,
  ) {}

  @Get('webhook-deliveries')
  async list(@Query() q: unknown) {
    return { deliveries: await this.deliveries.list(parse(s.listDeliveriesQuery, q)) };
  }

  @Get('webhook-deliveries/:id')
  async get(@Param('id') id: string) {
    return this.deliveries.getOwned(undefined, parse(s.uuid, id));
  }

  @Post('webhook-deliveries/:id/replay')
  @HttpCode(200)
  async replay(@Param('id') id: string, @Ip() ip: string) {
    return this.deliveries.replay(undefined, parse(s.uuid, id), ip);
  }

  @Get('webhook-endpoints')
  async endpoints(@Query('merchantId') merchantId?: string) {
    return { endpoints: await this.endpointsSvc.listAll(merchantId) };
  }

  @Get('audit-logs')
  async auditLogs(@Query() q: Record<string, string>) {
    return { logs: await this.audit.list({ merchantId: q.merchantId, action: q.action, limit: q.limit ? Number(q.limit) : undefined }) };
  }

  @Get('webhook-stats')
  async stats() {
    return this.deliveries.stats();
  }
}
