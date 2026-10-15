import { describe, expect, it } from 'vitest';
import { nextAssignment, sortShopsForAssignment, sortStaffByShop } from './shared';

describe('設定 › スタッフ管理 helpers', () => {
  it('orders shop columns by the known area names, others after them in their own order', () => {
    const names = ['福岡店', '本店', '表参道店', '渋谷店', '別館', '青山店'].map((name) => ({ name }));
    expect(sortShopsForAssignment(names).map((s) => s.name)).toEqual([
      '渋谷店',
      '青山店',
      '表参道店',
      '福岡店',
      '本店',
      '別館',
    ]);
  });

  it('lists the staff of the chosen shop first without reordering the rest', () => {
    const staff = [
      { id: 'a', shops: [{ shop_id: 's1' }] },
      { id: 'b', shops: [{ shop_id: 's2' }] },
      { id: 'c', shops: [] },
      { id: 'd', shops: [{ shop_id: 's1' }, { shop_id: 's2' }] },
    ];
    expect(sortStaffByShop(staff, 's2').map((s) => s.id)).toEqual(['b', 'd', 'a', 'c']);
    expect(sortStaffByShop(staff, null)).toBe(staff);
  });

  it('keeps the main shop while it stays ticked and hands it over otherwise', () => {
    const current = [
      { shop_id: 's1', is_primary: true },
      { shop_id: 's2', is_primary: false },
    ];
    expect(nextAssignment(current, 's3', true)).toEqual({
      shopIds: ['s1', 's2', 's3'],
      primaryShopId: 's1',
    });
    expect(nextAssignment(current, 's1', false)).toEqual({ shopIds: ['s2'], primaryShopId: 's2' });
    expect(nextAssignment([{ shop_id: 's1', is_primary: true }], 's1', false)).toEqual({
      shopIds: [],
      primaryShopId: undefined,
    });
    expect(nextAssignment([], 's1', true)).toEqual({ shopIds: ['s1'], primaryShopId: 's1' });
  });
});
