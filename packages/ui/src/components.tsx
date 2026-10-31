import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { IconArrow } from './icons.js';
import { cx, formatInr, shortId } from './format.js';

// ---------------------------------------------------------------- Button
// primary  = ink-black, the in-app main action        signal = orange hardware button (stage world, chaos)
// line     = thin outline with a nudging arrow (on stage)   secondary = bordered paper button
type ButtonVariant = 'primary' | 'signal' | 'line' | 'secondary' | 'danger' | 'ghost';
const buttonStyles: Record<ButtonVariant, string> = {
  primary: 'bg-ink text-white hover:bg-ink-2',
  signal: 'zd-hw font-medium',
  line: 'group border border-on-stage bg-transparent text-on-stage hover:bg-white/10',
  secondary: 'border border-rule bg-card text-ink hover:bg-paper',
  danger: 'bg-failed-ink text-white hover:opacity-90',
  ghost: 'bg-transparent text-ink hover:bg-paper',
};

export function Button({ variant = 'secondary', size = 'md', className, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <button
      type="button"
      {...props}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-btn font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'px-2.5 py-1 text-xs' : size === 'lg' ? 'px-[18px] py-3.5 text-[15px]' : 'px-3.5 py-2 text-sm',
        buttonStyles[variant],
        className,
      )}
    >
      {children}
      {variant === 'line' && <IconArrow className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-1" />}
    </button>
  );
}

// ---------------------------------------------------------------- Card / layout
export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('rounded-card border border-rule bg-card', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-rule px-[18px] py-3.5">
          <h2 className="text-[15px] font-medium">{title}</h2>
          <div className="flex items-center gap-2">{actions}</div>
        </header>
      )}
      <div className="p-[18px]">{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 className="text-[28px] font-medium leading-tight tracking-[-0.02em]">{title}</h1>
        {subtitle && <p className="mt-1 max-w-2xl text-sm text-muted">{subtitle}</p>}
      </div>
      <div className="flex items-center gap-2">{actions}</div>
    </div>
  );
}

// ---------------------------------------------------------------- status: dot + word
export type Tone = 'neutral' | 'success' | 'danger' | 'warn' | 'info' | 'accent';
type DotTone = 'settled' | 'pending' | 'failed' | 'neutral';
const dotFor: Record<Tone, DotTone> = { neutral: 'neutral', success: 'settled', danger: 'failed', warn: 'pending', info: 'neutral', accent: 'settled' };

/** The status dot: green settled, yellow pending (pings while it waits), red failed, grey neutral. */
export function Dot({ tone = 'settled', pulse }: { tone?: DotTone; pulse?: boolean }) {
  return <span className="zd-dot" data-tone={tone} data-pulse={pulse ?? tone === 'pending'} aria-hidden="true" />;
}

/** A small label pill (for tags that are not statuses). */
export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  const style: Record<Tone, string> = {
    neutral: 'border-rule bg-paper text-ink-2',
    success: 'border-settled-dot/40 bg-settled-bg text-settled-ink',
    danger: 'border-failed-rule bg-failed-bg text-failed-ink',
    warn: 'border-pending-dot/50 bg-pending-bg text-pending',
    info: 'border-stamp/25 bg-info-bg text-stamp',
    accent: 'border-ink bg-ink text-white',
  };
  return <span className={cx('inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium', style[tone])}>{children}</span>;
}

/** One place that decides how every status in the system is coloured. */
export const STATUS_TONE: Record<string, Tone> = {
  // payments
  created: 'neutral', processing: 'warn', succeeded: 'success', failed: 'danger', partially_refunded: 'info', refunded: 'info',
  // refunds
  pending: 'warn',
  // webhook deliveries
  dead: 'danger',
  // reconciliation runs
  clean: 'success', mismatches: 'danger', running: 'warn',
  // services / containers
  up: 'success', down: 'danger', paused: 'warn', exited: 'danger',
  // severities
  critical: 'danger', warning: 'warn', info: 'info',
};

/** The word shown for a status. Payments say "succeeded" in the API and "settled" on screen, everywhere. */
export const statusLabel = (status: string): string => (status === 'succeeded' ? 'settled' : status.replace(/_/g, ' '));

