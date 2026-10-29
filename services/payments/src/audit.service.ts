import { Inject, Injectable } from '@nestjs/common';
import { getCorrelationId } from '@zerodrift/common';
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';
import type { PaymentsDB } from './db-schema.js';
import { DB } from './tokens.js';

export interface AuditEntry {
  actor: string;
  merchantId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  ip?: string | null;
  /** Small, non-sensitive facts (amounts, ids). Never secrets, keys or card data. */
  details?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  constructor(@Inject(DB) private readonly db: Kysely<PaymentsDB>) {}

  /** Pass the caller's transaction to make the audit row commit/roll back together with the action. */
  async write(entry: AuditEntry, trx?: Transaction<PaymentsDB>): Promise<void> {
    await sql`
      INSERT INTO audit_logs (actor, merchant_id, action, resource_type, resource_id, ip, correlation_id, details)
      VALUES (${entry.actor}, ${entry.merchantId ?? null}, ${entry.action}, ${entry.resourceType}, ${entry.resourceId ?? null},
              ${entry.ip ?? null}, ${getCorrelationId() ?? null}, ${entry.details ? JSON.stringify(entry.details) : null}::jsonb)`.execute(trx ?? this.db);
  }

  async list(q: { merchantId?: string; action?: string; limit?: number }) {
    const rows = await sql<{ id: string; actor: string; merchant_id: string | null; action: string; resource_type: string; resource_id: string | null; ip: string | null; correlation_id: string | null; details: unknown; created_at: Date }>`
      SELECT * FROM audit_logs
      WHERE (${q.merchantId ?? null}::uuid IS NULL OR merchant_id = ${q.merchantId ?? null}::uuid)
        AND (${q.action ?? null}::text IS NULL OR action = ${q.action ?? null}::text)
      ORDER BY created_at DESC, id DESC LIMIT ${Math.min(q.limit ?? 100, 500)}`.execute(this.db);
    return rows.rows.map((r) => ({ id: r.id, actor: r.actor, merchantId: r.merchant_id, action: r.action, resourceType: r.resource_type, resourceId: r.resource_id, ip: r.ip, correlationId: r.correlation_id, details: r.details, at: r.created_at.toISOString() }));
  }
}
