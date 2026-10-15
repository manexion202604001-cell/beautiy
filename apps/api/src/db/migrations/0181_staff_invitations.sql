-- =====================================================================
-- 0181 設定 › スタッフ管理 › スタッフ招待 / 招待履歴 (SALOGIC parity, docs/salogic-parity.md)
--   One row per invitation sent from the 設定 screen: who was invited to which shop with which
--   role, and by whom. The invited staff row (staffs.status = 'invited') is created at the same
--   time; accepted_at is set when the invitee opens the emailed link and sets a password.
--   Status shown on screen: accepted_at set → 承認済み; staff still 'invited' → 承認待ち;
--   otherwise (the staff row was retired / removed before acceptance) → 取消.
-- =====================================================================
CREATE TABLE staff_invitations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES organizations(id),
  staff_id             uuid NOT NULL REFERENCES staffs(id),
  shop_id              uuid NOT NULL REFERENCES shops(id),
  role_id              uuid NOT NULL REFERENCES roles(id),
  email                citext NOT NULL,
  invited_by_staff_id  uuid REFERENCES staffs(id),
  accepted_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  trace_id             text
);
CREATE INDEX staff_invitations_org_idx ON staff_invitations(organization_id, created_at DESC);
CREATE INDEX staff_invitations_staff_idx ON staff_invitations(staff_id);

ALTER TABLE staff_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON staff_invitations
  USING (app_bypass_rls() OR organization_id = app_current_org())
  WITH CHECK (app_bypass_rls() OR organization_id = app_current_org());
