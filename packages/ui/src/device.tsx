import { motion, useReducedMotion } from 'motion/react';
import { useEffect, useState } from 'react';
import { GaugeFace } from './gauge.js';
import { formatInr } from './format.js';

/**
 * The ZD-1: the one hardware object of the stage world. A drift meter (spring needle), an LCD that shows the
 * real drift, a knob, a blinking status LED, and a thermal receipt that prints out of the slot.
 * `drift` is in paise (signed); the page feeds it the real value, the landing page uses 0 when the API is not available.
 */
export function Zd1Device({ drift = '0', kicks = 0, receiptLines, className }: { drift?: string; kicks?: number; receiptLines: string[]; className?: string }) {
  const reduced = useReducedMotion();
  const [printed, setPrinted] = useState(!!reduced);
  useEffect(() => {
    const t = setTimeout(() => setPrinted(true), 900);
    return () => clearTimeout(t);
  }, []);
  const lcd = formatInr(drift).replace('₹', '');
  return (
    <div className={`relative mx-auto max-w-[860px] ${className ?? ''}`}>
      <svg viewBox="0 0 760 420" role="img" aria-label={`ZD-1 drift meter. Drift: ${formatInr(drift)}`} className="block h-auto w-full">
        <defs>
          <linearGradient id="zd1Body" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#EDEDE9" />
            <stop offset=".14" stopColor="#DEDED9" />
            <stop offset="1" stopColor="#BDBDB8" />
          </linearGradient>
          <radialGradient id="zd1Shadow">
            <stop offset="0" stopColor="#000" stopOpacity=".75" />
            <stop offset="1" stopColor="#000" stopOpacity="0" />
          </radialGradient>
          <pattern id="zd1Dots" width="10" height="10" patternUnits="userSpaceOnUse">
            <circle cx="5" cy="5" r="1.6" fill="#8E8E89" />
          </pattern>
        </defs>
        <ellipse cx="380" cy="372" rx="350" ry="18" fill="url(#zd1Shadow)" />
        <rect x="40" y="150" width="680" height="210" rx="24" fill="url(#zd1Body)" />
        <rect x="40.5" y="150.5" width="679" height="209" rx="24" fill="none" stroke="#F8F8F5" strokeOpacity=".7" />
        <path d="M64 330h632" stroke="#A9A9A4" />
        <rect x="78" y="178" width="254" height="150" rx="14" fill="#121212" stroke="#8E8E89" />
        <text x="96" y="200" fontFamily="var(--font-mono)" fontSize="11" fill="#8A8A86">drift · ₹</text>
        <GaugeFace cx={205} cy={318} r={100} drift={drift} kicks={kicks} />
        <rect x="360" y="186" width="180" height="60" rx="8" fill="#161616" />
        <text x="372" y="204" fontFamily="var(--font-mono)" fontSize="9" fill="#8A8A86">₹ DRIFT</text>
        <text x="528" y="234" textAnchor="end" fontFamily="var(--font-mono)" fontSize="32" fill="#FF5A1F">{lcd}</text>
        <rect x="360" y="262" width="180" height="56" rx="6" fill="url(#zd1Dots)" />
        <rect x="360" y="144" width="200" height="8" rx="4" fill="#2A2A2A" />
        <circle cx="626" cy="222" r="40" fill="none" stroke="#A9A9A4" />
        <circle cx="626" cy="222" r="34" fill="#E64E16" />
        <circle cx="626" cy="222" r="27" fill="#FF6A2E" />
        <path d="M626 222V198" stroke="#7A2A0A" strokeWidth="3" strokeLinecap="round" />
        <circle cx="586" cy="304" r="15" fill="#2A2A2A" />
        <path d="M586 304l-8-8" stroke="#E8E8E4" strokeWidth="2" strokeLinecap="round" />
        <circle cx="640" cy="304" r="15" fill="#2A2A2A" />
        <path d="M640 304l9-6" stroke="#E8E8E4" strokeWidth="2" strokeLinecap="round" />
        <circle className="zd-led-blink" cx="694" cy="174" r="5" fill="#22C995" />
        <text x="78" y="350" fontFamily="var(--font-mono)" fontSize="10" fill="#66665F">ZD-1   DOUBLE-ENTRY LEDGER   ₹ INR</text>
      </svg>
      {/* the receipt prints out of the slot in steps (thermal printer), anchored to the device */}
      <motion.div
        aria-hidden="true"
        className="mono absolute overflow-hidden whitespace-nowrap bg-[#fcfbf7] px-[8%] text-[#2a2a2a] shadow-[0_-6px_18px_rgba(0,0,0,0.35)]"
        style={{ left: '47.9%', width: '25.26%', bottom: '64.76%', fontSize: 'clamp(5px,1.05vw,9.5px)', lineHeight: 1.45 }}
        initial={false}
        animate={{ height: printed ? '29%' : '0%' }}
        transition={{ duration: reduced ? 0 : 2.8, ease: (t: number) => Math.floor(t * 14) / 14 }}
      >
        <div className="pt-[8%]">
          {receiptLines.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
      </motion.div>
    </div>
  );
}
