import { motion, useAnimationControls, useReducedMotion } from 'motion/react';
import { useEffect, useRef, type ReactNode } from 'react';
import { cx } from './format.js';
import { Gauge } from './gauge.js';

/** LED: green = up; red and blinking = down. */
export function Led({ down }: { down?: boolean }) {
  return <span aria-hidden="true" className={cx('h-[9px] w-[9px] rounded-full', down ? 'zd-led-fast bg-failed shadow-[0_0_10px_rgba(217,58,63,0.85)]' : 'bg-[#15b57f] shadow-[0_0_8px_rgba(21,181,127,0.7)]')} />;
}

/** A real switch (role="switch"): on = service running. Flipping it off kills the service. */
export function PowerSwitch({ on, onToggle, label, disabled }: { on: boolean; onToggle: () => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={onToggle} className={cx('relative h-6 w-[46px] rounded-xl border-0 p-0 transition-colors disabled:opacity-50', on ? 'bg-[#2a2a2a]' : 'bg-[#7a7a75]')}>
      <motion.span className="absolute top-[3px] h-[18px] w-[18px] rounded-full bg-[#f2f2ee]" initial={false} animate={{ left: on ? 25 : 3 }} transition={{ type: 'spring', stiffness: 600, damping: 32 }} />
    </button>
  );
}

/** The orange hardware kill button. */
export function KillButton({ onKill, label, disabled, children = 'kill' }: { onKill: () => void; label: string; disabled?: boolean; children?: ReactNode }) {
  return (
    <button type="button" aria-label={label} disabled={disabled} onClick={onKill} className="zd-hw mono h-11 w-11 rounded-nav text-[11px] font-semibold">
      {children}
    </button>
  );
}

/**
 * One chaos-bench module: a real service. LED, grille, live status, switch and kill button.
 * When `down` flips to true the tile shakes (a real fault landed).
 */
export function ModuleTile({ name, status, down, busy, onKill, onToggle, killLabel, shake = 0 }: { name: string; status: string; down: boolean; busy?: boolean; onKill: () => void; onToggle: () => void; killLabel?: string; /** bump this number to make the tile shake (a fault just landed on it) */ shake?: number }) {
  const reduced = useReducedMotion();
  const controls = useAnimationControls();
  const prev = useRef({ down, shake });
  useEffect(() => {
    const landed = (down && !prev.current.down) || shake !== prev.current.shake;
    if (landed && !reduced) void controls.start({ x: [0, -5, 5, -3, 3, 0], rotate: [0, -0.6, 0.6, 0, 0, 0], transition: { duration: 0.45 } });
    prev.current = { down, shake };
  }, [down, shake, reduced, controls]);
  return (
    <motion.div animate={controls} className="relative flex min-w-0 flex-col gap-2.5 rounded-2xl p-4 text-hw-ink" style={{ background: 'linear-gradient(#e3e3df,#c9c9c4)' }}>
      <div className="flex items-center justify-between">
        <span className="text-[19px] tracking-[-0.01em]">{name}</span>
        <Led down={down} />
      </div>
      <div aria-hidden="true" className="h-[26px]" style={{ background: 'radial-gradient(circle,#8f8f8a 1.4px,transparent 1.8px) 0 0/9px 9px' }} />
      <div aria-live="polite" className={cx('mono min-h-4 text-[11px]', down ? 'text-[#9b2125]' : 'text-[#3f3f3b]')}>
        {status}
      </div>
      <div className="mt-auto flex items-center justify-between">
        <PowerSwitch on={!down} onToggle={onToggle} label={`${name} power`} disabled={busy} />
        <KillButton onKill={onKill} label={killLabel ?? `kill ${name}`} disabled={busy || down} />
      </div>
    </motion.div>
  );
}

/** A black LCD readout with an orange value. */
export function Lcd({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mono rounded-lg bg-[#161616] px-2.5 py-2 text-[10px] tracking-[0.06em] text-on-stage-2">
      {label}
      <b className="mt-0.5 block text-[22px] font-medium tracking-normal text-signal">{children}</b>
    </div>
  );
}

/** The big meter module of the bench: the dial and its readouts. */
export function BenchMeter({ drift, kicks, transfers, faults, driftText }: { drift: string; kicks: number; transfers: ReactNode; faults: ReactNode; driftText: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 rounded-2xl p-4 text-hw-ink md:row-span-2" style={{ background: 'linear-gradient(#e3e3df,#c6c6c1)' }}>
      <div className="rounded-xl bg-[#121212] px-3 pb-3.5 pt-2.5 text-on-stage">
        <Gauge drift={drift} kicks={kicks} />
      </div>
      <div className="grid grid-cols-2 gap-2.5">
        <Lcd label="TRANSFERS">{transfers}</Lcd>
        <Lcd label="FAULTS">{faults}</Lcd>
      </div>
      <Lcd label="₹ DRIFT">{driftText}</Lcd>
    </div>
  );
}
