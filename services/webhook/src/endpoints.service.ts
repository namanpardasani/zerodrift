import { Inject, Injectable } from '@nestjs/common';
import { DomainError } from '@zerodrift/common';
import { decryptSecret, encryptSecret, generateSecret } from '@zerodrift/webhooks';
import { type Kysely, type Selectable, sql } from 'kysely';
import type { WebhookConfig } from './config.js';
import type { EndpointsTable, WebhookDB } from './db-schema.js';
import { CONFIG, DB } from './tokens.js';
import { assertSafeUrl } from './url-guard.js';

export type EndpointRow = Selectable<EndpointsTable>;

export interface EndpointView {
  id: string;
  url: string;
  description: string | null;
  eventTypes: string[];
  active: boolean;
  createdAt: string;
  /** Present only in the response that creates/rotates it: it can never be read again. */
  secret?: string;
}

const view = (e: EndpointRow, secret?: string): EndpointView => ({
  id: e.id,
  url: e.url,
  description: e.description,
  eventTypes: e.event_types,
  active: e.active,
  createdAt: e.created_at.toISOString(),
  ...(secret ? { secret } : {}),
});

@Injectable()
export class EndpointsService {
  constructor(
    @Inject(DB) private readonly db: Kysely<WebhookDB>,
    @Inject(CONFIG) private readonly config: WebhookConfig,
  ) {}

  async create(merchantId: string, input: { url: string; description?: string; eventTypes?: string[] }): Promise<EndpointView> {
    await assertSafeUrl(input.url, { allowPrivate: this.config.allowPrivateUrls });
    const secret = generateSecret();
    const row = await this.db
      .insertInto('webhook_endpoints')
      .values({
        merchant_id: merchantId,
        url: input.url,
        description: input.description ?? null,
        event_types: input.eventTypes?.length ? input.eventTypes : ['*'],
        secret_encrypted: encryptSecret(secret, this.config.encryptionKey),
        previous_secret_encrypted: null,
        previous_secret_expires_at: null,
        updated_at: new Date(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return view(row, secret);
  }

  async list(merchantId: string): Promise<EndpointView[]> {
    const rows = await this.db.selectFrom('webhook_endpoints').selectAll().where('merchant_id', '=', merchantId).orderBy('created_at', 'desc').execute();
    return rows.map((r) => view(r));
  }

  /** 404 (not 403) for someone else's endpoint, so ids of other merchants are never confirmed. */
  async getOwned(merchantId: string, id: string): Promise<EndpointRow> {
    const row = await this.db.selectFrom('webhook_endpoints').selectAll().where('id', '=', id).where('merchant_id', '=', merchantId).executeTakeFirst();
    if (!row) throw new DomainError('not_found', `Webhook endpoint ${id} not found`, 404);
    return row;
  }

  async get(merchantId: string, id: string): Promise<EndpointView> {
    return view(await this.getOwned(merchantId, id));
  }

  async update(merchantId: string, id: string, patch: { url?: string; description?: string; active?: boolean; eventTypes?: string[] }): Promise<EndpointView> {
    await this.getOwned(merchantId, id);
    if (patch.url) await assertSafeUrl(patch.url, { allowPrivate: this.config.allowPrivateUrls });
    const row = await this.db
      .updateTable('webhook_endpoints')
      .set({
        ...(patch.url !== undefined ? { url: patch.url } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.active !== undefined ? { active: patch.active } : {}),
        ...(patch.eventTypes !== undefined ? { event_types: patch.eventTypes.length ? patch.eventTypes : ['*'] } : {}),
        updated_at: sql`now()` as never,
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return view(row);
  }

  /** "Delete" disables the endpoint but keeps it (and its delivery history) so logs stay intact. */
  async disable(merchantId: string, id: string): Promise<void> {
    await this.update(merchantId, id, { active: false });
  }

  /**
   * Rotate the signing secret with zero downtime: the old secret keeps signing (alongside the new
   * one) for a grace period, so a receiver can switch secrets at its own pace.
   */
  async rotateSecret(merchantId: string, id: string): Promise<EndpointView> {
    const current = await this.getOwned(merchantId, id);
    const secret = generateSecret();
    const row = await this.db
      .updateTable('webhook_endpoints')
      .set({
        secret_encrypted: encryptSecret(secret, this.config.encryptionKey),
        previous_secret_encrypted: current.secret_encrypted,
        previous_secret_expires_at: sql`now() + make_interval(hours => ${this.config.previousSecretGraceHours})` as never,
        updated_at: sql`now()` as never,
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return view(row, secret);
  }

  /** The secrets to sign with right now: current first, plus the previous one while its grace lasts. */
  secretsFor(e: EndpointRow): string[] {
    const secrets = [decryptSecret(e.secret_encrypted, this.config.encryptionKey)];
    if (e.previous_secret_encrypted && e.previous_secret_expires_at && e.previous_secret_expires_at.getTime() > Date.now()) {
      secrets.push(decryptSecret(e.previous_secret_encrypted, this.config.encryptionKey));
    }
    return secrets;
  }
}
