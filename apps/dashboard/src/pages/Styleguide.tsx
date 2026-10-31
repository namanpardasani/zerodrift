import { BRAND_NAME } from '@zerodrift/brand';
import { Badge, BenchMeter, Brand, Button, Card, Count, DataTable, Dot, EmptyState, ErrorNote, Field, Gauge, Id, Input, Journal, KeyValue, Lcd, Led, MetroLine, MiniGauge, Money, ModuleTile, PowerSwitch, Receipt, Rupees, Select, Skeleton, Sparkline, Stamp, Stat, StatusBadge, Timeline, Zipper, KillButton } from '@zerodrift/ui';
import { type ReactNode, useState } from 'react';
import { Link } from 'react-router-dom';

const SWATCHES: [string, string, string][] = [
  ['stage', '#0B0B0B', 'landing and chaos bench background'], ['stage-2', '#151515', 'raised stage surface'], ['on-stage', '#EDEDEA', 'text on stage'], ['on-stage-2', '#A3A39E', 'secondary text on stage'],
  ['hardware', '#DCDCD8', 'the ZD-1 and bench modules'], ['paper', '#F3F3F0', 'app background, active nav'], ['card', '#FFFFFF', 'app surfaces'], ['ink', '#111418', 'text, primary button'],
  ['ink-2', '#454B57', 'secondary text'], ['muted', '#5F6571', 'labels'], ['rule', '#E2E2DE', '1px borders'], ['navy', '#172130', 'code panels'],
  ['signal', '#FF5A1F', 'primary action and chaos'], ['settled', '#22C995', 'settled / verified (text #0F9F73)'], ['pending', '#F2C230', 'in flight (text #8A6A00)'], ['failed', '#D93A3F', 'failure and debits (text #B42A2F)'],
  ['stamp', '#2B4C8F', '“balanced” stamps only'],
];

function Section({ title, children, stage }: { title: string; children: ReactNode; stage?: boolean }) {
  return (
    <section className="mb-12" aria-label={title}>
      <h2 className="mono mb-4 text-xs uppercase tracking-[0.08em] text-muted">{title}</h2>
      <div className={stage ? 'stage-top rounded-panel p-6' : ''}>{children}</div>
    </section>
  );
}

