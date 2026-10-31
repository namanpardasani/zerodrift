import { animate, motion, useMotionValue, useReducedMotion } from 'motion/react';
import { type ReactNode, useEffect, useState } from 'react';
import { Dot } from './components.js';
import { cx } from './format.js';
import { IconCheck, IconNotEqual } from './icons.js';
import { Rupees } from './odometer.js';

// ============================================================ MetroLine: payment state as a transit line
export function MetroLine({ states, current, className }: { states: string[]; current: string; className?: string }) {
  const reduced = useReducedMotion();
  const idx = Math.max(0, states.indexOf(current));
  const last = states.length - 1;
  // a finished payment (settled, refunded or failed) has no "in progress" step: its station is done, not pulsing
  const terminal = ['succeeded', 'refunded', 'failed'].includes(current);
  return (
    <div role="group" aria-label={`Payment state: ${current}`} className={cx('relative flex justify-between px-[7px] pt-1.5', className)}>
      <div className="absolute left-3.5 right-3.5 top-[13px] h-0.5 bg-rule" aria-hidden="true" />
      <motion.div className="absolute left-3.5 top-[13px] h-0.5 origin-left bg-ink" aria-hidden="true" style={{ right: 14 }} initial={reduced ? false : { scaleX: 0 }} animate={{ scaleX: last ? idx / last : 0 }} transition={{ duration: 0.9, ease: [0.2, 0.8, 0.2, 1] }} />
      {states.map((s, i) => {
        const done = i < idx || (i === idx && (i === last || terminal));
        const cur = i === idx && !done;
        return (
          <div key={s} aria-current={i === idx ? 'step' : undefined} className={cx('relative flex flex-col gap-2.5 text-[13px]', i === 0 ? 'items-start' : i === last ? 'items-end' : 'items-center', done || cur ? 'text-ink' : 'text-muted')}>
            <motion.i
              className={cx('block h-4 w-4 rounded-full border-2', done ? 'border-ink bg-ink' : cur ? 'border-signal bg-card shadow-[0_0_0_4px_rgba(255,90,31,0.18)]' : 'border-[#c3c3be] bg-card')}
              initial={reduced ? false : { scale: 0.6 }}
              animate={{ scale: 1 }}
              transition={{ delay: i * 0.25, type: 'spring', stiffness: 400, damping: 18 }}
            />
            {s.replace(/_/g, ' ')}
          </div>
        );
      })}
    </div>
  );
}

// ============================================================ TransferCard + timeline (plate 02's card)
export interface TimelineStep {
  label: ReactNode;
  time?: string;
  /** pending steps ping yellow until they settle */
  tone?: 'settled' | 'pending' | 'failed';
}

/** Steps appear one by one; a pending step pings yellow and turns green when its tone changes to settled. */
export function Timeline({ steps, stepDelay = 0.45, className }: { steps: TimelineStep[]; stepDelay?: number; className?: string }) {
  const reduced = useReducedMotion();
  return (
    <ol className={cx('m-0 list-none p-0', className)}>
      {steps.map((s, i) => (
        <motion.li
          key={i}
          className="relative grid grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-2 py-2.5 text-sm after:absolute after:left-1 after:top-[30px] after:h-[22px] after:w-[1.5px] after:bg-rule last:after:hidden"
          initial={reduced ? false : { opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * stepDelay, duration: 0.35, ease: [0.2, 0.8, 0.2, 1] }}
        >
          <Dot tone={s.tone ?? 'settled'} pulse={s.tone === 'pending'} />
          <span>{s.label}</span>
          <span className="mono text-[13px] text-muted">{s.time}</span>
        </motion.li>
      ))}
    </ol>
  );
}

/** The floating transfer card: it rises, the amount rolls up like an odometer, the timeline steps appear. */
export function TransferCard({ amountMinor, subtitle, steps, className }: { amountMinor: string; subtitle: ReactNode; steps: TimelineStep[]; className?: string }) {
  const reduced = useReducedMotion();
  return (
    <motion.div className={cx('rounded-[18px] bg-card shadow-[0_1px_0_rgba(0,0,0,0.04),0_24px_50px_-24px_rgba(17,20,24,0.35)]', className)} initial={reduced ? false : { y: 36, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ duration: 0.7, ease: [0.2, 0.8, 0.2, 1] }}>
      <div className="border-b border-rule px-7 pb-[18px] pt-[26px]">
        <div className="text-[38px] font-semibold tracking-[-0.02em]"><Rupees minor={amountMinor} className="mono" /></div>
        <div className="mt-1.5 flex items-center gap-2 text-[15px] text-ink-2">{subtitle}</div>
      </div>
      <Timeline steps={steps} className="px-7 pb-6 pt-[18px]" />
    </motion.div>
  );
}

