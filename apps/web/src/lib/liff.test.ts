import { describe, expect, it } from 'vitest';
import { isLiffId, liffStateTarget, liffTargetLookup } from './liff';

describe('LIFF entry (liff.state)', () => {
  it('turns liff.state into a path of this site', () => {
    expect(liffStateTarget('/consent/honten?staff=s1&walkin=1')).toBe(
      '/consent/honten?staff=s1&walkin=1',
    );
    expect(liffStateTarget('/line/link?linkToken=abc&liffId=1-x')).toBe(
      '/line/link?linkToken=abc&liffId=1-x',
    );
    // a query-only account link and an endpoint of <WEB_BASE_URL>/liff
    expect(liffStateTarget('?linkToken=abc')).toBe('/line/link?linkToken=abc');
    expect(liffStateTarget('/liff/book/honten')).toBe('/book/honten');
    // never another site
    expect(liffStateTarget('//evil.example/x')).toBeNull();
    expect(liffStateTarget('https://evil.example/x')).toBeNull();
    expect(liffStateTarget('/\\evil.example')).toBeNull();
    expect(liffStateTarget(null)).toBeNull();
  });

  it('finds which LIFF app the target page belongs to', () => {
    expect(liffTargetLookup('/line/link?linkToken=abc&liffId=1650000000-abcDEF')).toEqual({
      liffId: '1650000000-abcDEF',
    });
    expect(liffTargetLookup('/consent/fein-omotesando?staff=s1&walkin=1')).toEqual({
      shop: 'fein-omotesando',
    });
    expect(liffTargetLookup('/book/honten')).toEqual({ shop: 'honten' });
    expect(liffTargetLookup('/my/honten')).toEqual({ shop: 'honten' });
    expect(liffTargetLookup('/line/link?linkToken=abc')).toEqual({ linkToken: 'abc' });
    expect(liffTargetLookup('/my')).toEqual({});
    expect(isLiffId('1650000000-abcDEF')).toBe(true);
    expect(isLiffId('javascript:alert(1)')).toBe(false);
  });
});
