export interface DashboardConfig {
  /** HS256 signing secret for operator JWTs (>= 32 chars). */
  jwtSecret: string;
  tokenTtlSeconds: number;
  operatorUser: string;
  operatorPassword: string;
  /** Token the BFF presents to the internal admin APIs of the other services. */
  adminToken: string;
  upstreams: { ledger: string; payments: string; webhook: string; reconciliation: string; chaos: string; prometheus: string };
  /** Browser origins allowed to call the API cross-origin (dev server). Empty = same-origin only. */
  allowedOrigins: string[];
  /** Directory with the built dashboard to serve at `/` (optional). */
  staticDir?: string;
  loginMaxFailures: number;
  loginWindowSeconds: number;
}

export const DEV_DEFAULTS = { jwtSecret: 'dev-only-jwt-secret-change-me-0123456789', operatorPassword: 'zerodrift', adminToken: 'dev-admin-token' };
