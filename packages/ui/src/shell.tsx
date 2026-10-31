import { MotionConfig, motion, useReducedMotion } from 'motion/react';
import type { ReactNode } from 'react';
import { BRAND_NAME, BRAND_WORDMARK_LINES } from '@zerodrift/brand';
import { cx } from './format.js';
import { MarkMeter } from './icons.js';

/** Wrap every app once: with reducedMotion="user", transform and layout animations are skipped for people who ask for less motion. */
export function MotionRoot({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}

/** Page transition: a short fade with an 8px rise. Key it by route so each page enters. */
export function PageTransition({ children, className }: { children: ReactNode; className?: string }) {
  const reduced = useReducedMotion();
  return (
    <motion.div className={className} initial={reduced ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}>
      {children}
    </motion.div>
  );
}

/** The sliding highlight behind the active sidebar item or tab (shared layout animation). Render inside the active item. */
export function ActivePill({ group = 'nav', className }: { group?: string; className?: string }) {
  return <motion.span layoutId={`active-pill-${group}`} aria-hidden="true" className={cx('absolute inset-0 -z-10 rounded-nav bg-paper', className)} transition={{ type: 'spring', stiffness: 500, damping: 40 }} />;
}

/** Product mark and name. The name comes from @zerodrift/brand, the only place it is defined. */
export function Brand({ tone = 'paper', size = 'md' }: { tone?: 'paper' | 'stage'; size?: 'md' | 'lg' }) {
  return (
    <span className={cx('inline-flex items-center gap-2.5 font-semibold tracking-[-0.01em]', size === 'lg' ? 'text-[22px]' : 'text-[17px]', tone === 'stage' ? 'text-on-stage' : 'text-ink')}>
      <MarkMeter className={size === 'lg' ? 'h-7 w-7' : 'h-[22px] w-[22px]'} />
      {BRAND_NAME.toLowerCase()}
    </span>
  );
}

/** The stage wordmark: big, light, lowercase, split over two lines like the reference ("zero / drift"). */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cx('text-[34px] font-light leading-[1.02] tracking-[-0.02em] text-on-stage', className)}>
      {BRAND_WORDMARK_LINES[0]}
      <br />
      {BRAND_WORDMARK_LINES[1]}
    </span>
  );
}
