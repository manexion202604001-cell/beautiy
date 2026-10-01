import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api, downloadFile, type QueryValue } from '../lib/api';

/** Analytics reports (docs/kpi-definitions.md). All amounts are tax-included integer yen. */

export type CompareTo = 'previous_period' | 'previous_year' | 'none';
export type SalesGroupBy = 'day' | 'week' | 'month' | 'shop' | 'staff';

export interface ReportRange {
  from: string;
  to: string;
  days: number;
}

export interface BaseQuery {
  shopId?: string;
  from?: string;
  to?: string;
  compareTo?: CompareTo;
}

export interface SalesSummary {
  salesTotal: number;
  serviceSales: number;
  productSales: number;
  discountTotal?: number;
  taxTotal?: number;
  refundTotal?: number;
  transactionCount?: number;
  customerCount: number;
  newCustomerCount: number;
  repeatCustomerCount?: number;
  nominatedCount: number;
  avgTicket: number | null;
  avgTransactionValue?: number | null;
  nominatedRate: number | null;
  newCustomerRate?: number | null;
  // staff level
  bookedHours?: number;
  scheduledHours?: number;
  salesPerBookedHour?: number | null;
  salesPerScheduledHour?: number | null;
  utilization?: number | null;
}

export interface SalesRow extends SalesSummary {
  key: string;
  label: string;
  period?: string;
  shopId?: string;
  staffId?: string;
  previousSalesTotal?: number | null;
  salesDelta?: number | null;
}

export interface SalesReport {
  range: ReportRange;
  shopIds: string[];
  groupBy: SalesGroupBy;
  compareTo: CompareTo;
  level: 'shop' | 'staff';
  staffId?: string | null;
  summary: SalesSummary;
  comparison: {
    range: ReportRange;
    summary: SalesSummary;
    deltas: Record<string, number | null>;
  } | null;
  rows: SalesRow[];
}

export interface CustomerMetrics {
  visitors: number;
  newCustomers: number;
  repeatCustomers: number;
  lostCustomers: number;
  repeatRate: number | null;
}

export interface CustomersReport {
  range: ReportRange;
  lostThresholdDays: number;
  lostWindow: { from: string; to: string };
  summary: CustomerMetrics;
  comparison: {
    range: { from: string; to: string };
    summary: CustomerMetrics;
    deltas: Record<string, number | null>;
  } | null;
  visitCycle: {
    customers: number;
    multiVisitCustomers: number;
    singleVisitCustomers: number;
    avgCycleDays: number | null;
    medianCycleDays: number | null;
    buckets: { key: string; label: string; count: number; share: number | null }[];
  };
  rows: { period: string; newCustomerVisits: number; repeatCustomerVisits: number; customerVisits: number }[];
}

export interface RepeatWindow {
  eligible: number;
  returned: number;
  rate: number | null;
}
export interface RepeatRates {
  cohortSize: number;
  windows: Record<'d30' | 'd60' | 'd90', RepeatWindow>;
  returnedEver: number;
  returnedEverRate: number | null;
}

export interface RepeatRateReport {
  range: ReportRange;
  windows: number[];
  summary: RepeatRates;
  overallRepeatRate: { visitors: number; repeatCustomers: number; rate: number | null };
  comparison: { range: { from: string; to: string }; summary: RepeatRates } | null;
  cohorts: (RepeatRates & { cohort: string })[];
}

export interface LtvAgg {
  customers: number;
  totalSales: number;
  ltvAllTime: number | null;
  maturedCustomers: number;
  ltv12m: number | null;
  avgVisits: number | null;
  avgTicket: number | null;
}

export interface LtvReport {
  shopIds: string[];
  firstVisitRange: { from: string | null; to: string | null };
  asOf: string;
  summary: LtvAgg;
  bySource: (LtvAgg & { source: string })[];
  byShop: (LtvAgg & { shopId: string; shopName: string })[];
  byCohort: (LtvAgg & { cohort: string })[];
  topCustomers: {
    customerId: string;
    customerName: string;
    totalSales: number;
    sales12m: number;
    visits: number;
    firstVisitAt: string;
    lastVisitAt: string;
    acquisitionSource: string | null;
  }[];
}

