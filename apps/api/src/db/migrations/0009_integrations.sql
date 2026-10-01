-- =====================================================================
-- 0009 Integration Hub: accounts, external bookings, sync jobs, conflicts, webhooks
-- =====================================================================
CREATE TABLE integration_accounts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES organizations(id),
  shop_id               uuid REFERENCES shops(id),
  provider              text NOT NULL,  -- mock_booking / stripe / square / google_business / ...
  display_name          text NOT NULL,
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active','error','disabled','degraded')),
  encrypted_credentials text,           -- AES-256-GCM (lib/crypto.ts)
  config                jsonb NOT NULL DEFAULT '{}'::jsonb, -- staff/menu mapping, priority rules
  sync_cursor           text,
  last_synced_at        timestamptz,
  last_success_at       timestamptz,
  last_error            text,
  last_error_at         timestamptz,
  consecutive_failures  int NOT NULL DEFAULT 0,
  created_by            uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX integration_accounts_unique ON integration_accounts(organization_id, provider, coalesce(shop_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE external_bookings (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES organizations(id),
  integration_account_id uuid NOT NULL REFERENCES integration_accounts(id),
  provider              text NOT NULL,
  external_booking_id   text NOT NULL,
  appointment_id        uuid REFERENCES appointments(id),
  external_status       text NOT NULL,
  raw_payload           jsonb NOT NULL,
  normalized            jsonb NOT NULL,
  payload_hash          text NOT NULL,      -- skip unchanged payloads
  external_updated_at   timestamptz,
  sync_state            text NOT NULL DEFAULT 'pending' CHECK (sync_state IN ('pending','synced','conflict','error','ignored')),
  last_error            text,
  last_synced_at        timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (integration_account_id, external_booking_id)
);
CREATE INDEX external_bookings_appt_idx ON external_bookings(appointment_id);

-- Internal appointment reflected to an external provider as a blocked slot
CREATE TABLE external_slot_blocks (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        uuid NOT NULL REFERENCES organizations(id),
  integration_account_id uuid NOT NULL REFERENCES integration_accounts(id),
  appointment_id         uuid NOT NULL REFERENCES appointments(id),
  external_block_id      text,
  state                  text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','pushed','removed','error')),
  last_error             text,
  pushed_at              timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (integration_account_id, appointment_id)
);

CREATE TABLE sync_jobs (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        uuid NOT NULL REFERENCES organizations(id),
  integration_account_id uuid NOT NULL REFERENCES integration_accounts(id),
  provider               text NOT NULL,
  resource               text NOT NULL,  -- bookings / slots / reviews
  mode                   text NOT NULL CHECK (mode IN ('delta','full','push')),
  state                  text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','succeeded','failed','dead')),
  cursor_before          text,
  cursor_after           text,
  stats                  jsonb NOT NULL DEFAULT '{}'::jsonb, -- {fetched, created, updated, cancelled, conflicts, skipped}
  error                  text,
  retry_count            int NOT NULL DEFAULT 0,
  triggered_by           text NOT NULL DEFAULT 'schedule', -- schedule / manual / webhook
  started_at             timestamptz,
  finished_at            timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sync_jobs_account_idx ON sync_jobs(integration_account_id, created_at DESC);

-- Manual resolution queue
CREATE TABLE sync_conflicts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES organizations(id),
  external_booking_id  uuid REFERENCES external_bookings(id),
  appointment_id       uuid REFERENCES appointments(id),
  conflict_type        text NOT NULL CHECK (conflict_type IN ('overlap','duplicate','unknown_staff','unknown_menu','unknown_customer','stale_update','push_failed')),
  details              jsonb NOT NULL DEFAULT '{}'::jsonb,
  state                text NOT NULL DEFAULT 'open' CHECK (state IN ('open','resolved','ignored')),
  resolution           text,  -- keep_internal / accept_external / merged / manual
  resolved_by          uuid,
  resolved_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sync_conflicts_open_idx ON sync_conflicts(organization_id, state);

-- Raw inbound webhooks (all providers). organization_id may be unknown at receipt time.
CREATE TABLE webhook_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid REFERENCES organizations(id),
  provider         text NOT NULL,
  event_id         text NOT NULL,   -- provider event id (or payload hash)
  event_type       text,
  signature_valid  boolean NOT NULL,
  headers          jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload          jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'received' CHECK (status IN ('received','processing','processed','failed','ignored','dead')),
  attempts         int NOT NULL DEFAULT 0,
  last_error       text,
  received_at      timestamptz NOT NULL DEFAULT now(),
  processed_at     timestamptz,
  UNIQUE (provider, event_id)
);
CREATE INDEX webhook_events_status_idx ON webhook_events(status, received_at);

CREATE TRIGGER integration_accounts_updated BEFORE UPDATE ON integration_accounts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER external_bookings_updated BEFORE UPDATE ON external_bookings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER external_slot_blocks_updated BEFORE UPDATE ON external_slot_blocks FOR EACH ROW EXECUTE FUNCTION set_updated_at();
