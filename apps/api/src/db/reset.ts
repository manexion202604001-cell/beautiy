/** Development helper: drop and recreate the public schema, then migrate. Refuses in production. */
import pg from 'pg';
import { config } from '../config.js';
import { migrate } from './migrate.js';

export async function resetDatabase(connectionString = config.DATABASE_URL, log: (m: string) => void = console.log) {
  if (config.NODE_ENV === 'production') throw new Error('db:reset is disabled in production');
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
  } finally {
    await client.end();
  }
  await migrate(connectionString, log);
}

if (process.argv[1]?.endsWith('reset.ts') || process.argv[1]?.endsWith('reset.js')) {
  resetDatabase()
    .then(() => console.log('database reset complete'))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
