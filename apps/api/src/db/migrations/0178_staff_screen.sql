-- =====================================================================
-- 0178 スタッフ画面 / スタッフ別設定 (SALOGIC parity, docs/salogic-parity.md 7章・8章)
--   staffs.notify_line / line_user_id
--     スタッフ編集 › LINE通知: a new booking for this staff member is pushed to the LINE user id
--     through the shop's LINE official account.
--   staff_booking_settings (one row per staff × shop, only when something was set individually)
--     weekly_all_closed   スタッフ別 営業時間 with every weekday 休み. staff_weekly_schedules has no
--                         row for a day off, so "all days off" would otherwise read as "not set".
--     reservation         スタッフ別 予約設定 (何日先まで / 当日の締め切り / 同時刻に予約可能な人数 /
--                         開始時刻が同じ予約 / 営業時間外). NULL = the shop's settings apply.
-- =====================================================================
ALTER TABLE staffs
  ADD COLUMN notify_line boolean NOT NULL DEFAULT false,
  ADD COLUMN line_user_id text;

CREATE TABLE staff_booking_settings (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations(id),
  staff_id           uuid NOT NULL REFERENCES staffs(id),
  shop_id            uuid NOT NULL REFERENCES shops(id),
  weekly_all_closed  boolean NOT NULL DEFAULT false,
  reservation        jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (staff_id, shop_id)
);
CREATE INDEX staff_booking_settings_shop_idx ON staff_booking_settings(shop_id);
CREATE TRIGGER staff_booking_settings_updated BEFORE UPDATE ON staff_booking_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE staff_booking_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_booking_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON staff_booking_settings
  USING (app_bypass_rls() OR organization_id = app_current_org())
  WITH CHECK (app_bypass_rls() OR organization_id = app_current_org());
