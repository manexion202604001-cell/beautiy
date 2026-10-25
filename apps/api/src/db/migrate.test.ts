import { describe, expect, it } from 'vitest';
import { api } from '../test/helpers.js';
import { pendingMigrations } from './migrate.js';

describe('migration state', () => {
  it('reports no pending migrations once the test database is migrated, also on /v1/version', async () => {
    expect(await pendingMigrations()).toEqual([]);
    const res = await api().get('/v1/version');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ pendingMigrations: 0 });
  });
});
