-- =====================================================================
-- 0172 Customer screens (SALOGIC parity: 顧客管理 / 顧客詳細 / カウンセリングシート)
--   customers.memo       the one free-text note on the customer profile (新規顧客登録・顧客情報を編集 の「メモ」).
--                        Staff memos (customer_memos: per author, shared / private) stay as they are.
--   customers.member_no  会員番号 shared by records that staff marked as the same person
--                        (名前重複 ›「同一人物としてリンク」) without merging them. Unlike customer_number
--                        it is not unique: every linked record carries the same value.
--   customer_counseling_sheets
--                        the staff-editable counselling sheet of a customer (カウンセリングシート).
--                        data = { <category id>: { <question id>: string | string[] } } with the fixed
--                        categories of the sheet (髪 / 目 / エクステ / 眉 / ネイル / 顔 / 体).
--                        The sheet shown for a customer is the row saved last; a merge moves the
--                        source's rows to the target (and back on undo), so no unique constraint.
-- =====================================================================
ALTER TABLE customers ADD COLUMN memo text;
ALTER TABLE customers ADD COLUMN member_no text;
CREATE INDEX customers_member_no_idx ON customers(organization_id, member_no) WHERE member_no IS NOT NULL;

CREATE TABLE customer_counseling_sheets (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  customer_id      uuid NOT NULL REFERENCES customers(id),
  shop_id          uuid REFERENCES shops(id),          -- shop where it was saved last
  data             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_by       uuid
);
CREATE INDEX customer_counseling_sheets_customer_idx ON customer_counseling_sheets(customer_id, updated_at DESC);
CREATE TRIGGER customer_counseling_sheets_updated BEFORE UPDATE ON customer_counseling_sheets FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE customer_counseling_sheets ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_counseling_sheets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON customer_counseling_sheets USING (app_bypass_rls() OR organization_id = app_current_org()) WITH CHECK (app_bypass_rls() OR organization_id = app_current_org());
