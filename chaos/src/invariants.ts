/**
 * The invariant checker: after load + chaos + recovery, prove the money is still right.
 *
 * It deliberately does NOT use any service code. It reads the four databases with plain SQL, so a bug in
 * a service cannot hide itself by also being in the checker. Every check returns the offending rows
 * (capped) so a failure is debuggable, not just "false".
 */

/** The only thing the checker needs from a database connection (a pg Pool satisfies it). */
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export interface Databases {
  ledger: Queryable;
  payments: Queryable;
  webhook: Queryable;
  gateway: Queryable;
}

/** What the webhook receiver reported: eventId -> how many times it accepted ("ok") that event. */
export type ReceiverCounts = Record<string, number>;

export interface CheckerInput {
  /** Total paise that entered the system via top-ups, from the SEED (independent of the ledger). */
  expectedTopupMinor: bigint;
  /** Number of distinct idempotency keys the load generator used in this run (from k6). Undefined = skip that comparison. */
  runKeyPrefix?: string;
  uniqueKeysSent?: number;
  receiver: ReceiverCounts;
}

export interface CheckResult {
  name: string;
  description: string;
  passed: boolean;
  detail: string;
  /** Up to 10 offending rows, for debugging. */
  violations: unknown[];
}

const LIMIT = 10;

async function check(name: string, description: string, fn: () => Promise<{ violations: unknown[]; detail: string; count?: number }>): Promise<CheckResult> {
  try {
    const r = await fn();
    const n = r.count ?? r.violations.length;
    return { name, description, passed: n === 0, detail: r.detail, violations: r.violations.slice(0, LIMIT) };
  } catch (err) {
    // A checker that cannot run is a failed check, never a silent pass.
    return { name, description, passed: false, detail: `checker error: ${(err as Error).message}`, violations: [] };
  }
}

