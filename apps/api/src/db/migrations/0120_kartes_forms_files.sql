-- =====================================================================
-- 0120 kartes / files: file names, form template versioning (lineage),
--      form response void & submission metadata, immutability guard
-- =====================================================================

-- files: original file name (for download Content-Disposition) and who deleted it
ALTER TABLE files ADD COLUMN file_name text;
ALTER TABLE files ADD COLUMN deleted_by uuid;
CREATE INDEX files_pending_idx ON files(created_at) WHERE status = 'pending';

-- form_templates: every version of a template shares one lineage_id.
-- Editing an active template that already has responses inserts a new row (version + 1)
-- and archives the old one, so responses keep pointing at the exact version they answered.
ALTER TABLE form_templates ADD COLUMN lineage_id uuid;
ALTER TABLE form_templates ADD COLUMN created_by uuid;
ALTER TABLE form_templates ADD COLUMN updated_by uuid;
UPDATE form_templates SET lineage_id = id WHERE lineage_id IS NULL;

CREATE OR REPLACE FUNCTION form_templates_set_lineage() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.lineage_id IS NULL THEN
    NEW.lineage_id := NEW.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER form_templates_lineage BEFORE INSERT ON form_templates FOR EACH ROW EXECUTE FUNCTION form_templates_set_lineage();
ALTER TABLE form_templates ALTER COLUMN lineage_id SET NOT NULL;
CREATE UNIQUE INDEX form_templates_lineage_version_uq ON form_templates(lineage_id, version);
CREATE INDEX form_templates_org_idx ON form_templates(organization_id, kind, status);

CREATE INDEX karte_templates_org_idx ON karte_templates(organization_id, status);

-- form_responses: shop context, submission time, void metadata
ALTER TABLE form_responses ADD COLUMN shop_id uuid REFERENCES shops(id);
ALTER TABLE form_responses ADD COLUMN submitted_at timestamptz;
ALTER TABLE form_responses ADD COLUMN voided_at timestamptz;
ALTER TABLE form_responses ADD COLUMN voided_by uuid;
ALTER TABLE form_responses ADD COLUMN void_reason text;
CREATE INDEX form_responses_appointment_idx ON form_responses(appointment_id);
CREATE INDEX form_responses_signature_idx ON form_responses(signature_file_id);
CREATE INDEX karte_assets_file_idx ON karte_assets(file_id);

-- Submitted consent documents are immutable (tamper evidence, 電子署名).
-- Allowed after submission: submitted -> voided (+ void metadata), and customer_id relinking (customer merge).
CREATE OR REPLACE FUNCTION form_responses_guard_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('submitted', 'voided') THEN
    IF NEW.template_id IS DISTINCT FROM OLD.template_id
       OR NEW.template_version IS DISTINCT FROM OLD.template_version
       OR NEW.template_snapshot IS DISTINCT FROM OLD.template_snapshot
       OR NEW.answers IS DISTINCT FROM OLD.answers
       OR NEW.signature_file_id IS DISTINCT FROM OLD.signature_file_id
       OR NEW.signer_name IS DISTINCT FROM OLD.signer_name
       OR NEW.signed_at IS DISTINCT FROM OLD.signed_at
       OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
       OR NEW.document_hash IS DISTINCT FROM OLD.document_hash
       OR NEW.submitted_via IS DISTINCT FROM OLD.submitted_via
       OR NEW.appointment_id IS DISTINCT FROM OLD.appointment_id
       OR NEW.karte_id IS DISTINCT FROM OLD.karte_id
       OR NEW.ip IS DISTINCT FROM OLD.ip
       OR NEW.user_agent IS DISTINCT FROM OLD.user_agent THEN
      RAISE EXCEPTION 'form response % is immutable', OLD.id USING ERRCODE = 'check_violation', CONSTRAINT = 'form_responses_immutable';
    END IF;
    IF OLD.status = 'voided' AND NEW.status <> 'voided' THEN
      RAISE EXCEPTION 'voided form response % cannot be restored', OLD.id USING ERRCODE = 'check_violation', CONSTRAINT = 'form_responses_immutable';
    END IF;
    IF OLD.status = 'submitted' AND NEW.status NOT IN ('submitted', 'voided') THEN
      RAISE EXCEPTION 'submitted form response % cannot go back to %', OLD.id, NEW.status USING ERRCODE = 'check_violation', CONSTRAINT = 'form_responses_immutable';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER form_responses_immutable BEFORE UPDATE ON form_responses FOR EACH ROW EXECUTE FUNCTION form_responses_guard_immutable();

CREATE OR REPLACE FUNCTION form_responses_guard_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('submitted', 'voided') THEN
    RAISE EXCEPTION 'form response % cannot be deleted', OLD.id USING ERRCODE = 'check_violation', CONSTRAINT = 'form_responses_immutable';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER form_responses_no_delete BEFORE DELETE ON form_responses FOR EACH ROW EXECUTE FUNCTION form_responses_guard_delete();
