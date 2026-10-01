/**
 * Segment rule DSL (mirrors apps/api/src/modules/messaging/segments.ts) and the visual builder model.
 *
 *   rule  := condition | { all: rule[] } | { any: rule[] } | { not: rule }
 *
 * The builder edits a two-level structure: a root group (all/any) whose items are conditions
 * (optionally negated) or nested groups of conditions. Rules outside that shape (deeper nesting,
 * negated groups) cannot be edited visually → `fromRule` returns null and the UI falls back to JSON.
 */

export type BirthdayMonth = 'current' | 'next' | number;

export type SegmentCondition =
  | { type: 'last_visit_days_gt'; days: number }
  | { type: 'last_visit_days_lte'; days: number }
  | { type: 'no_future_appointment' }
  | { type: 'has_future_appointment' }
  | { type: 'first_visit_within_days_without_return'; days: number; windowElapsed?: boolean }
  | { type: 'ltv_top_percent'; percent: number }
  | { type: 'used_menu'; menuIds: string[]; withinDays?: number }
  | { type: 'birthday_month'; month?: BirthdayMonth }
  | { type: 'primary_staff'; staffIds: string[] }
  | { type: 'shop'; shopIds: string[] }
  | { type: 'tag'; tagIds: string[]; match?: 'any' | 'all' }
  | { type: 'visit_count'; gte?: number; lte?: number }
  | { type: 'no_review'; withinDays?: number }
  | { type: 'marketing_opt_in'; value?: boolean };

export type ConditionType = SegmentCondition['type'];

export type SegmentRule =
  | SegmentCondition
  | { all: SegmentRule[] }
  | { any: SegmentRule[] }
  | { not: SegmentRule };

export type Match = 'all' | 'any';

export interface BuilderCondition {
  kind: 'condition';
  id: string;
  negate: boolean;
  condition: SegmentCondition;
}

export interface BuilderGroup {
  kind: 'group';
  id: string;
  match: Match;
  conditions: BuilderCondition[];
}

export interface BuilderState {
  match: Match;
  items: (BuilderCondition | BuilderGroup)[];
}

export const CONDITION_TYPES: { type: ConditionType; label: string; hint?: string }[] = [
  { type: 'last_visit_days_gt', label: '最終来店からN日以上経過', hint: '来店履歴のない顧客は含みません' },
  { type: 'last_visit_days_lte', label: '最終来店からN日以内' },
  { type: 'no_future_appointment', label: '次回予約なし' },
  { type: 'has_future_appointment', label: '次回予約あり' },
  { type: 'first_visit_within_days_without_return', label: '初回来店のみ・再来なし' },
  { type: 'ltv_top_percent', label: '累計売上(LTV)上位N%' },
  { type: 'used_menu', label: '特定メニューの利用' },
  { type: 'birthday_month', label: '誕生月' },
  { type: 'primary_staff', label: '担当スタッフ' },
  { type: 'shop', label: '店舗' },
  { type: 'tag', label: 'タグ' },
  { type: 'visit_count', label: '来店回数' },
  { type: 'no_review', label: '口コミ未投稿' },
  { type: 'marketing_opt_in', label: '配信許可' },
];

export const CONDITION_LABEL = Object.fromEntries(
  CONDITION_TYPES.map((c) => [c.type, c.label]),
) as Record<ConditionType, string>;

