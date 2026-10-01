import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api, newIdempotencyKey } from '../lib/api';
import type { TaxBucket } from '../lib/money';
import type { Page } from './types';

// ---------------------------------------------------------------- staff side

export interface ProductStock {
  shop_id: string | null;
  quantity: number;
  reorder_point: number | null;
}

export interface Product {
  id: string;
  shop_id: string | null;
  sku: string | null;
  barcode: string | null;
  name: string;
  brand: string | null;
  category: string | null;
  description: string | null;
  price: number;
  price_tax_included: boolean;
  cost: number | null;
  tax_rate_bp: number;
  image_file_ids: string[];
  is_online: boolean;
  stock_managed: boolean;
  status: 'active' | 'inactive';
  created_at: string;
  updated_at: string;
  price_inclusive: number;
  stocks: ProductStock[];
  images?: { fileId: string; url: string }[];
}

export interface ProductInput {
  shopId?: string | null;
  sku?: string | null;
  barcode?: string | null;
  name?: string;
  brand?: string | null;
  category?: string | null;
  description?: string | null;
  price?: number;
  priceTaxIncluded?: boolean;
  cost?: number | null;
  taxRateBp?: number;
  imageFileIds?: string[];
  isOnline?: boolean;
  stockManaged?: boolean;
  status?: 'active' | 'inactive';
}

export interface ProductQuery {
  q?: string;
  shopId?: string;
  category?: string;
  barcode?: string;
  isOnline?: boolean;
  status?: 'active' | 'inactive';
  limit?: number;
}

export interface StockMovement {
  id: string;
  shop_id: string | null;
  shop_name: string | null;
  delta: number;
  reason: string;
  order_id: string | null;
  transaction_id: string | null;
  note: string | null;
  created_by: string | null;
  created_at: string;
}

export interface StockView {
  productId: string;
  stockManaged: boolean;
  locations: (ProductStock & { location: string; low: boolean })[];
  total: number;
  movements: StockMovement[];
}

export interface LowStockRow {
  product_id: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  shop_id: string | null;
  shop_name: string | null;
  quantity: number;
  reorder_point: number | null;
  location: string;
  shortage: number;
}

export type OrderStatus =
  'pending' | 'paid' | 'processing' | 'shipped' | 'delivered' | 'cancelled' | 'refunded';

export interface ShippingAddress {
  postalCode: string;
  prefecture: string;
  city: string;
  line1: string;
  line2?: string;
  name: string;
  phone: string;
}

export interface OrderRow {
  id: string;
  shop_id: string | null;
  customer_id: string | null;
  customer_name?: string | null;
  order_number: string;
  channel: string;
  status: OrderStatus;
  subtotal: number;
  shipping_fee: number;
  discount_total: number;
  tax_total: number;
  total: number;
  refunded_amount: number;
  shipping_address: ShippingAddress | null;
  contact_email: string | null;
  contact_phone: string | null;
  attributed_staff_id: string | null;
  referral_link_id: string | null;
  carrier: string | null;
  tracking_number: string | null;
  payment_attempts: number;
  payment_failed_at: string | null;
  expires_at: string | null;
  paid_at: string | null;
  shipped_at: string | null;
  delivered_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  note: string | null;
  created_at: string;
}

export interface OrderDetail extends OrderRow {
  items: {
    product_id: string;
    name: string;
    unit_price: number;
    quantity: number;
    tax_rate_bp: number;
    tax_amount: number;
    amount: number;
  }[];
  payments: {
    id: string;
    method: string;
    provider: string | null;
    amount: number;
    refunded_amount: number;
    status: string;
    failure_code: string | null;
    created_at: string;
  }[];
  attributed_staff: { id: string; display_name: string } | null;
  customer: { id: string; display_name: string } | null;
}

export interface SalesRow {
  productId?: string | null;
  staffId?: string | null;
  name: string;
  online: { quantity: number; amount: number; orders: number };
  store: { quantity: number; amount: number; transactions: number };
  quantity: number;
  total: number;
}

