import { describe, expect, it } from 'vitest';
import { compactNumber, formatDelta, labelStride, niceTicks, shortPeriod, xLabelIndices } from './scale';

describe('chart scale helpers', () => {
  it('builds clean ticks that include zero', () => {
    expect(niceTicks(0, 67100)).toEqual([0, 20000, 40000, 60000, 80000]);
    expect(niceTicks(-500, 1500)).toEqual([-500, 0, 500, 1000, 1500]);
    expect(niceTicks(0, 0)).toEqual([0, 1]);
  });

  it('never produces fractional ticks for counts', () => {
    expect(niceTicks(0, 2, 4, true)).toEqual([0, 1, 2]);
    expect(niceTicks(0, 3, 4, true)).toEqual([0, 1, 2, 3]);
  });

  it('formats compact Japanese numbers and deltas', () => {
    expect(compactNumber(1234)).toBe('1,234');
    expect(compactNumber(123456)).toBe('12.3万');
    expect(compactNumber(250_000_000)).toBe('2.5億');
    expect(formatDelta(12.34)).toBe('+12.3%');
    expect(formatDelta(-5)).toBe('−5.0%');
    expect(formatDelta(0)).toBe('±0%');
    expect(formatDelta(null)).toBe('—');
  });

  it('thins x labels and keeps the last one when it does not crowd', () => {
    expect(labelStride(30, 600)).toBe(3);
    expect([...xLabelIndices(10, 3)]).toEqual([0, 3, 6, 9]);
    expect([...xLabelIndices(11, 3)]).toEqual([0, 3, 6, 9]);
    expect([...xLabelIndices(12, 3)]).toEqual([0, 3, 6, 9, 11]);
  });

  it('shortens period keys', () => {
    expect(shortPeriod('2026-09-14')).toBe('9/14');
    expect(shortPeriod('2026-09')).toBe('9月');
    expect(shortPeriod('web')).toBe('web');
  });
});
