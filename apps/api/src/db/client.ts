import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { config } from '../config.js';
import type { DB } from './types.js';

// Return DATE columns as plain 'YYYY-MM-DD' strings (no timezone shifting)
pg.types.setTypeParser(1082, (v: string) => v);
// BIGINT -> number (amounts are well within 2^53)
pg.types.setTypeParser(20, (v: string) => Number(v));
// NUMERIC -> number
pg.types.setTypeParser(1700, (v: string) => Number(v));

export function createPool(connectionString = config.DATABASE_URL) {
  return new pg.Pool({ connectionString, max: config.DATABASE_POOL_MAX });
}

export function createDb(pool: pg.Pool = createPool()) {
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}

export const db = createDb();
export type Database = Kysely<DB>;