export interface SalesReport {
  from: string;
  to: string;
  groupBy: 'product' | 'staff';
  rows: SalesRow[];
  totals: { online: number; store: number; total: number };
}

export const commerceApi = {
  products: (q: ProductQuery & { cursor?: string }) =>
    api.get<Page<Product>>('/products', { ...q }),
  product: (id: string) => api.get<Product>(`/products/${id}`),
  createProduct: (input: ProductInput, key = newIdempotencyKey()) =>
    api.post<Product>('/products', input, { idempotencyKey: key }),
  updateProduct: (id: string, input: ProductInput) => api.patch<Product>(`/products/${id}`, input),
  deleteProduct: (id: string) => api.delete(`/products/${id}`),
  stock: (id: string) => api.get<StockView>(`/products/${id}/stock`),
  adjustStock: (
    id: string,
    input: {
      shopId: string | null;
      delta: number;
      reason: 'receive' | 'adjust' | 'transfer' | 'return';
      toShopId?: string | null;
      note?: string;
    },
    key = newIdempotencyKey(),
  ) => api.post<StockView>(`/products/${id}/stock-adjustments`, input, { idempotencyKey: key }),
  stockSettings: (id: string, input: { shopId: string | null; reorderPoint: number | null }) =>
    api.put<StockView>(`/products/${id}/stock-settings`, input),
  lowStock: (shopId?: string) => api.get<LowStockRow[]>('/products/low-stock', { shopId }),
  share: (id: string, input: { customerId: string; message?: string }, key = newIdempotencyKey()) =>
    api.post<{
      url: string;
      referralLinkId: string;
      referralCode: string;
      messageId: string | null;
    }>(`/products/${id}/share`, input, { idempotencyKey: key }),
  orders: (q: {
    status?: OrderStatus;
    customerId?: string;
    shopId?: string;
    from?: string;
    to?: string;
    cursor?: string;
    limit?: number;
  }) => api.get<Page<OrderRow>>('/orders', { ...q }),
  order: (id: string) => api.get<OrderDetail>(`/orders/${id}`),
  processOrder: (id: string, key = newIdempotencyKey()) =>
    api.post<OrderDetail>(`/orders/${id}/process`, {}, { idempotencyKey: key }),
  shipOrder: (
    id: string,
    input: { carrier: string; trackingNumber: string },
    key = newIdempotencyKey(),
  ) => api.post<OrderDetail>(`/orders/${id}/ship`, input, { idempotencyKey: key }),
  deliverOrder: (id: string, key = newIdempotencyKey()) =>
    api.post<OrderDetail>(`/orders/${id}/deliver`, {}, { idempotencyKey: key }),
  cancelOrder: (id: string, reason: string, key = newIdempotencyKey()) =>
    api.post<OrderDetail>(`/orders/${id}/cancel`, { reason }, { idempotencyKey: key }),
  sales: (q: { from: string; to: string; groupBy: 'product' | 'staff'; shopId?: string }) =>
    api.get<SalesReport>('/commerce/sales', { ...q }),
};

export const commerceKeys = {
  all: ['commerce'] as const,
  products: (q: ProductQuery) => ['commerce', 'products', q] as const,
  product: (id: string) => ['commerce', 'product', id] as const,
  stock: (id: string) => ['commerce', 'stock', id] as const,
  lowStock: (shopId?: string) => ['commerce', 'low-stock', shopId ?? null] as const,
  orders: (q: object) => ['commerce', 'orders', q] as const,
  order: (id: string) => ['commerce', 'order', id] as const,
  sales: (q: object) => ['commerce', 'sales', q] as const,
};

