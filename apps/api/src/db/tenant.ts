import { sql, type Kysely, type Transaction } from 'kysely';
import { fromPgError } from '../lib/errors.js';
import { db as defaultDb } from './client.js';
import type { DB } from './types.js';

export type Tx = Transaction<DB>;

export interface TxOptions {
  userId?: string | null;
  traceId?: string | null;
  isolation?: 'read committed' | 'repeatable read' | 'serializable';
  db?: Kysely<DB>;
}

async function setContext(trx: Tx, settings: Record<string, string | null | undefined>) {
  const entries = Object.entries(settings).filter(([, v]) => v !== undefined && v !== null) as [string, string][];
  if (entries.length === 0) return;
  // one round-trip for all settings
  const parts = entries.map(([k, v]) => sql`set_config(${k}, ${v}, true)`);
  await sql`SELECT ${sql.join(parts)}`.execute(trx);
}

/**
 * Run fn inside a transaction scoped to one tenant. RLS policies restrict every
 * statement to rows where organization_id = organizationId.
 */
export async function withTenant<T>(organizationId: string, fn: (trx: Tx) => Promise<T>, opts: TxOptions = {}): Promise<T> {
  const database = opts.db ?? defaultDb;
  try {
    let builder = database.transaction();
    if (opts.isolation) builder = builder.setIsolationLevel(opts.isolation);
    return await builder.execute(async (trx) => {
      await setContext(trx, {
        'app.organization_id': organizationId,
        'app.user_id': opts.userId ?? undefined,
        'app.trace_id': opts.traceId ?? undefined,
      });
      return fn(trx);
    });
  } catch (err) {
    throw fromPgError(err) ?? err;
  }
}

/**
 * Cross-tenant system transaction (RLS bypass). Only for: auth lookups, public slug
 * resolution, webhook routing, job claiming, migrations. Never expose to request handlers directly.
 */
export async function withSystem<T>(fn: (trx: Tx) => Promise<T>, opts: TxOptions = {}): Promise<T> {
  const database = opts.db ?? defaultDb;
  try {
    return await database.transaction().execute(async (trx) => {
      await setContext(trx, { 'app.bypass_rls': 'on', 'app.trace_id': opts.traceId ?? undefined });
      return fn(trx);
    });
  } catch (err) {
    throw fromPgError(err) ?? err;
  }
}

/** Retry a function on serialization/deadlock failures */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== 'CONCURRENT_UPDATE' && code !== '40001' && code !== '40P01') throw err;
      lastErr = err;
      await new Promise((r) => setTimeout(r, 20 * 2 ** i + Math.random() * 20));
    }
  }
  throw lastErr;
}
