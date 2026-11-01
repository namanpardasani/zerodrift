import { Brand, Button, formatInr } from '@zerodrift/ui';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { DOCS_URL, REPO_URL } from './chaosResults.js';

export interface PublicStatus {
  available: boolean;
  ok: boolean | null;
  driftMinor: string | null;
}

/** The live claim, as a pill: whether the books balance right now. Unknown stays unknown (grey), never a made-up zero. */
export function StatusPill({ status, compact }: { status: PublicStatus | null; compact?: boolean }) {
  const known = !!status && status.available && status.ok !== null;
  const good = known && status!.ok === true;
  const tone = !known ? 'bg-[#6f6f6a]' : good ? 'bg-settled-dot' : 'bg-failed';
  const text = !known ? 'status unavailable' : good ? `books balanced · drift ${formatInr(status!.driftMinor ?? '0')}` : `VIOLATION · drift ${formatInr(status!.driftMinor ?? '0')}`;
  return (
    <span role="status" className="mono inline-flex items-center gap-2 rounded-full border border-white/15 px-3 py-1.5 text-[12px] text-on-stage-2" title="Read live from the ledger">
      <span className={`h-2 w-2 flex-none rounded-full ${tone} ${good ? 'zd-led-blink' : ''}`} aria-hidden="true" />
      {compact ? (known ? (good ? 'balanced' : 'violation') : 'offline') : text}
    </span>
  );
}

const LINKS: { label: string; href: string; section?: string; external?: boolean }[] = [
  { label: 'how it works', href: '#anatomy', section: 'anatomy' },
  { label: 'chaos results', href: '#chaos-results', section: 'chaos-results' },
  { label: 'docs', href: DOCS_URL, external: true },
  { label: 'github', href: REPO_URL, external: true },
];

/** Which in-page section is on screen, to underline its link. */
function useSectionSpy(ids: string[]): string | null {
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    const els = ids.map((id) => document.getElementById(id)).filter((e): e is HTMLElement => !!e);
    if (els.length === 0 || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setActive(e.target.id);
        if (window.scrollY < 200) setActive(null);
      },
      { rootMargin: '-35% 0px -55% 0px' },
    );
    els.forEach((e) => io.observe(e));
    const onScroll = () => window.scrollY < 200 && setActive(null);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      io.disconnect();
      window.removeEventListener('scroll', onScroll);
    };
  }, [ids.join(',')]);
  return active;
}

const ExternalArrow = () => (
  <svg viewBox="0 0 12 12" className="ml-1 inline h-2.5 w-2.5 text-on-stage-2" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
    <path d="M3 9l6-6M4 3h5v5" />
  </svg>
);

/**
 * The landing top bar: one slim sticky line. Wordmark, four plain links (the current section is underlined in orange),
 * the live "books balance" pill and one clear action. On phones it collapses to wordmark + status dot + a menu button
 * that opens a sheet (Escape or a tap on a link closes it).
 */
export function TopBar({ status }: { status: PublicStatus | null }) {
  const reduced = useReducedMotion();
  const [open, setOpen] = useState(false);
  const active = useSectionSpy(['anatomy', 'chaos-results']);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const linkClass = (isActive: boolean) => `relative py-5 text-[14px] no-underline transition-colors ${isActive ? 'text-on-stage' : 'text-on-stage-2 hover:text-on-stage'}`;

  return (
    <header className="sticky top-0 z-50 border-b border-white/10 bg-stage">
      <div className="mx-auto flex h-16 max-w-[1280px] items-center gap-6 px-[18px] md:px-8">
        <Link to="/" aria-label="Home" className="flex-none no-underline"><Brand tone="stage" /></Link>

        <nav aria-label="Main" className="ml-4 hidden items-center gap-7 md:flex">
          {LINKS.map((l) => (
            <a key={l.label} href={l.href} className={linkClass(l.section === active)} {...(l.external ? { target: '_blank', rel: 'noreferrer' } : {})} aria-current={l.section === active ? 'location' : undefined}>
              {l.label}
              {l.external && <ExternalArrow />}
              {l.section === active && <motion.span layoutId="topbar-underline" className="absolute inset-x-0 bottom-0 h-0.5 bg-signal" transition={{ type: 'spring', stiffness: 500, damping: 40 }} />}
            </a>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-3">
          <span className="hidden lg:block"><StatusPill status={status} /></span>
          <span className="lg:hidden"><StatusPill status={status} compact /></span>
          <Link to="/app" className="hidden sm:block"><Button variant="signal" size="sm">open console</Button></Link>
          <button
            type="button"
            className="flex h-10 w-10 items-center justify-center rounded-btn border border-white/15 text-on-stage md:hidden"
            aria-label={open ? 'Close menu' : 'Open menu'}
            aria-expanded={open}
            aria-controls="topbar-menu"
            onClick={() => setOpen((o) => !o)}
          >
            <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
              {open ? <path d="M5 5l10 10M15 5L5 15" /> : <path d="M3 6h14M3 14h14" />}
            </svg>
          </button>
        </div>
      </div>

      <AnimatePresence>
        {open && (
          <motion.div id="topbar-menu" className="overflow-hidden border-t border-white/10 bg-stage md:hidden" initial={reduced ? false : { height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}>
            <nav aria-label="Menu" className="flex flex-col px-[18px] pb-5 pt-2">
              {LINKS.map((l) => (
                <a key={l.label} href={l.href} onClick={() => setOpen(false)} className="border-b border-white/10 py-4 text-[22px] font-light tracking-[-0.01em] text-on-stage no-underline" {...(l.external ? { target: '_blank', rel: 'noreferrer' } : {})}>
                  {l.label}
                  {l.external && <ExternalArrow />}
                </a>
              ))}
              <div className="mt-5"><StatusPill status={status} /></div>
              <Link to="/app" onClick={() => setOpen(false)} className="mt-4 block"><Button variant="signal" size="lg" className="w-full">open console</Button></Link>
            </nav>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}
