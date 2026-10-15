-- =====================================================================
-- 0180 設定 › スタッフ管理 › 店舗割り当て (SALOGIC parity, docs/salogic-parity.md)
--   staff_shop_assignments.is_visible_to_customer
--     the eye toggle next to each staff × shop checkbox: false hides the staff member from the
--     customer-facing booking page of that shop (staff can still take bookings entered by staff).
-- =====================================================================
ALTER TABLE staff_shop_assignments ADD COLUMN is_visible_to_customer boolean NOT NULL DEFAULT true;
