-- =====================================================================
-- 0006 Files (object storage metadata), kartes, forms, consents, access tokens
-- =====================================================================
CREATE TABLE files (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  object_key       text NOT NULL UNIQUE,
  purpose          text NOT NULL, -- karte_photo / sketch / signature / product_image / staff_photo / export / sns_asset
  content_type     text NOT NULL,
  size_bytes       bigint,
  checksum_sha256  text,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','uploaded','deleted')),
  uploaded_by      uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  uploaded_at      timestamptz,
  deleted_at       timestamptz
);
CREATE INDEX files_org_idx ON files(organization_id, purpose);

CREATE TABLE karte_templates (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  shop_id          uuid REFERENCES shops(id),
  name             text NOT NULL,
  category         text,  -- cut / color / perm / eyelash / nail / esthe
  fields           jsonb NOT NULL DEFAULT '[]'::jsonb, -- [{key,label,type,options,required}]
  is_default       boolean NOT NULL DEFAULT false,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE kartes (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES organizations(id),
  shop_id              uuid NOT NULL REFERENCES shops(id),
  customer_id          uuid NOT NULL REFERENCES customers(id),
  appointment_id       uuid REFERENCES appointments(id),
  staff_id             uuid NOT NULL REFERENCES staffs(id),
  template_id          uuid REFERENCES karte_templates(id),
  visit_date           date NOT NULL,
  fields               jsonb NOT NULL DEFAULT '{}'::jsonb,
  chemicals            jsonb NOT NULL DEFAULT '[]'::jsonb, -- [{name, brand, ratio, processing_min, note}]
  note                 text,
  homecare             jsonb NOT NULL DEFAULT '{}'::jsonb, -- {advice, product_ids[]}
  shared_with_customer boolean NOT NULL DEFAULT false,
  shared_at            timestamptz,
  version              int NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid,
  updated_by           uuid,
  trace_id             text,
  deleted_at           timestamptz
);
CREATE INDEX kartes_customer_idx ON kartes(customer_id, visit_date DESC);
CREATE INDEX kartes_appointment_idx ON kartes(appointment_id);

CREATE TABLE karte_assets (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations(id),
  karte_id            uuid NOT NULL REFERENCES kartes(id),
  customer_id         uuid NOT NULL REFERENCES customers(id),
  file_id             uuid NOT NULL REFERENCES files(id),
  object_key          text NOT NULL,
  asset_type          text NOT NULL CHECK (asset_type IN ('photo_before','photo_after','photo','sketch','document')),
  caption             text,
  share_with_customer boolean NOT NULL DEFAULT false,
  sort_order          int NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid,
  deleted_at          timestamptz
);
CREATE INDEX karte_assets_karte_idx ON karte_assets(karte_id);
CREATE INDEX karte_assets_customer_idx ON karte_assets(customer_id);

-- Counseling sheets, consent forms, pre-visit questionnaires (versioned)
CREATE TABLE form_templates (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations(id),
  shop_id            uuid REFERENCES shops(id),
  kind               text NOT NULL CHECK (kind IN ('counseling','consent','pre_visit')),
  name               text NOT NULL,
  fields             jsonb NOT NULL DEFAULT '[]'::jsonb,
  body_markdown      text,               -- consent text
  version            int NOT NULL DEFAULT 1,
  requires_signature boolean NOT NULL DEFAULT false,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','archived')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE form_responses (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations(id),
  template_id         uuid NOT NULL REFERENCES form_templates(id),
  template_version    int NOT NULL,
  template_snapshot   jsonb NOT NULL,     -- fields + consent body at time of signing
  customer_id         uuid NOT NULL REFERENCES customers(id),
  appointment_id      uuid REFERENCES appointments(id),
  karte_id            uuid REFERENCES kartes(id),
  answers             jsonb NOT NULL DEFAULT '{}'::jsonb,
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','submitted','voided')),
  submitted_via       text CHECK (submitted_via IN ('staff','customer_link','line')),
  signature_file_id   uuid REFERENCES files(id),
  signer_name         text,
  signed_at           timestamptz,
  -- sha256(template_snapshot || answers || signature) for tamper evidence
  document_hash       text,
  ip                  inet,
  user_agent          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid
);
CREATE INDEX form_responses_customer_idx ON form_responses(customer_id, created_at DESC);

-- Opaque single-purpose links (pre-visit form, karte share, review request, LINE link...)
CREATE TABLE access_tokens (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  purpose          text NOT NULL CHECK (purpose IN ('pre_visit_form','karte_share','review_request','line_link','booking_manage','product_share')),
  token_hash       text NOT NULL UNIQUE,
  resource_type    text NOT NULL,
  resource_id      uuid NOT NULL,
  customer_id      uuid REFERENCES customers(id),
  max_uses         int,
  use_count        int NOT NULL DEFAULT 0,
  expires_at       timestamptz NOT NULL,
  revoked_at       timestamptz,
  last_used_at     timestamptz,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX access_tokens_resource_idx ON access_tokens(resource_type, resource_id);

CREATE TRIGGER karte_templates_updated BEFORE UPDATE ON karte_templates FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER kartes_updated BEFORE UPDATE ON kartes FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER form_templates_updated BEFORE UPDATE ON form_templates FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER form_responses_updated BEFORE UPDATE ON form_responses FOR EACH ROW EXECUTE FUNCTION set_updated_at();
