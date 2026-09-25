// Message templating and segment evaluation (pure).

export const TEMPLATE_VARIABLES: Record<string, string> = {
  customer_name: 'お客様のお名前',
  shop_name: '店舗名',
  staff_name: '担当者名',
  date: '予約日',
  time: '予約時刻',
  menu: 'メニュー',
  manage_url: '予約変更・キャンセルURL',
  booking_url: '予約ページURL',
  review_url: '口コミURL',
  karte_url: 'カルテ共有URL',
  days_since: '前回来店からの日数',
};

export function renderTemplate(body: string, vars: Record<string, string | number | null | undefined>): string {
  return body.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, k: string) => {
    const v = vars[k];
    return v === undefined || v === null ? '' : String(v);
  });
}

export interface Segment {
  tagIds?: string[];
  lastVisitDaysMin?: number;
  lastVisitDaysMax?: number;
  minVisits?: number;
  staffId?: string;
  favorite?: boolean;
  shopId?: string;
}

export interface SegmentCustomer {
  tagIds: string[];
  lastVisitAt: number | null;
  visitCount: number;
  assignedStaffId: string | null;
  favorite: boolean;
  primaryShopId: string | null;
}

export function matchesSegment(c: SegmentCustomer, s: Segment, now: number): boolean {
  if (s.tagIds?.length && !s.tagIds.some((t) => c.tagIds.includes(t))) return false;
  if (s.minVisits && c.visitCount < s.minVisits) return false;
  if (s.staffId && c.assignedStaffId !== s.staffId) return false;
  if (s.favorite && !c.favorite) return false;
  if (s.shopId && c.primaryShopId !== s.shopId) return false;
  if (s.lastVisitDaysMin !== undefined || s.lastVisitDaysMax !== undefined) {
    if (c.lastVisitAt === null) return false;
    const days = (now - c.lastVisitAt) / 86400000;
    if (s.lastVisitDaysMin !== undefined && days < s.lastVisitDaysMin) return false;
    if (s.lastVisitDaysMax !== undefined && days > s.lastVisitDaysMax) return false;
  }
  return true;
}

/** Exponential backoff with cap, used for message and sync retries. */
export function backoffMs(attempt: number, baseMs = 30_000, capMs = 6 * 3600_000): number {
  return Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
}

export const MAX_SYNC_ATTEMPTS = 6;
