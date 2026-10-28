import type { ColumnType, Generated } from 'kysely';

type Ts = ColumnType<Date, Date | string | undefined, Date | string>;

export interface EndpointsTable {
  id: Generated<string>;
  merchant_id: string;
  url: string;
  description: string | null;
  event_types: Generated<string[]>;
  secret_encrypted: string;
  previous_secret_encrypted: string | null;
  previous_secret_expires_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  active: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Ts;
}

export interface EventsTable {
  event_id: string;
  merchant_id: string;
  event_type: string;
  payload: ColumnType<unknown, string, string>;
  created_at: Generated<Date>;
}

export type DeliveryStatus = 'pending' | 'succeeded' | 'dead';

export interface DeliveriesTable {
  id: Generated<string>;
  event_id: string;
  endpoint_id: string;
  status: Generated<DeliveryStatus>;
  attempt_count: Generated<number>;
  cycle_attempts: Generated<number>;
  replay_count: Generated<number>;
  next_attempt_at: Ts;
  last_response_code: number | null;
  last_error: string | null;
  created_at: Generated<Date>;
  updated_at: Ts;
}

export interface AttemptsTable {
  id: Generated<string>;
  delivery_id: string;
  attempt_no: number;
  started_at: Date;
  duration_ms: number;
  response_code: number | null;
  error: string | null;
  response_snippet: string | null;
}

export interface WebhookDB {
  webhook_endpoints: EndpointsTable;
  webhook_events: EventsTable;
  webhook_deliveries: DeliveriesTable;
  webhook_attempts: AttemptsTable;
}
