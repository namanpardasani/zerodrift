import { z } from 'zod';

export { z };

/**
 * The product name lives here and nowhere else in backend code.
 * (The frontend has its own single constant in each app's src/brand.ts.)
 */
export const PRODUCT_NAME = 'Zerodrift';

/** Only INR is supported in v1, but `currency` is a column everywhere so this can grow. */
export const DEFAULT_CURRENCY = 'INR';

/** Kafka topic names, shared so producers and consumers can never drift apart. */
export const TOPICS = {
  payments: 'zerodrift.payments.v1',
  ledger: 'zerodrift.ledger.v1',
  paymentsDlq: 'zerodrift.payments.v1.dlq',
  ledgerDlq: 'zerodrift.ledger.v1.dlq',
} as const;

/** Topics to create at boot. Partition count is the ceiling on consumer parallelism per group. */
export const TOPIC_SPECS: { topic: string; numPartitions: number }[] = [
  { topic: TOPICS.payments, numPartitions: 6 },
  { topic: TOPICS.ledger, numPartitions: 6 },
  { topic: TOPICS.paymentsDlq, numPartitions: 3 },
  { topic: TOPICS.ledgerDlq, numPartitions: 3 },
];

/** Which topic an aggregate's events go to. Events are keyed by aggregate id, so one aggregate's events stay ordered. */
export function topicForAggregate(aggregateType: string): string {
  switch (aggregateType) {
    case 'payment':
    case 'refund':
      return TOPICS.payments;
    case 'transfer':
      return TOPICS.ledger;
    default:
      throw new Error(`No topic configured for aggregate type "${aggregateType}"`);
  }
}

/** Dead-letter topic for a source topic: poison/failed messages land here instead of blocking the partition. */
export const dlqTopicFor = (topic: string): string => `${topic}.dlq`;

const baseSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SERVICE_NAME: z.string().min(1),
  PORT: z.coerce.number().int().positive(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

/**
 * Parse and validate environment variables for a service.
 * Fails fast at boot with a readable message instead of crashing later on `undefined`.
 */
export function loadConfig<T extends z.ZodRawShape>(
  extra: T,
  env: NodeJS.ProcessEnv = process.env,
) {
  const schema = baseSchema.extend(extra);
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${issues.join('\n')}`);
  }
  return parsed.data;
}

/** Chaos endpoints must never be reachable in production. */
export function chaosEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== 'production' && env.CHAOS_ENABLED === 'true';
}
