-- =====================================================================
-- 0100 POS / payments additions
--   - transactions: main staff (主担当), nomination flag, whether completion closed the appointment
--   - transaction_items: allocated transaction-level discount, net amount, input details, returned qty
--   - refunds: register session for cash refunds (レジ締め計算), lookup indexes
-- =====================================================================
ALTER TABLE transactions
  ADD COLUMN staff_id uuid REFERENCES staffs(id),
  ADD COLUMN is_nominated boolean NOT NULL DEFAULT false,
  ADD COLUMN appointment_completed_by_tx boolean NOT NULL DEFAULT false;
CREATE INDEX transactions_staff_idx ON transactions(staff_id);
CREATE INDEX transactions_shop_created_idx ON transactions(shop_id, created_at DESC);
CREATE INDEX transactions_register_session_idx ON transactions(register_session_id) WHERE register_session_id IS NOT NULL;

ALTER TABLE transaction_items
  ADD COLUMN allocated_discount int NOT NULL DEFAULT 0,   -- 会計全体値引・クーポンの按分額
  ADD COLUMN net_amount int NOT NULL DEFAULT 0,           -- amount - allocated_discount (売上配賦・税計算の基礎)
  ADD COLUMN returned_quantity int NOT NULL DEFAULT 0 CHECK (returned_quantity >= 0),
  ADD COLUMN details jsonb NOT NULL DEFAULT '{}'::jsonb;  -- 入力値 (percent 等)

ALTER TABLE refunds
  ADD COLUMN register_session_id uuid REFERENCES register_sessions(id);
CREATE INDEX refunds_payment_idx ON refunds(payment_id);
CREATE INDEX refunds_register_session_idx ON refunds(register_session_id) WHERE register_session_id IS NOT NULL;
CREATE UNIQUE INDEX refunds_provider_id_idx ON refunds(provider_refund_id) WHERE provider_refund_id IS NOT NULL;

CREATE INDEX point_ledger_tx_idx ON point_ledger(transaction_id) WHERE transaction_id IS NOT NULL;
CREATE INDEX stock_movements_tx_idx ON stock_movements(transaction_id) WHERE transaction_id IS NOT NULL;
CREATE INDEX register_cash_movements_session_idx ON register_cash_movements(register_session_id);
CREATE INDEX receipts_reissue_idx ON receipts(reissue_of) WHERE reissue_of IS NOT NULL;