export async function runInvariants(db: Databases, input: CheckerInput): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // 1. Money conserved exactly. Everything that ever entered came from a top-up (debit gateway_clearing,
  //    credit wallet). So the sum over ALL non-clearing accounts must equal what the seed put in, to the paisa,
  //    and the clearing account must hold exactly the negative of it. Nothing created, nothing destroyed.
  results.push(
    await check('money_conserved', 'sum of all balances == money that entered (top-ups); clearing == -top-ups; global sum is 0', async () => {
      const { rows } = await db.ledger.query(`
        SELECT
          COALESCE(SUM(CASE WHEN a.type <> 'gateway_clearing' THEN b.available_minor + b.held_minor END), 0)::text AS held_by_users,
          COALESCE(SUM(CASE WHEN a.type = 'gateway_clearing' THEN b.available_minor + b.held_minor END), 0)::text AS clearing,
          COALESCE(SUM(b.available_minor + b.held_minor), 0)::text AS total
        FROM account_balances b JOIN accounts a ON a.id = b.account_id`);
      const r = rows[0];
      const problems: unknown[] = [];
      if (BigInt(r.total) !== 0n) problems.push({ problem: 'global balance sum is not zero', total: r.total });
      if (BigInt(r.held_by_users) !== input.expectedTopupMinor) problems.push({ problem: 'money held by accounts differs from money that entered', held: r.held_by_users, expected: input.expectedTopupMinor.toString() });
      if (BigInt(r.clearing) !== -input.expectedTopupMinor) problems.push({ problem: 'clearing account is not -(top-ups)', clearing: r.clearing, expected: (-input.expectedTopupMinor).toString() });
      return { violations: problems, detail: `entered=${input.expectedTopupMinor} held_by_accounts=${r.held_by_users} clearing=${r.clearing} total=${r.total}` };
    }),
  );

  // 2. Every transaction is balanced: debits == credits, and it has entries at all.
  results.push(
    await check('transactions_balanced', 'every ledger transaction has debits == credits (and at least two entries)', async () => {
      const { rows } = await db.ledger.query(`
        SELECT t.id, t.type,
               COALESCE(SUM(e.amount_minor) FILTER (WHERE e.direction = 'debit'), 0)::text AS debits,
               COALESCE(SUM(e.amount_minor) FILTER (WHERE e.direction = 'credit'), 0)::text AS credits,
               COUNT(e.id)::int AS entries
        FROM ledger_transactions t LEFT JOIN journal_entries e ON e.transaction_id = t.id
        GROUP BY t.id, t.type
        HAVING COALESCE(SUM(e.amount_minor) FILTER (WHERE e.direction = 'debit'), 0)
            <> COALESCE(SUM(e.amount_minor) FILTER (WHERE e.direction = 'credit'), 0)
            OR COUNT(e.id) < 2`);
      const total = await db.ledger.query('SELECT COUNT(*)::int AS n FROM ledger_transactions');
      return { violations: rows, detail: `${total.rows[0].n} transactions checked, ${rows.length} unbalanced` };
    }),
  );

  // 3. Stored balances equal the sum of journal entries (balance = credits - debits), and nobody is overdrawn.
  results.push(
    await check('balances_match_entries', 'account balance (available + held) == credits - debits from the journal; no unauthorised negative balance', async () => {
      const { rows } = await db.ledger.query(`
        SELECT a.id, a.allow_negative, b.available_minor::text AS available, b.held_minor::text AS held,
               COALESCE(e.net, 0)::text AS journal_net
        FROM accounts a
        LEFT JOIN account_balances b ON b.account_id = a.id
        LEFT JOIN (SELECT account_id, SUM(CASE direction WHEN 'credit' THEN amount_minor ELSE -amount_minor END) AS net
                   FROM journal_entries GROUP BY account_id) e ON e.account_id = a.id
        WHERE COALESCE(b.available_minor, 0) + COALESCE(b.held_minor, 0) <> COALESCE(e.net, 0)
           OR (COALESCE(b.available_minor, 0) < 0 AND NOT a.allow_negative)`);
      const total = await db.ledger.query('SELECT COUNT(*)::int AS n FROM accounts');
      return { violations: rows, detail: `${total.rows[0].n} accounts checked, ${rows.length} mismatched` };
    }),
  );

  // 4. Nothing is stuck in a hold once the system has quiesced (a payment that failed must have released its hold).
  results.push(
    await check('no_money_stuck_in_holds', 'no active holds and no held balance after the recovery window', async () => {
      const holds = await db.ledger.query(`SELECT id, status, amount_minor::text AS amount FROM holds WHERE status = 'active' LIMIT ${LIMIT}`);
      const held = await db.ledger.query(`SELECT COALESCE(SUM(held_minor), 0)::text AS held FROM account_balances`);
      const problems: unknown[] = [...holds.rows];
      if (BigInt(held.rows[0].held) !== 0n) problems.push({ problem: 'held balance is not zero', held: held.rows[0].held });
      return { violations: problems, detail: `${holds.rows.length} active holds, held balance ${held.rows[0].held}` };
    }),
  );

  // 5. No duplicate charge. Three layers: the customer's ledger, the bank, and the request keys.
  results.push(
    await check('no_duplicate_charges', 'at most one capture per payment, at most one bank charge per payment, no charge for a failed payment, no payment without its charge', async () => {
      const problems: unknown[] = [];
      // (a) ledger: captures are keyed `capture:<paymentId>` (UNIQUE), so verify the relation to payment state
      const pay = await db.payments.query(`SELECT id::text AS id, status, ledger_tx_id::text AS ledger_tx_id FROM payments`);
      const captures = await db.ledger.query(`SELECT substr(idempotency_key, 9) AS payment_id, COUNT(*)::int AS n FROM ledger_transactions WHERE idempotency_key LIKE 'capture:%' GROUP BY 1`);
      const captureCount = new Map<string, number>(captures.rows.map((r) => [r.payment_id as string, r.n as number]));
      // (b) bank: the gateway reference IS the payment id; one row per reference by primary key
      const bank = await db.gateway.query(`SELECT reference, status FROM gateway_charges`);
      const bankStatus = new Map<string, string>(bank.rows.map((r) => [r.reference as string, r.status as string]));
      const paid = new Set(['succeeded', 'partially_refunded', 'refunded']);
      for (const p of pay.rows) {
        const captured = captureCount.get(p.id) ?? 0;
        const bankState = bankStatus.get(p.id);
        if (captured > 1) problems.push({ payment: p.id, problem: 'captured more than once', captured });
        if (paid.has(p.status) && captured !== 1) problems.push({ payment: p.id, problem: 'succeeded payment without exactly one capture', captured });
        if (!paid.has(p.status) && captured > 0) problems.push({ payment: p.id, problem: 'capture exists for a payment that did not succeed', status: p.status });
        if (paid.has(p.status) && bankState !== 'succeeded') problems.push({ payment: p.id, problem: 'succeeded payment but the bank did not charge', bank: bankState });
        // a bank charge that still stands for a payment that did not succeed = customer charged for nothing
        if (!paid.has(p.status) && bankState === 'succeeded') problems.push({ payment: p.id, problem: 'bank charge stands for a failed payment', status: p.status });
      }
      // (c) every capture belongs to a known payment
      const known = new Set<string>(pay.rows.map((r) => r.id as string));
      for (const [id] of captureCount) if (!known.has(id)) problems.push({ payment: id, problem: 'capture for an unknown payment' });
      // (d) request keys: (merchant, key) is UNIQUE in the schema; compare to what the load generator sent
      const dupKeys = await db.payments.query(`SELECT merchant_id::text AS merchant_id, idempotency_key, COUNT(*)::int AS n FROM payments GROUP BY 1, 2 HAVING COUNT(*) > 1`);
      problems.push(...dupKeys.rows);
      let keysDetail = '';
      if (input.runKeyPrefix && input.uniqueKeysSent !== undefined) {
        const mine = await db.payments.query(`SELECT COUNT(*)::int AS n FROM payments WHERE idempotency_key LIKE $1`, [`${input.runKeyPrefix}-%`]);
        const created = mine.rows[0].n as number;
        keysDetail = `; ${created} payments from ${input.uniqueKeysSent} keys (payments are ~75% of keys)`;
        if (created > input.uniqueKeysSent) problems.push({ problem: 'more payments than distinct keys sent', payments: created, keys: input.uniqueKeysSent });
      }
      return { violations: problems, detail: `${pay.rows.length} payments, ${captures.rows.length} captures, ${bank.rows.length} bank charges${keysDetail}` };
    }),
  );

  // 6. Nothing stuck mid-flight after the recovery window.
  results.push(
    await check('no_stuck_payments', 'no payment left in created/processing after the recovery window', async () => {
      const { rows } = await db.payments.query(`SELECT id::text AS id, status, now() - updated_at AS stuck_for FROM payments WHERE status IN ('created','processing') ORDER BY updated_at LIMIT ${LIMIT}`);
      const n = await db.payments.query(`SELECT COUNT(*)::int AS n FROM payments WHERE status IN ('created','processing')`);
      return { violations: rows, count: n.rows[0].n, detail: `${n.rows[0].n} stuck payments` };
    }),
  );

  // 7. Webhooks: every succeeded payment's event is delivered or dead-lettered, exactly once per endpoint.
  results.push(
    await check('webhooks_exactly_once', 'each succeeded payment has one payment.succeeded event; one delivery per (event, endpoint), each succeeded or dead; receiver accepted each event at most once', async () => {
      const problems: unknown[] = [];
      const succeeded = await db.payments.query(`SELECT id::text AS id, merchant_id::text AS merchant_id FROM payments WHERE status IN ('succeeded','partially_refunded','refunded')`);
      const events = await db.webhook.query(`SELECT event_id::text AS event_id, merchant_id::text AS merchant_id, payload->>'aggregateId' AS payment_id FROM webhook_events WHERE event_type = 'payment.succeeded'`);
      const eventsByPayment = new Map<string, { event_id: string }[]>();
      for (const e of events.rows) eventsByPayment.set(e.payment_id, [...(eventsByPayment.get(e.payment_id) ?? []), e]);
      const endpoints = await db.webhook.query(`SELECT id::text AS id, merchant_id::text AS merchant_id FROM webhook_endpoints WHERE active AND event_types && ARRAY['*','payment.succeeded']`);
      const endpointsByMerchant = new Map<string, string[]>();
      for (const e of endpoints.rows) endpointsByMerchant.set(e.merchant_id, [...(endpointsByMerchant.get(e.merchant_id) ?? []), e.id]);
      const deliveries = await db.webhook.query(`SELECT event_id::text AS event_id, endpoint_id::text AS endpoint_id, status, COUNT(*) OVER (PARTITION BY event_id, endpoint_id)::int AS copies FROM webhook_deliveries`);
      const byEvent = new Map<string, { endpoint_id: string; status: string; copies: number }[]>();
      for (const d of deliveries.rows) byEvent.set(d.event_id, [...(byEvent.get(d.event_id) ?? []), d]);

      let delivered = 0;
      let dead = 0;
      for (const p of succeeded.rows) {
        const evs = eventsByPayment.get(p.id) ?? [];
        if (evs.length !== 1) {
          problems.push({ payment: p.id, problem: 'expected exactly one payment.succeeded event', events: evs.length });
          continue;
        }
        const wanted = endpointsByMerchant.get(p.merchant_id) ?? [];
        const got = byEvent.get(evs[0]!.event_id) ?? [];
        for (const ep of wanted) {
          const mine = got.filter((d) => d.endpoint_id === ep);
          if (mine.length !== 1) problems.push({ payment: p.id, endpoint: ep, problem: 'expected exactly one delivery', deliveries: mine.length });
          else if (mine[0]!.status === 'pending') problems.push({ payment: p.id, endpoint: ep, problem: 'delivery still pending after recovery window' });
          else if (mine[0]!.status === 'succeeded') {
            delivered++;
            const accepted = input.receiver[evs[0]!.event_id] ?? 0;
            if (accepted !== 1) problems.push({ payment: p.id, endpoint: ep, problem: 'marked delivered but the receiver accepted it a different number of times', accepted });
          } else dead++;
        }
      }
      // the receiver must never have accepted an event twice, whatever the delivery state
      for (const [eventId, n] of Object.entries(input.receiver)) if (n > 1) problems.push({ event: eventId, problem: 'receiver accepted the same event more than once', accepted: n });
      return { violations: problems, detail: `${succeeded.rows.length} succeeded payments: ${delivered} deliveries succeeded, ${dead} dead-lettered` };
    }),
  );

  return results;
}

/** Reconciliation result from the reconciliation service, turned into the same shape as the SQL checks. */
export function reconciliationResult(kind: string, run: { status?: string; mismatches?: unknown[]; error?: string | null } | null | undefined): CheckResult {
  const name = `reconciliation_${kind}`;
  const description = `${kind} reconciliation run is clean`;
  if (!run || run.status === undefined) return { name, description, passed: false, detail: 'no reconciliation run result', violations: [] };
  const mismatches = run.mismatches ?? [];
  return { name, description, passed: run.status === 'clean' && mismatches.length === 0, detail: `status=${run.status}, ${mismatches.length} mismatches${run.error ? `, error=${run.error}` : ''}`, violations: mismatches.slice(0, LIMIT) };
}
