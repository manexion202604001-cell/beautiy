-- =====================================================================
-- 0007 Products/EC, POS (transactions, register), payments, points, receipts
-- =====================================================================
CREATE TABLE products (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  shop_id          uuid REFERENCES shops(id),     -- NULL = 法人共通
  sku              text,
  barcode          text,
  name             text NOT NULL,
  brand            text,
  category         text,
  description      text,
  price            int NOT NULL CHECK (price >= 0),
  price_tax_included boolean NOT NULL DEFAULT true,
  cost             int CHECK (cost >= 0),
  tax_rate_bp      int NOT NULL DEFAULT 1000,
  image_file_ids   uuid[] NOT NULL DEFAULT '{}',
  is_online        boolean NOT NULL DEFAULT false,  -- EC販売
  stock_managed    boolean NOT NULL DEFAULT true,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_by       uuid,
  trace_id         text,
  deleted_at       timestamptz
);
CREATE UNIQUE INDEX products_sku_idx ON products(organization_id, sku) WHERE sku IS NOT NULL AND deleted_at IS NULL;

-- shop_id NULL = EC倉庫
CREATE TABLE product_stocks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  product_id       uuid NOT NULL REFERENCES products(id),
  shop_id          uuid REFERENCES shops(id),
  quantity         int NOT NULL DEFAULT 0,
  reorder_point    int,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX product_stocks_unique ON product_stocks(product_id, coalesce(shop_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE stock_movements (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  product_id       uuid NOT NULL REFERENCES products(id),
  shop_id          uuid REFERENCES shops(id),
  delta            int NOT NULL,
  reason           text NOT NULL CHECK (reason IN ('sale','order','adjust','return','receive','cancel','transfer')),
  transaction_id   uuid,
  order_id         uuid,
  note             text,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stock_movements_product_idx ON stock_movements(product_id, created_at DESC);

CREATE TABLE orders (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id),
  shop_id           uuid REFERENCES shops(id),
  customer_id       uuid REFERENCES customers(id),
  order_number      text NOT NULL,
  channel           text NOT NULL DEFAULT 'online' CHECK (channel IN ('online','line','staff')),
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','paid','processing','shipped','delivered','cancelled','refunded')),
  subtotal          int NOT NULL DEFAULT 0,
  shipping_fee      int NOT NULL DEFAULT 0,
  discount_total    int NOT NULL DEFAULT 0,
  tax_total         int NOT NULL DEFAULT 0,
  total             int NOT NULL DEFAULT 0,
  shipping_address  jsonb,
  contact_email     citext,
  contact_phone     text,
  attributed_staff_id uuid REFERENCES staffs(id),  -- 店販紹介スタッフ
  referral_link_id  uuid,
  is_subscription   boolean NOT NULL DEFAULT false, -- 定期購入(拡張余地)
  carrier           text,
  tracking_number   text,
  paid_at           timestamptz,
  shipped_at        timestamptz,
  delivered_at      timestamptz,
  cancelled_at      timestamptz,
  cancel_reason     text,
  note              text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  trace_id          text
);
CREATE UNIQUE INDEX orders_number_idx ON orders(organization_id, order_number);
CREATE INDEX orders_customer_idx ON orders(customer_id, created_at DESC);

CREATE TABLE order_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  order_id         uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id       uuid NOT NULL REFERENCES products(id),
  name             text NOT NULL,
  unit_price       int NOT NULL,
  quantity         int NOT NULL CHECK (quantity > 0),
  tax_rate_bp      int NOT NULL,
  tax_amount       int NOT NULL DEFAULT 0,
  amount           int NOT NULL
);
CREATE INDEX order_items_order_idx ON order_items(order_id);

CREATE TABLE register_sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  shop_id          uuid NOT NULL REFERENCES shops(id),
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  opened_by        uuid NOT NULL REFERENCES staffs(id),
  opened_at        timestamptz NOT NULL DEFAULT now(),
  opening_cash     int NOT NULL DEFAULT 0,
  closed_by        uuid REFERENCES staffs(id),
  closed_at        timestamptz,
  expected_cash    int,
  counted_cash     int,
  difference       int,
  cash_breakdown   jsonb,     -- {"10000":3,"5000":1,...}
  summary          jsonb,     -- method totals at close
  note             text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX register_sessions_one_open ON register_sessions(shop_id) WHERE status = 'open';

CREATE TABLE register_cash_movements (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES organizations(id),
  register_session_id  uuid NOT NULL REFERENCES register_sessions(id),
  movement_type        text NOT NULL CHECK (movement_type IN ('pay_in','pay_out')),
  amount               int NOT NULL CHECK (amount > 0),
  reason               text NOT NULL,
  staff_id             uuid REFERENCES staffs(id),
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE custom_payment_methods (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  shop_id          uuid REFERENCES shops(id),
  name             text NOT NULL,   -- 回数券 / 商品券 / 店舗独自決済
  is_active        boolean NOT NULL DEFAULT true,
  counts_as_sales  boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE transactions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES organizations(id),
  shop_id              uuid NOT NULL REFERENCES shops(id),
  register_session_id  uuid REFERENCES register_sessions(id),
  appointment_id       uuid REFERENCES appointments(id),
  customer_id          uuid REFERENCES customers(id),
  transaction_number   text,       -- assigned on completion
  status               text NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft','completed','voided','refunded','partially_refunded')),
  subtotal             int NOT NULL DEFAULT 0,   -- 税込明細合計(値引前)
  discount_total       int NOT NULL DEFAULT 0,
  tax_total            int NOT NULL DEFAULT 0,   -- 内消費税
  total                int NOT NULL DEFAULT 0,   -- 請求額(税込)
  tax_breakdown        jsonb NOT NULL DEFAULT '{}'::jsonb, -- {"1000": {"taxable":..,"tax":..}}
  paid_total           int NOT NULL DEFAULT 0,
  change_total         int NOT NULL DEFAULT 0,
  refunded_total       int NOT NULL DEFAULT 0,
  point_earned         int NOT NULL DEFAULT 0,
  point_used           int NOT NULL DEFAULT 0,
  is_new_customer      boolean,
  note                 text,
  completed_at         timestamptz,
  completed_by         uuid REFERENCES staffs(id),
  voided_at            timestamptz,
  voided_by            uuid REFERENCES staffs(id),
  void_reason          text,
  version              int NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid,
  updated_by           uuid,
  trace_id             text
);
CREATE UNIQUE INDEX transactions_number_idx ON transactions(shop_id, transaction_number) WHERE transaction_number IS NOT NULL;
CREATE UNIQUE INDEX transactions_appointment_active_idx ON transactions(appointment_id) WHERE appointment_id IS NOT NULL AND status IN ('draft','completed','partially_refunded');
CREATE INDEX transactions_shop_completed_idx ON transactions(shop_id, completed_at);
CREATE INDEX transactions_customer_idx ON transactions(customer_id, completed_at DESC);

CREATE TABLE transaction_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  transaction_id   uuid NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  item_type        text NOT NULL CHECK (item_type IN ('service','product','nomination_fee','discount','coupon','adjustment')),
  menu_id          uuid REFERENCES menus(id),
  product_id       uuid REFERENCES products(id),
  coupon_id        uuid REFERENCES coupons(id),
  name             text NOT NULL,
  quantity         int NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price       int NOT NULL,                 -- 税込単価 (discount rows: negative)
  line_discount    int NOT NULL DEFAULT 0 CHECK (line_discount >= 0),
  tax_rate_bp      int NOT NULL DEFAULT 1000,
  amount           int NOT NULL,                 -- 税込行合計 = unit_price*qty - line_discount
  tax_amount       int NOT NULL DEFAULT 0,       -- allocated tax for this line
  sort_order       int NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX transaction_items_tx_idx ON transaction_items(transaction_id);
CREATE INDEX transaction_items_menu_idx ON transaction_items(menu_id);
CREATE INDEX transaction_items_product_idx ON transaction_items(product_id);

-- Sales allocation per staff (担当者別売上配賦)
CREATE TABLE transaction_item_staff (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES organizations(id),
  transaction_item_id  uuid NOT NULL REFERENCES transaction_items(id) ON DELETE CASCADE,
  staff_id             uuid NOT NULL REFERENCES staffs(id),
  role                 text NOT NULL DEFAULT 'main' CHECK (role IN ('main','assistant','referral')),
  share_bp             int NOT NULL CHECK (share_bp BETWEEN 0 AND 10000),
  is_nominated         boolean NOT NULL DEFAULT false,
  allocated_amount     int NOT NULL DEFAULT 0,
  UNIQUE (transaction_item_id, staff_id, role)
);
CREATE INDEX tis_staff_idx ON transaction_item_staff(staff_id);

CREATE TABLE payments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES organizations(id),
  transaction_id       uuid REFERENCES transactions(id),
  order_id             uuid REFERENCES orders(id),
  method               text NOT NULL CHECK (method IN ('cash','card','emoney','qr','custom','point','online')),
  custom_method_id     uuid REFERENCES custom_payment_methods(id),
  provider             text,              -- stripe / square / mock / NULL(offline)
  provider_payment_id  text,
  amount               int NOT NULL CHECK (amount > 0),
  tendered_amount      int,               -- 預り金 (cash)
  change_amount        int NOT NULL DEFAULT 0,
  refunded_amount      int NOT NULL DEFAULT 0,
  status               text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','requires_action','succeeded','failed','cancelled','refunded','partially_refunded')),
  idempotency_key      text NOT NULL,
  client_secret        text,              -- provider client secret (for online payments UI)
  failure_code         text,
  failure_reason       text,
  succeeded_at         timestamptz,
  metadata             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid,
  trace_id             text,
  CHECK ((transaction_id IS NOT NULL)::int + (order_id IS NOT NULL)::int = 1)
);
CREATE UNIQUE INDEX payments_idempotency_idx ON payments(organization_id, idempotency_key);
CREATE UNIQUE INDEX payments_provider_id_idx ON payments(provider, provider_payment_id) WHERE provider_payment_id IS NOT NULL;
CREATE INDEX payments_tx_idx ON payments(transaction_id);
CREATE INDEX payments_order_idx ON payments(order_id);

CREATE TABLE refunds (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES organizations(id),
  payment_id           uuid NOT NULL REFERENCES payments(id),
  amount               int NOT NULL CHECK (amount > 0),
  reason               text,
  provider_refund_id   text,
  status               text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','failed')),
  idempotency_key      text NOT NULL,
  created_by           uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX refunds_idempotency_idx ON refunds(organization_id, idempotency_key);

CREATE TABLE receipts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  transaction_id   uuid NOT NULL REFERENCES transactions(id),
  receipt_number   text NOT NULL,
  receipt_type     text NOT NULL CHECK (receipt_type IN ('receipt','invoice')), -- レシート / 領収書
  addressee        text,
  proviso          text,                 -- 但し書き
  content          jsonb NOT NULL,       -- rendered snapshot
  reissue_of       uuid REFERENCES receipts(id),
  issued_by        uuid,
  issued_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX receipts_tx_idx ON receipts(transaction_id);

CREATE TABLE point_ledger (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  customer_id      uuid NOT NULL REFERENCES customers(id),
  delta            int NOT NULL,
  reason           text NOT NULL CHECK (reason IN ('earn','redeem','adjust','expire','revert')),
  transaction_id   uuid REFERENCES transactions(id),
  balance_after    int NOT NULL,
  expires_at       timestamptz,
  note             text,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX point_ledger_customer_idx ON point_ledger(customer_id, created_at DESC);

-- Gapless per-shop counters (transaction numbers, receipt numbers, order numbers)
CREATE TABLE counters (
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  scope            text NOT NULL,  -- e.g. 'tx:<shop_id>:2026', 'order:2026'
  value            bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (organization_id, scope)
);

ALTER TABLE coupon_redemptions ADD CONSTRAINT coupon_redemptions_tx_fk FOREIGN KEY (transaction_id) REFERENCES transactions(id);

CREATE TRIGGER products_updated BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER product_stocks_updated BEFORE UPDATE ON product_stocks FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER orders_updated BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER register_sessions_updated BEFORE UPDATE ON register_sessions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER transactions_updated BEFORE UPDATE ON transactions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER payments_updated BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER refunds_updated BEFORE UPDATE ON refunds FOR EACH ROW EXECUTE FUNCTION set_updated_at();
