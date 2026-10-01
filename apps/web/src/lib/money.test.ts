import { describe, expect, it } from 'vitest';
import {
  appliedCash,
  bpToPercentText,
  changeFor,
  cleanBreakdown,
  evenShares,
  includedTax,
  inclusivePrice,
  parseYen,
  percentTextToBp,
  sumDenominations,
  taxBreakdownRows,
  taxRateText,
  tenderSuggestions,
} from './money';

describe('tax display', () => {
  it('labels tax rates (reduced rate marked)', () => {
    expect(taxRateText(1000)).toBe('10%');
    expect(taxRateText('800')).toBe('8%（軽減）');
    expect(taxRateText(800, { reducedMark: false })).toBe('8%');
    expect(taxRateText(0)).toBe('非課税');
  });

  it('builds sorted per-rate rows and drops empty buckets', () => {
    const rows = taxBreakdownRows({
      '800': { taxable: 1080, tax: 80 },
      '1000': { taxable: 11000, tax: 1000 },
      '0': { taxable: 0, tax: 0 },
    });
    expect(rows.map((r) => r.rateBp)).toEqual([1000, 800]);
    expect(rows[0]).toMatchObject({ label: '10%対象', taxable: 11000, tax: 1000, net: 10000 });
    expect(rows[1]!.label).toBe('8%（軽減）対象');
    expect(taxBreakdownRows(null)).toEqual([]);
  });

  it('computes included tax and inclusive prices (floor)', () => {
    expect(includedTax(11000, 1000)).toBe(1000);
    expect(includedTax(1080, 800)).toBe(80);
    expect(includedTax(999, 1000)).toBe(90);
    expect(includedTax(500, 0)).toBe(0);
    expect(inclusivePrice(1000, false, 1000)).toBe(1100);
    expect(inclusivePrice(999, false, 800)).toBe(1078);
    expect(inclusivePrice(1100, true, 1000)).toBe(1100);
  });
});

describe('cash handling', () => {
  it('calculates change and applied amounts', () => {
    expect(changeFor(10000, 8250)).toBe(1750);
    expect(changeFor(5000, 8250)).toBe(0);
    expect(appliedCash(10000, 8250)).toBe(8250);
    expect(appliedCash(5000, 8250)).toBe(5000);
    expect(appliedCash(5000, 0)).toBe(0);
  });

  it('suggests tender amounts', () => {
    expect(tenderSuggestions(8250)).toEqual([8250, 9000, 10000]);
    expect(tenderSuggestions(10000)).toEqual([10000]);
    expect(tenderSuggestions(0)).toEqual([]);
  });

  it('sums denominations and cleans the breakdown payload', () => {
    expect(sumDenominations({ '10000': 2, '1000': '3', '500': 1, '1': 7 })).toBe(23507);
    expect(sumDenominations({ abc: 3, '100': -1, '50': '' })).toBe(0);
    expect(cleanBreakdown({ '10000': 2, '5000': 0, '1000': '4', x: 3 })).toEqual({
      '10000': 2,
      '1000': 4,
    });
  });
});

describe('staff shares & parsing', () => {
  it('splits 100% evenly', () => {
    expect(evenShares(1)).toEqual([10000]);
    expect(evenShares(3)).toEqual([3334, 3333, 3333]);
    expect(evenShares(3).reduce((a, b) => a + b, 0)).toBe(10000);
    expect(evenShares(0)).toEqual([]);
  });

  it('converts percent text and bp', () => {
    expect(bpToPercentText(3333)).toBe('33.33');
    expect(bpToPercentText(5000)).toBe('50');
    expect(percentTextToBp('33.33')).toBe(3333);
    expect(percentTextToBp('101')).toBeNull();
    expect(percentTextToBp('')).toBeNull();
  });

  it('parses yen inputs', () => {
    expect(parseYen('1,200')).toBe(1200);
    expect(parseYen('¥１２００')).toBe(1200);
    expect(parseYen('-500')).toBe(-500);
    expect(parseYen('12a')).toBeNull();
    expect(parseYen('')).toBeNull();
  });
});
