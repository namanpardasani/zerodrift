import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SIGNATURE_HEADER, verifySignature } from '@zerodrift/webhooks';

export interface ReceivedWebhook {
  eventId: string;
  type: string;
  deliveryId: string;
  attempt: number;
  /** What we answered: 'ok' (processed), 'duplicate' (already had it), or the injected/failure status. */
  outcome: 'ok' | 'duplicate' | 'bad_signature' | 'injected_failure';
  signatureReason?: string;
  body?: unknown;
  at: string;
}

export interface Behavior {
  /** Answer the next N valid requests with `failStatus` instead of processing them. */
  failNext: number;
  failStatus: number;
  /** Delay every response by this long (to demo/test timeouts). */
  delayMs: number;
}

export interface Receiver {
  url: string;
  received: ReceivedWebhook[];
  behavior: Behavior;
  /** The signing secrets this merchant currently trusts (supports rotation overlap). */
  secrets: string[];
  close(): Promise<void>;
}

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

/**
 * A merchant's webhook endpoint, done right:
 *  1. read the RAW body (the signature covers the exact bytes),
 *  2. verify the HMAC + timestamp BEFORE trusting anything,
 *  3. deduplicate on the event id (delivery is at-least-once, so duplicates will arrive),
 *  4. only then act, and answer 2xx fast.
 * The behaviour knobs let a demo/test make it fail or stall on demand.
 */
export async function startReceiver(opts: { port?: number; secrets: string[]; log?: (msg: string) => void }): Promise<Receiver> {
  const processed = new Set<string>();
  const r: Receiver = {
    url: '',
    received: [],
    behavior: { failNext: 0, failStatus: 500, delayMs: 0 },
    secrets: [...opts.secrets],
    close: async () => {},
  };

  const server: Server = createServer(async (req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      if (req.method === 'GET' && url.pathname === '/health') return json(200, { status: 'ok' });
      if (req.method === 'GET' && url.pathname === '/received') return json(200, { received: r.received, behavior: r.behavior });
      if (req.method === 'POST' && url.pathname === '/admin/behavior') {
        Object.assign(r.behavior, JSON.parse((await readBody(req)) || '{}'));
        return json(200, r.behavior);
      }
      if (req.method === 'POST' && url.pathname === '/admin/secrets') {
        // demo convenience: paste the secret shown when the endpoint was created
        const { secrets } = JSON.parse((await readBody(req)) || '{}') as { secrets?: string[] };
        r.secrets = Array.isArray(secrets) ? secrets.filter((x) => typeof x === 'string') : [];
        return json(200, { trusted: r.secrets.length });
      }
      if (req.method !== 'POST' || url.pathname !== '/webhooks') return json(404, { error: 'not found' });

      const raw = await readBody(req);
      if (r.behavior.delayMs > 0) await new Promise((x) => setTimeout(x, r.behavior.delayMs));

      const meta = {
        eventId: String(req.headers['zerodrift-event-id'] ?? ''),
        type: String(req.headers['zerodrift-event-type'] ?? ''),
        deliveryId: String(req.headers['zerodrift-delivery-id'] ?? ''),
        attempt: Number(req.headers['zerodrift-attempt'] ?? 0),
        at: new Date().toISOString(),
      };
      const check = verifySignature(r.secrets, raw, req.headers[SIGNATURE_HEADER] as string | undefined);
      if (!check.ok) {
        r.received.push({ ...meta, outcome: 'bad_signature', signatureReason: check.reason });
        return json(401, { error: 'invalid signature', reason: check.reason });
      }
      if (r.behavior.failNext > 0) {
        r.behavior.failNext--;
        r.received.push({ ...meta, outcome: 'injected_failure' });
        return json(r.behavior.failStatus, { error: 'injected failure' });
      }
      const body = JSON.parse(raw) as { id: string };
      if (processed.has(body.id)) {
        r.received.push({ ...meta, outcome: 'duplicate', body });
        return json(200, { duplicate: true }); // already handled: acknowledge so the sender stops retrying
      }
      processed.add(body.id);
      r.received.push({ ...meta, outcome: 'ok', body });
      opts.log?.(`received ${meta.type} ${body.id}`);
      return json(200, { received: true });
    } catch (err) {
      return json(400, { error: (err as Error).message });
    }
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '0.0.0.0', resolve));
  r.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  r.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return r;
}
