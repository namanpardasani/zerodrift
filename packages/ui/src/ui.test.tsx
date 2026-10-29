// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Badge, DataTable, ErrorNote, Sparkline, StatusBadge, STATUS_TONE, formatInr, shortId, timeAgo } from './index.js';

afterEach(cleanup);

describe('formatInr', () => {
  it('formats paise exactly with Indian digit grouping', () => {
    expect(formatInr('123450')).toBe('₹1,234.50');
    expect(formatInr(5)).toBe('₹0.05');
    expect(formatInr('0')).toBe('₹0.00');
    expect(formatInr('1234567890')).toBe('₹1,23,45,678.90'); // lakh/crore grouping
  });
  it('handles negative balances (the gateway clearing account) and bigint', () => {
    expect(formatInr('-250000')).toBe('-₹2,500.00');
    expect(formatInr(-5n)).toBe('-₹0.05');
  });
  it('stays exact beyond 2^53 (no float rounding)', () => {
    // 2^53 + 1 paise: a float would round the last digits; bigint keeps them
    expect(formatInr('9007199254740993')).toBe('₹9,00,71,99,25,47,409.93');
    expect(formatInr('9223372036854775807')).toContain('.07'); // BIGINT max, last two digits intact
  });
  it('shows a dash for missing values and echoes garbage instead of crashing', () => {
    expect(formatInr(null)).toBe('-');
    expect(formatInr(undefined)).toBe('-');
    expect(formatInr('abc')).toBe('abc');
  });
});

describe('helpers', () => {
  it('shortId and timeAgo', () => {
    expect(shortId('123e4567-e89b-12d3-a456-426614174000')).toBe('123e4567…');
    expect(shortId('short')).toBe('short');
    const now = Date.parse('2026-10-29T12:00:00Z');
    expect(timeAgo('2026-10-29T11:59:57Z', now)).toBe('just now');
    expect(timeAgo('2026-10-29T11:59:00Z', now)).toBe('1m ago');
    expect(timeAgo('2026-10-29T09:00:00Z', now)).toBe('3h ago');
    expect(timeAgo(null)).toBe('-');
  });
});

describe('components', () => {
  it('StatusBadge uses one consistent tone per status and prettifies the label', () => {
    expect(STATUS_TONE.succeeded).toBe('success');
    expect(STATUS_TONE.failed).toBe('danger');
    expect(STATUS_TONE.processing).toBe('warn');
    render(<StatusBadge status="partially_refunded" />);
    expect(screen.getByText('partially refunded')).toBeTruthy();
    render(<Badge tone="danger">x</Badge>);
  });

  it('DataTable renders rows, supports click and keyboard activation, and shows the empty state', () => {
    const onClick = vi.fn();
    const rows = [{ id: 'a', n: 1 }, { id: 'b', n: 2 }];
    const cols = [{ header: 'N', cell: (r: { n: number }) => r.n }];
    const { rerender } = render(<DataTable columns={cols} rows={rows} rowKey={(r) => r.id} onRowClick={onClick} />);
    expect(screen.getAllByRole('row')).toHaveLength(3); // header + 2
    fireEvent.click(screen.getByText('2'));
    expect(onClick).toHaveBeenCalledWith(rows[1]);
    fireEvent.keyDown(screen.getAllByRole('row')[1]!, { key: 'Enter' });
    expect(onClick).toHaveBeenCalledTimes(2);
    rerender(<DataTable columns={cols} rows={[]} rowKey={() => 'x'} empty="no rows" />);
    expect(screen.getByText('no rows')).toBeTruthy();
  });

  it('ErrorNote shows the message and a retry button that works', () => {
    const retry = vi.fn();
    render(<ErrorNote error={new Error('ledger is not reachable')} onRetry={retry} />);
    expect(screen.getByRole('alert').textContent).toContain('ledger is not reachable');
    fireEvent.click(screen.getByText('Retry'));
    expect(retry).toHaveBeenCalled();
  });

  it('Sparkline draws a path for 2+ points and an empty note otherwise', () => {
    const { container, rerender } = render(<Sparkline points={[1, 3, 2]} />);
    expect(container.querySelector('path')?.getAttribute('d')).toMatch(/^M0\.0,/);
    rerender(<Sparkline points={[1]} />);
    expect(screen.getByText('no data yet')).toBeTruthy();
  });
});
