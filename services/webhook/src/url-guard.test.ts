import { describe, expect, it } from 'vitest';
import { assertSafeUrl, isPrivateAddress } from './url-guard.js';

describe('isPrivateAddress', () => {
  it('flags private, loopback, link-local, metadata and reserved ranges', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });
  it('allows public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '203.0.113.5', '2606:4700:4700::1111']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });
});

describe('assertSafeUrl', () => {
  it('rejects bad schemes, credentials, localhost and private IP literals when private is not allowed', async () => {
    for (const u of ['ftp://example.com/x', 'file:///etc/passwd', 'not a url', 'https://user:pw@example.com/', 'http://localhost:3000/hook', 'http://127.0.0.1/hook', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/x', 'http://10.0.0.5/x', 'http://foo.internal/x']) {
      await expect(assertSafeUrl(u, { allowPrivate: false }), u).rejects.toMatchObject({ status: 400 });
    }
  });
  it('allows public IP literals, and anything http(s) when private is allowed (dev)', async () => {
    await expect(assertSafeUrl('https://8.8.8.8/hook', { allowPrivate: false })).resolves.toBeInstanceOf(URL);
    await expect(assertSafeUrl('http://localhost:4000/hook', { allowPrivate: true })).resolves.toBeInstanceOf(URL);
    await expect(assertSafeUrl('ftp://example.com', { allowPrivate: true })).rejects.toMatchObject({ status: 400 });
  });
});
