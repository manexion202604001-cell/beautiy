import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api, downloadFile, newIdempotencyKey } from '../lib/api';
import type { TaxBucket } from '../lib/money';
import type { Page } from './types';

// ---------------------------------------------------------------- types (snake_case rows from the API)

export type TransactionStatus =
  'draft' | 'completed' | 'voided' | 'refunded' | 'partially_refunded';

export type ItemType =
  'service' | 'product' | 'nomination_fee' | 'discount' | 'coupon' | 'adjustment';
export type StaffRole = 'main' | 'assistant' | 'referral';
export type PaymentMethod = 'cash' | 'card' | 'emoney' | 'qr' | 'custom' | 'point' | 'online';

export interface ItemStaff {
  id: string;
  staff_id: string;
  staff_name: string;
  role: StaffRole;
  share_bp: number;
  is_nominated: boolean;
  allocated_amount: number;
}

export interface TransactionItem {
  id: string;
  item_type: ItemType;
  menu_id: string | null;
  product_id: string | null;
  coupon_id: string | null;
  name: string;
  quantity: number;
  unit_price: number;
  line_discount: number;
  tax_rate_bp: number;
  amount: number;
  allocated_discount: number;
  net_amount: number;
  tax_amount: number;
  returned_quantity: number;
  sort_order: number;
  details: Record<string, unknown>;
  staff: ItemStaff[];
}

export interface TxPayment {
  id: string;
  method: PaymentMethod;
  custom_method_id: string | null;
  custom_method_name: string | null;
  provider: string | null;
  amount: number;
  tendered_amount: number | null;
  change_amount: number;
  refunded_amount: number;
  status:
    | 'pending'
    | 'requires_action'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
    | 'refunded'
    | 'partially_refunded';
  client_secret: string | null;
  failure_code: string | null;
  succeeded_at: string | null;
  created_at: string;
}

export interface TxRefund {
  id: string;
  payment_id: string;
  method: PaymentMethod;
  amount: number;
  reason: string | null;
  status: string;
  created_at: string;
}

export interface TxReceipt {
  id: string;
  receipt_number: string;
  receipt_type: 'receipt' | 'invoice';
  addressee: string | null;
  reissue_of: string | null;
  issued_at: string;
}

export interface Transaction {
  id: string;
  shop_id: string;
  appointment_id: string | null;
  customer_id: string | null;
  customer_name: string | null;
  customer_point_balance: number | null;
  staff_id: string | null;
  staff_name: string | null;
  is_nominated: boolean;
  status: TransactionStatus;
  transaction_number: string | null;
  subtotal: number;
  discount_total: number;
  tax_total: number;
  total: number;
  tax_breakdown: Record<string, TaxBucket>;
  paid_total: number;
  change_total: number;
  refunded_total: number;
  point_used: number;
  point_earned: number;
  is_new_customer: boolean | null;
  note: string | null;
  register_session_id: string | null;
  completed_at: string | null;
  voided_at: string | null;
  void_reason: string | null;
  created_at: string;
  updated_at: string;
  version: number;
  items: TransactionItem[];
  payments: TxPayment[];
  refunds: TxRefund[];
  receipts: TxReceipt[];
  outstanding: number;
  warnings?: string[];
  stockWarnings?: { productId: string; name: string; quantity: number }[];
  replayed?: boolean;
}

export interface TransactionListItem {
  id: string;
  shop_id: string;
  transaction_number: string | null;
  status: TransactionStatus;
  appointment_id: string | null;
  customer_id: string | null;
  customer_name: string | null;
  staff_id: string | null;
  staff_name: string | null;
  is_nominated: boolean;
  subtotal: number;
  discount_total: number;
  tax_total: number;
  total: number;
  paid_total: number;
  refunded_total: number;
  point_earned: number;
  point_used: number;
  is_new_customer: boolean | null;
  completed_at: string | null;
  voided_at: string | null;
  created_at: string;
  version: number;
}

/** Line input for PUT /transactions/:id/items */
export interface ItemInput {
  type: ItemType;
  menuId?: string;
  productId?: string;
  couponId?: string;
  name?: string;
  quantity?: number;
  unitPrice?: number;
  taxRateBp?: number;
  lineDiscount?: number;
  lineDiscountPercent?: number;
  amount?: number;
  percent?: number;
  staff?: { staffId: string; shareBp: number; role: StaffRole; isNominated: boolean }[];
}

