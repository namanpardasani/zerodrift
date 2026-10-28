import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { DomainError } from '@zerodrift/common';

/**
 * SSRF protection. A webhook URL is chosen by a merchant, and OUR servers make the request, so
 * without a guard a merchant could point it at internal services (the ledger, Postgres, a cloud
 * metadata endpoint) and read the response status/snippet from our delivery log.
 * We only allow http(s) and refuse hosts that resolve to private, loopback, link-local or
 * otherwise non-public addresses. Disabled in dev (so localhost demo receivers work).
 * Known limit: a hostile DNS server could answer differently between this check and the actual
 * connection (DNS rebinding); production should additionally egress-filter at the network layer.
 */
export function isPrivateAddress(ip: string): boolean {
  if (ip.includes(':')) {
    const v6 = ip.toLowerCase();
    if (v6 === '::1' || v6 === '::') return true;
    if (v6.startsWith('fe8') || v6.startsWith('fe9') || v6.startsWith('fea') || v6.startsWith('feb')) return true; // fe80::/10 link-local
    if (v6.startsWith('fc') || v6.startsWith('fd')) return true; // fc00::/7 unique local
    const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped
    return mapped ? isPrivateAddress(mapped[1]!) : false;
  }
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) || // link-local incl. cloud metadata 169.254.169.254
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    a >= 224 // multicast / reserved
  );
}

export async function assertSafeUrl(raw: string, opts: { allowPrivate: boolean }): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DomainError('invalid_url', 'Webhook URL is not a valid URL', 400);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new DomainError('invalid_url', 'Webhook URL must use http or https', 400);
  if (url.username || url.password) throw new DomainError('invalid_url', 'Webhook URL must not contain credentials', 400);
  if (opts.allowPrivate) return url;

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw new DomainError('url_not_allowed', 'Webhook URL points at a non-public host', 400);
  }
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (addresses.length === 0) throw new DomainError('url_not_allowed', 'Webhook URL host could not be resolved', 400);
  if (addresses.some(isPrivateAddress)) throw new DomainError('url_not_allowed', 'Webhook URL points at a non-public address', 400);
  return url;
}
