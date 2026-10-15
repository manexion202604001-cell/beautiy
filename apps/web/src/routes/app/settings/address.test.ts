import { describe, expect, it } from 'vitest';
import { addressOf, splitAddress } from './address';

describe('one-line shop address', () => {
  it('joins the three stored parts', () => {
    expect(addressOf({ prefecture: '東京都', city: '渋谷区', address_line: '神南1-2-3' })).toBe(
      '東京都渋谷区神南1-2-3',
    );
    expect(addressOf({ prefecture: null, city: null, address_line: '東京都新宿区1-1' })).toBe(
      '東京都新宿区1-1',
    );
    expect(addressOf({ prefecture: null, city: null, address_line: null })).toBe('');
  });

  it('keeps prefecture and city when the edited line still starts with them', () => {
    expect(splitAddress(' 東京都渋谷区神南9-9-9 ', { prefecture: '東京都', city: '渋谷区' })).toEqual({
      prefecture: '東京都',
      city: '渋谷区',
      addressLine: '神南9-9-9',
    });
    expect(splitAddress('東京都港区青山1-1', { prefecture: '東京都', city: '渋谷区' })).toEqual({
      prefecture: '東京都',
      city: null,
      addressLine: '港区青山1-1',
    });
  });

  it('stores a different or first-time address whole in the address line', () => {
    expect(splitAddress('大阪府大阪市中央区1-1', { prefecture: '東京都', city: '渋谷区' })).toEqual({
      prefecture: null,
      city: null,
      addressLine: '大阪府大阪市中央区1-1',
    });
    expect(splitAddress('東京都新宿区1-1', { prefecture: null, city: null })).toEqual({
      prefecture: null,
      city: null,
      addressLine: '東京都新宿区1-1',
    });
    expect(splitAddress('  ', { prefecture: '東京都', city: '渋谷区' })).toEqual({
      prefecture: null,
      city: null,
      addressLine: null,
    });
  });
});
