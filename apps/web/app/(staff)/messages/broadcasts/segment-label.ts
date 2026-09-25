import type { Segment } from '@salonos/core';

export function describeSegment(s: Segment, maps: { tags: Map<string, string>; staff: Map<string, string>; shops: Map<string, string> }): string[] {
  const out: string[] = [];
  if (s.shopId) out.push(`店舗: ${maps.shops.get(s.shopId) ?? '不明'}`);
  if (s.tagIds?.length) out.push(`タグ: ${s.tagIds.map((t) => maps.tags.get(t) ?? '削除済み').join(' / ')}`);
  if (s.lastVisitDaysMin !== undefined || s.lastVisitDaysMax !== undefined) {
    out.push(`最終来店: ${s.lastVisitDaysMin ?? 0}日前〜${s.lastVisitDaysMax !== undefined ? `${s.lastVisitDaysMax}日前` : ''}`);
  }
  if (s.minVisits) out.push(`来店${s.minVisits}回以上`);
  if (s.staffId) out.push(`担当: ${maps.staff.get(s.staffId) ?? '不明'}`);
  if (s.favorite) out.push('お気に入り');
  return out.length ? out : ['全顧客'];
}
