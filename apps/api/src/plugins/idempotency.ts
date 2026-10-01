import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { withTenant } from '../db/tenant.js';
import { sha256 } from '../lib/crypto.js';
import { Errors } from '../lib/errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    idempotencyRecordId?: string;
  }
}

/**
 * Idempotency-Key support (要件 8.1 / 21): for routes with config.idempotent.
 *  - first request: record "in_progress", run handler, persist response (status < 500)
 *  - replay with same key + same body: return stored response with Idempotent-Replayed: true
 *  - same key + different body: 422 IDEMPOTENCY_KEY_REUSED
 *  - concurrent duplicate while in progress: 409 IDEMPOTENCY_IN_PROGRESS
 *  - 5xx: record removed so the client can retry safely
 */
async function idempotencyPlugin(app: FastifyInstance) {
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const mode = req.routeOptions.config?.idempotent;
    if (!mode) return;
    const keyHeader = req.headers['idempotency-key'];
    const key = typeof keyHeader === 'string' ? keyHeader.trim() : '';
    if (!key) {
      if (mode === 'required') throw Errors.validation('Idempotency-Key ヘッダーが必要です');
      return;
    }
    if (key.length > 255) throw Errors.validation('Idempotency-Key が長すぎます');
    const actor = req.actor;
    if (!actor) return; // public routes without tenant context cannot use stored idempotency

    const actorKey = actor.kind === 'staff' ? actor.staffId : actor.kind === 'customer' ? actor.customerId : 'system';
    const scope = `${req.method} ${req.routeOptions.url}:${actorKey}`;
    const requestHash = sha256(JSON.stringify({ body: req.body ?? null, params: req.params ?? null }));

    const result = await withTenant(actor.organizationId, async (trx) => {
      // purge expired record for this key so it can be reused after TTL
      await trx
        .deleteFrom('idempotency_keys')
        .where('scope', '=', scope)
        .where('key', '=', key)
        .where('expires_at', '<', new Date())
        .execute();
      const inserted = await trx
        .insertInto('idempotency_keys')
        .values({ organization_id: actor.organizationId, key, scope, request_hash: requestHash })
        .onConflict((oc) => oc.columns(['organization_id', 'scope', 'key']).doNothing())
        .returning('id')
        .executeTakeFirst();
      if (inserted) return { kind: 'new' as const, id: inserted.id };
      const existing = await trx
        .selectFrom('idempotency_keys')
        .selectAll()
        .where('scope', '=', scope)
        .where('key', '=', key)
        .executeTakeFirstOrThrow();
      return { kind: 'existing' as const, row: existing };
    });

    if (result.kind === 'new') {
      req.idempotencyRecordId = result.id;
      return;
    }
    const row = result.row;
    if (row.request_hash !== requestHash) {
      throw Errors.business('IDEMPOTENCY_KEY_REUSED', '同じIdempotency-Keyが異なるリクエストで使用されています');
    }
    if (row.state === 'in_progress') {
      throw Errors.conflict('IDEMPOTENCY_IN_PROGRESS', '同じリクエストを処理中です');
    }
    void reply
      .status(row.response_status ?? 200)
      .header('idempotent-replayed', 'true')
      .header('content-type', 'application/json; charset=utf-8')
      .send(JSON.stringify(row.response_body));
    return reply;
  });

  app.addHook('onSend', async (req: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    const id = req.idempotencyRecordId;
    const actor = req.actor;
    if (!id || !actor) return payload;
    req.idempotencyRecordId = undefined;
    await withTenant(actor.organizationId, async (trx) => {
      if (reply.statusCode >= 500) {
        await trx.deleteFrom('idempotency_keys').where('id', '=', id).execute();
        return;
      }
      let body: unknown = null;
      if (typeof payload === 'string') {
        try {
          body = JSON.parse(payload);
        } catch {
          body = payload;
        }
      }
      await trx
        .updateTable('idempotency_keys')
        .set({ state: 'completed', response_status: reply.statusCode, response_body: JSON.stringify(body) })
        .where('id', '=', id)
        .execute();
    });
    return payload;
  });
}

export default fp(idempotencyPlugin, { name: 'idempotency', dependencies: ['context'] });
