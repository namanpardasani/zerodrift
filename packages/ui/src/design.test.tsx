// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DoubleTap, Journal, MetroLine, ModuleTile, Receipt, RetryTrack, Rupees, Stamp, Zipper, driftToAngle, formatMinorPlain, minorToRupees, statusLabel } from './index.js';

// jsdom has no real custom-element upgrade for NumberFlow's <number-flow-react>; render its value as plain text here.
vi.mock('@number-flow/react', () => ({
  default: ({ value, format, suffix }: { value: number; format?: Intl.NumberFormatOptions; suffix?: string }) => <span data-testid="nf">{new Intl.NumberFormat('en-IN', format).format(value)}{suffix}</span>,
}));

afterEach(cleanup);

describe('drift needle', () => {
  it('zero drift is exactly zero degrees; any drift is clearly off zero, in the right direction', () => {
    expect(driftToAngle('0')).toBe(0);
    expect(driftToAngle(null)).toBe(0);
    expect(driftToAngle('1')).toBeGreaterThan(10);
    expect(driftToAngle('-1')).toBeLessThan(-10);
    expect(Math.abs(driftToAngle('999999999999'))).toBeLessThanOrEqual(58); // never leaves the dial
  });
});

describe('money formatting helpers', () => {
  it('plain amounts for journals, exact beyond 2^53, and a null where a JS number cannot be exact', () => {
    expect(formatMinorPlain('25000')).toBe('250.00');
    expect(formatMinorPlain(5n)).toBe('0.05');
    expect(formatMinorPlain('9223372036854775807')).toContain('.07');
    expect(minorToRupees('25000')).toBe(250);
    expect(minorToRupees('9223372036854775807')).toBeNull();
  });
  it('Rupees gives screen readers the exact formatted amount', () => {
    render(<Rupees minor="124000000" />);
    expect(screen.getAllByText('₹12,40,000.00').length).toBeGreaterThan(0); // the screen-reader text; the rolling digits are aria-hidden
  });
  it('Rupees shows the exact string, not a rolling number, when a JS number would lose digits', () => {
    render(<Rupees minor="9223372036854775807" />);
    expect(screen.getByText(/\.07$/).textContent).toBe('₹92,23,37,20,36,85,47,758.07');
  });
});

describe('status words', () => {
  it('the API says succeeded, the screen says settled; other statuses are prettified', () => {
    expect(statusLabel('succeeded')).toBe('settled');
    expect(statusLabel('partially_refunded')).toBe('partially refunded');
  });
});

describe('Journal', () => {
  const lines = [
    { account: 'Riya', sub: 'customer wallet', direction: 'debit' as const, amountMinor: '25000' },
    { account: 'Café Aman', direction: 'credit' as const, amountMinor: '24500' },
    { account: 'Zerodrift fees', direction: 'credit' as const, amountMinor: '500' },
  ];

  it('totals the columns and stamps BALANCED only when debits equal credits', () => {
    render(<Journal title="Journal x" lines={lines} />);
    expect(screen.getAllByText('250.00')).toHaveLength(3); // the debit, the two totals
    const stamp = screen.getByText('balanced');
    expect(stamp.getAttribute('aria-hidden')).toBe('false');
    expect(screen.queryByText('unbalanced')).toBeNull();
  });

  it('an unbalanced transaction can never read balanced: it gets the red UNBALANCED stamp', () => {
    render(<Journal title="Journal bad" lines={[lines[0]!, { account: 'Café', direction: 'credit', amountMinor: '24000' }]} />);
    expect(screen.getByText('unbalanced').getAttribute('aria-hidden')).toBe('false');
    expect(screen.getByText('balanced').getAttribute('aria-hidden')).toBe('true'); // present in the DOM only as a hidden, never-shown stamp
  });
});

describe('Stamp', () => {
  it('is hidden from assistive tech until it lands', () => {
    const { rerender } = render(<Stamp show={false}>already paid</Stamp>);
    expect(screen.getByText('already paid').getAttribute('aria-hidden')).toBe('true');
    rerender(<Stamp show>already paid</Stamp>);
    expect(screen.getByText('already paid').getAttribute('aria-hidden')).toBe('false');
  });
});

describe('MetroLine', () => {
  it('marks the current state as the current step', () => {
    render(<MetroLine states={['created', 'processing', 'succeeded', 'refunded']} current="processing" />);
    expect(screen.getByText('processing').closest('[aria-current]')?.getAttribute('aria-current')).toBe('step');
    expect(screen.getByRole('group').getAttribute('aria-label')).toBe('Payment state: processing');
  });
});

describe('RetryTrack', () => {
  it('describes every attempt for screen readers', () => {
    render(<RetryTrack attempts={[{ atMs: 0, label: '503', ok: false }, { atMs: 2000, label: '200 ok', ok: true }]} />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe('2 delivery attempts: 503, 200 ok');
  });
});

describe('Zipper', () => {
  it('shows the explanation only for mismatching rows and labels every row matched or mismatch', () => {
    render(<Zipper leftTitle="ledger" rightTitle="bank" rows={[{ ref: 'a', left: '1', right: '1' }, { ref: 'b', left: '2', right: '3', note: 'ledger says 2, bank says 3' }]} />);
    expect(screen.getByLabelText('matched')).toBeTruthy();
    expect(screen.getByLabelText('mismatch')).toBeTruthy();
    expect(screen.getByText('ledger says 2, bank says 3')).toBeTruthy();
  });
});

describe('chaos bench module', () => {
  it('uses a real switch, and a down service cannot be killed again', () => {
    const onToggle = vi.fn();
    const onKill = vi.fn();
    const { rerender } = render(<ModuleTile name="ledger" status="running" down={false} onKill={onKill} onToggle={onToggle} />);
    const sw = screen.getByRole('switch', { name: 'ledger power' });
    expect(sw.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(sw);
    fireEvent.click(screen.getByRole('button', { name: 'kill ledger' }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onKill).toHaveBeenCalledTimes(1);
    rerender(<ModuleTile name="ledger" status="killed" down onKill={onKill} onToggle={onToggle} />);
    expect(screen.getByRole('switch', { name: 'ledger power' }).getAttribute('aria-checked')).toBe('false');
    expect((screen.getByRole('button', { name: 'kill ledger' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('killed').getAttribute('aria-live')).toBe('polite');
  });
});

describe('Receipt', () => {
  it('prints the data it was given and offers print and download', () => {
    render(<Receipt brand="Zerodrift" data={{ kind: 'payment receipt', rows: [['pay', 'pay_1']], amountMinor: '25000', ledger: [['drift', '0.00']], status: 'SETTLED', barcodeSeed: 's', fileName: 'r' }} />);
    expect(screen.getByText('₹250.00')).toBeTruthy();
    expect(screen.getByText('SETTLED')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Print' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download .txt' })).toBeTruthy();
  });
});

describe('DoubleTap', () => {
  it('ends with one charge and the absorbed duplicate', () => {
    vi.useFakeTimers();
    try {
      render(<DoubleTap counterLabel="Charges on Riya" request={<span>req</span>} response="201 created" duplicates={3} />);
      act(() => {
        vi.advanceTimersByTime(4500);
      });
      expect(screen.getByText(/3 duplicates absorbed/)).toBeTruthy();
      expect(screen.getByText('1')).toBeTruthy(); // one charge, however many requests
    } finally {
      vi.useRealTimers();
    }
  });
});
