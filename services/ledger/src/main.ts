// Tracing must be registered BEFORE anything else loads http/pg so they can be instrumented.
import '@zerodrift/telemetry/register';
import 'reflect-metadata';
import { loadConfig, z } from '@zerodrift/config';
import { startLedger } from './app.js';

const config = loadConfig(
  {
    DATABASE_URL: z.string().min(1),
    MIGRATE_ON_BOOT: z.stringbool().default(true),
    DB_POOL_MAX: z.coerce.number().int().positive().default(20),
    HOLD_SWEEP_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(10),
    /** Comma-separated Kafka brokers. Unset = do not publish events. */
    KAFKA_BROKERS: z.string().optional(),
  },
  { SERVICE_NAME: 'ledger', PORT: '3001', ...process.env },
);

startLedger({
  databaseUrl: config.DATABASE_URL,
  port: config.PORT,
  migrate: config.MIGRATE_ON_BOOT,
  poolMax: config.DB_POOL_MAX,
  holdSweepIntervalSeconds: config.HOLD_SWEEP_INTERVAL_SECONDS,
  kafkaBrokers: config.KAFKA_BROKERS?.split(',').map((b) => b.trim()).filter(Boolean),
  logLevel: config.LOG_LEVEL,
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
