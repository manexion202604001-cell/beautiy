-- =====================================================================
-- 0140 Reviews / marketing / commerce: columns and indexes needed by the
--      reviews, marketing and commerce modules (FR-07, FR-08).
--      Only existing tables are altered, so RLS policies from 0090 still apply.
-- =====================================================================

-- ---------------------------------------------------------------- reviews
ALTER TABLE reviews
  ADD COLUMN staff_rating smallint CHECK (staff_rating BETWEEN 1 AND 5),
  ADD COLUMN integration_account_id uuid REFERENCES integration_accounts(id),
  ADD COLUMN reply_sync_error text;
CREATE INDEX reviews_org_status_idx ON reviews(organization_id, status, posted_at DESC);

-- one review request per appointment (transaction uniqueness already exists)
CREATE UNIQUE INDEX review_requests_appointment_idx ON review_requests(appointment_id) WHERE appointment_id IS NOT NULL;
CREATE INDEX review_requests_customer_idx ON review_requests(customer_id, created_at DESC);
CREATE INDEX review_requests_message_idx ON review_requests(message_id) WHERE message_id IS NOT NULL;

-- ---------------------------------------------------------------- marketing
ALTER TABLE referral_links
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN deleted_at timestamptz;
CREATE INDEX referral_links_org_idx ON referral_links(organization_id, created_at DESC);
CREATE INDEX referral_links_customer_idx ON referral_links(customer_id) WHERE customer_id IS NOT NULL;
CREATE TRIGGER referral_links_updated BEFORE UPDATE ON referral_links FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- attribution is recorded at most once per link/event/appointment|order
CREATE UNIQUE INDEX referral_events_appointment_idx ON referral_events(referral_link_id, event_type, appointment_id) WHERE appointment_id IS NOT NULL;
CREATE UNIQUE INDEX referral_events_order_idx ON referral_events(referral_link_id, event_type, order_id) WHERE order_id IS NOT NULL;

ALTER TABLE sns_assets
  ADD COLUMN shop_id uuid REFERENCES shops(id),
  ADD COLUMN review_id uuid REFERENCES reviews(id),
  ADD COLUMN deleted_at timestamptz;
CREATE INDEX sns_assets_org_idx ON sns_assets(organization_id, created_at DESC);

-- ---------------------------------------------------------------- commerce
CREATE UNIQUE INDEX products_barcode_idx ON products(organization_id, barcode) WHERE barcode IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX products_org_idx ON products(organization_id, created_at DESC) WHERE deleted_at IS NULL;

ALTER TABLE orders
  ADD COLUMN idempotency_key   text,
  ADD COLUMN expires_at        timestamptz,          -- unpaid orders are cancelled after this
  ADD COLUMN payment_attempts  int NOT NULL DEFAULT 0,
  ADD COLUMN paid_payment_id   uuid REFERENCES payments(id),
  ADD COLUMN payment_failed_at timestamptz,          -- last attempt failed (order stays pending for retry)
  ADD COLUMN refunded_amount   int NOT NULL DEFAULT 0,
  ADD COLUMN stock_released_at timestamptz;          -- EC warehouse reservation returned
CREATE UNIQUE INDEX orders_idempotency_idx ON orders(organization_id, customer_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX orders_org_created_idx ON orders(organization_id, created_at DESC);
CREATE INDEX orders_paid_idx ON orders(organization_id, paid_at) WHERE paid_at IS NOT NULL;

CREATE INDEX stock_movements_order_idx ON stock_movements(order_id) WHERE order_id IS NOT NULL;
ALTER TABLE order_items ADD COLUMN sort_order int NOT NULL DEFAULT 0;
CREATE INDEX order_items_product_idx ON order_items(product_id);