/** Every token and component in one place, on real components (not screenshots): the thing to open when changing the design. */
export function StyleguidePage() {
  const [on, setOn] = useState(true);
  const [kicks, setKicks] = useState(0);
  const [replay, setReplay] = useState(0);
  return (
    <div className="min-h-screen bg-paper">
      <div className="mx-auto max-w-[1100px] px-4 py-10 md:px-8">
        <div className="mb-10 flex flex-wrap items-end justify-between gap-4">
          <div>
            <Link to="/" aria-label="Home"><Brand size="lg" /></Link>
            <h1 className="mt-6 text-[40px] font-light leading-none tracking-[-0.03em]">{BRAND_NAME.toLowerCase()} / style guide</h1>
            <p className="mt-3 max-w-xl text-ink-2">Two worlds: the <b>stage</b> (black, one hardware object, orange signal) and the <b>paper</b> (calm, crisp numbers, status dots). Colour always means something. Tokens live in <code className="mono">packages/ui/src/theme.css</code>.</p>
          </div>
          <Button onClick={() => { setReplay((n) => n + 1); setKicks((n) => n + 1); }}>Replay animations</Button>
        </div>

        <Section title="colour tokens">
          <ul className="m-0 grid list-none grid-cols-2 gap-3 p-0 sm:grid-cols-3 lg:grid-cols-4">
            {SWATCHES.map(([name, hex, use]) => (
              <li key={name} className="mono text-[11px] text-ink-2">
                <i className="mb-1.5 block h-10 rounded-nav border border-black/10" style={{ background: hex }} />
                {name} {hex}<br /><span className="text-muted">{use}</span>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="type">
          <p className="m-0 text-[56px] font-light leading-none tracking-[-0.045em]">money that never drifts.</p>
          <p className="mt-4 text-[28px] font-medium tracking-[-0.02em]">Page title, Geist 500</p>
          <p className="mt-2 text-[15px]">Body, Geist 400 at 15px. <span className="text-muted">Muted labels at the same size.</span></p>
          <p className="mono mt-2 text-[13px]">Geist Mono for money, ids, times: ₹12,40,000.00 · pay_7731 · 18:42:07.841</p>
        </Section>

        <Section title="buttons">
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary">primary (in-app)</Button>
            <Button>secondary</Button>
            <Button variant="ghost">ghost</Button>
            <Button variant="danger">danger</Button>
            <Button variant="primary" disabled>disabled</Button>
          </div>
          <div className="stage-top mt-4 flex flex-wrap items-center gap-4 rounded-panel p-6">
            <Button variant="signal" size="lg">hardware (presses down)</Button>
            <Button variant="line" size="lg">outline on stage</Button>
          </div>
        </Section>

        <Section title="status: dots mean something">
          <div className="flex flex-wrap gap-6 text-sm">
            <span className="flex items-center gap-2"><Dot />settled</span>
            <span className="flex items-center gap-2"><Dot tone="pending" />pending (pings)</span>
            <span className="flex items-center gap-2"><Dot tone="failed" />failed</span>
            <span className="flex items-center gap-2"><Dot tone="neutral" />created</span>
            {['succeeded', 'processing', 'failed', 'refunded', 'dead', 'clean'].map((s) => <StatusBadge key={s} status={s} />)}
            <Badge>label</Badge><Badge tone="success">ok</Badge><Badge tone="danger">bad</Badge><Badge tone="warn">careful</Badge>
          </div>
        </Section>

        <Section title="numbers roll, money is mono">
          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-3">
            <Stat label="Money in system" value={<Rupees key={replay} minor="124000000" />} hint="rolls like an odometer" />
            <Stat label="Payments" value={<Count key={replay} value={1204} />} />
            <Stat label="Drift" value={<span className="flex items-center justify-between"><Rupees minor="0" /><MiniGauge key={replay} drift="0" /></span>} hint={<><Dot pulse={false} />steady</>} />
          </div>
          <p className="mono mt-3 text-sm">Money: <Money minor="25000" /> · debit <Money minor="25000" debit /> · <Id id="8f2c1a7e-0000-4000-8000-000000000001" /></p>
        </Section>

        <Section title="the drift needle (spring, always returns to zero)" stage>
          <div className="mx-auto max-w-sm rounded-xl bg-[#121212] p-3">
            <Gauge key={replay} drift="0" kicks={kicks} />
          </div>
          <div className="mt-4 text-center"><Button variant="signal" onClick={() => setKicks((n) => n + 1)}>kick the needle</Button></div>
        </Section>

        <Section title="journal: ink rows, bracket, BALANCED stamp">
          <Journal
            key={replay}
            title={<>Journal <Id id="88f2a1b3-0000-4000-8000-000000000001" /></>}
            meta="payment · posted 18:42:07.841"
            lines={[
              { account: 'Riya', sub: 'customer wallet', direction: 'debit', amountMinor: '25000' },
              { account: 'Café Aman', sub: 'merchant', direction: 'credit', amountMinor: '24500' },
              { account: `${BRAND_NAME} fees`, sub: 'system', direction: 'credit', amountMinor: '500' },
            ]}
          />
          <div className="relative mt-6 h-16"><Stamp show tone="red" className="left-2 top-2">already paid</Stamp></div>
        </Section>

        <div className="mb-12 grid grid-cols-1 gap-8 lg:grid-cols-2">
          <Section title="state line"><MetroLine key={replay} states={['created', 'processing', 'succeeded', 'refunded']} current="succeeded" /></Section>
          <Section title="timeline"><Timeline key={replay} steps={[{ label: 'Payment created', time: '18:42:07.112' }, { label: 'Held on wallet', time: '.148' }, { label: 'Webhook sending', time: 'sending…', tone: 'pending' }]} /></Section>
        </div>

        <Section title="receipt (prints in steps, torn edge, print / download)">
          <div className="max-w-[300px]">
            <Receipt key={replay} brand={BRAND_NAME} data={{ kind: 'payment receipt', rows: [['pay', 'pay_7731'], ['from', 'riya · wallet'], ['to', 'café aman']], amountMinor: '25000', ledger: [['debits', '250.00'], ['credits', '250.00'], ['drift', '0.00']], status: 'SETTLED', barcodeSeed: 'styleguide', fileName: 'receipt-example' }} />
          </div>
        </Section>

        <Section title="zipper (reconciliation)">
          <Zipper key={replay} leftTitle="our ledger" rightTitle="gateway report" rows={[{ ref: 'pay_7731', left: '₹250.00', right: '₹250.00' }, { ref: 'pay_7790', left: '₹499.00', right: '₹449.00', note: 'ledger says ₹499.00, gateway says ₹449.00. Flagged for review.' }]} />
        </Section>

        <Section title="bench modules" stage>
          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-3">
            <BenchMeter drift="0" kicks={kicks} transfers="0" faults="0" driftText="0.00" />
            <ModuleTile name="ledger" status="running · 2/2 pods ready" down={!on} shake={kicks} onKill={() => setKicks((n) => n + 1)} onToggle={() => setOn((v) => !v)} />
            <ModuleTile name="kafka" status="killed · restarting…" down onKill={() => undefined} onToggle={() => undefined} />
          </div>
          <div className="mt-4 flex items-center gap-4 text-on-stage"><Led /><Led down /><PowerSwitch on={on} onToggle={() => setOn((v) => !v)} label="demo switch" /><KillButton onKill={() => undefined} label="demo kill" /><div className="w-40"><Lcd label="LCD">0.00</Lcd></div></div>
        </Section>

        <Section title="forms, tables, states">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-3">
              <Field label="Input" hint="hint text"><Input placeholder="placeholder" /></Field>
              <Field label="Select"><Select><option>one</option><option>two</option></Select></Field>
            </div>
            <KeyValue items={[['Key', 'value'], ['Another', <Money key="m" minor="12345" />]]} />
          </div>
          <Card title="Table" className="mt-4 overflow-hidden [&>div]:p-0">
            <DataTable rows={[{ id: 'a1', amt: '25000', st: 'succeeded' }, { id: 'b2', amt: '4900', st: 'processing' }]} rowKey={(r) => r.id} columns={[{ header: 'id', cell: (r) => <Id id={r.id} /> }, { header: 'amount', cell: (r) => <Money minor={r.amt} />, className: 'text-right' }, { header: 'status', cell: (r) => <StatusBadge status={r.st} /> }]} />
          </Card>
          <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
            <Card title="Loading"><Skeleton rows={3} /></Card>
            <Card title="Empty"><EmptyState>Nothing here yet.</EmptyState></Card>
            <Card title="Error"><ErrorNote error="Something failed to load" onRetry={() => undefined} /></Card>
          </div>
          <Card title="Sparkline" className="mt-4"><Sparkline points={[3, 5, 4, 8, 6, 9, 7]} label="example trend" /></Card>
        </Section>
      </div>
    </div>
  );
}
