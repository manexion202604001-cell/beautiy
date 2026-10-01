import { actorId, type Ctx } from '../auth/actor.js';

/**
 * In-process domain event bus with a durable log (domain_events).
 * Subscribers run synchronously INSIDE the emitting transaction and should only do
 * cheap, transactional work — typically enqueueing jobs (transactional outbox pattern).
 */
export interface DomainEvent<P = Record<string, unknown>> {
  type: string;
  aggregateType: string;
  aggregateId: string;
  payload: P;
}

type Subscriber = (ctx: Ctx, event: DomainEvent<any>) => Promise<void> | void;

const subscribers = new Map<string, Subscriber[]>();

export function onEvent<P = Record<string, unknown>>(type: string, fn: (ctx: Ctx, event: DomainEvent<P>) => Promise<void> | void) {
  const list = subscribers.get(type) ?? [];
  list.push(fn as Subscriber);
  subscribers.set(type, list);
}

export async function emit<P extends Record<string, unknown>>(ctx: Ctx, event: DomainEvent<P>): Promise<void> {
  await ctx.trx
    .insertInto('domain_events')
    .values({
      organization_id: ctx.actor.organizationId,
      event_type: event.type,
      aggregate_type: event.aggregateType,
      aggregate_id: event.aggregateId,
      payload: JSON.stringify(event.payload),
      actor_id: actorId(ctx.actor),
      trace_id: ctx.meta.traceId ?? null,
    })
    .execute();
  for (const fn of [...(subscribers.get(event.type) ?? []), ...(subscribers.get('*') ?? [])]) {
    await fn(ctx, event);
  }
}
