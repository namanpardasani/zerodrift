import { afterEach, describe, expect, it, vi } from 'vitest';
import { newId } from '../src/ids.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
afterEach(() => vi.unstubAllGlobals());

describe('newId', () => {
  it('uses crypto.randomUUID when the browser provides it', () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'from-randomUUID', getRandomValues: () => { throw new Error('unused'); } });
    expect(newId()).toBe('from-randomUUID');
  });

  it('still works in an insecure context (no randomUUID, e.g. plain http on a LAN hostname)', () => {
    vi.stubGlobal('crypto', { getRandomValues: (a: Uint8Array) => a.fill(0xab) });
    const id = newId();
    expect(id).toMatch(UUID_V4);
  });

  it('produces valid, distinct v4 UUIDs from random bytes', () => {
    const real = globalThis.crypto;
    vi.stubGlobal('crypto', { getRandomValues: (a: Uint8Array) => real.getRandomValues(a as Uint8Array<ArrayBuffer>) });
    const ids = new Set(Array.from({ length: 500 }, newId));
    expect(ids.size).toBe(500);
    for (const id of ids) expect(id).toMatch(UUID_V4);
  });
});
