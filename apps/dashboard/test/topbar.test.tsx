// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { StatusPill, TopBar } from '../src/landing/TopBar.js';

afterEach(cleanup);
const mount = (status: Parameters<typeof TopBar>[0]['status']) =>
  render(
    <MemoryRouter>
      <TopBar status={status} />
    </MemoryRouter>,
  );

describe('landing top bar', () => {
  it('has the four plain links and one clear action', () => {
    mount({ available: true, ok: true, driftMinor: '0' });
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(nav.textContent).toMatch(/how it works/);
    expect(nav.textContent).toMatch(/chaos results/);
    expect(screen.getByRole('link', { name: /docs/ }).getAttribute('href')).toMatch(/github\.com\/.*\/docs$/);
    expect(screen.getByRole('link', { name: /github/ }).getAttribute('target')).toBe('_blank');
    expect(screen.getAllByText('open console').length).toBeGreaterThan(0);
  });

  it('the pill says what the ledger says and never invents a zero', () => {
    const { rerender } = render(<StatusPill status={{ available: true, ok: true, driftMinor: '0' }} />);
    expect(screen.getByRole('status').textContent).toContain('books balanced · drift ₹0.00');
    rerender(<StatusPill status={{ available: true, ok: false, driftMinor: '1250' }} />);
    expect(screen.getByRole('status').textContent).toContain('VIOLATION · drift ₹12.50');
    rerender(<StatusPill status={{ available: false, ok: null, driftMinor: null }} />);
    expect(screen.getByRole('status').textContent).toBe('status unavailable');
    expect(screen.getByRole('status').textContent).not.toContain('₹0.00');
    rerender(<StatusPill status={null} />);
    expect(screen.getByRole('status').textContent).toBe('status unavailable');
  });

  it('the phone menu is a real disclosure: it opens, reports aria-expanded, and Escape closes it', async () => {
    mount({ available: true, ok: true, driftMinor: '0' });
    const button = screen.getByRole('button', { name: 'Open menu' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('navigation', { name: 'Menu' })).toBeNull();
    fireEvent.click(button);
    expect(screen.getByRole('button', { name: 'Close menu' }).getAttribute('aria-expanded')).toBe('true');
    expect(await screen.findByRole('navigation', { name: 'Menu' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'Open menu' }).getAttribute('aria-expanded')).toBe('false');
  });
});
