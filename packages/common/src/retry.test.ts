import { describe, expect, it } from 'vitest';
import { backoffDelayMs, retry } from './index.js';

describe('backoffDelayMs (full jitter)', () => {
  it('never exceeds the exponential ceiling or maxMs, and never goes negative', () => {
    for (let attempt = 0; attempt < 12; attempt++) {
      for (let i = 0; i < 200; i++) {
        const d = backoffDelayMs(attempt, { baseMs: 100, maxMs: 5_000 });
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThanOrEqual(Math.min(5_000, 100 * 2 ** attempt));
      }
    }
  });
  it('is actually jittered: many different delays for the same attempt', () => {
    const seen = new Set(Array.from({ length: 200 }, () => backoffDelayMs(5, { baseMs: 100, maxMs: 60_000 })));
    expect(seen.size).toBeGreaterThan(50);
  });
  it('uses the injected random source (0 -> 0, 1 -> ceiling)', () => {
    expect(backoffDelayMs(3, { baseMs: 100, maxMs: 10_000, random: () => 0 })).toBe(0);
    expect(backoffDelayMs(3, { baseMs: 100, maxMs: 10_000, random: () => 1 })).toBe(800);
  });
});

describe('retry', () => {
  const fast = { baseMs: 1, maxMs: 2, sleep: async () => {} };
  it('returns on first success without retrying', async () => {
    let calls = 0;
    expect(await retry(async () => ++calls, { ...fast, retries: 3 })).toBe(1);
  });
  it('retries failures up to `retries` times then throws the last error', async () => {
    let calls = 0;
    await expect(retry(async () => { calls++; throw new Error(`fail ${calls}`); }, { ...fast, retries: 3 })).rejects.toThrow('fail 4');
    expect(calls).toBe(4);
  });
  it('recovers when a later attempt succeeds', async () => {
    let calls = 0;
    const r = await retry(async () => { if (++calls < 3) throw new Error('flaky'); return 'ok'; }, { ...fast, retries: 5 });
    expect(r).toBe('ok');
    expect(calls).toBe(3);
  });
  it('does not retry errors that shouldRetry rejects', async () => {
    let calls = 0;
    await expect(retry(async () => { calls++; throw new Error('permanent'); }, { ...fast, retries: 5, shouldRetry: () => false })).rejects.toThrow('permanent');
    expect(calls).toBe(1);
  });
});