// ============================================================ CodeBlock: navy panel, lines "typed" in by a stepped reveal
export type CodeToken = { t: string; k?: 'kw' | 'st' | 'dm' };
export function CodeBlock({ lines, lineDelay = 0.26, className, label }: { lines: CodeToken[][]; lineDelay?: number; className?: string; label: string }) {
  const reduced = useReducedMotion();
  const color = { kw: 'text-code-kw', st: 'text-code-str', dm: 'text-code-dim' } as const;
  return (
    <div role="img" aria-label={label} className={cx('mono min-w-0 overflow-hidden rounded-[22px] bg-navy px-5 py-[30px] text-[13px] leading-[1.9] text-code-text sm:px-[30px] sm:text-[15px]', className)}>
      {lines.map((tokens, i) => (
        <div key={i} className="flex gap-[22px] whitespace-pre" aria-hidden="true">
          <span className="w-[18px] flex-none text-right text-code-ln">{i + 1}</span>
          <motion.span initial={reduced ? false : { clipPath: 'inset(0 100% 0 0)' }} animate={{ clipPath: 'inset(0 0% 0 0)' }} transition={{ delay: i * lineDelay, duration: 0.38, ease: (t: number) => Math.floor(t * 22) / 22 }}>
            {tokens.map((tk, j) => (
              <span key={j} className={tk.k ? color[tk.k] : undefined}>
                {tk.t}
              </span>
            ))}
          </motion.span>
        </div>
      ))}
    </div>
  );
}

// ============================================================ RetryTrack: webhook attempts on a to-scale time axis
export interface TrackAttempt {
  /** milliseconds since the first attempt */
  atMs: number;
  label: string;
  ok: boolean;
}

