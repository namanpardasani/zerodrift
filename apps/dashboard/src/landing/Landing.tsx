import { BRAND_NAME } from '@zerodrift/brand';
import { Button, CodeBlock, type CodeToken, Count, DoubleTap, IconArrow, IconBolt, IconCheck, IconLedger, IconLock, IconPayments, IconRecon, IconWebhooks, RetryTrack, StageChaos, StageDocs, StageLedger, StageMark, StagePayments, TransferCard, Wordmark, Zd1Device, Zipper, cx } from '@zerodrift/ui';
import { useInView } from 'motion/react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CHAOS_BUGS, CHAOS_DOC_URL, CHAOS_RUNS, CHAOS_TOTALS, FAULT_KINDS, REPO_URL } from './chaosResults.js';

/** Mount children only once they scroll into view, so their entrance animations play when you get there. `replay` restarts them. */
function InView({ children, replay = 0 }: { children: ReactNode; replay?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const seen = useInView(ref, { once: true, margin: '0px 0px -15% 0px' });
  return <div ref={ref} className="min-h-[1px] min-w-0">{seen ? <div key={replay}>{children}</div> : null}</div>;
}

function Replay({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="mono rounded-btn border border-[#bdbdb8] bg-transparent px-2.5 py-1.5 text-[11px] uppercase tracking-[0.06em] text-ink-2 hover:bg-[#dcdcd7]">
      replay
    </button>
  );
}

/** Whether the books balance right now, from the one public endpoint. Unknown stays unknown: never a made-up zero. */
function usePublicStatus() {
  const [s, setS] = useState<{ available: boolean; ok: boolean | null; driftMinor: string | null } | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      fetch('/api/public/status')
        .then((r) => (r.ok ? r.json() : null))
        .then((b) => live && setS(b))
        .catch(() => live && setS(null));
    void load();
    const t = setInterval(load, 10_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  return s;
}

const NAV = [
  { href: '/app/ledger', label: 'ledger', lines: ['accounts', 'journal', 'holds'], Icon: StageLedger, internal: true },
  { href: '#anatomy', label: 'payments', lines: ['api', 'webhooks', 'refunds'], Icon: StagePayments },
  { href: '#chaos-results', label: 'chaos', lines: ['bench', 'results', 'invariants'], Icon: StageChaos },
  { href: REPO_URL, label: 'docs', lines: ['guides', 'reference', 'github'], Icon: StageDocs },
];

function Hero() {
  const status = usePublicStatus();
  const drift = status?.available && status.driftMinor !== null ? status.driftMinor : null;
  return (
    <section className="stage" aria-label="Introduction">
      <nav aria-label="Main" className="mx-auto grid max-w-[1280px] grid-cols-2 items-start gap-6 px-[18px] py-[22px] md:px-8 md:py-7 lg:grid-cols-[auto_repeat(4,minmax(0,1fr))_170px_92px]">
        <a href="/" className="no-underline" aria-label={`${BRAND_NAME} home`}><Wordmark /></a>
        {NAV.map(({ href, label, lines, Icon, internal }) => {
          const inner = (
            <>
              <Icon className="hidden h-[46px] w-[46px] flex-none text-on-stage sm:block" />
              <div>
                <b className="block text-[22px] font-light leading-none tracking-[-0.01em] sm:text-[26px]">{label}</b>
                <span className="mt-2 block text-[13px] leading-[1.35] text-on-stage-2">{lines.map((l) => <span key={l} className="block">{l}</span>)}</span>
              </div>
            </>
          );
          const cls = 'flex gap-3 text-on-stage no-underline hover:[&_b]:text-white';
          return internal ? <Link key={label} to={href} className={cls}>{inner}</Link> : <a key={label} href={href} className={cls} {...(href.startsWith('http') ? { target: '_blank', rel: 'noreferrer' } : {})}>{inner}</a>;
        })}
        <p className="mono hidden text-[10px] leading-[1.45] text-on-stage-2 lg:block">zd-1 is a double-entry payments ledger. it moves money between accounts, and proves under failure that none of it drifts. built with care, tested with violence.</p>
        <StageMark className="hidden h-[92px] w-[92px] text-on-stage lg:block" />
      </nav>

      <div className="px-6 pt-9 text-center">
        <h1 className="m-0 text-[clamp(40px,7vw,92px)] font-light leading-[0.95] tracking-[-0.045em]">money that never drifts.</h1>
        <p className="mono mx-auto mt-4 max-w-[560px] text-[13px] text-on-stage-2">a payments ledger you can kill, unplug and flood with duplicates. the books still balance to the paisa.</p>
      </div>

      <div className="mt-1.5 px-3">
        <Zd1Device drift={drift ?? '0'} receiptLines={['ZERODRIFT', 'pay_7731', 'riya → café', '₹250.00', 'dr 250.00', 'cr 250.00', 'drift 0.00', 'SETTLED']} />
        <p className="mono mt-1 text-center text-[11px] text-on-stage-2" role="status">
          {status === null ? 'live drift unavailable right now (the needle rests at zero, the display shows the example reading)' : status.available ? `live: ${status.ok ? 'every transaction balances' : 'VIOLATION: the books do not balance'}` : 'live drift unavailable right now (the ledger is not answering)'}
          {' · receipt shown is an example'}
        </p>
      </div>

      <div className="mx-auto flex max-w-[1280px] flex-wrap items-end justify-between gap-6 px-[18px] pb-10 pt-3 md:px-8">
        <ul className="mono m-0 list-none p-0 text-[11px] leading-[1.7] text-on-stage-2">
          <li>ledger <span className="text-on-stage">double-entry, append-only</span></li>
          <li>api <span className="text-on-stage">idempotent, every money call</span></li>
          <li>events <span className="text-on-stage">outbox → kafka, effectively once</span></li>
          <li>proof <span className="text-on-stage">chaos-tested, invariants checked</span></li>
        </ul>
        <div className="flex flex-wrap gap-3">
          <a href="#chaos-results"><Button variant="line" size="lg">see the chaos results</Button></a>
          <Link to="/app"><Button variant="signal" size="lg">open the ledger</Button></Link>
        </div>
      </div>
    </section>
  );
}

const features: [string, ReactNode, boolean?][] = [
  ['idempotent API', <IconArrow key="a" />, true],
  ['double-entry ledger', <IconLedger key="b" />],
  ['holds & captures', <IconLock key="c" />],
  ['signed webhooks', <IconWebhooks key="d" />],
  ['reconciliation', <IconRecon key="e" />],
  ['chaos-tested', <IconBolt key="f" />],
];

/** The API call as it really is (REST, amounts as integer strings in paise). */
const CODE: CodeToken[][] = [
  [{ t: 'await', k: 'kw' }, { t: ' fetch(' }, { t: '"/v1/payments"', k: 'st' }, { t: ', {' }],
  [{ t: '    method: ' }, { t: '"POST"', k: 'st' }, { t: ',' }],
  [{ t: '    headers: { ' }, { t: '"Idempotency-Key"', k: 'st' }, { t: ': ' }, { t: '"ord_7731"', k: 'st' }, { t: ' },' }],
  [{ t: '    body: JSON.' }, { t: 'stringify', k: 'kw' }, { t: '({' }],
  [{ t: '      customerId: ' }, { t: '"riya"', k: 'st' }, { t: ',' }],
  [{ t: '      amountMinor: ' }, { t: '"25000"', k: 'st' }, { t: ',  ' }, { t: '// ₹250.00 in paise', k: 'dm' }],
  [{ t: '    }),' }],
  [{ t: '});' }],
];

function Anatomy() {
  const [replay, setReplay] = useState(0);
  return (
    <section id="anatomy" className="bg-paper px-3 py-14 md:px-6" aria-labelledby="anatomy-title">
      <div className="mx-auto max-w-[1280px]">
        <div className="mb-3 flex items-center justify-between"><span className="mono text-xs uppercase tracking-[0.08em] text-muted">anatomy of a payment</span><Replay onClick={() => setReplay((n) => n + 1)} /></div>
        <div className="grid grid-cols-1 gap-11 rounded-[24px] bg-card p-6 md:p-10 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <div className="min-w-0">
            <h2 id="anatomy-title" className="m-0 text-[28px] font-medium leading-[1.1] tracking-[-0.025em] md:text-[34px]">One payment. Every step on record.</h2>
            <p className="mt-3 max-w-[420px] text-ink-2">Call the API once, or ten times by accident. {BRAND_NAME} holds the money, talks to the gateway, posts balanced entries and tells the merchant, exactly as many times as it should.</p>
            <ul className="m-0 mt-10 grid list-none grid-cols-1 gap-6 p-0 sm:grid-cols-2">
              {features.map(([label, icon, hot]) => (
                <li key={label} className="flex items-center gap-3.5 text-[19px] tracking-[-0.01em]">
                  <i className={cx('flex h-[46px] w-[46px] flex-none items-center justify-center rounded-[11px] border [&>svg]:h-[22px] [&>svg]:w-[22px]', hot ? 'border-[#5be5b9] bg-[#5be5b9]' : 'border-rule bg-card')}>{icon}</i>
                  {label}
                </li>
              ))}
            </ul>
          </div>
          <InView replay={replay}>
            <div className="relative min-h-[470px] sm:min-h-[500px]">
              <CodeBlock label="Example: creating a payment with the REST API" lines={CODE} className="pb-[170px]" />
              <TransferCard
                className="absolute inset-x-3 bottom-[-6px] sm:left-14 sm:right-0"
                amountMinor="25000"
                subtitle={<><IconPayments className="h-[18px] w-[18px]" />wallet payment · café aman (example)</>}
                steps={[
                  { label: 'Payment created', time: '18:42:07.112' },
                  { label: '₹250.00 held on Riya’s wallet', time: '.148' },
                  { label: 'Approved by gateway', time: '.806' },
                  { label: 'Posted to ledger · debits = credits', time: '.841' },
                  { label: 'Webhook delivered to Café Aman', time: '.020', tone: 'settled' },
                ]}
              />
            </div>
          </InView>
        </div>
      </div>
    </section>
  );
}

function Panel({ id, kicker, title, text, children, replay }: { id?: string; kicker: string; title: string; text: string; children: ReactNode; replay: () => void }) {
  return (
    <section id={id} className="bg-paper px-3 pb-14 md:px-6" aria-label={title}>
      <div className="mx-auto max-w-[1280px]">
        <div className="mb-3 flex items-center justify-between"><span className="mono text-xs uppercase tracking-[0.08em] text-muted">{kicker}</span><Replay onClick={replay} /></div>
        <div className="rounded-[20px] border border-rule bg-card p-6 md:p-9">
          <h2 className="m-0 text-[22px] font-medium tracking-[-0.015em]">{title}</h2>
          <p className="mt-1.5 max-w-[640px] text-sm text-ink-2">{text}</p>
          <div className="mt-8">{children}</div>
        </div>
      </div>
    </section>
  );
}

function DoubleTapSection() {
  const [replay, setReplay] = useState(0);
  return (
    <Panel kicker="the double tap · example" title="Ten taps, one charge." text="A network retry, a double click, a client that timed out and asked again. Same Idempotency-Key, same request: the second one gets the first one’s answer. A different request under the same key is rejected." replay={() => setReplay((n) => n + 1)}>
      <div className="rounded-[14px] bg-paper p-4 md:p-6">
        <InView replay={replay}>
          <DoubleTap
            counterLabel="Charges on Riya’s wallet"
            request={<><div className="mono font-medium">POST /v1/payments</div><div className="mono text-muted">Idempotency-Key: ord_7731</div><div className="mono">amountMinor 25000 · customer riya</div></>}
            response="201 created · pay_7731"
          />
        </InView>
      </div>
    </Panel>
  );
}

const RETRY_EXAMPLE = [
  { atMs: 0, label: '503', ok: false },
  { atMs: 2_000, label: '503', ok: false },
  { atMs: 6_000, label: 'timeout', ok: false },
  { atMs: 14_000, label: '503', ok: false },
  { atMs: 30_000, label: '200 ok', ok: true },
];

function HooksSection() {
  const [replay, setReplay] = useState(0);
  return (
    <Panel kicker="webhook retries · example" title="Telling the merchant, until they hear it." text="Their server was down for a while. Each retry waits longer than the last, plus a little random jitter, so a struggling server is not flooded. Deliveries that run out of attempts are dead-lettered and can be replayed." replay={() => setReplay((n) => n + 1)}>
      <InView replay={replay}><RetryTrack attempts={RETRY_EXAMPLE} /></InView>
    </Panel>
  );
}

function ReconSection() {
  const [replay, setReplay] = useState(0);
  return (
    <Panel kicker="reconciliation · example" title="Our books, their report, side by side." text="Zerodrift lines up its ledger against the gateway’s settlement file. Anything that does not match is flagged, never silently fixed." replay={() => setReplay((n) => n + 1)}>
      <InView replay={replay}>
        <Zipper
          leftTitle="our ledger"
          rightTitle="gateway report"
          rows={[
            { ref: 'pay_7731', left: '₹250.00', right: '₹250.00' },
            { ref: 'pay_7742', left: '₹1,199.00', right: '₹1,199.00' },
            { ref: 'pay_7790', left: '₹499.00', right: '₹449.00', note: 'pay_7790: ledger says ₹499.00, gateway says ₹449.00. Flagged for review, nothing changed automatically.' },
            { ref: 'pay_7802', left: '₹2,350.00', right: '₹2,350.00' },
          ]}
        />
      </InView>
    </Panel>
  );
}

const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

function ChaosResults() {
  const t = CHAOS_TOTALS;
  return (
    <section id="chaos-results" className="stage-top" aria-labelledby="chaos-title">
      <div className="mx-auto max-w-[1280px] px-[18px] py-16 md:px-8">
        <h2 id="chaos-title" className="m-0 text-[40px] font-light leading-none tracking-[-0.04em] md:text-[56px]">tested with violence.</h2>
        <p className="mono mt-3 max-w-[620px] text-xs text-on-stage-2">
          the real run, measured on one laptop kubernetes node: {t.operations.toLocaleString('en-IN')} payments and transfers across {t.runs} runs, about 10% of them duplicate requests, while pods were killed, the bank misbehaved, kafka paused and the network dropped. after every run: the same questions, asked of the databases directly.
        </p>

        <dl className="mt-10 grid grid-cols-2 gap-3.5 lg:grid-cols-4">
          {[
            ['operations', <Count key="o" value={t.operations} />, `${t.runs} runs of 10,000`],
            ['faults injected', <Count key="f" value={t.faults} />, FAULT_KINDS.slice(0, 2).map(([l, c]) => `${c} ${l}`).join(' · ') + ' · …'],
            ['duplicate requests', <Count key="d" value={t.duplicatePairs} />, 'same idempotency key, sent twice at once'],
            ['invariants held', <span key="i"><Count value={t.invariantEvaluations} />/<Count value={t.invariantEvaluations} /></span>, 'every check, every run'],
          ].map(([label, value, hint]) => (
            <div key={String(label)} className="rounded-2xl border border-[#2a2a2a] bg-[#161616] p-5">
              <dt className="text-[13px] text-on-stage-2">{label}</dt>
              <dd className="m-0"><div className="mono mt-2 text-[34px] font-medium leading-none text-signal">{value}</div><div className="mono mt-2 text-[11px] text-on-stage-2">{hint}</div></dd>
            </div>
          ))}
        </dl>

        <div className="mt-10 grid gap-6 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
          <div>
            <h3 className="m-0 text-[22px] font-light tracking-[-0.02em]">what was checked, after every run</h3>
            <ul className="mono m-0 mt-4 list-none space-y-2 p-0 text-[13px] text-on-stage">
              {['money conserved exactly: everything held equals everything topped up, to the paisa', 'every transaction balanced: debits equal credits', 'every balance equals the sum of its journal entries', 'no money stuck in holds', 'no duplicate charge: at most one capture and one bank charge per payment', 'no payment left half-done after the recovery window', 'every succeeded payment’s webhook delivered once per endpoint', 'internal and external reconciliation clean'].map((x) => (
                <li key={x} className="flex gap-2.5"><IconCheck className="mt-0.5 h-4 w-4 flex-none text-code-str" />{x}</li>
              ))}
            </ul>
          </div>
          <div className="rounded-2xl border border-[#2a2a2a] bg-[#161616] p-5">
            <h3 className="m-0 text-[22px] font-light tracking-[-0.02em]">what it cost</h3>
            <p className="mono mt-3 text-[13px] leading-[1.7] text-on-stage-2">
              throughput <span className="text-on-stage">{t.throughputMin}–{t.throughputMax} ops/s</span> with chaos, <span className="text-on-stage">{t.baselineThroughput} ops/s</span> with none: the limit is one shared laptop node, not the faults. payment latency p50 <span className="text-on-stage">{sec(t.paymentP50MinMs)}–{sec(t.paymentP50MaxMs)}</span>, p99 <span className="text-on-stage">{sec(t.paymentP99MinMs)}–{sec(t.paymentP99MaxMs)}</span> at 200 concurrent users. {t.gaveUp.toLocaleString('en-IN')} operations ended with the client not knowing the outcome; the books were right anyway.
            </p>
          </div>
        </div>

        <h3 className="mb-4 mt-12 text-[22px] font-light tracking-[-0.02em]">the run table</h3>
        <div className="overflow-x-auto rounded-2xl border border-[#2a2a2a]">
          <table className="mono w-full min-w-[760px] border-collapse text-xs">
            <caption className="sr-only-zd">Measured results of each chaos run</caption>
            <thead>
              <tr className="text-left text-on-stage-2">
                {['run', 'mode', 'ops/s', 'payment p50 / p99', 'duplicates', 'retries', 'gave up', 'faults', 'recovery', 'invariants'].map((h) => <th key={h} scope="col" className="border-b border-[#2a2a2a] px-3.5 py-3 font-normal">{h}</th>)}
              </tr>
            </thead>
            <tbody className="text-on-stage">
              {CHAOS_RUNS.map((r) => (
                <tr key={r.run} className="border-b border-[#1f1f1f] last:border-0">
                  <td className="px-3.5 py-2.5">{r.run}</td><td className="px-3.5 py-2.5">{r.mode}</td><td className="px-3.5 py-2.5">{r.opsPerSecond}</td>
                  <td className="px-3.5 py-2.5">{sec(r.paymentP50Ms)} / {sec(r.paymentP99Ms)}</td><td className="px-3.5 py-2.5">{r.duplicatePairs}</td><td className="px-3.5 py-2.5">{r.clientRetries}</td><td className="px-3.5 py-2.5">{r.gaveUp}</td>
                  <td className="px-3.5 py-2.5">{r.faults}</td><td className="px-3.5 py-2.5">{r.recoverySeconds} s</td><td className="px-3.5 py-2.5 text-code-str">{r.invariants}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mono mt-3 max-w-[760px] text-[11px] text-on-stage-2">run 1 took {CHAOS_RUNS[0]!.recoverySeconds} s to settle because webhook consumption stalled for several minutes; cause unknown, not reproduced, no data lost. one node: node failure was not tested. the method, every number and the bugs are in the <a className="text-on-stage underline" href={CHAOS_DOC_URL} target="_blank" rel="noreferrer">chaos results</a>.</p>

        <h3 className="mb-4 mt-12 text-[22px] font-light tracking-[-0.02em]">bugs it caught</h3>
        <div className="grid gap-4 md:grid-cols-2">
          {CHAOS_BUGS.map((b) => (
            <div key={b.title} className="rounded-2xl border border-[#2a2a2a] bg-[#161616] p-5">
              <b className="text-[17px] font-normal tracking-[-0.01em]">{b.title}</b>
              <p className="mono mt-2 text-xs leading-[1.7] text-on-stage-2">{b.body}</p>
            </div>
          ))}
        </div>
        <p className="mono mt-8 text-xs text-on-stage-2">fault kinds over the six runs: {FAULT_KINDS.map(([l, c]) => `${c} ${l}`).join(' · ')}.</p>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="stage px-[18px] py-12 md:px-8" aria-label="Footer">
      <div className="mx-auto flex max-w-[1280px] flex-wrap items-end justify-between gap-8">
        <div>
          <Wordmark />
          <p className="mono mt-3 max-w-sm text-[11px] leading-[1.6] text-on-stage-2">built with care, tested with violence. a portfolio project: nothing here moves real money.</p>
        </div>
        <nav aria-label="Footer" className="mono flex flex-wrap gap-x-6 gap-y-2 text-xs text-on-stage-2">
          <Link className="hover:text-on-stage" to="/app">console</Link>
          <a className="hover:text-on-stage" href="#chaos-results">chaos results</a>
          <Link className="hover:text-on-stage" to="/styleguide">style guide</Link>
          <a className="hover:text-on-stage" href={REPO_URL} target="_blank" rel="noreferrer">github</a>
        </nav>
      </div>
    </footer>
  );
}

export function LandingPage() {
  return (
    <div className="bg-paper">
      <Hero />
      <Anatomy />
      <DoubleTapSection />
      <HooksSection />
      <ReconSection />
      <ChaosResults />
      <Footer />
    </div>
  );
}
