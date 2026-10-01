import { afterAll } from 'vitest';
import { db } from '../db/client.js';

afterAll(async () => {
  await db.destroy();
});