/** A pulse travels the line and lands on each attempt. Gaps are drawn to scale, so exponential backoff is visible. */
export function RetryTrack({ attempts, className }: { attempts: TrackAttempt[]; className?: string }) {
  const reduced = useReducedMotion();
  const x = useMotionValue(0);
  const [hit, setHit] = useState(reduced ? attempts.length : 0);
  const span = Math.max(1, attempts.at(-1)?.atMs ?? 1);
  const pos = (ms: number) => 2 + (ms / span) * 96;

  useEffect(() => {
    if (reduced || attempts.length === 0) {
      setHit(attempts.length);
      return;
    }
    let cancelled = false;
    setHit(0);
    x.set(pos(attempts[0]!.atMs));
    (async () => {
      for (let i = 0; i < attempts.length; i++) {
        if (i > 0) {
          const gap = attempts[i]!.atMs - attempts[i - 1]!.atMs;
          // compress real time (could be minutes) into a watchable travel, keeping the proportions
          await animate(x, pos(attempts[i]!.atMs), { duration: 0.25 + (gap / span) * 2.6, ease: [0.45, 0, 0.55, 1] });
        }
        if (cancelled) return;
        setHit(i + 1);
        await new Promise((r) => setTimeout(r, 300));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reduced, attempts.length, span]);

  const gapLabel = (ms: number) => (ms < 1000 ? `${ms} ms` : ms < 120_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);
  return (
    <div className={cx('relative mx-8 h-[150px]', className)} role="img" aria-label={`${attempts.length} delivery attempts: ${attempts.map((a) => a.label).join(', ')}`}>
      <div className="absolute inset-x-0 top-16 h-0.5" style={{ background: 'repeating-linear-gradient(90deg,#CFCFCA 0 6px,transparent 6px 12px)' }} aria-hidden="true" />
      {attempts.map((a, i) => (
        <div key={i} aria-hidden="true">
          {i > 0 && (
            <motion.span className="mono absolute top-[22px] -translate-x-1/2 text-xs text-muted" style={{ left: `${(pos(attempts[i - 1]!.atMs) + pos(a.atMs)) / 2}%` }} initial={false} animate={{ opacity: hit > i ? 1 : 0 }}>
              wait {gapLabel(a.atMs - attempts[i - 1]!.atMs)}
            </motion.span>
          )}
          <motion.span className={cx('absolute top-14 -ml-[9px] h-[18px] w-[18px] rounded-full border-2', hit > i ? (a.ok ? 'border-settled bg-settled' : 'border-failed bg-failed') : 'border-[#c3c3be] bg-card')} style={{ left: `${pos(a.atMs)}%` }} initial={false} animate={{ scale: hit > i ? 1 : 0.6, opacity: hit > i ? 1 : 0.5 }} transition={{ type: 'spring', stiffness: 500, damping: 14 }}>
            <b className={cx('mono absolute left-1/2 top-7 -translate-x-1/2 whitespace-nowrap text-xs font-normal', a.ok ? 'text-settled-ink' : 'text-failed-ink', hit > i ? 'opacity-100' : 'opacity-0')}>
              #{i + 1} · {a.label}
            </b>
          </motion.span>
        </div>
      ))}
      <motion.span className="absolute left-0 top-[57px] -ml-2 h-4 w-4 rounded-full bg-ink shadow-[0_0_0_6px_rgba(17,20,24,0.12)]" style={{ left: useTransformPct(x) }} initial={false} animate={{ opacity: hit >= attempts.length ? 0 : 1 }} aria-hidden="true" />
    </div>
  );
}

function useTransformPct(x: ReturnType<typeof useMotionValue<number>>) {
  const [v, setV] = useState(`${x.get()}%`);
  useEffect(() => x.on('change', (n) => setV(`${n}%`)), [x]);
  return v;
}

// ============================================================ Zipper: two columns meeting in the middle
export interface ZipRow {
  ref: string;
  left: string;
  right: string;
  /** set for a mismatch: why it does not match */
  note?: string;
}

/** Rows slide in from both sides and meet like a zip; matches get a check, a mismatch turns red and expands. */
export function Zipper({ rows, leftTitle, rightTitle, className }: { rows: ZipRow[]; leftTitle: string; rightTitle: string; className?: string }) {
  const reduced = useReducedMotion();
  const step = 0.55;
  const cell = (side: -1 | 1, bad: boolean, i: number) => ({
    initial: reduced ? false : { opacity: 0, x: side * 36 },
    animate: { opacity: 1, x: 0 },
    transition: { delay: i * step, duration: 0.5, ease: [0.2, 0.8, 0.2, 1] as const },
    className: cx('mono flex justify-between gap-2.5 rounded-[10px] border px-3.5 py-2.5 text-sm', bad ? 'border-failed-rule bg-failed-bg' : 'border-rule'),
  });
  return (
    <div className={cx('grid grid-cols-[minmax(0,1fr)_36px_minmax(0,1fr)] gap-y-2.5 sm:grid-cols-[minmax(0,1fr)_64px_minmax(0,1fr)]', className)}>
      <div className="mono px-1 pb-1 text-xs text-muted">{leftTitle}</div>
      <div />
      <div className="mono px-1 pb-1 text-xs text-muted">{rightTitle}</div>
      {rows.map((r, i) => {
        const bad = r.note !== undefined;
        return (
          <div key={r.ref + i} className="contents">
            <motion.div {...cell(-1, bad, i)}>
              <span>{r.ref}</span>
              <span>{r.left}</span>
            </motion.div>
            <motion.div className="flex items-center justify-center" initial={reduced ? false : { opacity: 0, scale: 0.4 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: i * step + 0.3, type: 'spring', stiffness: 500, damping: 14 }}>
              {bad ? <IconNotEqual role="img" aria-label="mismatch" className="h-[22px] w-[22px] text-failed" /> : <IconCheck role="img" aria-label="matched" className="h-[22px] w-[22px] text-settled" />}
            </motion.div>
            <motion.div {...cell(1, bad, i)}>
              <span>{r.ref}</span>
              <span>{r.right}</span>
            </motion.div>
            {bad && (
              <motion.div className="col-span-3 overflow-hidden text-[13px] text-failed-ink" initial={reduced ? false : { height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} transition={{ delay: i * step + 0.6, duration: 0.5, ease: [0.2, 0.8, 0.2, 1] }}>
                <div className="mt-0.5 border-l-0 bg-failed-bg px-3.5 py-2 text-failed-ink">{r.note}</div>
              </motion.div>
            )}
          </div>
        );
      })}
    </div>
  );
}