export interface CashMovement {
  id: string;
  movement_type: 'pay_in' | 'pay_out';
  amount: number;
  reason: string;
  staff_id: string | null;
  created_at: string;
}

export interface RegisterSummary {
  openingCash: number;
  cashSales: number;
  cashRefunds: number;
  payIn: number;
  payOut: number;
  sales: number;
  transactionCount: number;
  voidedCount: number;
  openDrafts: number;
  byMethod: Record<string, number>;
  customMethods: Record<string, number>;
  refundsByMethod: Record<string, number>;
  byStaff: { staffId: string; name: string; amount: number; transactions: number }[];
}

export interface RegisterSession {
  id: string;
  shop_id: string;
  status: 'open' | 'closed';
  opened_at: string;
  opened_by: string;
  opening_cash: number;
  closed_at: string | null;
  closed_by: string | null;
  expected_cash: number | null;
  counted_cash: number | null;
  difference: number | null;
  cash_breakdown: Record<string, number> | null;
  summary: RegisterSummary | null;
  note: string | null;
  movements?: CashMovement[];
}

export interface CustomPaymentMethod {
  id: string;
  shop_id: string | null;
  name: string;
  is_active: boolean;
  counts_as_sales: boolean;
}

export interface DailyReportStaffRow {
  staffId: string;
  name: string;
  sales: number;
  serviceSales: number;
  productSales: number;
  transactions: number;
  nominatedCount: number;
  newCustomers: number;
}

export type DailyReport =
  | { scope: 'own'; shopId: string; date: string; byStaff: DailyReportStaffRow[] }
  | {
      scope: 'shop';
      shopId: string;
      date: string;
      totals: {
        transactionCount: number;
        subtotal: number;
        discountTotal: number;
        grossSales: number;
        refundTotal: number;
        netSales: number;
        taxTotal: number;
        pointsUsed: number;
        pointsEarned: number;
        averageSpend: number;
      };
      customers: { new: number; repeat: number; walkIn: number; nominated: number };
      taxByRate: Record<string, TaxBucket>;
      byMethod: { method: string; label: string; amount: number; count: number }[];
      refunds: { method: string; amount: number; transactions: number }[];
      voided: { count: number; amount: number };
      byStaff: DailyReportStaffRow[];
      register: {
        id: string;
        status: string;
        opened_at: string;
        closed_at: string | null;
        opening_cash: number;
        expected_cash: number | null;
        counted_cash: number | null;
        difference: number | null;
      }[];
      registerDifference: number;
    };

export interface TransactionQuery {
  shopId?: string;
  from?: string;
  to?: string;
  status?: TransactionStatus | TransactionStatus[];
  customerId?: string;
  staffId?: string;
  limit?: number;
}

export interface AddPaymentInput {
  method: Exclude<PaymentMethod, 'online'>;
  amount?: number;
  tenderedAmount?: number;
  customMethodId?: string;
  online?: boolean;
  note?: string;
}

// ---------------------------------------------------------------- endpoints

