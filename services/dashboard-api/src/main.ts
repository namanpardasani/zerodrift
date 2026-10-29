// Tracing must be registered BEFORE anything else loads http/pg so they can be instrumented.
import '@zerodrift/telemetry/register';
import 'reflect-metadata';
import { loadConfig, z } from '@zerodrift/config';
import { startDashboardApi } from './app.js';
import { DEV_DEFAULTS } from './config.js';

const env = loadConfig(
  {
    JWT_SECRET: z.string().min(32).default(DEV_DEFAULTS.jwtSecret),
    TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
    DASHBOARD_USER: z.string().min(1).default('admin'),
    DASHBOARD_PASSWORD: z.string().min(1).default(DEV_DEFAULTS.operatorPassword),
    ADMIN_TOKEN: z.string().min(8).default(DEV_DEFAULTS.adminToken),
    LEDGER_URL: z.string().url().default('http://ledger:3001'),
    PAYMENTS_URL: z.string().url().default('http://payments:3002'),
    WEBHOOK_URL: z.string().url().default('http://webhook:3003'),
    RECONCILIATION_URL: z.string().url().default('http://reconciliation:3004'),
    CHAOS_URL: z.string().url().default('http://chaos-controller:3006'),
    PROMETHEUS_URL: z.string().url().default('http://prometheus:9090'),
    ALLOWED_ORIGINS: z.string().default(''),
    STATIC_DIR: z.string().default('../../apps/dashboard/dist'),
    LOGIN_MAX_FAILURES: z.coerce.number().int().positive().default(5),
    LOGIN_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  },
  { SERVICE_NAME: 'dashboard-api', PORT: '3008', ...process.env },
);

startDashboardApi({
  port: env.PORT,
  nodeEnv: env.NODE_ENV,
  logLevel: env.LOG_LEVEL,
  config: {
    jwtSecret: env.JWT_SECRET,
    tokenTtlSeconds: env.TOKEN_TTL_SECONDS,
    operatorUser: env.DASHBOARD_USER,
    operatorPassword: env.DASHBOARD_PASSWORD,
    adminToken: env.ADMIN_TOKEN,
    upstreams: { ledger: env.LEDGER_URL, payments: env.PAYMENTS_URL, webhook: env.WEBHOOK_URL, reconciliation: env.RECONCILIATION_URL, chaos: env.CHAOS_URL, prometheus: env.PROMETHEUS_URL },
    allowedOrigins: env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    staticDir: env.STATIC_DIR,
    loginMaxFailures: env.LOGIN_MAX_FAILURES,
    loginWindowSeconds: env.LOGIN_WINDOW_SECONDS,
  },
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
