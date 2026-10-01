-- =====================================================================
-- 0012 Platform: audit logs, idempotency, job queue, domain events, flags, exports
-- =====================================================================
CREATE TABLE audit_logs (
  id               bigserial PRIMARY KEY,
  organization_id  uuid REFERENCES organizations(id),
  actor_type       text NOT NULL CHECK (actor_type IN ('staff','customer','system','api','anonymous')),
  actor_id         uuid,           -- staff id / customer id
  actor_user_id    uuid,
  action           text NOT NULL,  -- customer.view / sales.view / export.csv / role.change / customer.merge ...
  resource_type    text NOT NULL,
  resource_id      text,
  shop_id          uuid,
  before           jsonb,
  after            jsonb,
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip               inet,
  user_agent       text,
  request_id       text,
  trace_id         text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_org_time_idx ON audit_logs(organization_id, created_at DESC);
CREATE INDEX audit_logs_resource_idx ON audit_logs(resource_type, resource_id);
CREATE INDEX audit_logs_actor_idx ON audit_logs(actor_id, created_at DESC);

-- Append-only enforcement
CREATE OR REPLACE FUNCTION audit_logs_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END $$;
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();

CREATE TABLE idempotency_keys (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  key              text NOT NULL,
  scope            text NOT NULL,       -- "<METHOD> <route>:<actor>"
  request_hash     text NOT NULL,
  state            text NOT NULL DEFAULT 'in_progress' CHECK (state IN ('in_progress','completed')),
  response_status  int,
  response_body    jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  UNIQUE (organization_id, scope, key)
);

-- Postgres-backed durable job queue (SELECT ... FOR UPDATE SKIP LOCKED)
CREATE TABLE jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid REFERENCES organizations(id),
  queue            text NOT NULL DEFAULT 'default',
  type             text NOT NULL,
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  state            text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','succeeded','failed','dead','cancelled')),
  priority         int NOT NULL DEFAULT 0,
  run_at           timestamptz NOT NULL DEFAULT now(),
  attempts         int NOT NULL DEFAULT 0,
  max_attempts     int NOT NULL DEFAULT 8,
  last_error       text,
  locked_by        text,
  locked_at        timestamptz,
  dedupe_key       text,
  trace_id         text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz
);
CREATE INDEX jobs_ready_idx ON jobs(queue, priority DESC, run_at) WHERE state = 'queued';
CREATE UNIQUE INDEX jobs_dedupe_idx ON jobs(dedupe_key) WHERE dedupe_key IS NOT NULL AND state IN ('queued','running');
CREATE INDEX jobs_dead_idx ON jobs(organization_id, state) WHERE state IN ('dead','failed');

CREATE TABLE domain_events (
  id               bigserial PRIMARY KEY,
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  event_type       text NOT NULL,     -- appointment.created / transaction.completed / customer.merged ...
  aggregate_type   text NOT NULL,
  aggregate_id     uuid NOT NULL,
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_id         uuid,
  trace_id         text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX domain_events_aggregate_idx ON domain_events(aggregate_type, aggregate_id);
CREATE INDEX domain_events_org_time_idx ON domain_events(organization_id, created_at DESC);

CREATE TABLE feature_flags (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid REFERENCES organizations(id),  -- NULL = global default
  key              text NOT NULL,
  enabled          boolean NOT NULL DEFAULT false,
  rollout          jsonb NOT NULL DEFAULT '{}'::jsonb,
  description      text,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX feature_flags_unique ON feature_flags(coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), key);

CREATE TABLE data_exports (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  kind             text NOT NULL CHECK (kind IN ('customers','appointments','transactions','transaction_items','staff_sales')),
  params           jsonb NOT NULL DEFAULT '{}'::jsonb,
  status           text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','expired')),
  file_id          uuid REFERENCES files(id),
  row_count        int,
  error            text,
  requested_by     uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  expires_at       timestamptz
);

CREATE TRIGGER feature_flags_updated BEFORE UPDATE ON feature_flags FOR EACH ROW EXECUTE FUNCTION set_updated_at();
