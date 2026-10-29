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
