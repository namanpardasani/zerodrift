import { animate, motion, useMotionValue, useReducedMotion } from 'motion/react';
import { useEffect, useRef } from 'react';

/**
 * The drift needle. ONE component, used by the landing hero, the overview KPI and the chaos bench.
 *
 * The dial is centred on 0 (drift = 0 paise). The needle is a damped spring: it swings in from the left on
 * mount, wobbles when "kicked" by a real fault event, and ALWAYS comes back to its target. The target is the
 * real drift, so a non-zero drift would visibly hold the needle off zero.
 */

/** Real drift (paise, signed) -> needle angle in degrees. 0 stays exactly 0; anything else is clearly off zero. */
export function driftToAngle(drift: string | number | bigint | null | undefined): number {
  if (drift === null || drift === undefined || drift === '') return 0;
  let v: bigint;
  try {
    v = BigInt(drift);
  } catch {
    return 0;
  }
  if (v === 0n) return 0;
  const mag = Math.min(58, 14 + 8 * Math.log10(Number(v < 0n ? -v : v) + 1));
  return v < 0n ? -mag : mag;
}

const START_ANGLE = -58;

/** Spring state shared by the faces below: returns the motion value that drives the needle rotation. */
export function useNeedle({ drift, kicks = 0, entrance = true }: { drift?: string | number | bigint | null; kicks?: number; entrance?: boolean }) {
  const reduced = useReducedMotion();
  const angle = useMotionValue(entrance && !reduced ? START_ANGLE : driftToAngle(drift));
  const target = driftToAngle(drift);
  const lastKicks = useRef(kicks);

  // swing to the target (also runs on mount: the entrance sweep)
  useEffect(() => {
    if (reduced) {
      angle.set(target);
      return;
    }
    const c = animate(angle, target, { type: 'spring', stiffness: 40, damping: 5, mass: 1 });
    return () => c.stop();
  }, [target, reduced, angle]);

  // a real fault happened: shove the needle, the spring pulls it back
  useEffect(() => {
    if (kicks === lastKicks.current) return;
    lastKicks.current = kicks;
    if (reduced) return;
    const dir = Math.random() < 0.5 ? -1 : 1;
    const c = animate(angle, target, { type: 'spring', stiffness: 40, damping: 5, mass: 1, velocity: dir * (260 + Math.random() * 220) });
    return () => c.stop();
  }, [kicks, reduced, angle, target]);

  return angle;
}

/** The dial markings and the needle, drawn inside any <svg>. Centre (cx, cy), tick radius r. */
export function GaugeFace({ cx, cy, r, drift, kicks, entrance, labelInset = 30, font = 11, needleLength }: { cx: number; cy: number; r: number; drift?: string | number | bigint | null; kicks?: number; entrance?: boolean; labelInset?: number; font?: number; needleLength?: number }) {
  const angle = useNeedle({ drift, kicks, entrance });
  const ticks = [];
  for (let i = -10; i <= 10; i++) {
    const a = i * 6;
    const major = i % 5 === 0;
    ticks.push(<line key={`t${i}`} x1={cx} x2={cx} y1={cy - r} y2={cy - r + (major ? 14 : 7)} stroke={major ? '#EDEDEA' : '#6F6F6A'} strokeWidth={major ? 2 : 1.2} transform={`rotate(${a} ${cx} ${cy})`} />);
    if (major) {
      const rad = (a * Math.PI) / 180;
      const lr = r - labelInset;
      ticks.push(
        <text key={`l${i}`} x={cx + lr * Math.sin(rad)} y={cy - lr * Math.cos(rad) + 4} textAnchor="middle" fontFamily="var(--font-mono)" fontSize={font} fill="#A3A39E">
          {i === 0 ? '0' : (i < 0 ? '−' : '+') + Math.abs(i)}
        </text>,
      );
    }
  }
  const len = needleLength ?? r - 14;
  return (
    <g>
      {ticks}
      <motion.line x1={cx} y1={cy} x2={cx} y2={cy - len} stroke="#FF5A1F" strokeWidth={3} strokeLinecap="round" style={{ rotate: angle, transformOrigin: `${cx}px ${cy}px` }} />
      <circle cx={cx} cy={cy} r={8} fill="#2A2A2A" stroke="#5A5A56" />
    </g>
  );
}

/** Standalone dial on a black display (the chaos bench meter). */
export function Gauge({ drift, kicks, entrance, label = 'Drift needle' }: { drift?: string | number | bigint | null; kicks?: number; entrance?: boolean; label?: string }) {
  return (
    <svg viewBox="0 0 260 150" role="img" aria-label={`${label}: ${drift === undefined || drift === null || String(drift) === '0' ? 'on zero' : `off zero by ${String(drift)} paise`}`} className="block h-auto w-full">
      <GaugeFace cx={130} cy={138} r={100} drift={drift} kicks={kicks} entrance={entrance} labelInset={32} font={12} />
    </svg>
  );
}

/** The tiny dial in the Overview KPI card: a half-circle track and a needle, same spring. */
export function MiniGauge({ drift, kicks }: { drift?: string | number | bigint | null; kicks?: number }) {
  const angle = useNeedle({ drift, kicks });
  return (
    <svg width="64" height="36" viewBox="0 0 64 36" role="img" aria-label={String(drift ?? '0') === '0' ? 'drift needle on zero' : 'drift needle off zero'}>
      <path d="M6 32a26 26 0 0 1 52 0" fill="none" stroke="#E2E2DE" strokeWidth="4" strokeLinecap="round" />
      <motion.line x1="32" y1="32" x2="32" y2="12" stroke="#FF5A1F" strokeWidth="2.5" strokeLinecap="round" style={{ rotate: angle, transformOrigin: '32px 32px' }} />
      <circle cx="32" cy="32" r="3" fill="#111418" />
    </svg>
  );
}
