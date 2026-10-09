-- Data migration from the salon's previous system (CSV exports): customers, visit history and
-- future reservations. Imports run as jobs, can be previewed, re-run without duplicates
-- (import_keys) and undone (import_job_rows records what each row created).

-- Visit statistics carried over from the previous system. recomputeCustomerStats adds them to the
-- figures computed from Salon OS transactions/appointments, so "来店回数" stays continuous.
ALTER TABLE customers
  ADD COLUMN legacy_visit_count integer NOT NULL DEFAULT 0 CHECK (legacy_visit_count >= 0),
  ADD COLUMN legacy_total_sales integer NOT NULL DEFAULT 0 CHECK (legacy_total_sales >= 0),
  ADD COLUMN legacy_first_visit_at timestamptz,
  ADD COLUMN legacy_last_visit_at timestamptz;

-- reservations brought over from the previous system
ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_source_check;
ALTER TABLE appointments
  ADD CONSTRAINT appointments_source_check CHECK (source IN ('web','line','external','phone','walk_in','staff','import'));

CREATE TABLE import_jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  shop_id          uuid REFERENCES shops(id),
  kind             text NOT NULL CHECK (kind IN ('customers','visits','reservations')),
  source_label     text NOT NULL DEFAULT '旧システム',
  file_name        text,
  status           text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','undone')),
  mapping          jsonb NOT NULL DEFAULT '{}'::jsonb,
  options          jsonb NOT NULL DEFAULT '{}'::jsonb,
  csv              text NOT NULL,
  total_rows       integer NOT NULL DEFAULT 0,
  processed_rows   integer NOT NULL DEFAULT 0,
  summary          jsonb NOT NULL DEFAULT '{}'::jsonb,
  totals           jsonb NOT NULL DEFAULT '{}'::jsonb,
  error            text,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  completed_at     timestamptz,
  undone_at        timestamptz,
  undone_by        uuid
);
CREATE INDEX import_jobs_org_idx ON import_jobs(organization_id, created_at DESC);

CREATE TABLE import_job_rows (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  job_id           uuid NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  row_no           integer NOT NULL,
  outcome          text NOT NULL CHECK (outcome IN ('created','updated','matched','skipped','error')),
  resource_type    text,
  resource_id      uuid,
  message          text,
  data             jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (job_id, row_no)
);
CREATE INDEX import_job_rows_outcome_idx ON import_job_rows(job_id, outcome);

-- stable identity of an imported record (legacy customer number, slip number, row hash ...)
CREATE TABLE import_keys (
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  kind             text NOT NULL,
  key              text NOT NULL,
  resource_id      uuid NOT NULL,
  job_id           uuid REFERENCES import_jobs(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, kind, key)
);
CREATE INDEX import_keys_resource_idx ON import_keys(organization_id, resource_id);

-- visit history from the previous system (shown in the customer's history; not part of Salon OS sales)
CREATE TABLE legacy_visits (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  customer_id      uuid NOT NULL REFERENCES customers(id),
  shop_id          uuid REFERENCES shops(id),
  import_job_id    uuid REFERENCES import_jobs(id) ON DELETE SET NULL,
  visited_at       timestamptz NOT NULL,
  staff_id         uuid REFERENCES staffs(id),
  staff_name       text,
  menu_text        text,
  amount           integer,
  memo             text,
  external_id      text,
  raw              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX legacy_visits_customer_idx ON legacy_visits(customer_id, visited_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['import_jobs','import_job_rows','import_keys','legacy_visits'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING (app_bypass_rls() OR organization_id = app_current_org()) WITH CHECK (app_bypass_rls() OR organization_id = app_current_org())$p$, t);
  END LOOP;
END $$;
