/** Class list of a tab panel on the 設定 screens (shadcn TabsContent + the page's top margin) */
export const PANEL =
  'mt-6 ring-offset-background focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

/**
 * Column order of the 店舗割り当て table: shops whose name contains one of these come first, in this
 * order (the order the salon group lists its shops); the others keep their order after them.
 */
const SHOP_ORDER = ['渋谷', '青山', '表参道', '明治', '心斎橋', '福岡'];

export function sortShopsForAssignment<T extends { name: string }>(shops: T[]): T[] {
  const rank = (s: T) => SHOP_ORDER.findIndex((k) => s.name.includes(k));
  return [...shops].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra === -1 && rb === -1) return 0;
    if (ra === -1) return 1;
    if (rb === -1) return -1;
    return ra - rb;
  });
}

/** Staff of the chosen shop first (stable); unchanged when no shop is chosen */
export function sortStaffByShop<T extends { shops: { shop_id: string }[] }>(
  staff: T[],
  shopId: string | null,
): T[] {
  if (!shopId) return staff;
  const member = (s: T) => (s.shops.some((x) => x.shop_id === shopId) ? 1 : 0);
  return [...staff].sort((a, b) => member(b) - member(a));
}

/**
 * Shop ids and main shop after ticking / unticking one shop for a staff member: the main shop is
 * kept while it stays ticked, otherwise the first remaining shop takes over.
 */
export function nextAssignment(
  current: { shop_id: string; is_primary: boolean }[],
  shopId: string,
  assign: boolean,
): { shopIds: string[]; primaryShopId: string | undefined } {
  const ids = current.map((s) => s.shop_id);
  const shopIds = assign ? [...ids.filter((id) => id !== shopId), shopId] : ids.filter((id) => id !== shopId);
  const primary = current.find((s) => s.is_primary)?.shop_id;
  return { shopIds, primaryShopId: primary && shopIds.includes(primary) ? primary : shopIds[0] };
}
