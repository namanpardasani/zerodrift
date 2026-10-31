import NumberFlow from '@number-flow/react';
import { useEffect, useState } from 'react';
import { cx, formatInr, minorToRupees } from './format.js';

/**
 * Rolling numbers (odometer): every money value and KPI that changes rolls instead of jumping.
 * `rollIn` starts the first render from zero so a number "counts up" when its page opens.
 * Screen readers get the final formatted text once; the rolling digits are aria-hidden.
 */
function useRoll(value: number, rollIn: boolean) {
  const [v, setV] = useState(rollIn ? 0 : value);
  useEffect(() => {
    setV(value);
  }, [value]);
  return v;
}

export function Rupees({ minor, rollIn = true, className }: { minor: string | number | bigint | null | undefined; rollIn?: boolean; className?: string }) {
  const rupees = minorToRupees(minor);
  const shown = useRoll(rupees ?? 0, rollIn);
  const text = formatInr(minor);
  // beyond 2^53 paise a JS number cannot be exact: show the exact string, no rolling
  if (rupees === null) return <span className={className}>{text}</span>;
  return (
    <span className={cx('relative', className)}>
      <span className="sr-only-zd">{text}</span>
      <NumberFlow aria-hidden="true" value={shown} locales="en-IN" format={{ style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 }} />
    </span>
  );
}

export function Count({ value, rollIn = true, className }: { value: number; rollIn?: boolean; className?: string }) {
  const shown = useRoll(value, rollIn);
  return (
    <span className={cx('relative', className)}>
      <span className="sr-only-zd">{value.toLocaleString('en-IN')}</span>
      <NumberFlow aria-hidden="true" value={shown} locales="en-IN" />
    </span>
  );
}

/** value is a percentage 0..100 */
export function Percent({ value, rollIn = true, className }: { value: number; rollIn?: boolean; className?: string }) {
  const shown = useRoll(value, rollIn);
  return (
    <span className={cx('relative', className)}>
      <span className="sr-only-zd">{value.toFixed(1)}%</span>
      <NumberFlow aria-hidden="true" value={shown} locales="en-IN" format={{ minimumFractionDigits: 1, maximumFractionDigits: 1 }} suffix="%" />
    </span>
  );
}
