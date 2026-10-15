-- =====================================================================
-- 0175 Walk-in intakes (SALOGIC parity: 同意書一覧（受付保留）)
--   A customer without a reservation scans the shop's (or a staff member's) reception QR,
--   enters name / kana / birthday / phone / occupation / visit reason, agrees to the consent
--   form and may go on to fill the counselling sheet. The submission waits here until staff
--   link it to an existing customer, register a new customer from it, or discard it.
--   form_responses.customer_id is NOT NULL, so the signed consent is kept on this row
--   (same snapshot / answers / document hash as a form response) and copied into
--   form_responses when the intake is linked; the counselling answers are then merged into
--   the customer's counselling sheet (customer_counseling_sheets, per category).
-- =====================================================================
CREATE TABLE walkin_intakes (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id            uuid NOT NULL REFERENCES organizations(id),
  shop_id                    uuid NOT NULL REFERENCES shops(id),
  staff_id                   uuid REFERENCES staffs(id),          -- staff whose QR was scanned
  last_name                  text NOT NULL DEFAULT '',
  first_name                 text NOT NULL DEFAULT '',
  last_name_kana             text NOT NULL DEFAULT '',
  first_name_kana            text NOT NULL DEFAULT '',
  birthday                   date,
  phone                      text,
  phone_normalized           text,
  occupation                 text,
  visit_reason               text,                               -- ご来店のきっかけ
  -- consent as submitted (immutable once written; mirrors form_responses)
  consent_template_id        uuid NOT NULL REFERENCES form_templates(id),
  consent_template_version   int NOT NULL,
  consent_snapshot           jsonb NOT NULL,
  consent_answers            jsonb NOT NULL DEFAULT '{}'::jsonb,
  consent_signature_file_id  uuid REFERENCES files(id),
  consent_signer_name        text,
  consent_signed_at          timestamptz,
  consent_submitted_at       timestamptz NOT NULL,
  consent_document_hash      text NOT NULL,
  -- counselling sheet filled after the consent, same shape as customer_counseling_sheets.data:
  -- { <category id>: { <question id>: string | string[] } }
  counseling_data            jsonb NOT NULL DEFAULT '{}'::jsonb,
  counseling_submitted_at    timestamptz,
  ip                         inet,
  user_agent                 text,
  status                     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','linked','created','discarded')),
  customer_id                uuid REFERENCES customers(id),      -- set when linked / created
  consent_response_id        uuid REFERENCES form_responses(id), -- the form response created from the consent
  resolved_at                timestamptz,
  resolved_by                uuid,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  search_text                text GENERATED ALWAYS AS (
    normalize_search_text(last_name || first_name || ' ' || last_name_kana || first_name_kana || ' ' || coalesce(phone_normalized,'') || ' ' || coalesce(phone,''))
  ) STORED,
  CHECK ((status IN ('linked','created')) = (customer_id IS NOT NULL))
);
CREATE INDEX walkin_intakes_shop_idx ON walkin_intakes(organization_id, shop_id, status, consent_submitted_at DESC);
CREATE INDEX walkin_intakes_customer_idx ON walkin_intakes(customer_id) WHERE customer_id IS NOT NULL;
CREATE TRIGGER walkin_intakes_updated BEFORE UPDATE ON walkin_intakes FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE walkin_intakes ENABLE ROW LEVEL SECURITY;
ALTER TABLE walkin_intakes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON walkin_intakes USING (app_bypass_rls() OR organization_id = app_current_org()) WITH CHECK (app_bypass_rls() OR organization_id = app_current_org());
