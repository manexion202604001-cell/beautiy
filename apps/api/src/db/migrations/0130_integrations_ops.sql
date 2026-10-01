-- =====================================================================
-- 0130 Integration Hub (mock provider store, slot block details) + Ops (flags, indexes)
-- =====================================================================

-- ---------------------------------------------------------------------
-- Simulated booking-media provider ("mock_booking" adapter).
-- Acts as the provider's own datastore: rows are written by test hooks /
-- the demo console and read by the adapter exactly like a remote API would be.
-- Payloads are stored in a provider-native shape; the adapter normalizes them.
-- ---------------------------------------------------------------------
CREATE SEQUENCE mock_provider_seq;

CREATE TABLE mock_provider_bookings (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        uuid NOT NULL REFERENCES organizations(id),
  integration_account_id uuid NOT NULL REFERENCES integration_accounts(id),
  reserve_id             text NOT NULL,           -- provider booking id
  payload                jsonb NOT NULL,          -- provider-native representation
  change_seq             bigint NOT NULL DEFAULT nextval('mock_provider_seq'), -- change feed cursor
  start_at               timestamptz NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (integration_account_id, reserve_id)
);
CREATE INDEX mock_provider_bookings_feed_idx ON mock_provider_bookings(integration_account_id, change_seq);

-- slots blocked on the provider side by our pushes
CREATE TABLE mock_provider_blocks (
  id                     text PRIMARY KEY,
  organization_id        uuid NOT NULL REFERENCES organizations(id),
  integration_account_id uuid NOT NULL REFERENCES integration_accounts(id),
  payload                jsonb NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  removed_at             timestamptz
);
CREATE INDEX mock_provider_blocks_account_idx ON mock_provider_blocks(integration_account_id);

-- outage simulation (fail_* : number of upcoming calls to fail, -1 = until cleared)
CREATE TABLE mock_provider_state (
  integration_account_id uuid PRIMARY KEY REFERENCES integration_accounts(id),
  organization_id        uuid NOT NULL REFERENCES organizations(id),
  fail_fetch             int NOT NULL DEFAULT 0,
  fail_push              int NOT NULL DEFAULT 0,
  updated_at             timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE mock_provider_bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE mock_provider_bookings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mock_provider_bookings USING (app_bypass_rls() OR organization_id = app_current_org()) WITH CHECK (app_bypass_rls() OR organization_id = app_current_org());
ALTER TABLE mock_provider_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE mock_provider_blocks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mock_provider_blocks USING (app_bypass_rls() OR organization_id = app_current_org()) WITH CHECK (app_bypass_rls() OR organization_id = app_current_org());
ALTER TABLE mock_provider_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE mock_provider_state FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mock_provider_state USING (app_bypass_rls() OR organization_id = app_current_org()) WITH CHECK (app_bypass_rls() OR organization_id = app_current_org());

-- ---------------------------------------------------------------------
-- Slot block details (what was pushed, to detect reschedules)
-- ---------------------------------------------------------------------
ALTER TABLE external_slot_blocks
  ADD COLUMN block_start_at    timestamptz,
  ADD COLUMN block_end_at      timestamptz,
  ADD COLUMN staff_external_id text,
  ADD COLUMN attempts          int NOT NULL DEFAULT 0;

CREATE INDEX external_slot_blocks_state_idx ON external_slot_blocks(integration_account_id, state);
CREATE INDEX sync_conflicts_booking_idx ON sync_conflicts(external_booking_id);
CREATE INDEX webhook_events_org_idx ON webhook_events(organization_id, received_at DESC);
CREATE INDEX audit_logs_org_id_idx ON audit_logs(organization_id, id DESC);
CREATE INDEX data_exports_org_idx ON data_exports(organization_id, created_at DESC);
CREATE INDEX jobs_org_state_idx ON jobs(organization_id, state, created_at DESC);

-- ---------------------------------------------------------------------
-- Global feature flag defaults (organization_id NULL). Orgs override per key.
-- ---------------------------------------------------------------------
INSERT INTO feature_flags (organization_id, key, enabled, description) VALUES
  (NULL, 'ai_assist', false, 'AIアシスト(返信文・カルテ要約・提案)'),
  (NULL, 'ec_store', false, 'EC・店販オンラインストア'),
  (NULL, 'external_sync', true, '外部予約媒体との自動同期(差分同期・枠反映)'),
  (NULL, 'campaign_approval_required', false, '一括配信の承認フロー必須化');
