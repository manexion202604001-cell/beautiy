import { describe, expect, it } from 'vitest';
import { monthGrid } from './time';

describe('monthGrid', () => {
  it('lays out whole Sunday-first weeks around the month', () => {
    const oct = monthGrid('2026-10-13');
    expect(oct).toHaveLength(5);
    expect(oct.every((w) => w.length === 7)).toBe(true);
    expect(oct[0]![0]).toBe('2026-09-27'); // Sunday before Thu 1 Oct
    expect(oct[0]![4]).toBe('2026-10-01');
    expect(oct[4]![6]).toBe('2026-10-31'); // the 31st is a Saturday
  });

  it('handles months that start on Sunday or need six weeks', () => {
    const feb = monthGrid('2026-02-10'); // 1 Feb 2026 is a Sunday, 28 days → exactly 4 weeks
    expect(feb).toHaveLength(4);
    expect(feb[0]![0]).toBe('2026-02-01');
    expect(feb[3]![6]).toBe('2026-02-28');
    const aug = monthGrid('2026-08-31'); // starts on Saturday, 31 days → 6 weeks
    expect(aug).toHaveLength(6);
    expect(aug[0]![6]).toBe('2026-08-01');
    expect(aug[5]![1]).toBe('2026-08-31');
    expect(aug[5]![6]).toBe('2026-09-05');
  });
});
