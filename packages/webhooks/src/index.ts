import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Webhook signing, shared by the sender (webhook-service) and receivers (merchants / demo receiver).
 *
 * Scheme (same idea as Stripe's): the sender computes
 *     HMAC-SHA256(secret, `${timestamp}.${rawBody}`)
 * and sends   Zerodrift-Signature: t=<unix seconds>,v1=<hex>[,v1=<hex>]
 *
 *  - The HMAC proves the body came from someone who knows the secret and was not modified.
 *  - The timestamp is INSIDE the signed string, so an attacker cannot replay an old captured
 *    request later: receivers reject timestamps outside a tolerance window (default 5 minutes).
 *  - Several `v1` values can be present so a secret can be rotated without downtime: during the
 *    overlap we sign with both the new and the previous secret.
 *  - Comparison is constant-time so the signature cannot be guessed byte by byte from timing.
 */

export const SIGNATURE_HEADER = 'zerodrift-signature';
export const DEFAULT_TOLERANCE_SECONDS = 300;

export function signPayload(secret: string, timestampSeconds: number, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestampSeconds}.${rawBody}`).digest('hex');
}

/** Build the header value, signing with every given secret (current first, optionally the previous one). */
export function buildSignatureHeader(secrets: string[], rawBody: string, timestampSeconds = Math.floor(Date.now() / 1000)): string {
  const sigs = secrets.map((s) => `v1=${signPayload(s, timestampSeconds, rawBody)}`);
  return [`t=${timestampSeconds}`, ...sigs].join(',');
}

export type VerifyResult = { ok: true; timestamp: number } | { ok: false; reason: 'malformed' | 'timestamp_out_of_tolerance' | 'no_matching_signature' };

/**
 * Verify a request on the receiving side. `rawBody` must be the EXACT bytes received (before any
 * JSON parsing / re-serialisation), otherwise the HMAC will not match.
 */
export function verifySignature(
  secrets: string[],
  rawBody: string,
  header: string | undefined,
  opts: { toleranceSeconds?: number; nowSeconds?: number } = {},
): VerifyResult {
  if (!header) return { ok: false, reason: 'malformed' };
  let timestamp: number | undefined;
  const candidates: string[] = [];
  for (const part of header.split(',')) {
    const [k, v] = part.split('=');
    if (k === 't' && v) timestamp = Number(v);
    else if (k === 'v1' && v) candidates.push(v);
  }
  if (timestamp === undefined || !Number.isInteger(timestamp) || candidates.length === 0) return { ok: false, reason: 'malformed' };

  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > (opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS)) return { ok: false, reason: 'timestamp_out_of_tolerance' };

  for (const secret of secrets) {
    const expected = Buffer.from(signPayload(secret, timestamp, rawBody), 'hex');
    for (const c of candidates) {
      const given = Buffer.from(c, 'hex');
      if (given.length === expected.length && timingSafeEqual(given, expected)) return { ok: true, timestamp };
    }
  }
  return { ok: false, reason: 'no_matching_signature' };
}

/** Generate a new endpoint signing secret: `whsec_` + 192 random bits. */
export const generateSecret = (): string => `whsec_${randomBytes(24).toString('base64url')}`;

// ---------------------------------------------------------------------------------------------
// Secrets at rest. We must be able to READ a secret back (to sign), so it is encrypted, not hashed.
// AES-256-GCM: authenticated encryption; a tampered ciphertext fails to decrypt instead of
// yielding garbage. Format: base64(iv) . base64(tag) . base64(ciphertext)
// ---------------------------------------------------------------------------------------------

export function parseEncryptionKey(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== 32) throw new Error('WEBHOOK_ENCRYPTION_KEY must be 32 bytes, base64 encoded');
  return key;
}

export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ct].map((b) => b.toString('base64')).join('.');
}

export function decryptSecret(encoded: string, key: Buffer): string {
  const [iv, tag, ct] = encoded.split('.').map((p) => Buffer.from(p, 'base64'));
  if (!iv || !tag || !ct) throw new Error('malformed encrypted secret');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
