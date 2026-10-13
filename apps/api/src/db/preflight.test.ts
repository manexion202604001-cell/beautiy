import { describe, expect, it } from 'vitest';
import { config } from '../config.js';
import {
  assertDatabaseReady,
  evaluateDatabase,
  inspectDatabase,
  type DatabaseFacts,
} from './preflight.js';

const ok: DatabaseFacts = {
  role: 'salon',
  superuser: false,
  bypassRls: false,
  database: 'salon',
  encoding: 'UTF8',
  ctype: 'en_US.UTF-8',
};

describe('database preflight', () => {
  it('accepts an ordinary role on a UTF-8 database', () => {
    for (const env of ['development', 'test', 'production'] as const)
      expect(evaluateDatabase(ok, env)).toEqual([]);
  });

  it('rejects roles that bypass RLS everywhere except development', () => {
    for (const facts of [
      { ...ok, superuser: true },
      { ...ok, bypassRls: true },
    ]) {
      expect(evaluateDatabase(facts, 'production')).toMatchObject([
        { code: 'rls_bypassed', fatal: true },
      ]);
      expect(evaluateDatabase(facts, 'test')).toMatchObject([
        { code: 'rls_bypassed', fatal: true },
      ]);
      expect(evaluateDatabase(facts, 'development')).toMatchObject([
        { code: 'rls_bypassed', fatal: false },
      ]);
    }
  });

  it('rejects a C / non-UTF-8 database in tests and warns elsewhere', () => {
    for (const facts of [
      { ...ok, ctype: 'C' },
      { ...ok, ctype: 'POSIX' },
      { ...ok, encoding: 'SQL_ASCII' },
    ]) {
      expect(evaluateDatabase(facts, 'test')).toMatchObject([
        { code: 'non_utf8_locale', fatal: true },
      ]);
      expect(evaluateDatabase(facts, 'production')).toMatchObject([
        { code: 'non_utf8_locale', fatal: false },
      ]);
    }
  });

  it('passes against the test database connection, even with production rules', async () => {
    const facts = await inspectDatabase(config.DATABASE_URL);
    expect(facts).toMatchObject({ superuser: false, bypassRls: false, encoding: 'UTF8' });
    const warnings: string[] = [];
    await assertDatabaseReady({ env: 'production', warn: (m) => warnings.push(m) });
    expect(warnings).toEqual([]);
  });

  it('fails outside development and only warns in development when the database is unreachable', async () => {
    const connectionString = 'postgres://salon:salon@127.0.0.1:1/salon';
    await expect(assertDatabaseReady({ connectionString, env: 'production' })).rejects.toThrow(
      /Database preflight failed/,
    );
    const warnings: string[] = [];
    await assertDatabaseReady({
      connectionString,
      env: 'development',
      warn: (m) => warnings.push(m),
    });
    expect(warnings).toHaveLength(1);
  });
});
