-- =====================================================================
-- 0183 媒体の自動枠止め (sync agent)
--   A helper running in the salon's own Chrome (infra/chrome-sync-agent) every 10 minutes closes
--   and reopens slots on booking media that have no write API (minimo, SALON BOARD), using the
--   salon's own logged-in session. One row per issued helper; the token is stored hashed.
--   last_seen_at / last_report are its heartbeat; alerted_at marks the "helper stopped" mail.
-- =====================================================================
CREATE TABLE sync_agents (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES organizations(id),
  shop_id              uuid NOT NULL REFERENCES shops(id),
  name                 text NOT NULL,
  token_hash           text NOT NULL UNIQUE,
  created_by_staff_id  uuid REFERENCES staffs(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  revoked_at           timestamptz,
  last_seen_at         timestamptz,
  last_report          jsonb,
  alerted_at           timestamptz
);
CREATE INDEX sync_agents_shop_idx ON sync_agents(organization_id, shop_id);

ALTER TABLE sync_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_agents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sync_agents
  USING (app_bypass_rls() OR organization_id = app_current_org())
  WITH CHECK (app_bypass_rls() OR organization_id = app_current_org());
