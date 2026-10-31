import { motion } from 'motion/react';
import type { CSSProperties, ReactNode } from 'react';
import { cx } from './format.js';

/**
 * A rubber stamp that thuds down: it lands from a big scale with overshoot, slightly rotated.
 * Blue = "balanced / verified" only. Red = "already paid" / unbalanced. Never decorative.
 */
export function Stamp({ show, tone = 'blue', children, className, style, delay = 0 }: { show: boolean; tone?: 'blue' | 'red'; children: ReactNode; className?: string; style?: CSSProperties; delay?: number }) {
  return (
    <motion.span
      aria-hidden={!show}
      initial={false}
      animate={show ? { opacity: 0.92, scale: 1, rotate: -9 } : { opacity: 0, scale: 1.9, rotate: -9 }}
      transition={show ? { type: 'spring', stiffness: 520, damping: 16, delay } : { duration: 0 }}
      style={style}
      className={cx('mono pointer-events-none absolute rounded-md border-[2.5px] border-current bg-white/55 px-3 py-1.5 text-[15px] font-semibold uppercase tracking-[0.16em]', tone === 'red' ? 'text-failed-ink' : 'text-stamp', className)}
    >
      {children}
    </motion.span>
  );
}
