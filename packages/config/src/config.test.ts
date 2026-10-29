import { describe, expect, it } from 'vitest';
import { DEV_SECRETS, chaosEnabled, loadConfig, refuseDevSecrets, z } from './index.js';

describe('refuseDevSecrets', () => {
  it('does nothing outside production, even with dev secrets', () => {
    expect(() => refuseDevSecrets('development', { ADMIN_TOKEN: 'dev-admin-token' })).not.toThrow();
    expect(() => refuseDevSecrets('test', { ADMIN_TOKEN: 'dev-admin-token' })).not.toThrow();
  });

  it('in production rejects every known dev secret, empty and missing values, and names them', () => {
    for (const dev of DEV_SECRETS) expect(() => refuseDevSecrets('production', { X: dev }), dev).toThrow(/X/);
    expect(() => refuseDevSecrets('production', { A: undefined, B: '', C: 'ok-real-secret-value' })).toThrow(/A, B/);
    expect(() => refuseDevSecrets('production', { A: undefined, B: '', C: 'ok-real-secret-value' })).not.toThrow(/C/);
  });

  it('in production accepts real secrets', () => {
    expect(() => refuseDevSecrets('production', { ADMIN_TOKEN: 'b6c1f0e8d2a94c37a5e1', JWT: 'x'.repeat(48) })).not.toThrow();
  });
});

describe('loadConfig / chaosEnabled', () => {
  it('fails fast with a readable list of problems', () => {
    expect(() => loadConfig({ DATABASE_URL: z.string().min(1) }, { SERVICE_NAME: 's', PORT: '3000' })).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({}, { SERVICE_NAME: 's', PORT: 'abc' })).toThrow(/PORT/);
  });
  it('applies defaults and coerces', () => {
    const c = loadConfig({ N: z.coerce.number().default(5) }, { SERVICE_NAME: 's', PORT: '3001' });
    expect(c).toMatchObject({ PORT: 3001, N: 5, NODE_ENV: 'development', LOG_LEVEL: 'info' });
  });
  it('chaos is never enabled in production, and only with an explicit opt-in elsewhere', () => {
    expect(chaosEnabled({ NODE_ENV: 'production', CHAOS_ENABLED: 'true' })).toBe(false);
    expect(chaosEnabled({ NODE_ENV: 'development' })).toBe(false);
    expect(chaosEnabled({ NODE_ENV: 'development', CHAOS_ENABLED: 'true' })).toBe(true);
  });
});
