import { resetDatabase } from '../db/reset.js';

export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://salon:salon@localhost:5432/salon_test';
  process.env.NODE_ENV = 'test';
  await resetDatabase(url, () => {});
}
