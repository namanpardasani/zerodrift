// Tracing must be registered BEFORE anything else loads http/pg so they can be instrumented.
import '@zerodrift/telemetry/register';
import 'reflect-metadata';
import { loadConfig, refuseDevSecrets, z } from '@zerodrift/config';
import { startGateway } from './app.js';

const config = loadConfig(
  {
    DATABASE_URL: z.string().min(1),
    /** Optional: lets the gateway create its own database on first boot. */
    ADMIN_DATABASE_URL: z.string().optional(),
    GATEWAY_CALLBACK_SECRET: z.string().default('dev-gateway-secret'),
  },
  { SERVICE_NAME: 'mock-gateway', PORT: '3005', ...process.env },
);

refuseDevSecrets(config.NODE_ENV, { GATEWAY_CALLBACK_SECRET: config.GATEWAY_CALLBACK_SECRET });

startGateway({
  databaseUrl: config.DATABASE_URL,
  adminDatabaseUrl: config.ADMIN_DATABASE_URL,
  databaseName: new URL(config.DATABASE_URL).pathname.slice(1),
  port: config.PORT,
  callbackSecret: config.GATEWAY_CALLBACK_SECRET,
  logLevel: config.LOG_LEVEL,
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
