import { requirePermission, type Ctx } from '../../auth/actor.js';
import { audit } from '../../lib/audit.js';
import { toCsv } from '../../lib/csv.js';

/**
 * CSV export of analytics reports (FR-10: CSVエクスポート). Requires export.data in addition to the
 * report permission, and is audited as export.csv (要件 2.1).
 */
type Header = { key: string; label: string };

export async function exportReportCsv(ctx: Ctx, kind: string, headers: Header[], rows: Record<string, unknown>[], filter: Record<string, unknown>) {
  requirePermission(ctx.actor, 'export.data');
  await audit(ctx, { action: 'export.csv', resourceType: 'analytics', metadata: { kind: `analytics.${kind}`, rowCount: rows.length, filter } });
  return toCsv(headers, rows);
}

const SHOP_SALES: Header[] = [
  { key: 'label', label: '区分' },
  { key: 'salesTotal', label: '純売上' },
  { key: 'serviceSales', label: '施術売上' },
  { key: 'productSales', label: '店販売上' },
  { key: 'discountTotal', label: '値引額' },
  { key: 'taxTotal', label: '消費税(内税)' },
  { key: 'refundTotal', label: '返金額' },
  { key: 'transactionCount', label: '会計件数' },
  { key: 'customerCount', label: '延べ客数' },
  { key: 'newCustomerCount', label: '新規客数' },
  { key: 'repeatCustomerCount', label: '再来客数' },
  { key: 'avgTicket', label: '客単価' },
  { key: 'nominatedRate', label: '指名率(%)' },
];

const STAFF_SALES: Header[] = [
  { key: 'label', label: '区分' },
  { key: 'salesTotal', label: '純売上' },
  { key: 'serviceSales', label: '施術売上' },
  { key: 'productSales', label: '店販売上' },
  { key: 'customerCount', label: '担当客数' },
  { key: 'newCustomerCount', label: '新規客数' },
  { key: 'nominatedCount', label: '指名数' },
  { key: 'avgTicket', label: '客単価' },
];

export function salesCsv(report: { level: 'shop' | 'staff'; rows: Record<string, unknown>[] }) {
  return { headers: report.level === 'shop' ? SHOP_SALES : STAFF_SALES, rows: report.rows };
}

export const STAFF_HEADERS: Header[] = [
  { key: 'staffName', label: 'スタッフ' },
  { key: 'salesTotal', label: '純売上' },
  { key: 'serviceSales', label: '施術売上' },
  { key: 'productSales', label: '店販売上' },
  { key: 'customerCount', label: '担当客数' },
  { key: 'newCustomerCount', label: '新規客数' },
  { key: 'nominatedCount', label: '指名数' },
  { key: 'nominatedRate', label: '指名率(%)' },
  { key: 'avgTicket', label: '客単価' },
  { key: 'bookedHours', label: '予約稼働時間(h)' },
  { key: 'scheduledHours', label: '勤務時間(h)' },
  { key: 'salesPerBookedHour', label: '稼働1時間あたり売上' },
  { key: 'salesPerScheduledHour', label: '勤務1時間あたり売上' },
  { key: 'utilization', label: '稼働率(%)' },
  { key: 'salesDelta', label: '売上前期比(%)' },
];

export const MENU_HEADERS: Header[] = [
  { key: 'menuName', label: 'メニュー' },
  { key: 'categoryName', label: 'カテゴリ' },
  { key: 'count', label: '件数' },
  { key: 'countShare', label: '件数構成比(%)' },
  { key: 'sales', label: '売上' },
  { key: 'salesShare', label: '売上構成比(%)' },
  { key: 'avgPrice', label: '平均単価' },
];

export const CATEGORY_HEADERS: Header[] = [
  { key: 'categoryName', label: 'カテゴリ' },
  { key: 'count', label: '件数' },
  { key: 'countShare', label: '件数構成比(%)' },
  { key: 'sales', label: '売上' },
  { key: 'salesShare', label: '売上構成比(%)' },
];

export const CHANNEL_HEADERS: Header[] = [
  { key: 'label', label: '予約経路' },
  { key: 'appointmentCount', label: '予約数' },
  { key: 'completedCount', label: '来店完了数' },
  { key: 'completionRate', label: '来店完了率(%)' },
  { key: 'sales', label: '売上' },
  { key: 'salesShare', label: '売上構成比(%)' },
  { key: 'salesDelta', label: '売上前期比(%)' },
];

export const CUSTOMER_HEADERS: Header[] = [
  { key: 'period', label: '期間' },
  { key: 'newCustomerVisits', label: '新規客数(店舗日別)' },
  { key: 'repeatCustomerVisits', label: '再来客数(店舗日別)' },
  { key: 'customerVisits', label: '延べ客数' },
];

export const REPEAT_HEADERS: Header[] = [
  { key: 'cohort', label: '初回来店期間' },
  { key: 'cohortSize', label: '新規客数' },
  { key: 'd30', label: '30日リピート率(%)' },
  { key: 'd60', label: '60日リピート率(%)' },
  { key: 'd90', label: '90日リピート率(%)' },
  { key: 'returnedEverRate', label: '再来店率(累計%)' },
];

export const LTV_HEADERS: Record<'source' | 'shop' | 'cohort' | 'top', Header[]> = {
  source: [
    { key: 'source', label: '来店きっかけ' },
    { key: 'customers', label: '顧客数' },
    { key: 'ltvAllTime', label: 'LTV(累計)' },
    { key: 'ltv12m', label: 'LTV(初回後12ヶ月)' },
    { key: 'maturedCustomers', label: '12ヶ月経過顧客数' },
    { key: 'avgVisits', label: '平均来店回数' },
    { key: 'avgTicket', label: '客単価' },
  ],
  shop: [
    { key: 'shopName', label: '初回来店店舗' },
    { key: 'customers', label: '顧客数' },
    { key: 'ltvAllTime', label: 'LTV(累計)' },
    { key: 'ltv12m', label: 'LTV(初回後12ヶ月)' },
    { key: 'avgVisits', label: '平均来店回数' },
  ],
  cohort: [
    { key: 'cohort', label: '初回来店月' },
    { key: 'customers', label: '顧客数' },
    { key: 'ltvAllTime', label: 'LTV(累計)' },
    { key: 'ltv12m', label: 'LTV(初回後12ヶ月)' },
    { key: 'avgVisits', label: '平均来店回数' },
  ],
  top: [
    { key: 'customerName', label: '顧客名' },
    { key: 'totalSales', label: '累計純売上' },
    { key: 'sales12m', label: '初回後12ヶ月売上' },
    { key: 'visits', label: '来店回数' },
    { key: 'firstVisitAt', label: '初回来店' },
    { key: 'lastVisitAt', label: '最終来店' },
  ],
};

export const DASHBOARD_HEADERS: Header[] = [
  { key: 'shopName', label: '店舗' },
  { key: 'appointments', label: '本日予約数' },
  { key: 'expectedSales', label: '見込売上' },
  { key: 'completedSales', label: '確定売上' },
  { key: 'newCustomers', label: '新規客数' },
  { key: 'cancellations', label: 'キャンセル' },
  { key: 'noShows', label: '無断キャンセル' },
  { key: 'mtdSales', label: '月初来売上' },
  { key: 'target', label: '月間目標' },
  { key: 'achievementRate', label: '達成率(%)' },
];
