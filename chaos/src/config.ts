/**
 * Where everything lives when the kind cluster from deploy/kind is up. Every service is exposed on
 * 127.0.0.1 through a NodePort (see deploy/kind/kind-config.yaml). The tokens are the TEST-ONLY values
 * from deploy/helm/zerodrift/values-kind.yaml: they protect nothing real.
 */
export const ENDPOINTS = {
  ledger: 'http://127.0.0.1:30001',
  payments: 'http://127.0.0.1:30002',
  webhook: 'http://127.0.0.1:30003',
  reconciliation: 'http://127.0.0.1:30004',
  gateway: 'http://127.0.0.1:30005',
  chaos: 'http://127.0.0.1:30006',
  receiver: 'http://127.0.0.1:30007',
} as const;

/** Where the demo receiver is reachable from INSIDE the cluster (what webhook endpoints are registered with). */
export const RECEIVER_URL_IN_CLUSTER = 'http://demo-receiver:3007/webhooks';

export const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? 'kind-test-admin-1f8c2a97d4b6';

export const POSTGRES = {
  host: '127.0.0.1',
  port: 30432,
  user: process.env.PGUSER ?? 'zerodrift',
  password: process.env.PGPASSWORD ?? 'change-me-test-only',
} as const;

export const NAMESPACE = 'zerodrift';
