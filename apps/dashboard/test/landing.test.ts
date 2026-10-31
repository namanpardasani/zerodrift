// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CHAOS_RUNS, CHAOS_TOTALS, FAULT_KINDS } from '../src/landing/chaosResults.js';

/**
 * The landing page shows REAL chaos numbers. This test reads docs/CHAOS_RESULTS.md (the measured record) and fails
 * if the numbers in the page's data module differ from it: no number can be invented or drift away from the record.
 */
const doc = readFileSync(fileURLToPath(new URL('../../../docs/CHAOS_RESULTS.md', import.meta.url)), 'utf8');
const tableRows = doc
  .split('\n')
  .filter((l) => /^\| \d+ \| (chaos|none \(baseline\)) \|/.test(l))
  .map((l) => l.split('|').slice(1, -1).map((c) => c.trim()));

describe('landing page chaos numbers match docs/CHAOS_RESULTS.md', () => {
  it('has one table row per run in the data module', () => {
    expect(tableRows).toHaveLength(CHAOS_RUNS.length);
  });

  it.each(CHAOS_RUNS.map((r) => [r.run, r] as const))('run %i matches its row in the document', (_n, r) => {
    const row = tableRows[r.run - 1]!;
    const [, mode, loadSeconds, ops, pay, xfer, dups, retries, gaveUp, faults, recovery, inv] = row;
    expect(mode === 'chaos' ? 'chaos' : 'baseline').toBe(r.mode);
    expect(Number(loadSeconds)).toBe(r.loadSeconds);
    expect(Number(ops)).toBe(r.opsPerSecond);
    expect(pay).toBe(`${r.paymentP50Ms} / ${r.paymentP99Ms}`);
    expect(xfer).toBe(`${r.transferP50Ms} / ${r.transferP99Ms}`);
    expect(Number(dups)).toBe(r.duplicatePairs);
    expect(Number(retries)).toBe(r.clientRetries);
    expect(Number(gaveUp)).toBe(r.gaveUp);
    expect(Number(faults)).toBe(r.faults);
    expect(Number(recovery)).toBe(r.recoverySeconds);
    expect(inv).toBe(r.invariants);
  });

  it('the headline totals equal the totals written in the document', () => {
    expect(doc).toContain(`${CHAOS_TOTALS.operations.toLocaleString('en-US')} operations, ${CHAOS_TOTALS.faults} faults injected`);
    expect(doc).toContain(`${CHAOS_TOTALS.duplicatePairs.toLocaleString('en-US')} duplicate request pairs, ${CHAOS_TOTALS.clientRetries.toLocaleString('en-US')} client retries`);
    expect(doc).toContain(`${CHAOS_TOTALS.gaveUp.toLocaleString('en-US')} operations where the client gave up`);
    expect(doc).toContain(`${CHAOS_TOTALS.invariantEvaluations} invariant evaluations`);
  });

  it('the fault kinds add up to the total and appear in the document', () => {
    expect(FAULT_KINDS.reduce((s, [, n]) => s + n, 0)).toBe(CHAOS_TOTALS.faults);
    for (const [label, n] of FAULT_KINDS) {
      const wordFor = label.replace('bank fault windows', 'bank fault windows').replace('dropped-connection windows', 'dropped-connection windows').replace('kafka pauses', 'Kafka pauses');
      expect(doc.toLowerCase()).toContain(`${n} ${wordFor.toLowerCase()}`);
    }
  });
});
