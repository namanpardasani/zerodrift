import type { Reconciler, RunKind } from './reconciler.service.js';

/**
 * Runs reconciliations on a timer. Every replica runs this loop; the advisory lock inside
 * `Reconciler.run` guarantees only one replica actually performs a given run at a time.
 */
export class ReconScheduler {
  private timers: NodeJS.Timeout[] = [];
  private inFlight = new Set<Promise<unknown>>();

  constructor(
    private readonly reconciler: Reconciler,
    private readonly intervals: Record<RunKind, number>,
    private readonly onError: (kind: RunKind, err: unknown) => void = () => {},
  ) {}

  start(initialDelayMs = 5_000): void {
    for (const kind of ['internal', 'external'] as const) {
      const tick = () => {
        const p = this.reconciler.run(kind, { trigger: 'scheduled' }).catch((err) => this.onError(kind, err));
        this.inFlight.add(p);
        void p.finally(() => this.inFlight.delete(p));
      };
      const first = setTimeout(() => {
        tick();
        const t = setInterval(tick, this.intervals[kind]);
        t.unref();
        this.timers.push(t);
      }, initialDelayMs);
      first.unref();
      this.timers.push(first);
    }
  }

  async stop(): Promise<void> {
    for (const t of this.timers) {
      clearTimeout(t);
      clearInterval(t);
    }
    await Promise.allSettled([...this.inFlight]);
  }
}
