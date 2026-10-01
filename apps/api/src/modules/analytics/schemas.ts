import { z } from 'zod';
import { isoDate, uuid } from '../../lib/schemas.js';

export const compareToSchema = z.enum(['previous_period', 'previous_year', 'none']);
export const formatSchema = z.enum(['json', 'csv']).default('json');

/** Common report query: shop scope + local date range (both inclusive, shop TZ) + comparison */
export const baseReportQuery = z.object({
  shopId: uuid.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  compareTo: compareToSchema.default('previous_period'),
  format: formatSchema,
});

export const salesQuery = baseReportQuery.extend({
  groupBy: z.enum(['day', 'week', 'month', 'shop', 'staff']).default('day'),
  staffId: uuid.optional(),
});
export type SalesQuery = z.infer<typeof salesQuery>;

export const customersQuery = baseReportQuery.extend({
  groupBy: z.enum(['day', 'week', 'month']).default('month'),
  lostThresholdDays: z.coerce.number().int().min(14).max(730).default(90),
});
export type CustomersQuery = z.infer<typeof customersQuery>;

export const repeatRateQuery = baseReportQuery.extend({
  groupBy: z.enum(['month', 'week']).default('month'),
});
export type RepeatRateQuery = z.infer<typeof repeatRateQuery>;

export const ltvQuery = z.object({
  shopId: uuid.optional(),
  /** first-visit (acquisition) date range filter; omitted = all customers */
  from: isoDate.optional(),
  to: isoDate.optional(),
  top: z.coerce.number().int().min(0).max(100).default(20),
  format: formatSchema,
  /** CSV only: which table to export */
  csvTable: z.enum(['source', 'shop', 'cohort', 'top']).default('source'),
});
export type LtvQuery = z.infer<typeof ltvQuery>;

export const menusQuery = baseReportQuery.extend({
  csvTable: z.enum(['menu', 'category']).default('menu'),
});
export type MenusQuery = z.infer<typeof menusQuery>;

export const staffQuery = baseReportQuery.extend({ staffId: uuid.optional() });
export type StaffQuery = z.infer<typeof staffQuery>;

export const channelsQuery = baseReportQuery;
export type ChannelsQuery = z.infer<typeof channelsQuery>;

export const dashboardQuery = z.object({
  shopId: uuid.optional(),
  date: isoDate.optional(),
  format: formatSchema,
});
export type DashboardQuery = z.infer<typeof dashboardQuery>;

export const rebuildBody = z.object({
  shopId: uuid,
  from: isoDate,
  to: isoDate,
});
export type RebuildBody = z.infer<typeof rebuildBody>;