export interface MenusReport {
  range: ReportRange;
  summary: { totalCount: number; totalSales: number };
  comparison: {
    range: ReportRange;
    summary: { totalCount: number; totalSales: number };
    deltas: { totalCount: number | null; totalSales: number | null };
  } | null;
  menus: {
    menuId: string;
    menuName: string;
    categoryId: string | null;
    categoryName: string;
    count: number;
    sales: number;
    countShare: number | null;
    salesShare: number | null;
    avgPrice: number | null;
    previousCount: number | null;
    previousSales: number | null;
    salesDelta: number | null;
  }[];
  categories: {
    categoryId: string | null;
    categoryName: string;
    count: number;
    sales: number;
    countShare: number | null;
    salesShare: number | null;
  }[];
}

export interface StaffRow extends SalesSummary {
  staffId: string;
  staffName: string;
  previous: {
    salesTotal: number;
    customerCount: number;
    nominatedRate: number | null;
    utilization: number | null;
  } | null;
  salesDelta: number | null;
}

export interface StaffReport {
  range: ReportRange;
  comparisonRange: ReportRange | null;
  ownOnly: boolean;
  rows: StaffRow[];
}

export interface ChannelsReport {
  range: ReportRange;
  comparisonRange: ReportRange | null;
  summary: { totalSales: number; totalAppointments: number };
  rows: {
    source: string;
    label: string;
    appointmentCount: number;
    completedCount: number;
    completionRate: number | null;
    appointmentShare: number | null;
    sales: number;
    salesShare: number | null;
    salesPerCompleted: number | null;
    previousSales: number | null;
    salesDelta: number | null;
  }[];
}

export interface DashboardReport {
  date: string;
  shops: {
    shopId: string;
    shopName: string;
    today: {
      appointments: number;
      expectedSales: number;
      completedSales: number;
      transactions: number;
      customers: number;
      newCustomers: number;
      cancellations: number;
      noShows: number;
    };
    monthToDate: {
      from: string;
      to: string;
      sales: number;
      customers: number;
      target: number | null;
      achievementRate: number | null;
      paceRate: number | null;
      remainingToTarget: number | null;
    };
  }[];
  total: {
    today: DashboardReport['shops'][number]['today'];
    monthToDate: { sales: number; target: number | null; achievementRate: number | null; paceRate: number | null };
  };
}

type Q = Record<string, QueryValue>;

export const analyticsApi = {
  sales: (q: BaseQuery & { groupBy?: SalesGroupBy; staffId?: string }) =>
    api.get<SalesReport>('/analytics/sales', q as Q),
  customers: (q: BaseQuery & { groupBy?: 'day' | 'week' | 'month'; lostThresholdDays?: number }) =>
    api.get<CustomersReport>('/analytics/customers', q as Q),
  repeatRate: (q: BaseQuery & { groupBy?: 'month' | 'week' }) =>
    api.get<RepeatRateReport>('/analytics/repeat-rate', q as Q),
  ltv: (q: { shopId?: string; from?: string; to?: string; top?: number }) =>
    api.get<LtvReport>('/analytics/ltv', q as Q),
  menus: (q: BaseQuery) => api.get<MenusReport>('/analytics/menus', q as Q),
  staff: (q: BaseQuery & { staffId?: string }) => api.get<StaffReport>('/analytics/staff', q as Q),
  channels: (q: BaseQuery) => api.get<ChannelsReport>('/analytics/channels', q as Q),
  dashboard: (q: { shopId?: string; date?: string }) =>
    api.get<DashboardReport>('/analytics/dashboard', q as Q),
  /** CSV export (export.data). `report` is the path segment after /analytics/ */
  csv: (report: string, q: Q) =>
    downloadFile(`/analytics/${report}`, { ...q, format: 'csv' }, `analytics-${report}.csv`),
  rebuild: (input: { shopId: string; from: string; to: string }) =>
    api.post<{ shopId: string; from: string; to: string; days: number; enqueued: number }>(
      '/analytics/rebuild',
      input,
    ),
};

export function useReport<T>(name: string, q: object, fn: () => Promise<T>, enabled = true) {
  return useQuery({
    queryKey: ['analytics', name, q],
    queryFn: fn,
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

export const SOURCE_LABEL: Record<string, string> = {
  web: 'Web予約',
  line: 'LINE予約',
  external: '外部予約媒体',
  phone: '電話',
  walk_in: '飛び込み',
  staff: 'スタッフ登録',
  none: '予約なし(直接会計)',
  referral: '紹介',
  instagram: 'Instagram',
  不明: '不明',
};
