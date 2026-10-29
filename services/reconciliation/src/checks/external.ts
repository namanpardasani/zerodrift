import { type FeedPayment, type GatewayCharge, type Mismatch, type Window, inWindow, isSettledPayment } from '../types.js';
import { dedupe } from './payments-ledger.js';

/**
 * Payments <-> the bank's settlement file (the external source of truth about what the bank
 * actually charged). The settlement lists charges that SUCCEEDED and were not voided.
 *
 *   payment settled, bank has no such charge   -> missing_in_gateway   (we took money the bank never collected)
 *   payment settled, amounts differ            -> amount_mismatch
 *   payment FAILED, bank charged anyway        -> bank_charge_without_payment (customer charged, we did not credit)
 *   bank charge nobody has a payment for       -> bank_charge_without_payment
 *
 * Payments still created/processing are in flight: the bank may legitimately know about them first,
 * so they are skipped here (the payments<->ledger check flags the ones that stay stuck).
 * Inputs may be padded beyond the window so a charge on the day boundary still finds its payment;
 * only records whose own timestamp is inside `window` are reported.
 */
export function compareToSettlement(payments: FeedPayment[], charges: GatewayCharge[], opts: { window: Window }): Mismatch[] {
  const out: Mismatch[] = [];
  const chargeByRef = new Map(charges.map((c) => [c.reference, c]));
  const paymentById = new Map(payments.map((p) => [p.id, p]));

  for (const p of payments) {
    if (!inWindow(p.createdAt, opts.window)) continue;
    const charge = chargeByRef.get(p.id);
    if (isSettledPayment(p.status)) {
      if (!charge) {
        out.push({ kind: 'missing_in_gateway', severity: 'critical', reference: p.id, message: `Payment ${p.id} is ${p.status} (${p.amountMinor} ${p.currency}) but the bank's settlement has no successful charge for it`, expected: { amountMinor: p.amountMinor }, actual: null });
      } else if (charge.amountMinor !== p.amountMinor || charge.currency !== p.currency) {
        out.push({ kind: 'amount_mismatch', severity: 'critical', reference: p.id, message: `Payment ${p.id} amount differs from the bank's charge`, expected: { amountMinor: p.amountMinor, currency: p.currency }, actual: { amountMinor: charge.amountMinor, currency: charge.currency } });
      }
    } else if (p.status === 'failed' && charge) {
      out.push({ kind: 'bank_charge_without_payment', severity: 'critical', reference: p.id, message: `Payment ${p.id} FAILED but the bank collected ${charge.amountMinor} for it: the customer was charged without being credited`, expected: { status: 'succeeded or no charge' }, actual: { status: p.status, bankAmountMinor: charge.amountMinor } });
    }
  }

  for (const c of charges) {
    if (!inWindow(c.createdAt, opts.window)) continue;
    if (!paymentById.has(c.reference)) {
      out.push({ kind: 'bank_charge_without_payment', severity: 'critical', reference: c.reference, message: `The bank charged ${c.amountMinor} for reference ${c.reference}, which matches no payment`, expected: null, actual: { amountMinor: c.amountMinor, createdAt: c.createdAt } });
    }
  }
  return dedupe(out);
}
