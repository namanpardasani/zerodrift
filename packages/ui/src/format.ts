/**
 * Money is shown from INTEGER minor units (paise), using bigint so values beyond 2^53 stay exact.
 * Accepts the decimal strings the APIs send ("12500"), numbers (only safe integers) or bigint.
 */
export function formatInr(minor: string | number | bigint | null | undefined): string {
  if (minor === null || minor === undefined || minor === '') return '-';
  let v: bigint;
  try {
    v = typeof minor === 'bigint' ? minor : BigInt(minor);
  } catch {
    return String(minor);
  }
  const negative = v < 0n;
  const abs = negative ? -v : v;
  const rupees = (abs / 100n).toLocaleString('en-IN');
  const paise = (abs % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}₹${rupees}.${paise}`;
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '-';
  const s = Math.round((now - new Date(iso).getTime()) / 1000);
  if (Number.isNaN(s)) return '-';
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export const shortId = (id: string): string => (id.length > 12 ? `${id.slice(0, 8)}…` : id);

export const cx = (...parts: (string | false | null | undefined)[]): string => parts.filter(Boolean).join(' ');

/** "25000" paise -> "250.00" (no currency sign), used inside journals and receipts where the column says what it is. */
export function formatMinorPlain(minor: string | number | bigint | null | undefined): string {
  if (minor === null || minor === undefined || minor === '') return '';
  try {
    const v = BigInt(minor);
    const abs = v < 0n ? -v : v;
    return `${v < 0n ? '-' : ''}${(abs / 100n).toLocaleString('en-IN')}.${(abs % 100n).toString().padStart(2, '0')}`;
  } catch {
    return String(minor);
  }
}

/** Rupees as a JS number for NumberFlow, or null when the value is too large to be exact (then show the exact string instead). */
export function minorToRupees(minor: string | number | bigint | null | undefined): number | null {
  if (minor === null || minor === undefined || minor === '') return null;
  try {
    const v = BigInt(minor);
    if (v > 9_007_199_254_740_991n || v < -9_007_199_254_740_991n) return null;
    return Number(v) / 100;
  } catch {
    return null;
  }
}

/** "18:42:07.841" from an ISO time: precise times are part of the paper-trail look. */
export function formatClock(iso: string | null | undefined, withMillis = true): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${withMillis ? `.${p(d.getMilliseconds(), 3)}` : ''}`;
}
