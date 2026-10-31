import type { SVGProps } from 'react';

/** Thin line icons (1.2 to 1.6px strokes), the only icon style in the product. Decorative: aria-hidden. */
type P = SVGProps<SVGSVGElement>;
const base = (p: P, vb: string) => ({ viewBox: vb, fill: 'none', stroke: 'currentColor', 'aria-hidden': true, ...p });

export const IconOverview = (p: P) => <svg {...base(p, '0 0 24 24')} strokeWidth="1.6"><path d="M4 18a8 8 0 0 1 16 0" /><path d="M12 18V10" /></svg>;
export const IconPayments = (p: P) => <svg {...base(p, '0 0 24 24')} strokeWidth="1.6"><circle cx="12" cy="12" r="8" /><path d="M8 12h8M13 9l3 3-3 3" /></svg>;
export const IconAccounts = (p: P) => <svg {...base(p, '0 0 24 24')} strokeWidth="1.6"><circle cx="12" cy="9" r="3.5" /><path d="M5 20a7 7 0 0 1 14 0" /></svg>;
export const IconLedger = (p: P) => <svg {...base(p, '0 0 24 24')} strokeWidth="1.6"><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M4 9h16M12 9v11" /></svg>;
export const IconWebhooks = (p: P) => <svg {...base(p, '0 0 24 24')} strokeWidth="1.6" strokeLinecap="round"><path d="M5 12a7 7 0 0 1 12-5l2 2M19 12a7 7 0 0 1-12 5l-2-2M19 4v5h-5M5 20v-5h5" /></svg>;
export const IconRecon = (p: P) => <svg {...base(p, '0 0 24 24')} strokeWidth="1.6" strokeLinecap="round"><path d="M4 7h6M4 12h6M4 17h6M14 7h6M14 12h6M14 17h6" /></svg>;
export const IconAudit = (p: P) => <svg {...base(p, '0 0 24 24')} strokeWidth="1.6" strokeLinecap="round"><path d="M7 4h10v16H7zM10 9h4M10 13h4" /></svg>;
export const IconMetrics = (p: P) => <svg {...base(p, '0 0 24 24')} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19V5M4 19h16M8 15l3-4 3 2 4-6" /></svg>;
export const IconChaos = (p: P) => <svg {...base(p, '0 0 24 24')} strokeWidth="1.6"><rect x="3" y="9" width="18" height="8" rx="4" /><circle cx="16" cy="13" r="2" /></svg>;
export const IconArrow = (p: P) => <svg {...base(p, '0 0 24 24')} strokeWidth="1.6" strokeLinecap="round"><path d="M4 12h12M12 6l6 6-6 6" /></svg>;
export const IconBolt = (p: P) => <svg {...base(p, '0 0 24 24')} strokeWidth="1.6" strokeLinecap="round"><path d="M13 3L5 14h6l-1 7 8-11h-6z" /></svg>;
export const IconLock = (p: P) => <svg {...base(p, '0 0 24 24')} strokeWidth="1.6"><path d="M7 11V8a5 5 0 0 1 10 0v3" /><rect x="5" y="11" width="14" height="9" rx="2" /></svg>;
export const IconCheck = (p: P) => <svg {...base(p, '0 0 24 24')} strokeWidth="2.4" strokeLinecap="round"><path d="M5 12l5 5 9-10" /></svg>;
export const IconNotEqual = (p: P) => <svg {...base(p, '0 0 24 24')} strokeWidth="2.4" strokeLinecap="round"><path d="M5 9h14M5 15h14M15 4L9 20" /></svg>;

/** The mark: a drift meter (dial arc, needle, base line). */
export const MarkMeter = (p: P) => <svg {...base(p, '0 0 92 92')} strokeWidth="6" strokeLinecap="round"><path d="M10 64a36 36 0 0 1 72 0" /><path d="M46 64V26" /></svg>;

/** Big thin icons of the stage navigation (46px, 1.2px stroke, like the reference). */
export const StageLedger = (p: P) => <svg {...base(p, '0 0 46 46')} strokeWidth="1.2"><rect x="6" y="5" width="34" height="36" /><path d="M6 13h34M23 5v36M10 19h9M10 24h9M27 29h9M27 34h9" /></svg>;
export const StagePayments = (p: P) => <svg {...base(p, '0 0 46 46')} strokeWidth="1.2"><circle cx="23" cy="23" r="16" /><path d="M3 23h40M35 16l8 7-8 7" /></svg>;
export const StageChaos = (p: P) => <svg {...base(p, '0 0 46 46')} strokeWidth="1.2"><rect x="5" y="15" width="36" height="16" rx="8" /><circle cx="33" cy="23" r="5" /><path d="M12 9l3 4M23 6v5M34 9l-3 4" /></svg>;
export const StageDocs = (p: P) => <svg {...base(p, '0 0 46 46')} strokeWidth="1.2"><path d="M8 6h22l8 8v26H8z" /><path d="M30 6v8h8M14 22h18M14 28h18M14 34h11" /></svg>;
export const StageMark = (p: P) => <svg {...base(p, '0 0 92 92')} strokeWidth="1.4"><path d="M10 64a36 36 0 0 1 72 0" /><path d="M46 64V26" /><circle cx="46" cy="64" r="5" /><path d="M14 64h8M70 64h8M46 20v-6" /><path d="M10 78h72" /></svg>;
