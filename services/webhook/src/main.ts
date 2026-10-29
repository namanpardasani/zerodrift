// Tracing must be registered BEFORE anything else loads http/pg so they can be instrumented.
import '@zerodrift/telemetry/register';
import 'reflect-metadata';
import { loadConfig, refuseDevSecrets, z } from '@zerodrift/config';
import { parseEncryptionKey } from '@zerodrift/webhooks';
import { startWebhook } from './app.js';
import { PaymentsAuthenticator } from './auth.js';
import { DEFAULT_WEBHOOK_CONFIG } from './config.js';

const env = loadConfig(
  {
    DATABASE_URL: z.string().min(1),
    PAYMENTS_URL: z.string().url(),
    /** base64 of 32 random bytes: `openssl rand -base64 32`. No default on purpose in production. */
    WEBHOOK_ENCRYPTION_KEY: z.string().min(1),
    ADMIN_TOKEN: z.string().min(8).default(DEFAULT_WEBHOOK_CONFIG.adminToken),
    KAFKA_BROKERS: z.string().optional(),
    WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(DEFAULT_WEBHOOK_CONFIG.timeoutMs),
    WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().positive().default(DEFAULT_WEBHOOK_CONFIG.maxAttempts),
    WEBHOOK_BACKOFF_BASE_MS: z.coerce.number().int().positive().default(DEFAULT_WEBHOOK_CONFIG.backoffBaseMs),
    WEBHOOK_BACKOFF_MAX_MS: z.coerce.number().int().positive().default(DEFAULT_WEBHOOK_CONFIG.backoffMaxMs),
    /** Dev/demo only: allow webhook URLs on private networks (e.g. the demo receiver). */
    ALLOW_PRIVATE_WEBHOOK_URLS: z.stringbool().default(false),
    DB_POOL_MAX: z.coerce.number().int().positive().default(20),
  },
  { SERVICE_NAME: 'webhook', PORT: '3003', ...process.env },
);

refuseDevSecrets(env.NODE_ENV, { ADMIN_TOKEN: env.ADMIN_TOKEN, WEBHOOK_ENCRYPTION_KEY: env.WEBHOOK_ENCRYPTION_KEY });
if (env.NODE_ENV === 'production' && env.ALLOW_PRIVATE_WEBHOOK_URLS) {
  throw new Error('ALLOW_PRIVATE_WEBHOOK_URLS must not be enabled in production (SSRF)');
}

startWebhook({
  databaseUrl: env.DATABASE_URL,
  port: env.PORT,
  poolMax: env.DB_POOL_MAX,
  logLevel: env.LOG_LEVEL,
  authenticator: new PaymentsAuthenticator(env.PAYMENTS_URL),
  kafkaBrokers: env.KAFKA_BROKERS?.split(',').map((b) => b.trim()).filter(Boolean),
  config: {
    encryptionKey: parseEncryptionKey(env.WEBHOOK_ENCRYPTION_KEY),
    adminToken: env.ADMIN_TOKEN,
    timeoutMs: env.WEBHOOK_TIMEOUT_MS,
    maxAttempts: env.WEBHOOK_MAX_ATTEMPTS,
    backoffBaseMs: env.WEBHOOK_BACKOFF_BASE_MS,
    backoffMaxMs: env.WEBHOOK_BACKOFF_MAX_MS,
    allowPrivateUrls: env.ALLOW_PRIVATE_WEBHOOK_URLS,
  },
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
