import { motion, useReducedMotion } from 'motion/react';
import type { ReactNode } from 'react';
import { cx, formatMinorPlain } from './format.js';
import { Stamp } from './stamp.js';

export interface JournalLine {
  account: ReactNode;
  /** small grey text after the account, e.g. "customer wallet" */
  sub?: string;
  direction: 'debit' | 'credit';
  amountMinor: string;
}

const ROW_STEP = 0.38; // seconds between rows being "written"

/**
 * A ledger transaction drawn as a paper journal: rows are written in left to right like ink, a bracket is drawn
 * around them, then a BALANCED stamp thuds down and the card bumps. Debits are red ink, credits plain ink.
 * The total and the stamp are computed from the lines (BigInt), so an unbalanced transaction can never read "balanced".
 */
export function Journal({ title, meta, lines, className }: { title: ReactNode; meta?: ReactNode; lines: JournalLine[]; className?: string }) {
  const reduced = useReducedMotion();
  const debits = lines.filter((l) => l.direction === 'debit').reduce((s, l) => s + BigInt(l.amountMinor), 0n);
  const credits = lines.filter((l) => l.direction === 'credit').reduce((s, l) => s + BigInt(l.amountMinor), 0n);
  const balanced = debits === credits && lines.length > 0;
  const rowsDone = (lines.length + 1) * ROW_STEP; // lines + total row
  const ink = (i: number) => ({ initial: reduced ? false : { clipPath: 'inset(0 100% 0 0)' }, animate: { clipPath: 'inset(0 0% 0 0)' }, transition: { duration: 0.55, delay: i * ROW_STEP, ease: [0.2, 0.8, 0.2, 1] as const } });
  const cols = 'grid grid-cols-[minmax(0,1fr)_96px_96px] sm:grid-cols-[minmax(0,1fr)_110px_110px] items-center gap-x-2 px-[18px]';

  return (
    <motion.section aria-label="Journal entry" className={cx('relative overflow-hidden rounded-card border border-rule bg-card', className)} animate={reduced ? undefined : { y: [0, 0, 2, 0] }} transition={{ duration: 0.45, times: [0, 0.7, 0.85, 1], delay: rowsDone + 0.9 }}>
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-rule px-[18px] py-3.5 text-sm">
        <b className="font-medium">{title}</b>
        {meta && <span className="mono text-xs text-muted">{meta}</span>}
      </header>
      <div className={cx(cols, 'mono border-b border-rule py-2.5 text-xs text-muted')}>
        <span>account</span>
        <span className="text-right">debit</span>
        <span className="text-right">credit</span>
      </div>
      <div className="relative pr-6">
        {lines.map((l, i) => (
          <motion.div key={i} {...ink(i)} className={cx(cols, 'border-b border-rule py-3 text-sm')}>
            <span className="min-w-0 break-words">
              {l.account}
              {l.sub && <small className="text-xs text-muted"> · {l.sub}</small>}
            </span>
            <span className="mono text-right text-failed-ink">{l.direction === 'debit' ? formatMinorPlain(l.amountMinor) : ''}</span>
            <span className="mono text-right">{l.direction === 'credit' ? formatMinorPlain(l.amountMinor) : ''}</span>
          </motion.div>
        ))}
        <motion.div {...ink(lines.length)} className={cx(cols, 'bg-paper/60 py-3 text-sm font-medium')}>
          <span>total</span>
          <span className="mono text-right">{formatMinorPlain(debits)}</span>
          <span className="mono text-right">{formatMinorPlain(credits)}</span>
        </motion.div>
        {/* the bracket: drawn with stroke-dashoffset (pathLength) once the rows are written */}
        <svg aria-hidden="true" className="pointer-events-none absolute right-1 top-0 h-full w-5" viewBox="0 0 22 100" preserveAspectRatio="none" fill="none">
          <motion.path d="M2 2H12V98H2M12 50H20" stroke="var(--stamp)" strokeWidth="2" vectorEffect="non-scaling-stroke" initial={reduced ? false : { pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.6, delay: rowsDone + 0.2, ease: [0.2, 0.8, 0.2, 1] }} />
        </svg>
        <Stamp show={balanced} delay={rowsDone + 0.8} className="bottom-2 left-24">
          balanced
        </Stamp>
        {!balanced && lines.length > 0 && (
          <Stamp show tone="red" className="bottom-2 left-24" delay={rowsDone + 0.8}>
            unbalanced
          </Stamp>
        )}
      </div>
    </motion.section>
  );
}
