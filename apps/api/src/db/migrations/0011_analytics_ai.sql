-- =====================================================================
-- 0011 Analytics aggregates (rebuilt idempotently by jobs) & AI scores
-- =====================================================================
CREATE TABLE analytics_daily_shop (
  organization_id     uuid NOT NULL REFERENCES organizations(id),
  shop_id             uuid NOT NULL REFERENCES shops(id),
  date                date NOT NULL,
  sales_total         bigint NOT NULL DEFAULT 0,
  service_sales       bigint NOT NULL DEFAULT 0,
  product_sales       bigint NOT NULL DEFAULT 0,
  discount_total      bigint NOT NULL DEFAULT 0,
  tax_total           bigint NOT NULL DEFAULT 0,
  transaction_count   int NOT NULL DEFAULT 0,
  customer_count      int NOT NULL DEFAULT 0,
  new_customer_count  int NOT NULL DEFAULT 0,
  repeat_customer_count int NOT NULL DEFAULT 0,
  nominated_count     int NOT NULL DEFAULT 0,
  appointment_count   int NOT NULL DEFAULT 0,
  cancel_count        int NOT NULL DEFAULT 0,
  no_show_count       int NOT NULL DEFAULT 0,
  computed_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, date)
);

CREATE TABLE analytics_daily_staff (
  organization_id     uuid NOT NULL REFERENCES organizations(id),
  shop_id             uuid NOT NULL REFERENCES shops(id),
  staff_id            uuid NOT NULL REFERENCES staffs(id),
  date                date NOT NULL,
  sales_total         bigint NOT NULL DEFAULT 0,
  service_sales       bigint NOT NULL DEFAULT 0,
  product_sales       bigint NOT NULL DEFAULT 0,
  customer_count      int NOT NULL DEFAULT 0,
  new_customer_count  int NOT NULL DEFAULT 0,
  nominated_count     int NOT NULL DEFAULT 0,
  scheduled_minutes   int NOT NULL DEFAULT 0,
  booked_minutes      int NOT NULL DEFAULT 0,
  computed_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, staff_id, date)
);

CREATE TABLE analytics_daily_menu (
  organization_id     uuid NOT NULL REFERENCES organizations(id),
  shop_id             uuid NOT NULL REFERENCES shops(id),
  menu_id             uuid NOT NULL REFERENCES menus(id),
  date                date NOT NULL,
  count               int NOT NULL DEFAULT 0,
  sales               bigint NOT NULL DEFAULT 0,
  computed_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, menu_id, date)
);

CREATE TABLE analytics_daily_source (
  organization_id     uuid NOT NULL REFERENCES organizations(id),
  shop_id             uuid NOT NULL REFERENCES shops(id),
  source              text NOT NULL,
  date                date NOT NULL,
  appointment_count   int NOT NULL DEFAULT 0,
  completed_count     int NOT NULL DEFAULT 0,
  sales               bigint NOT NULL DEFAULT 0,
  computed_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, source, date)
);

CREATE TABLE customer_scores (
  customer_id            uuid PRIMARY KEY REFERENCES customers(id),
  organization_id        uuid NOT NULL REFERENCES organizations(id),
  churn_risk             numeric(5,4) NOT NULL,     -- 0..1
  churn_risk_level       text NOT NULL CHECK (churn_risk_level IN ('low','medium','high')),
  predicted_next_visit   date,
  expected_ltv_12m       int,
  recommended_action     text,
  features               jsonb NOT NULL DEFAULT '{}'::jsonb,
  model_version          text NOT NULL,
  computed_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_scores_risk_idx ON customer_scores(organization_id, churn_risk DESC);

-- AI-generated suggestions always require human approval before any external send
CREATE TABLE ai_suggestions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  kind             text NOT NULL CHECK (kind IN ('message_draft','review_reply','karte_summary','sales_forecast','next_action')),
  subject_type     text NOT NULL,
  subject_id       uuid,
  input            jsonb NOT NULL DEFAULT '{}'::jsonb,
  output           jsonb NOT NULL DEFAULT '{}'::jsonb,
  provider         text NOT NULL,   -- heuristic / anthropic
  model            text,
  status           text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','accepted','rejected','applied')),
  decided_by       uuid,
  decided_at       timestamptz,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_suggestions_subject_idx ON ai_suggestions(subject_type, subject_id);