export function useProducts(q: ProductQuery, enabled = true) {
  return useInfiniteQuery({
    queryKey: commerceKeys.products(q),
    queryFn: ({ pageParam }) => commerceApi.products({ ...q, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
  });
}

export function useProduct(id: string | null | undefined) {
  return useQuery({
    queryKey: commerceKeys.product(id ?? ''),
    queryFn: () => commerceApi.product(id!),
    enabled: !!id,
  });
}

export function useStock(id: string | null | undefined) {
  return useQuery({
    queryKey: commerceKeys.stock(id ?? ''),
    queryFn: () => commerceApi.stock(id!),
    enabled: !!id,
  });
}

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  pending: '決済待ち',
  paid: '支払済',
  processing: '出荷準備中',
  shipped: '発送済',
  delivered: '配達完了',
  cancelled: 'キャンセル',
  refunded: '返金済',
};

export const ORDER_STATUS_TONE: Record<
  OrderStatus,
  'warning' | 'success' | 'info' | 'primary' | 'neutral' | 'danger'
> = {
  pending: 'warning',
  paid: 'primary',
  processing: 'info',
  shipped: 'info',
  delivered: 'success',
  cancelled: 'neutral',
  refunded: 'danger',
};

export const STOCK_REASON_LABEL: Record<string, string> = {
  receive: '入荷',
  adjust: '棚卸調整',
  transfer: '移動',
  return: '返品',
  sale: '店頭販売',
  cancel: '取消戻し',
  order: 'EC注文',
  order_cancel: 'EC注文取消',
  reserve: 'EC引当',
  release: 'EC引当解除',
};

// ---------------------------------------------------------------- customer side (storefront)

export interface PublicProduct {
  id: string;
  name: string;
  brand: string | null;
  category: string | null;
  description: string | null;
  /** tax-inclusive */
  price: number;
  taxRateBp: number;
  images: string[];
  inStock: boolean;
  stockStatus: 'in_stock' | 'low' | 'out_of_stock';
  seller?: { name: string; shopSlug: string | null };
  url?: string | null;
}

export interface CustomerOrder {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  subtotal: number;
  shippingFee: number;
  taxTotal: number;
  total: number;
  refundedAmount: number;
  items: {
    productId: string;
    name: string;
    unitPrice: number;
    quantity: number;
    taxRateBp: number;
    amount: number;
  }[];
  shippingAddress: ShippingAddress | null;
  carrier: string | null;
  trackingNumber: string | null;
  paymentFailed: boolean;
  expiresAt: string | null;
  createdAt: string;
  paidAt: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
}

export interface OrderPayment {
  paymentId: string;
  status: string;
  provider: string;
  clientSecret: string | null;
}

export interface CreateOrderInput {
  shopSlug: string;
  items: { productId: string; quantity: number }[];
  shippingAddress: ShippingAddress;
  contactEmail?: string;
  referralCode?: string;
  note?: string;
  channel?: 'online' | 'line';
  idempotencyKey: string;
}

const none = { auth: 'none' as const };
const cust = (token: string) => ({ auth: 'customer' as const, token });

export const storeApi = {
  products: (slug: string, q: { category?: string; cursor?: string; limit?: number } = {}) =>
    api.get<Page<PublicProduct>>(
      `/public/shops/${encodeURIComponent(slug)}/products`,
      { ...q },
      none,
    ),
  product: (id: string) => api.get<PublicProduct>(`/public/products/${id}`, undefined, none),
  createOrder: (token: string, input: CreateOrderInput) =>
    api.post<{ order: CustomerOrder; payment: OrderPayment | null; replayed: boolean }>(
      '/public/orders',
      input,
      cust(token),
    ),
  myOrders: (token: string) =>
    api.get<CustomerOrder[]>('/public/me/orders', undefined, cust(token)),
  myOrder: (token: string, id: string) =>
    api.get<CustomerOrder>(`/public/me/orders/${id}`, undefined, cust(token)),
  /** dev/mock only: simulate the hosted payment page completing this order's pending payment */
  mockPay: (token: string, id: string) =>
    api.post<{ paymentId: string; status: string; orderId: string }>(`/public/me/orders/${id}/mock-pay`, { success: true }, cust(token)),
  retryPayment: (token: string, id: string) =>
    api.post<{ orderId: string; payment: OrderPayment | null }>(
      `/public/me/orders/${id}/pay`,
      {},
      cust(token),
    ),
};

export type { TaxBucket };
