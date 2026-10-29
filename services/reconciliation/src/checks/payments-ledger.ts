import { type FeedPayment, type LedgerTx, type Mismatch, type Window, inWindow, isSettledPayment } from '../types.js';

const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);

/**
 * Payments <-> ledger. The payments service says "this payment succeeded, ledger transaction X
 * moved the money"; the ledger holds the truth about what moved. This pure function compares the two.
 *
 *  - every settled payment must have its ledger transaction, moving exactly: customer debited the
 *    amount, merchant credited amount - fee, fee credited (total credits == amount)
 *  - a failed payment must NOT have a ledger payment transaction (money moved for nothing)
 *  - every ledger payment transaction must belong to a settled payment (no orphan captures)
 *  - every succeeded refund must have a ledger refund crediting the customer; a refund that did not
 *    succeed must not
 *  - payments stuck in created/processing past the threshold are flagged
 *
 * `payments`/`ledgerTxs` may be padded beyond the window (so a lookup never misses just because a
 * record sits on the edge); only items whose own timestamp is INSIDE `window` are reported.
 */
export function comparePaymentsToLedger(
  payments: FeedPayment[],
  ledgerTxs: LedgerTx[],
  opts: { window: Window; now: Date; stuckAfterMs: number },
): Mismatch[] {
  const out: Mismatch[] = [];
  const txById = new Map(ledgerTxs.map((t) => [t.id, t]));
  const paymentById = new Map(payments.map((p) => [p.id, p]));
  const paymentTxByRef = new Map<string, LedgerTx>();
  const refundTxByRef = new Map<string, LedgerTx>();
  for (const t of ledgerTxs) {
    if (t.type === 'payment' && t.referenceId) paymentTxByRef.set(t.referenceId, t);
    if (t.type === 'refund' && t.referenceId) refundTxByRef.set(t.referenceId, t);
  }
  const refundById = new Map(payments.flatMap((p) => p.refunds.map((r) => [r.id, { r, p }] as const)));

  for (const p of payments) {
    if (!inWindow(p.createdAt, opts.window)) continue;
    const amount = BigInt(p.amountMinor);
    const fee = BigInt(p.feeMinor);

    if (isSettledPayment(p.status)) {
      const tx = p.ledgerTxId ? txById.get(p.ledgerTxId) : undefined;
      if (!tx) {
        out.push({ kind: 'ledger_tx_missing', severity: 'critical', reference: p.id, message: `Payment ${p.id} is ${p.status} but its ledger transaction ${p.ledgerTxId ?? '(none recorded)'} was not found`, expected: { ledgerTxId: p.ledgerTxId }, actual: null });
      } else {
        const debitsCustomer = sum(tx.entries.filter((e) => e.direction === 'debit' && e.accountId === p.customerAccountId).map((e) => BigInt(e.amountMinor)));
        const creditsMerchant = sum(tx.entries.filter((e) => e.direction === 'credit' && e.accountId === p.merchantLedgerAccountId).map((e) => BigInt(e.amountMinor)));
        const totalCredits = sum(tx.entries.filter((e) => e.direction === 'credit').map((e) => BigInt(e.amountMinor)));
        const expected = { customerDebit: amount.toString(), merchantCredit: (amount - fee).toString(), totalCredits: amount.toString() };
        const actual = { customerDebit: debitsCustomer.toString(), merchantCredit: creditsMerchant.toString(), totalCredits: totalCredits.toString() };
        if (tx.type !== 'payment' || tx.referenceId !== p.id || debitsCustomer !== amount || creditsMerchant !== amount - fee || totalCredits !== amount) {
          out.push({ kind: 'ledger_amount_mismatch', severity: 'critical', reference: p.id, message: `Ledger transaction ${tx.id} does not match payment ${p.id}`, expected, actual: { ...actual, type: tx.type, referenceId: tx.referenceId } });
        }
      }
    } else if (p.status === 'failed') {
      const tx = paymentTxByRef.get(p.id);
      if (tx) out.push({ kind: 'ledger_orphan_payment', severity: 'critical', reference: p.id, message: `Payment ${p.id} FAILED but the ledger has a payment transaction ${tx.id} moving money for it`, expected: null, actual: { ledgerTxId: tx.id } });
    } else {
      // created / processing
      const tx = paymentTxByRef.get(p.id);
      if (tx) out.push({ kind: 'ledger_orphan_payment', severity: 'critical', reference: p.id, message: `Payment ${p.id} is still ${p.status} but the ledger already captured it (${tx.id})`, expected: { status: 'succeeded' }, actual: { status: p.status, ledgerTxId: tx.id } });
      if (opts.now.getTime() - Date.parse(p.updatedAt) > opts.stuckAfterMs) {
        out.push({ kind: 'stuck_payment', severity: 'warning', reference: p.id, message: `Payment ${p.id} has been ${p.status} for longer than the recovery window`, expected: { status: 'settled' }, actual: { status: p.status, lastUpdate: p.updatedAt } });
      }
    }

    for (const r of p.refunds) {
      const rtx = r.ledgerTxId ? txById.get(r.ledgerTxId) : refundTxByRef.get(r.id);
      if (r.status === 'succeeded') {
        if (!rtx) {
          out.push({ kind: 'ledger_refund_missing', severity: 'critical', reference: r.id, message: `Refund ${r.id} succeeded but has no ledger transaction`, expected: { ledgerTxId: r.ledgerTxId }, actual: null });
        } else {
          const credited = sum(rtx.entries.filter((e) => e.direction === 'credit' && e.accountId === p.customerAccountId).map((e) => BigInt(e.amountMinor)));
          if (rtx.type !== 'refund' || credited !== BigInt(r.amountMinor)) {
            out.push({ kind: 'ledger_amount_mismatch', severity: 'critical', reference: r.id, message: `Ledger refund ${rtx.id} does not match refund ${r.id}`, expected: { customerCredit: r.amountMinor }, actual: { customerCredit: credited.toString(), type: rtx.type } });
          }
        }
      } else if (r.status === 'failed' && refundTxByRef.has(r.id)) {
        out.push({ kind: 'ledger_orphan_refund', severity: 'critical', reference: r.id, message: `Refund ${r.id} FAILED but the ledger moved money for it`, expected: null, actual: { ledgerTxId: refundTxByRef.get(r.id)!.id } });
      }
    }
  }

  // Ledger transactions with no matching business record.
  for (const t of ledgerTxs) {
    if (!inWindow(t.createdAt, opts.window) || !t.referenceId) continue;
    if (t.type === 'payment') {
      const p = paymentById.get(t.referenceId);
      if (!p) out.push({ kind: 'ledger_orphan_payment', severity: 'critical', reference: t.referenceId, message: `Ledger payment transaction ${t.id} references payment ${t.referenceId}, which does not exist`, expected: null, actual: { ledgerTxId: t.id } });
    } else if (t.type === 'refund') {
      const found = refundById.get(t.referenceId);
      if (!found) out.push({ kind: 'ledger_orphan_refund', severity: 'critical', reference: t.referenceId, message: `Ledger refund transaction ${t.id} references refund ${t.referenceId}, which does not exist`, expected: null, actual: { ledgerTxId: t.id } });
    }
  }

  return dedupe(out);
}

/** The same finding can be produced from two angles (payment side and ledger side): keep one. */
export function dedupe(ms: Mismatch[]): Mismatch[] {
  const seen = new Set<string>();
  return ms.filter((m) => {
    const k = `${m.kind}:${m.reference}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
