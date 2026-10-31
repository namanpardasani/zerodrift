// Tracing must be registered BEFORE anything else loads http/pg so they can be instrumented.
import '@zerodrift/telemetry/register';
import 'reflect-metadata';
import { chaosEnabled, loadConfig, z } from '@zerodrift/config';
import { startChaos } from './app.js';

const env = loadConfig(
  {
    CHAOS_ENABLED: z.stringbool().default(false),
    /** docker (compose) or kubernetes (in-cluster ServiceAccount). */
    CHAOS_BACKEND: z.enum(['docker', 'kubernetes']).default('docker'),
    ADMIN_TOKEN: z.string().min(8).default('dev-admin-token'),
    DOCKER_SOCKET: z.string().default('/var/run/docker.sock'),
    COMPOSE_PROJECT: z.string().default('zerodrift'),
    GATEWAY_URL: z.string().url().default('http://mock-gateway:3005'),
    TOXIPROXY_URL: z.string().url().default('http://toxiproxy:8474'),
  },
  { SERVICE_NAME: 'chaos-controller', PORT: '3006', ...process.env },
);

startChaos({
  port: env.PORT,
  nodeEnv: env.NODE_ENV,
  chaosEnabled: env.CHAOS_ENABLED && chaosEnabled({ ...process.env, CHAOS_ENABLED: String(env.CHAOS_ENABLED) }),
  adminToken: env.ADMIN_TOKEN,
  backend: env.CHAOS_BACKEND,
  dockerSocketPath: env.DOCKER_SOCKET,
  composeProject: env.COMPOSE_PROJECT,
  gatewayUrl: env.GATEWAY_URL,
  toxiproxyUrl: env.TOXIPROXY_URL,
  logLevel: env.LOG_LEVEL,
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
