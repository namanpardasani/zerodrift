// Tracing must be registered BEFORE anything else loads http/pg so they can be instrumented.
import '@zerodrift/telemetry/register';
import 'reflect-metadata';
import { loadConfig, refuseDevSecrets, z } from '@zerodrift/config';
import { startReconciliation } from './app.js';
import { DEFAULT_RECON_CONFIG } from './reconciler.service.js';
import { createHttpSources } from './sources.js';

const env = loadConfig(
  {
    DATABASE_URL: z.string().min(1),
    LEDGER_URL: z.string().url(),
    PAYMENTS_URL: z.string().url(),
    GATEWAY_URL: z.string().url(),
    /** The payments service's admin token (its reconciliation feed is operator-only). */
    PAYMENTS_ADMIN_TOKEN: z.string().min(8),
    ADMIN_TOKEN: z.string().min(8).default('dev-admin-token'),
    INTERNAL_RUN_INTERVAL_SECONDS: z.coerce.number().int().positive().default(300),
    EXTERNAL_RUN_INTERVAL_SECONDS: z.coerce.number().int().positive().default(900),
    RECON_GRACE_SECONDS: z.coerce.number().int().min(0).default(DEFAULT_RECON_CONFIG.graceMs / 1000),
    RECON_STUCK_AFTER_SECONDS: z.coerce.number().int().min(0).default(DEFAULT_RECON_CONFIG.stuckAfterMs / 1000),
    RECON_CONFIRM_DELAY_SECONDS: z.coerce.number().int().min(0).default(DEFAULT_RECON_CONFIG.confirmDelayMs / 1000),
  },
  { SERVICE_NAME: 'reconciliation', PORT: '3004', ...process.env },
);

refuseDevSecrets(env.NODE_ENV, { ADMIN_TOKEN: env.ADMIN_TOKEN, PAYMENTS_ADMIN_TOKEN: env.PAYMENTS_ADMIN_TOKEN });

startReconciliation({
  databaseUrl: env.DATABASE_URL,
  port: env.PORT,
  logLevel: env.LOG_LEVEL,
  adminToken: env.ADMIN_TOKEN,
  sources: createHttpSources({ ledgerUrl: env.LEDGER_URL, paymentsUrl: env.PAYMENTS_URL, gatewayUrl: env.GATEWAY_URL, paymentsAdminToken: env.PAYMENTS_ADMIN_TOKEN }),
  scheduleMs: { internal: env.INTERNAL_RUN_INTERVAL_SECONDS * 1000, external: env.EXTERNAL_RUN_INTERVAL_SECONDS * 1000 },
  config: { graceMs: env.RECON_GRACE_SECONDS * 1000, stuckAfterMs: env.RECON_STUCK_AFTER_SECONDS * 1000, confirmDelayMs: env.RECON_CONFIRM_DELAY_SECONDS * 1000 },
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
