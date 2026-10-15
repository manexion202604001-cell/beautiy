import { describe, expect, it } from 'vitest';
import { createTenant } from '../../test/helpers.js';

describe('catalog', () => {
  it('stores a calendar colour on menu categories', async () => {
    const t = await createTenant();
    const created = await t.owner.post('/v1/menu-categories', { name: 'まつげ', color: '#EAB308' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'まつげ', color: '#EAB308' });

    const plain = await t.owner.post('/v1/menu-categories', { name: 'ネイル' });
    expect(plain.body.color).toBeNull();

    // renaming alone keeps the colour; null clears it
    const renamed = await t.owner.patch(`/v1/menu-categories/${created.body.id}`, { name: 'アイ' });
    expect(renamed.body).toMatchObject({ name: 'アイ', color: '#EAB308' });
    const cleared = await t.owner.patch(`/v1/menu-categories/${created.body.id}`, { color: null });
    expect(cleared.body.color).toBeNull();

    expect((await t.owner.post('/v1/menu-categories', { name: '不正', color: 'red' })).status).toBe(400);
    const list = await t.owner.get('/v1/menu-categories');
    expect(list.body.map((c: { name: string; color: string | null }) => [c.name, c.color])).toEqual(
      expect.arrayContaining([
        ['アイ', null],
        ['ネイル', null],
      ]),
    );
  });
});