let seq = 0;
export function newId(prefix = 'n'): string {
  seq += 1;
  return `${prefix}${seq}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Sensible defaults for a newly added condition */
export function defaultCondition(type: ConditionType): SegmentCondition {
  switch (type) {
    case 'last_visit_days_gt':
      return { type, days: 60 };
    case 'last_visit_days_lte':
      return { type, days: 30 };
    case 'first_visit_within_days_without_return':
      return { type, days: 60, windowElapsed: true };
    case 'ltv_top_percent':
      return { type, percent: 20 };
    case 'used_menu':
      return { type, menuIds: [] };
    case 'birthday_month':
      return { type, month: 'current' };
    case 'primary_staff':
      return { type, staffIds: [] };
    case 'shop':
      return { type, shopIds: [] };
    case 'tag':
      return { type, tagIds: [], match: 'any' };
    case 'visit_count':
      return { type, gte: 2 };
    case 'no_review':
      return { type };
    case 'marketing_opt_in':
      return { type, value: true };
    case 'no_future_appointment':
    case 'has_future_appointment':
      return { type };
  }
}

export function newCondition(type: ConditionType): BuilderCondition {
  return { kind: 'condition', id: newId('c'), negate: false, condition: defaultCondition(type) };
}

export function newGroup(match: Match = 'any', types: ConditionType[] = ['tag']): BuilderGroup {
  return { kind: 'group', id: newId('g'), match, conditions: types.map(newCondition) };
}

export function emptyState(): BuilderState {
  return { match: 'all', items: [] };
}

export function isCondition(r: unknown): r is SegmentCondition {
  return !!r && typeof r === 'object' && typeof (r as { type?: unknown }).type === 'string';
}

/** Drop undefined/empty optional props so the API's strict schemas accept the condition */
export function cleanCondition(c: SegmentCondition): SegmentCondition {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c)) {
    if (v === undefined || v === null || (typeof v === 'number' && Number.isNaN(v))) continue;
    out[k] = v;
  }
  return out as unknown as SegmentCondition;
}

function wrap(c: BuilderCondition): SegmentRule {
  const cond = cleanCondition(c.condition);
  return c.negate ? { not: cond } : cond;
}

/** Builder → DSL. Returns null when there is nothing to evaluate. */
export function toRule(state: BuilderState): SegmentRule | null {
  const parts: SegmentRule[] = [];
  for (const item of state.items) {
    if (item.kind === 'condition') parts.push(wrap(item));
    else {
      const inner = item.conditions.map(wrap);
      if (!inner.length) continue;
      parts.push(item.match === 'all' ? { all: inner } : { any: inner });
    }
  }
  if (!parts.length) return null;
  return state.match === 'all' ? { all: parts } : { any: parts };
}

function toBuilderCondition(r: SegmentRule): BuilderCondition | null {
  if (isCondition(r)) return { kind: 'condition', id: newId('c'), negate: false, condition: r };
  if ('not' in r && isCondition(r.not)) {
    return { kind: 'condition', id: newId('c'), negate: true, condition: r.not };
  }
  return null;
}

/** DSL → builder. null = not representable in the visual editor (use the JSON editor). */
export function fromRule(rule: unknown): BuilderState | null {
  if (!rule || typeof rule !== 'object') return null;
  const r = rule as SegmentRule;
  const single = toBuilderCondition(r);
  if (single) return { match: 'all', items: [single] };
  const match: Match | null = 'all' in r ? 'all' : 'any' in r ? 'any' : null;
  if (!match) return null;
  const children = (r as Record<Match, SegmentRule[]>)[match];
  if (!Array.isArray(children)) return null;
  const items: BuilderState['items'] = [];
  for (const child of children) {
    const c = toBuilderCondition(child);
    if (c) {
      items.push(c);
      continue;
    }
    const gm: Match | null = 'all' in child ? 'all' : 'any' in child ? 'any' : null;
    if (!gm) return null;
    const conds: BuilderCondition[] = [];
    for (const gc of (child as Record<Match, SegmentRule[]>)[gm]) {
      const bc = toBuilderCondition(gc);
      if (!bc) return null;
      conds.push(bc);
    }
    items.push({ kind: 'group', id: newId('g'), match: gm, conditions: conds });
  }
  return { match, items };
}

/** Client-side validation mirroring the API's zod rules (Japanese messages) */
export function validateCondition(c: SegmentCondition): string | null {
  const intOk = (n: unknown, min = 0, max = 36500) =>
    typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max;
  switch (c.type) {
    case 'last_visit_days_gt':
    case 'last_visit_days_lte':
    case 'first_visit_within_days_without_return':
      return intOk(c.days) ? null : '日数を0以上の整数で入力してください';
    case 'ltv_top_percent':
      return typeof c.percent === 'number' && c.percent >= 0.1 && c.percent <= 100
        ? null
        : '0.1〜100の範囲で入力してください';
    case 'used_menu':
      if (!c.menuIds.length) return 'メニューを1つ以上選択してください';
      return c.withinDays === undefined || intOk(c.withinDays) ? null : '期間の日数が不正です';
    case 'primary_staff':
      return c.staffIds.length ? null : 'スタッフを1人以上選択してください';
    case 'shop':
      return c.shopIds.length ? null : '店舗を1つ以上選択してください';
    case 'tag':
      return c.tagIds.length ? null : 'タグを1つ以上選択してください';
    case 'visit_count':
      if (c.gte === undefined && c.lte === undefined) return '下限または上限を入力してください';
      if (c.gte !== undefined && !intOk(c.gte, 0, 1e9)) return '下限が不正です';
      if (c.lte !== undefined && !intOk(c.lte, 0, 1e9)) return '上限が不正です';
      if (c.gte !== undefined && c.lte !== undefined && c.gte > c.lte)
        return '下限は上限以下にしてください';
      return null;
    case 'no_review':
      return c.withinDays === undefined || intOk(c.withinDays) ? null : '期間の日数が不正です';
    default:
      return null;
  }
}

export function validateState(state: BuilderState): string[] {
  const errors: string[] = [];
  const all = state.items.flatMap((i) => (i.kind === 'condition' ? [i] : i.conditions));
  for (const c of all) {
    const e = validateCondition(c.condition);
    if (e) errors.push(`${CONDITION_LABEL[c.condition.type]}: ${e}`);
  }
  return errors;
}

/** Short human-readable summary of a rule (lists, confirmations) */
export function describeRule(
  rule: unknown,
  names: { menus?: Map<string, string>; staff?: Map<string, string>; shops?: Map<string, string>; tags?: Map<string, string> } = {},
): string {
  if (!rule || typeof rule !== 'object') return '—';
  const r = rule as SegmentRule;
  const list = (ids: string[], m?: Map<string, string>) =>
    ids.map((id) => m?.get(id) ?? '（不明）').join('・');
  if ('all' in r) return r.all.map((x) => wrapParen(describeRule(x, names), x)).join(' かつ ');
  if ('any' in r) return r.any.map((x) => wrapParen(describeRule(x, names), x)).join(' または ');
  if ('not' in r) return `NOT(${describeRule(r.not, names)})`;
  const c = r;
  switch (c.type) {
    case 'last_visit_days_gt':
      return `最終来店${c.days}日超`;
    case 'last_visit_days_lte':
      return `最終来店${c.days}日以内`;
    case 'no_future_appointment':
      return '次回予約なし';
    case 'has_future_appointment':
      return '次回予約あり';
    case 'first_visit_within_days_without_return':
      return c.windowElapsed === false
        ? `初回来店から${c.days}日以内・未再来`
        : `初回来店から${c.days}日以上・未再来`;
    case 'ltv_top_percent':
      return `LTV上位${c.percent}%`;
    case 'used_menu':
      return `メニュー利用: ${list(c.menuIds, names.menus)}${c.withinDays !== undefined ? `（${c.withinDays}日以内）` : ''}`;
    case 'birthday_month':
      return `誕生月: ${c.month === 'next' ? '来月' : typeof c.month === 'number' ? `${c.month}月` : '今月'}`;
    case 'primary_staff':
      return `担当: ${list(c.staffIds, names.staff)}`;
    case 'shop':
      return `店舗: ${list(c.shopIds, names.shops)}`;
    case 'tag':
      return `タグ${c.match === 'all' ? '(すべて)' : ''}: ${list(c.tagIds, names.tags)}`;
    case 'visit_count':
      return `来店回数 ${c.gte !== undefined ? `${c.gte}回以上` : ''}${c.lte !== undefined ? `${c.lte}回以下` : ''}`;
    case 'no_review':
      return c.withinDays !== undefined ? `直近${c.withinDays}日 口コミなし` : '口コミ未投稿';
    case 'marketing_opt_in':
      return c.value === false ? '配信拒否' : '配信許可あり';
  }
}

function wrapParen(text: string, r: SegmentRule): string {
  return !isCondition(r) && !('not' in r) ? `（${text}）` : text;
}
