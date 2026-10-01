import type { Ctx } from '../auth/actor.js';

/**
 * Inbound webhook registry (Integration Hub, 要件 9.1).
 * Provider modules register a verifier + processor; the generic route
 * POST /v1/webhooks/:provider (ops/integrations module) persists every delivery to webhook_events
 * (dedupe on provider event id), acknowledges fast, and processes asynchronously via the job queue
 * ('webhook.process'), with retries and DLQ.
 */
export interface IncomingWebhook {
  provider: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
  body: unknown;
  /** route params beyond provider, e.g. /webhooks/line/:channelId */
  pathParams?: Record<string, string>;
}

export interface VerifiedWebhook {
  /** provider event id used for dedupe (fallback: sha256 of raw body) */
  eventId: string;
  eventType?: string;
  /** tenant if resolvable at receipt time (e.g. LINE destination → line_channels) */
  organizationId?: string | null;
  signatureValid: boolean;
  /** a single HTTP delivery may contain multiple events (LINE) — split into separate records */
  events?: { eventId: string; eventType?: string; payload: unknown }[];
}

export interface WebhookProvider {
  /** verify signature & extract ids. Must not throw for bad signatures: return signatureValid=false */
  verify(req: IncomingWebhook): Promise<VerifiedWebhook>;
  /** process one stored event inside a tenant transaction (organizationId known) */
  process(ctx: Ctx, event: { eventId: string; eventType: string | null; payload: unknown }): Promise<'processed' | 'ignored'>;
}

const providers = new Map<string, WebhookProvider>();

export function registerWebhookProvider(name: string, provider: WebhookProvider) {
  if (providers.has(name)) throw new Error(`webhook provider already registered: ${name}`);
  providers.set(name, provider);
}

export function getWebhookProvider(name: string): WebhookProvider | undefined {
  return providers.get(name);
}

export function registeredWebhookProviders(): string[] {
  return [...providers.keys()];
}
