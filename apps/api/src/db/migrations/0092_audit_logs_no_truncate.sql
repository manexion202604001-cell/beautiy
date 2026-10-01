-- audit_logs is append-only: also block TRUNCATE (row triggers do not fire for TRUNCATE)
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON audit_logs FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_immutable();
