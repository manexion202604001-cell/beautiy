import { describe, expect, it } from 'vitest';
import {
  cleanCondition,
  describeRule,
  emptyState,
  fromRule,
  newCondition,
  newGroup,
  toRule,
  validateCondition,
  validateState,
  type BuilderState,
  type SegmentRule,
} from './segment-dsl';

const strip = (s: BuilderState | null) =>
  s && {
    match: s.match,
    items: s.items.map((i) =>
      i.kind === 'condition'
        ? { kind: i.kind, negate: i.negate, condition: i.condition }
        : {
            kind: i.kind,
            match: i.match,
            conditions: i.conditions.map((c) => ({ negate: c.negate, condition: c.condition })),
          },
    ),
  };

describe('segment builder ↔ DSL', () => {
  it('returns null for an empty builder', () => {
    expect(toRule(emptyState())).toBeNull();
  });

  it('converts a flat all-group (13.1 dormant example)', () => {
    const s: BuilderState = {
      match: 'all',
      items: [newCondition('last_visit_days_gt'), newCondition('no_future_appointment')],
    };
    expect(toRule(s)).toEqual({
      all: [{ type: 'last_visit_days_gt', days: 60 }, { type: 'no_future_appointment' }],
    });
  });

  it('converts nested groups and negation', () => {
    const g = newGroup('any', ['birthday_month', 'tag']);
    const tag = g.conditions[1]!;
    tag.condition = { type: 'tag', tagIds: ['t1', 't2'], match: 'any' };
    const optOut = newCondition('marketing_opt_in');
    optOut.negate = true;
    const s: BuilderState = { match: 'all', items: [g, optOut] };
    expect(toRule(s)).toEqual({
      all: [
        {
          any: [
            { type: 'birthday_month', month: 'current' },
            { type: 'tag', tagIds: ['t1', 't2'], match: 'any' },
          ],
        },
        { not: { type: 'marketing_opt_in', value: true } },
      ],
    });
  });

  it('skips empty groups', () => {
    const g = newGroup('any', []);
    expect(toRule({ match: 'any', items: [g, newCondition('no_review')] })).toEqual({
      any: [{ type: 'no_review' }],
    });
  });

  it('drops undefined optional fields', () => {
    expect(cleanCondition({ type: 'visit_count', gte: 3, lte: undefined })).toEqual({
      type: 'visit_count',
      gte: 3,
    });
    expect(
      toRule({
        match: 'all',
        items: [
          {
            kind: 'condition',
            id: 'x',
            negate: false,
            condition: { type: 'used_menu', menuIds: ['m'], withinDays: undefined },
          },
        ],
      }),
    ).toEqual({ all: [{ type: 'used_menu', menuIds: ['m'] }] });
  });

  it('round-trips rules through the builder', () => {
    const rules: SegmentRule[] = [
      { all: [{ type: 'last_visit_days_gt', days: 45 }, { type: 'no_future_appointment' }] },
      {
        any: [
          { type: 'ltv_top_percent', percent: 10 },
          { all: [{ type: 'visit_count', gte: 5 }, { not: { type: 'no_review' } }] },
        ],
      },
      { all: [{ not: { type: 'has_future_appointment' } }] },
    ];
    for (const r of rules) {
      const s = fromRule(r);
      expect(s).not.toBeNull();
      expect(toRule(s!)).toEqual(r);
    }
  });

  it('wraps a bare condition into an all-group', () => {
    const s = fromRule({ type: 'birthday_month', month: 'next' });
    expect(strip(s)).toEqual({
      match: 'all',
      items: [{ kind: 'condition', negate: false, condition: { type: 'birthday_month', month: 'next' } }],
    });
    expect(toRule(s!)).toEqual({ all: [{ type: 'birthday_month', month: 'next' }] });
  });

  it('rejects rules deeper than the visual editor supports', () => {
    expect(fromRule({ all: [{ any: [{ all: [{ type: 'no_review' }] }] }] })).toBeNull();
    expect(fromRule({ not: { all: [{ type: 'no_review' }] } })).toBeNull();
    expect(fromRule(null)).toBeNull();
    expect(fromRule('x')).toBeNull();
  });

  it('validates conditions like the API', () => {
    expect(validateCondition({ type: 'visit_count' })).toMatch(/下限または上限/);
    expect(validateCondition({ type: 'visit_count', gte: 5, lte: 2 })).toMatch(/下限は上限以下/);
    expect(validateCondition({ type: 'tag', tagIds: [] })).toMatch(/タグ/);
    expect(validateCondition({ type: 'ltv_top_percent', percent: 0 })).not.toBeNull();
    expect(validateCondition({ type: 'last_visit_days_gt', days: 1.5 })).not.toBeNull();
    expect(validateCondition({ type: 'last_visit_days_gt', days: 30 })).toBeNull();
    expect(validateState({ match: 'all', items: [newCondition('shop')] })).toHaveLength(1);
  });

  it('describes rules in Japanese', () => {
    expect(
      describeRule(
        { all: [{ type: 'last_visit_days_gt', days: 45 }, { any: [{ type: 'tag', tagIds: ['a'] }, { type: 'no_review' }] }] },
        { tags: new Map([['a', 'VIP']]) },
      ),
    ).toBe('最終来店45日超 かつ （タグ: VIP または 口コミ未投稿）');
  });
});