export const posApi = {
  currentRegister: (shopId: string) =>
    api.get<{ session: RegisterSession | null }>('/register-sessions/current', { shopId }),
  registerSessions: (q: {
    shopId: string;
    from?: string;
    to?: string;
    cursor?: string;
    limit?: number;
  }) => api.get<Page<RegisterSession>>('/register-sessions', { ...q }),
  openRegister: (
    input: { shopId: string; openingCash: number; note?: string },
    key = newIdempotencyKey(),
  ) => api.post<RegisterSession>('/register-sessions/open', input, { idempotencyKey: key }),
  cashMovement: (
    id: string,
    input: { type: 'pay_in' | 'pay_out'; amount: number; reason: string },
    key = newIdempotencyKey(),
  ) =>
    api.post<CashMovement>(`/register-sessions/${id}/cash-movements`, input, {
      idempotencyKey: key,
    }),
  closeRegister: (
    id: string,
    input: { countedCash?: number; cashBreakdown?: Record<string, number>; note?: string },
    key = newIdempotencyKey(),
  ) => api.post<RegisterSession>(`/register-sessions/${id}/close`, input, { idempotencyKey: key }),

  list: (q: TransactionQuery & { cursor?: string }) =>
    api.get<Page<TransactionListItem>>('/transactions', { ...q }),
  exportCsv: (q: TransactionQuery, kind: 'transactions' | 'items' = 'transactions') =>
    downloadFile(
      kind === 'items' ? '/transaction-items/export.csv' : '/transactions/export.csv',
      { ...q, limit: undefined },
      kind === 'items' ? 'transaction-items.csv' : 'transactions.csv',
    ),
  get: (id: string) => api.get<Transaction>(`/transactions/${id}`),
  create: (
    input: {
      shopId: string;
      appointmentId?: string;
      customerId?: string;
      staffId?: string;
      isNominated?: boolean;
      note?: string;
    },
    key = newIdempotencyKey(),
  ) => api.post<Transaction>('/transactions', input, { idempotencyKey: key }),
  replaceItems: (
    id: string,
    input: {
      version: number;
      items: ItemInput[];
      staffId?: string | null;
      isNominated?: boolean;
      customerId?: string | null;
      note?: string | null;
    },
  ) => api.put<Transaction>(`/transactions/${id}/items`, input),
  setPoints: (id: string, use: number, key = newIdempotencyKey()) =>
    api.post<Transaction>(`/transactions/${id}/points`, { use }, { idempotencyKey: key }),
  addPayment: (id: string, input: AddPaymentInput, key = newIdempotencyKey()) =>
    api.post<{ paymentId: string; replayed: boolean; change?: number; transaction: Transaction }>(
      `/transactions/${id}/payments`,
      { ...input, idempotencyKey: key },
      { idempotencyKey: key },
    ),
  removePayment: (id: string, paymentId: string) =>
    api.delete<Transaction>(`/transactions/${id}/payments/${paymentId}`),
  complete: (id: string, key = newIdempotencyKey()) =>
    api.post<Transaction>(`/transactions/${id}/complete`, {}, { idempotencyKey: key }),
  void: (id: string, reason: string, key = newIdempotencyKey()) =>
    api.post<Transaction>(`/transactions/${id}/void`, { reason }, { idempotencyKey: key }),
  refund: (
    id: string,
    input: {
      amount: number;
      reason: string;
      paymentId?: string;
      restockItems?: { itemId: string; quantity: number }[];
    },
    key = newIdempotencyKey(),
  ) =>
    api.post<Transaction>(
      `/transactions/${id}/refunds`,
      { ...input, idempotencyKey: key },
      { idempotencyKey: key },
    ),
  issueReceipt: (
    id: string,
    input: { type: 'receipt' | 'invoice'; addressee?: string; proviso?: string },
    key = newIdempotencyKey(),
  ) => api.post<TxReceipt>(`/transactions/${id}/receipts`, input, { idempotencyKey: key }),
  dailyReport: (shopId: string, date: string) =>
    api.get<DailyReport>('/pos/daily-report', { shopId, date }),
  customMethods: (shopId?: string) =>
    api.get<CustomPaymentMethod[]>('/payment-methods/custom', { shopId }),
  mockCompletePayment: (paymentId: string, success = true) =>
    api.post(`/payments/${paymentId}/mock-complete`, { success }),
};

export const posKeys = {
  all: ['pos'] as const,
  register: (shopId: string) => ['pos', 'register', shopId] as const,
  registerHistory: (shopId: string) => ['pos', 'register-history', shopId] as const,
  list: (q: TransactionQuery) => ['pos', 'transactions', q] as const,
  detail: (id: string) => ['pos', 'transaction', id] as const,
  daily: (shopId: string, date: string) => ['pos', 'daily', shopId, date] as const,
  customMethods: (shopId?: string) => ['pos', 'custom-methods', shopId ?? null] as const,
};

export function useCurrentRegister(shopId: string | null | undefined) {
  return useQuery({
    queryKey: posKeys.register(shopId ?? ''),
    queryFn: () => posApi.currentRegister(shopId!),
    enabled: !!shopId,
    refetchInterval: 60_000,
  });
}

