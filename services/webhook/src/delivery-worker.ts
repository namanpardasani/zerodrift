import { DeliveriesService } from './deliveries.service.js';

/**
 * Background loop: claim due deliveries, attempt them concurrently, repeat. Several instances can
 * run against the same database (claiming uses SKIP LOCKED), and a crashed instance's claimed rows
 * become due again when their lease runs out.
 */
export class DeliveryWorker {
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private inFlight = 0;

  constructor(
    private readonly deliveries: DeliveriesService,
    private readonly opts: { pollIntervalMs: number; batchSize: number; onError?: (err: unknown) => void },
  ) {}

  start(): void {
    const tick = async () => {
      if (this.stopped) return;
      try {
        while (!this.stopped && (await this.runOnce()) === this.opts.batchSize) {
          /* more waiting: keep draining */
        }
      } catch (err) {
        this.opts.onError?.(err);
      }
      if (!this.stopped) this.timer = setTimeout(tick, this.opts.pollIntervalMs);
    };
    this.timer = setTimeout(tick, 0);
  }

  /** Claim and attempt one batch. Returns how many were claimed. */
  async runOnce(): Promise<number> {
    const ids = await this.deliveries.claimDue(this.opts.batchSize);
    this.inFlight += ids.length;
    try {
      await Promise.all(
        ids.map((id) =>
          this.deliveries.attempt(id).catch((err) => {
            this.opts.onError?.(err); // the lease expires and it will be retried
          }),
        ),
      );
    } finally {
      this.inFlight -= ids.length;
    }
    return ids.length;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    while (this.inFlight > 0) await new Promise((r) => setTimeout(r, 10));
  }
}
