import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { PaymentStatus } from './db-schema.js';
import { ALL_STATUSES, InvalidTransitionError, TRANSITIONS, assertTransition, canTransition, isSettled } from './state-machine.js';

describe('payment state machine', () => {
  const legal: [PaymentStatus, PaymentStatus][] = [
    ['created', 'processing'],
    ['created', 'failed'],
    ['processing', 'succeeded'],
    ['processing', 'failed'],
    ['succeeded', 'partially_refunded'],
    ['succeeded', 'refunded'],
    ['partially_refunded', 'partially_refunded'],
    ['partially_refunded', 'refunded'],
  ];

  it('allows exactly the documented transitions and rejects every other pair', () => {
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        const expected = legal.some(([f, t]) => f === from && t === to);
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(expected);
      }
    }
  });

  it('assertTransition throws a typed error for illegal moves', () => {
    expect(() => assertTransition('failed', 'succeeded')).toThrow(InvalidTransitionError);
    expect(() => assertTransition('succeeded', 'processing')).toThrow('succeeded -> processing');
    expect(() => assertTransition('processing', 'succeeded')).not.toThrow();
  });

  it('failed and refunded are terminal; a payment cannot go backwards', () => {
    expect(TRANSITIONS.failed).toEqual([]);
    expect(TRANSITIONS.refunded).toEqual([]);
    expect(canTransition('succeeded', 'processing')).toBe(false);
    expect(canTransition('processing', 'created')).toBe(false);
  });

  it('property: any random walk through legal moves never reaches an illegal state, and always ends or continues sensibly', () => {
    fc.assert(
      fc.property(fc.array(fc.nat(100), { maxLength: 30 }), (choices) => {
        let state: PaymentStatus = 'created';
        let sawSucceeded = false;
        for (const c of choices) {
          const options: readonly PaymentStatus[] = TRANSITIONS[state];
          if (options.length === 0) break;
          state = options[c % options.length]!;
          if (state === 'succeeded') sawSucceeded = true;
          // refunds are only reachable AFTER success
          if (state === 'partially_refunded' || state === 'refunded') expect(sawSucceeded).toBe(true);
        }
        return true;
      }),
    );
  });

  it('isSettled is true only once the saga has nothing left to do', () => {
    expect(isSettled('created')).toBe(false);
    expect(isSettled('processing')).toBe(false);
    for (const s of ['succeeded', 'failed', 'partially_refunded', 'refunded'] as const) expect(isSettled(s)).toBe(true);
  });
});
