import { assertDatabaseReady } from '../db/preflight.js';
import { resetDatabase } from '../db/reset.js';

export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://salon:salon@localhost:5432/salon_test';
  process.env.NODE_ENV = 'test';
  // a superuser / BYPASSRLS role would make every tenant-isolation test meaningless
  await assertDatabaseReady({ connectionString: url, env: 'test' });
  await resetDatabase(url, () => {});
}
