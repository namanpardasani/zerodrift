export interface WebhookConfig {
  /** 32-byte AES key that encrypts endpoint secrets at rest. */
  encryptionKey: Buffer;
  /** Per-attempt HTTP timeout. A merchant that does not answer in time counts as a failed attempt. */
  timeoutMs: number;
  /** Attempts per delivery cycle before it is dead-lettered (a manual replay starts a new cycle). */
  maxAttempts: number;
  /** Exponential backoff with full jitter between attempts: delay = random(0 .. min(max, base * 2^n)). */
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** Floor under the jittered delay so a retry can never be (near-)immediate. */
  backoffMinMs: number;
  pollIntervalMs: number;
  batchSize: number;
  /** A claimed delivery is invisible to other workers for this long; if the worker dies it becomes due again. */
  leaseSeconds: number;
  /** Allow webhook URLs that resolve to private addresses (dev/demo only). */
  allowPrivateUrls: boolean;
  adminToken: string;
  /** How long the previous signing secret keeps signing after a rotation. */
  previousSecretGraceHours: number;
}

export const DEFAULT_WEBHOOK_CONFIG: Omit<WebhookConfig, 'encryptionKey'> = {
  timeoutMs: 5_000,
  maxAttempts: 8,
  backoffBaseMs: 15_000,
  backoffMaxMs: 60 * 60_000,
  backoffMinMs: 1_000,
  pollIntervalMs: 250,
  batchSize: 20,
  leaseSeconds: 60,
  allowPrivateUrls: false,
  adminToken: 'dev-admin-token',
  previousSecretGraceHours: 24,
};
