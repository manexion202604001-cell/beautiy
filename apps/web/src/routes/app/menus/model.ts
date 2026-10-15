import type { EffectiveMenu, MenuCategory } from '../../../api/types';

/** Separator between the parent and the child part of a category name (「まつげ：上」) */
export const CATEGORY_SEPARATOR = '：';

/** Group name shown for menus without a category */
export const NO_CATEGORY = 'その他';

/** Dot colour of a category that has none */
export const DEFAULT_CATEGORY_COLOR = '#6B7280';

/** 「まつげ：上」 → 「まつげ」: menus are grouped by the part of the category name before 「：」 */
export function groupOfCategory(name: string | null | undefined): string {
  const full = name || NO_CATEGORY;
  const i = full.indexOf(CATEGORY_SEPARATOR);
  return i > 0 ? full.substring(0, i) : full;
}

/** 「まつげ：上」 → 「上」 (the whole name when it has no parent part) */
export function childLabel(name: string): string {
  return name.includes(CATEGORY_SEPARATOR)
    ? name.split(CATEGORY_SEPARATOR).slice(1).join(CATEGORY_SEPARATOR)
    : name;
}

export const isCoupon = (m: Pick<EffectiveMenu, 'menuType'>) => m.menuType === 'coupon';

/** 掲載 = bookable in this shop (not switched off, not hidden by the shop's override) */
export const isListed = (m: Pick<EffectiveMenu, 'status'>) => m.status === 'active';

/** Menus keyed by their category group, in the order the groups first appear */
export function groupMenus<T extends Pick<EffectiveMenu, 'categoryName'>>(menus: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const m of menus) {
    const g = groupOfCategory(m.categoryName);
    const list = groups.get(g);
    if (list) list.push(m);
    else groups.set(g, [m]);
  }
  return groups;
}

/** Colour of a group: the category named like the group, else the category of its first menu */
export function groupColor(
  group: string,
  menus: Pick<EffectiveMenu, 'categoryName'>[],
  colors: Map<string, string | null>,
): string {
  return colors.get(group) || colors.get(menus[0]?.categoryName ?? '') || DEFAULT_CATEGORY_COLOR;
}

export function colorByCategoryName(categories: MenuCategory[] | undefined): Map<string, string | null> {
  return new Map((categories ?? []).map((c) => [c.name, c.color]));
}

export const COUPON_TYPE_LABEL = { all: '全員', new: '新規', repeat: '再来' } as const;

export function couponTypeLabel(t: EffectiveMenu['couponType']): string {
  return t === 'new' ? '新規' : t === 'repeat' ? '再来' : '全員';
}

/** Pill colours of the coupon type badge */
export function couponTypeClass(t: EffectiveMenu['couponType']): string {
  return t === 'new'
    ? 'bg-blue-100 text-blue-700'
    : t === 'repeat'
      ? 'bg-green-100 text-green-700'
      : 'bg-orange-100 text-orange-700';
}