export function useTransactions(q: TransactionQuery, enabled = true) {
  return useInfiniteQuery({
    queryKey: posKeys.list(q),
    queryFn: ({ pageParam }) => posApi.list({ ...q, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
  });
}

export function useTransaction(id: string | null | undefined) {
  return useQuery({
    queryKey: posKeys.detail(id ?? ''),
    queryFn: () => posApi.get(id!),
    enabled: !!id,
  });
}

export function useDailyReport(shopId: string | null | undefined, date: string) {
  return useQuery({
    queryKey: posKeys.daily(shopId ?? '', date),
    queryFn: () => posApi.dailyReport(shopId!, date),
    enabled: !!shopId,
  });
}

export function useCustomMethods(shopId: string | null | undefined) {
  return useQuery({
    queryKey: posKeys.customMethods(shopId ?? undefined),
    queryFn: () => posApi.customMethods(shopId ?? undefined),
    enabled: !!shopId,
    staleTime: 5 * 60_000,
  });
}

// ---------------------------------------------------------------- labels

export const TX_STATUS_LABEL: Record<TransactionStatus, string> = {
  draft: '会計中',
  completed: '完了',
  voided: '取消',
  refunded: '返金済',
  partially_refunded: '一部返金',
};

export const TX_STATUS_TONE: Record<
  TransactionStatus,
  'warning' | 'success' | 'neutral' | 'danger' | 'info'
> = {
  draft: 'warning',
  completed: 'success',
  voided: 'neutral',
  refunded: 'danger',
  partially_refunded: 'info',
};

export const METHOD_LABEL: Record<string, string> = {
  cash: '現金',
  card: 'クレジットカード',
  emoney: '電子マネー',
  qr: 'QR決済',
  custom: '店舗独自決済',
  point: 'ポイント',
  online: 'オンライン決済',
};

export const ITEM_TYPE_LABEL: Record<ItemType, string> = {
  service: '施術',
  product: '商品',
  nomination_fee: '指名料',
  discount: '値引',
  coupon: 'クーポン',
  adjustment: '調整',
};

export const ROLE_LABEL: Record<StaffRole, string> = {
  main: 'メイン',
  assistant: 'アシスタント',
  referral: '紹介',
};

/**
 * Stored transaction lines → editable inputs for PUT /items (round-trips the API representation:
 * percent line discounts are kept in details, negative adjustments are stored as discount rows).
 */
export function itemsToInputs(items: TransactionItem[]): ItemInput[] {
  return [...items]
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((i): ItemInput => {
      const staff = i.staff.length
        ? i.staff.map((s) => ({
            staffId: s.staff_id,
            shareBp: s.share_bp,
            role: s.role,
            isNominated: s.is_nominated,
          }))
        : undefined;
      const pct = Number(i.details?.lineDiscountPercent ?? 0) || 0;
      const gross = i.unit_price * i.quantity;
      const pctAmount = pct ? Math.floor((gross * pct) / 100) : 0;
      const yenDiscount = Math.max(0, i.line_discount - pctAmount);
      const lineFields = {
        ...(yenDiscount ? { lineDiscount: yenDiscount } : {}),
        ...(pct ? { lineDiscountPercent: pct } : {}),
      };
      switch (i.item_type) {
        case 'service':
          return {
            type: 'service',
            ...(i.menu_id ? { menuId: i.menu_id } : {}),
            name: i.name,
            quantity: i.quantity,
            unitPrice: i.unit_price,
            taxRateBp: i.tax_rate_bp,
            ...lineFields,
            staff,
          };
        case 'product':
          return {
            type: 'product',
            productId: i.product_id!,
            name: i.name,
            quantity: i.quantity,
            unitPrice: i.unit_price,
            taxRateBp: i.tax_rate_bp,
            ...lineFields,
            staff,
          };
        case 'nomination_fee':
          return {
            type: 'nomination_fee',
            name: i.name,
            quantity: i.quantity,
            unitPrice: i.unit_price,
            taxRateBp: i.tax_rate_bp,
            staff,
          };
        case 'coupon':
          return { type: 'coupon', couponId: i.coupon_id!, quantity: 1 };
        case 'discount': {
          const percent = Number(i.details?.percent ?? 0) || 0;
          if (percent) return { type: 'discount', name: i.name, percent };
          const amount = Number(i.details?.amount ?? -i.amount) || 0;
          return { type: 'discount', name: i.name, amount };
        }
        case 'adjustment':
          return {
            type: 'adjustment',
            name: i.name,
            quantity: 1,
            unitPrice: i.unit_price,
            taxRateBp: i.tax_rate_bp || undefined,
          };
      }
    });
}
