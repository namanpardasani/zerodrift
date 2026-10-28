import { randomBytes } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  buildSignatureHeader,
  decryptSecret,
  encryptSecret,
  generateSecret,
  parseEncryptionKey,
  verifySignature,
} from './index.js';

const body = JSON.stringify({ id: 'evt_1', type: 'payment.succeeded', data: { amountMinor: '100' } });

describe('signing', () => {
  it('a valid signature verifies', () => {
    const secret = generateSecret();
    const header = buildSignatureHeader([secret], body, 1_700_000_000);
    expect(verifySignature([secret], body, header, { nowSeconds: 1_700_000_010 })).toEqual({ ok: true, timestamp: 1_700_000_000 });
  });

  it('rejects a tampered body, a wrong secret, and a malformed header', () => {
    const secret = generateSecret();
    const header = buildSignatureHeader([secret], body, 1_700_000_000);
    const now = { nowSeconds: 1_700_000_000 };
    expect(verifySignature([secret], body.replace('100', '999'), header, now)).toMatchObject({ ok: false, reason: 'no_matching_signature' });
    expect(verifySignature([generateSecret()], body, header, now)).toMatchObject({ ok: false, reason: 'no_matching_signature' });
    expect(verifySignature([secret], body, 'garbage', now)).toMatchObject({ ok: false, reason: 'malformed' });
    expect(verifySignature([secret], body, undefined, now)).toMatchObject({ ok: false, reason: 'malformed' });
    expect(verifySignature([secret], body, 't=abc,v1=00', now)).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('rejects replays outside the tolerance window (in the past AND the future)', () => {
    const secret = generateSecret();
    const header = buildSignatureHeader([secret], body, 1_700_000_000);
    expect(verifySignature([secret], body, header, { nowSeconds: 1_700_000_000 + 301 })).toMatchObject({ ok: false, reason: 'timestamp_out_of_tolerance' });
    expect(verifySignature([secret], body, header, { nowSeconds: 1_700_000_000 - 301 })).toMatchObject({ ok: false, reason: 'timestamp_out_of_tolerance' });
    expect(verifySignature([secret], body, header, { nowSeconds: 1_700_000_000 + 300 })).toMatchObject({ ok: true });
  });

  it('the timestamp is part of the signed data: swapping it invalidates the signature', () => {
    const secret = generateSecret();
    const header = buildSignatureHeader([secret], body, 1_700_000_000);
    const forged = header.replace('t=1700000000', 't=1700000100');
    expect(verifySignature([secret], body, forged, { nowSeconds: 1_700_000_100 })).toMatchObject({ ok: false, reason: 'no_matching_signature' });
  });

  it('secret rotation: signing with new+previous lets a receiver holding EITHER secret verify', () => {
    const oldS = generateSecret();
    const newS = generateSecret();
    const header = buildSignatureHeader([newS, oldS], body, 1_700_000_000);
    const now = { nowSeconds: 1_700_000_000 };
    expect(verifySignature([oldS], body, header, now).ok).toBe(true);
    expect(verifySignature([newS], body, header, now).ok).toBe(true);
    expect(verifySignature([generateSecret()], body, header, now).ok).toBe(false);
  });

  it('property: sign then verify always succeeds; any single-character body change always fails', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.integer({ min: 1, max: 2_000_000_000 }), (raw, ts) => {
        const secret = generateSecret();
        const header = buildSignatureHeader([secret], raw, ts);
        const ok = verifySignature([secret], raw, header, { nowSeconds: ts }).ok;
        const tampered = verifySignature([secret], `${raw}x`, header, { nowSeconds: ts }).ok;
        return ok && !tampered;
      }),
    );
  });
});

describe('secret encryption at rest', () => {
  const key = randomBytes(32);
  it('round-trips and never stores the plaintext', () => {
    const secret = generateSecret();
    const enc = encryptSecret(secret, key);
    expect(enc).not.toContain(secret);
    expect(decryptSecret(enc, key)).toBe(secret);
  });
  it('uses a fresh IV each time', () => {
    expect(encryptSecret('same', key)).not.toBe(encryptSecret('same', key));
  });
  it('detects tampering and wrong keys (authenticated encryption)', () => {
    const enc = encryptSecret('top secret', key);
    const [iv, tag, ct] = enc.split('.');
    const flipped = Buffer.from(ct!, 'base64');
    flipped[0] = flipped[0]! ^ 1;
    expect(() => decryptSecret([iv, tag, flipped.toString('base64')].join('.'), key)).toThrow();
    expect(() => decryptSecret(enc, randomBytes(32))).toThrow();
  });
  it('validates the configured key length', () => {
    expect(() => parseEncryptionKey(Buffer.from('short').toString('base64'))).toThrow('32 bytes');
    expect(parseEncryptionKey(randomBytes(32).toString('base64')).length).toBe(32);
  });
});
