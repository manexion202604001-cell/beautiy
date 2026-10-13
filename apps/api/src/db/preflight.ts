/**
 * Database preflight: checks that the connection cannot silently weaken the application.
 *
 * - Tenant isolation is enforced by row-level security (migration 0090). PostgreSQL skips every
 *   policy for superusers and BYPASSRLS roles — FORCE ROW LEVEL SECURITY does not change that —
 *   so the application must connect as an ordinary role.
 * - Customer duplicate detection uses pg_trgm, which ignores non-ASCII letters when the database
 *   LC_CTYPE is C / POSIX (kana and kanji names then never match).
 *
 * Run at API / worker startup and in the test global-setup. Not run by migrate.ts: the migration
 * role may legitimately be more privileged than the application role.
 */
import pg from 'pg';
import { config, type Config } from '../config.js';

export interface DatabaseFacts {
  role: string;
  superuser: boolean;
  bypassRls: boolean;
  database: string;
  encoding: string;
  ctype: string;
}

export interface PreflightIssue {
  code: 'rls_bypassed' | 'non_utf8_locale';
  /** fatal issues abort startup; the others are reported as warnings */
  fatal: boolean;
  message: string;
}

export async function inspectDatabase(
  connectionString = config.DATABASE_URL,
): Promise<DatabaseFacts> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const { rows } = await client.query<DatabaseFacts>(
      `SELECT r.rolname AS role, r.rolsuper AS superuser, r.rolbypassrls AS "bypassRls",
              d.datname AS database, pg_encoding_to_char(d.encoding) AS encoding, d.datctype AS ctype
       FROM pg_roles r, pg_database d
       WHERE r.rolname = current_user AND d.datname = current_database()`,
    );
    if (!rows[0]) throw new Error('could not read the attributes of the connected role');
    return rows[0];
  } finally {
    await client.end();
  }
}

export function evaluateDatabase(
  facts: DatabaseFacts,
  env: Config['NODE_ENV'] = config.NODE_ENV,
): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  if (facts.superuser || facts.bypassRls) {
    const attribute = facts.superuser ? 'a SUPERUSER' : 'a BYPASSRLS role';
    issues.push({
      code: 'rls_bypassed',
      fatal: env !== 'development',
      message:
        `Database role "${facts.role}" is ${attribute}: PostgreSQL bypasses row-level security for it, so tenant isolation is NOT enforced. ` +
        'Connect as an ordinary role (NOSUPERUSER NOBYPASSRLS) that owns the database — see infra/postgres-init.sql.',
    });
  }
  if (facts.encoding !== 'UTF8' || facts.ctype === 'C' || facts.ctype === 'POSIX') {
    issues.push({
      code: 'non_utf8_locale',
      fatal: env === 'test',
      message:
        `Database "${facts.database}" uses encoding ${facts.encoding} / LC_CTYPE "${facts.ctype}": pg_trgm ignores non-ASCII letters there, so similarity-based ` +
        "duplicate detection misses kana / kanji names. Create the database with a UTF-8 locale (TEMPLATE template0 ENCODING 'UTF8' LOCALE 'en_US.UTF-8').",
    });
  }
  return issues;
}

/**
 * Throws on fatal issues and reports the rest through `warn`. In development nothing is fatal
 * (an unreachable database is reported as a warning too) so local work is never blocked.
 */
export async function assertDatabaseReady(
  opts: {
    connectionString?: string;
    env?: Config['NODE_ENV'];
    warn?: (message: string) => void;
  } = {},
): Promise<void> {
  const env = opts.env ?? config.NODE_ENV;
  const warn = opts.warn ?? ((message: string) => console.warn(message));
  let facts: DatabaseFacts;
  try {
    facts = await inspectDatabase(opts.connectionString);
  } catch (err) {
    if (env !== 'development')
      throw new Error(`Database preflight failed: ${(err as Error).message}`, { cause: err });
    warn(`Database preflight skipped: ${(err as Error).message}`);
    return;
  }
  const issues = evaluateDatabase(facts, env);
  for (const issue of issues.filter((i) => !i.fatal)) warn(issue.message);
  const fatal = issues.filter((i) => i.fatal);
  if (fatal.length > 0)
    throw new Error(`Database preflight failed:\n${fatal.map((i) => `- ${i.message}`).join('\n')}`);
}