/** Status as a dot and a word: the same everywhere. */
export function StatusBadge({ status }: { status: string }) {
  const tone = STATUS_TONE[status] ?? 'neutral';
  return (
    <span className="inline-flex items-center gap-2 text-sm">
      <Dot tone={dotFor[tone]} />
      <span>{statusLabel(status)}</span>
    </span>
  );
}

// ---------------------------------------------------------------- Stat
export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: Tone }) {
  return (
    <div className="min-w-0 rounded-card border border-rule bg-card px-[18px] py-4">
      <div className="text-[13px] text-muted">{label}</div>
      <div className={cx('mono mt-2 text-2xl font-medium tracking-[-0.01em]', tone === 'danger' && 'text-failed-ink', tone === 'success' && 'text-settled-ink', tone === 'warn' && 'text-pending')}>{value}</div>
      {hint && <div className="mt-1.5 flex items-center gap-1.5 text-xs text-muted">{hint}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- Table
export interface Column<T> {
  header: string;
  cell: (row: T) => ReactNode;
  className?: string;
}

export function DataTable<T>({ columns, rows, rowKey, onRowClick, empty = 'Nothing here yet.' }: { columns: Column<T>[]; rows: T[]; rowKey: (row: T) => string; onRowClick?: (row: T) => void; empty?: ReactNode }) {
  if (rows.length === 0) return <EmptyState>{empty}</EmptyState>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[420px] border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-rule">
            {columns.map((c) => (
              <th key={c.header} scope="col" className={cx('mono px-[18px] py-2.5 text-xs font-normal text-muted', c.className)}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              onKeyDown={onRowClick ? (e) => e.key === 'Enter' && onRowClick(row) : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              className={cx('border-b border-rule last:border-0', onRowClick && 'cursor-pointer hover:bg-paper')}
            >
              {columns.map((c) => (
                <td key={c.header} className={cx('px-[18px] py-3 align-top', c.className)}>
                  {c.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- misc
export function KeyValue({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
      {items.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Money from integer minor units. Debits are red ink (`debit`), everything else plain ink. */
export function Money({ minor, className, debit }: { minor: string | number | bigint | null | undefined; className?: string; debit?: boolean }) {
  return <span className={cx('mono', debit && 'text-failed-ink', className)}>{formatInr(minor)}</span>;
}

/** An identifier shortened for tables, full value on hover. */
export function Id({ id }: { id: string }) {
  return (
    <code className="mono text-[13px] text-ink-2" title={id}>
      {shortId(id)}
    </code>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center gap-2 text-sm text-muted">
      <Dot tone="pending" />
      {label}…
    </div>
  );
}

/** Paper-style loading placeholder: rows of shimmering rules, shaped like the content that will replace them. */
export function Skeleton({ rows = 4, className }: { rows?: number; className?: string }) {
  return (
    <div role="status" aria-label="Loading" className={cx('space-y-3', className)}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="zd-skeleton h-6" style={{ width: `${100 - ((i * 13) % 35)}%` }} />
      ))}
      <span className="sr-only-zd">Loading…</span>
    </div>
  );
}

export function ErrorNote({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div role="alert" className="flex items-center justify-between gap-3 rounded-card border border-failed-rule bg-failed-bg px-4 py-2.5 text-sm text-failed-ink">
      <span>{message}</span>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="px-6 py-10 text-center text-sm text-muted">{children}</div>;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

const inputStyles = 'w-full rounded-nav border border-rule bg-card px-3 py-2 text-sm text-ink placeholder:text-muted';
export const Input = (props: InputHTMLAttributes<HTMLInputElement>) => <input {...props} className={cx(inputStyles, props.className)} />;
export const Select = (props: SelectHTMLAttributes<HTMLSelectElement>) => <select {...props} className={cx(inputStyles, props.className)} />;

/** Minimal dependency-free line chart. */
export function Sparkline({ points, width = 240, height = 48, label }: { points: number[]; width?: number; height?: number; label?: string }) {
  if (points.length < 2) return <div className="text-xs text-muted">no data yet</div>;
  const max = Math.max(...points, 1e-9);
  const min = Math.min(...points, 0);
  const span = max - min || 1;
  const step = width / (points.length - 1);
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(height - 2 - ((p - min) / span) * (height - 4)).toFixed(1)}`).join(' ');
  return (
    <svg role="img" aria-label={label ?? 'trend'} viewBox={`0 0 ${width} ${height}`} width="100%" height={height} preserveAspectRatio="none">
      <path d={d} fill="none" stroke="var(--ink)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
