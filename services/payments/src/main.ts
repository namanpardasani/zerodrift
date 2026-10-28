import 'reflect-metadata';
import { loadConfig, z } from '@zerodrift/config';
import { DEFAULT_CONFIG, startPayments } from './app.js';

const config = loadConfig(
  {
    DATABASE_URL: z.string().min(1),
    LEDGER_URL: z.string().url(),
    GATEWAY_URL: z.string().url(),
    /** Address the gateway can reach this service on, for async callbacks. */
    PUBLIC_URL: z.string().url().optional(),
    ADMIN_TOKEN: z.string().min(8).default(DEFAULT_CONFIG.adminToken),
    GATEWAY_CALLBACK_SECRET: z.string().min(8).default(DEFAULT_CONFIG.gatewayCallbackSecret),
    GATEWAY_TIMEOUT_MS: z.coerce.number().int().positive().default(1500),
    HOLD_TTL_SECONDS: z.coerce.number().int().positive().default(DEFAULT_CONFIG.holdTtlSeconds),
    RECOVERY_INTERVAL_SECONDS: z.coerce.number().int().positive().default(DEFAULT_CONFIG.recoveryIntervalSeconds),
    RECOVERY_STUCK_AFTER_SECONDS: z.coerce.number().int().min(0).default(DEFAULT_CONFIG.recoveryStuckAfterSeconds),
    RECOVERY_ABANDON_AFTER_SECONDS: z.coerce.number().int().min(0).default(DEFAULT_CONFIG.recoveryAbandonAfterSeconds),
    MIGRATE_ON_BOOT: z.stringbool().default(true),
    DB_POOL_MAX: z.coerce.number().int().positive().default(20),
  },
  { SERVICE_NAME: 'payments', PORT: '3002', ...process.env },
);

startPayments({
  databaseUrl: config.DATABASE_URL,
  port: config.PORT,
  ledgerUrl: config.LEDGER_URL,
  gatewayUrl: config.GATEWAY_URL,
  publicUrl: config.PUBLIC_URL,
  migrate: config.MIGRATE_ON_BOOT,
  poolMax: config.DB_POOL_MAX,
  gatewayClient: { timeoutMs: config.GATEWAY_TIMEOUT_MS },
  logLevel: config.LOG_LEVEL,
  config: {
    adminToken: config.ADMIN_TOKEN,
    gatewayCallbackSecret: config.GATEWAY_CALLBACK_SECRET,
    holdTtlSeconds: config.HOLD_TTL_SECONDS,
    recoveryIntervalSeconds: config.RECOVERY_INTERVAL_SECONDS,
    recoveryStuckAfterSeconds: config.RECOVERY_STUCK_AFTER_SECONDS,
    recoveryAbandonAfterSeconds: config.RECOVERY_ABANDON_AFTER_SECONDS,
  },
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
