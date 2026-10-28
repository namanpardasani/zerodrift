import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHealthModule } from './index.js';

describe('health module', () => {
  let app: Awaited<ReturnType<typeof NestFactory.create>>;
  let base: string;
  let failing = false;

  beforeAll(async () => {
    const Health = createHealthModule('test-svc', [
      {
        name: 'dep',
        check: async () => {
          if (failing) throw new Error('boom');
        },
      },
    ]);
    @Module({ imports: [Health] })
    class AppModule {}
    app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(0);
    base = await app.getUrl();
  });
  afterAll(() => app.close());

  it('/health is always ok', async () => {
    const res = await fetch(`${base}/health`);
    expect(await res.json()).toEqual({ status: 'ok', service: 'test-svc' });
  });

  it('/ready reflects dependency state (503 when a check fails)', async () => {
    expect((await fetch(`${base}/ready`)).status).toBe(200);
    failing = true;
    expect((await fetch(`${base}/ready`)).status).toBe(503);
  });

  it('/metrics is served in the Prometheus exposition format, not HTML', async () => {
    const res = await fetch(`${base}/metrics`);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toContain('process_cpu_user_seconds_total');
  });
});
