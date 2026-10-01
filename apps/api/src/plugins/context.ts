import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { Actor, CustomerActor, Ctx, RequestMeta, StaffActor } from '../auth/actor.js';
import { verifyToken } from '../auth/jwt.js';
import { loadStaffActor } from '../auth/load-actor.js';
import { withTenant, type TxOptions } from '../db/tenant.js';
import { Errors } from '../lib/errors.js';

export type RouteAuth = 'staff' | 'customer' | 'public' | 'any';

declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor | null;
    meta: RequestMeta;
    /** returns the authenticated staff actor or throws 401/403 */
    staff(): StaffActor;
    customer(): CustomerActor;
    /** run fn in a tenant-scoped transaction for the authenticated actor */
    tx<T>(fn: (ctx: Ctx) => Promise<T>, opts?: Pick<TxOptions, 'isolation'>): Promise<T>;
  }
  interface FastifyContextConfig {
    /** who may call this route (default: staff) */
    auth?: RouteAuth;
    /** honour Idempotency-Key header ('required' rejects requests without one) */
    idempotent?: boolean | 'required';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** W3C traceparent: 00-<trace-id>-<span-id>-<flags> */
function traceIdFrom(req: FastifyRequest): string {
  const tp = req.headers.traceparent;
  if (typeof tp === 'string') {
    const m = /^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$/i.exec(tp);
    if (m) return m[1]!;
  }
  return req.id.replace(/-/g, '');
}

async function contextPlugin(app: FastifyInstance) {
  app.decorateRequest('actor', null);
  app.decorateRequest('meta', null as unknown as RequestMeta);

  app.decorateRequest('staff', function (this: FastifyRequest) {
    if (!this.actor) throw Errors.unauthenticated();
    if (this.actor.kind !== 'staff') throw Errors.forbidden('スタッフ認証が必要です');
    return this.actor;
  });

  app.decorateRequest('customer', function (this: FastifyRequest) {
    if (!this.actor) throw Errors.unauthenticated();
    if (this.actor.kind !== 'customer') throw Errors.forbidden('顧客認証が必要です');
    return this.actor;
  });

  app.decorateRequest('tx', function <T>(this: FastifyRequest, fn: (ctx: Ctx) => Promise<T>, opts?: Pick<TxOptions, 'isolation'>) {
    const actor = this.actor;
    if (!actor) throw Errors.unauthenticated();
    return withTenant(actor.organizationId, (trx) => fn({ actor, trx, meta: this.meta }), {
      userId: actor.kind === 'staff' ? actor.userId : null,
      traceId: this.meta.traceId,
      isolation: opts?.isolation,
    });
  });

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const shopHeader = req.headers['x-shop-id'];
    req.meta = {
      requestId: req.id,
      traceId: traceIdFrom(req),
      ip: req.ip,
      userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 500) : undefined,
      currentShopId: typeof shopHeader === 'string' && UUID_RE.test(shopHeader) ? shopHeader : null,
    };
    reply.header('x-request-id', req.id);

    const header = req.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      const claims = await verifyToken(header.slice(7));
      if (claims?.typ === 'staff') {
        req.actor = await loadStaffActor(claims.org, claims.stf, claims.sub);
      } else if (claims?.typ === 'customer') {
        req.actor = { kind: 'customer', organizationId: claims.org, customerId: claims.sub, via: claims.via };
      }
    }
  });

  // Route-level authentication gate
  app.addHook('preHandler', async (req: FastifyRequest) => {
    const auth: RouteAuth = req.routeOptions.config?.auth ?? 'staff';
    if (auth === 'public') return;
    if (!req.actor) throw Errors.unauthenticated();
    if (auth === 'staff' && req.actor.kind !== 'staff') throw Errors.forbidden('スタッフ認証が必要です');
    if (auth === 'customer' && req.actor.kind !== 'customer') throw Errors.forbidden('顧客認証が必要です');
  });
}

export default fp(contextPlugin, { name: 'context' });

export function newRequestId(req: { headers: Record<string, unknown> }): string {
  const incoming = req.headers['x-request-id'];
  return typeof incoming === 'string' && /^[\w-]{8,128}$/.test(incoming) ? incoming : randomUUID();
}
