import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { type ReactNode, useEffect, useState } from 'react';
import { Dot } from './components.js';
import { cx } from './format.js';
import { Stamp } from './stamp.js';

/**
 * Idempotency in three seconds: request one runs; the identical request two is stamped ALREADY PAID, folds away
 * into a chip, and the charge counter flashes but stays at 1.
 *
 * `replayKey` restarts the sequence. With `duplicates` set (the operator console, for a real payment) the
 * request that was absorbed is real: the page passes how many duplicates the platform actually answered.
 */
export function DoubleTap({ request, response, duplicates = 1, counterLabel, replayKey = 0, className }: { request: ReactNode; response: ReactNode; duplicates?: number; counterLabel: string; replayKey?: number; className?: string }) {
  const reduced = useReducedMotion();
  // phases: 0 nothing, 1 first request, 2 response + counter, 3 duplicate arrives, 4 stamped, 5 folded into the chip
  const [phase, setPhase] = useState(reduced ? 5 : 0);
  useEffect(() => {
    if (reduced) return setPhase(5);
    setPhase(0);
    const steps = [300, 1000, 1700, 2600, 3900];
    const timers = steps.map((ms, i) => setTimeout(() => setPhase(i + 1), ms));
    return () => timers.forEach(clearTimeout);
  }, [replayKey, reduced]);

  const card = 'relative rounded-card border border-rule bg-card px-[18px] py-4 text-[13px] leading-[1.7]';
  return (
    <div className={cx('grid gap-7 md:grid-cols-[minmax(0,1fr)_260px] md:items-start', className)}>
      <div className="flex min-h-[240px] flex-col gap-3.5">
        <motion.div className={card} initial={false} animate={{ opacity: phase >= 1 ? 1 : 0, x: phase >= 1 ? 0 : -24 }} transition={{ duration: 0.5, ease: [0.2, 0.8, 0.2, 1] }}>
          {request}
          <motion.div className="mt-2 inline-flex items-center gap-2 rounded-full bg-settled-bg px-2.5 py-1 text-xs text-settled-ink" initial={false} animate={{ opacity: phase >= 2 ? 1 : 0 }}>
            <Dot pulse={false} />
            {response}
          </motion.div>
        </motion.div>
        <AnimatePresence>
          {phase >= 3 && phase < 5 && (
            <motion.div key="dup" className={card} initial={{ opacity: 0, x: -24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, rotateX: 75, scaleY: 0.15, transformOrigin: 'top' }} transition={{ duration: 0.5, ease: [0.2, 0.8, 0.2, 1] }} style={{ transformPerspective: 700 }}>
              {request}
              <Stamp show={phase >= 4} tone="red" className="right-[18px] top-[18px]">already paid</Stamp>
            </motion.div>
          )}
        </AnimatePresence>
        <motion.span className="mono inline-flex self-start rounded-full border border-dashed border-[#b9b9b4] px-3 py-1.5 text-xs text-ink-2" initial={false} animate={{ opacity: phase >= 5 ? 1 : 0, scale: phase >= 5 ? 1 : 0.9 }}>
          {duplicates === 1 ? 'duplicate absorbed · same response returned' : `${duplicates} duplicates absorbed · same response returned`}
        </motion.span>
      </div>
      <motion.div className="rounded-card border border-rule bg-card p-[18px]" animate={{ backgroundColor: phase === 2 || phase === 4 ? ['#FFF1E0', '#FFFFFF'] : '#FFFFFF' }} transition={{ duration: 0.7 }}>
        <div className="text-[13px] text-muted">{counterLabel}</div>
        <div className="mono mt-2.5 text-[56px] font-medium leading-none">{phase >= 2 ? 1 : 0}</div>
        <div className="mt-2.5 text-[13px] text-ink-2">{duplicates === 1 ? 'Two requests, one charge.' : `${duplicates + 1} requests, one charge.`} The duplicate gets the first one’s answer.</div>
      </motion.div>
    </div>
  );
}
