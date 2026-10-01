/**
 * Integration Hub adapter contract (要件 9.1 / 21).
 * Every booking medium is wrapped by an adapter that converts the provider's native payloads
 * into the normalized ExternalBooking model. Nothing provider-specific may leak past this layer:
 * the sync engine, conflict handling and the appointments domain only ever see these types.
 */

export type ConflictPolicy = 'manual' | 'external_wins' | 'internal_wins';

export interface IntegrationConfig {
  /** external staff id → internal staff id */
  staffMap: Record<string, string>;
  /** external menu id → internal menu id */
  menuMap: Record<string, string>;
  conflictPolicy: ConflictPolicy;
  /** reflect internal bookings to the provider as blocked slots */
  pushBlocks: boolean;
  /** e-mail ingestion connectors only */
  mail?: import('../schemas.js').MailConfig;
}

/** What an adapter receives: the account with decrypted credentials (never leaves the server) */
export interface AdapterAccount {
  id: string;
  organizationId: string;
  shopId: string | null;
  provider: string;
  credentials: Record<string, unknown>;
  config: IntegrationConfig;
}

export interface ExternalCustomer {
  name: string | null;
  kana: string | null;
  phone: string | null;
  email: string | null;
  externalMemberId: string | null;
}

export interface ExternalBooking {
  externalId: string;
  status: 'booked' | 'changed' | 'cancelled';
  start: Date;
  end: Date;
  /** null = フリー (no staff designated on the medium) */
  staffExternalId: string | null;
  menuExternalIds: string[];
  customer: ExternalCustomer;
  note: string | null;
  updatedAt: Date;
  /** provider-native payload, stored verbatim for traceability */
  raw: unknown;
}

export interface FetchResult {
  bookings: ExternalBooking[];
  /** opaque cursor for the next delta fetch */
  nextCursor: string | null;
}

export interface SlotBlock {
  appointmentId: string;
  staffExternalId: string | null;
  start: Date;
  end: Date;
}

export interface HealthResult {
  ok: boolean;
  message?: string;
  latencyMs?: number;
}

export interface BookingProviderAdapter {
  readonly name: string;
  /**
   * 'api' (default): pushBlock/removeBlock call the provider.
   * 'manual': the provider has no write API — blocks become staff tasks ("block this slot on the medium").
   */
  readonly pushMode?: 'api' | 'manual';
  /** bookings arrive as forwarded notification e-mails (inbound e-mail webhook) */
  readonly inboundEmail?: boolean;
  /** changes since cursor (null = from the beginning of the change feed) */
  fetchChanges(account: AdapterAccount, cursor: string | null): Promise<FetchResult>;
  /** every booking whose start falls in range (全件再同期) */
  fetchAll(account: AdapterAccount, range: { from: Date; to: Date }): Promise<FetchResult>;
  /** block a slot on the provider; returns the provider's block id */
  pushBlock(account: AdapterAccount, block: SlotBlock): Promise<string>;
  removeBlock(account: AdapterAccount, externalBlockId: string): Promise<void>;
  health(account: AdapterAccount): Promise<HealthResult>;
}

/** Errors raised by adapters (network / provider outage / auth). Always retryable unless permanent. */
export class AdapterError extends Error {
  constructor(
    readonly provider: string,
    message: string,
    readonly permanent = false,
  ) {
    super(message);
    this.name = 'AdapterError';
  }
}
