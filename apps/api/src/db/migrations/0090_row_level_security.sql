-- =====================================================================
-- 0090 Row Level Security: defense-in-depth tenant isolation
--   Every table with organization_id gets a policy:
--     organization_id = app_current_org() OR app_bypass_rls()
--   FORCE RLS makes it apply to the table owner (the app role) too.
--   Tables with nullable organization_id (system rows) allow reading NULL rows.
-- =====================================================================
DO $$
DECLARE
  r record;
  nullable_shared text[] := ARRAY['roles','role_permissions','feature_flags'];
BEGIN
  FOR r IN
    SELECT c.table_name, c.is_nullable
    FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
    WHERE c.table_schema = 'public' AND c.column_name = 'organization_id' AND t.table_type = 'BASE TABLE'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', r.table_name);
    IF r.table_name = ANY(nullable_shared) THEN
      EXECUTE format($p$CREATE POLICY tenant_read ON %I FOR SELECT USING (app_bypass_rls() OR organization_id IS NULL OR organization_id = app_current_org())$p$, r.table_name);
      EXECUTE format($p$CREATE POLICY tenant_write ON %I FOR ALL USING (app_bypass_rls() OR organization_id = app_current_org()) WITH CHECK (app_bypass_rls() OR organization_id = app_current_org())$p$, r.table_name);
    ELSE
      EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING (app_bypass_rls() OR organization_id = app_current_org()) WITH CHECK (app_bypass_rls() OR organization_id = app_current_org())$p$, r.table_name);
    END IF;
  END LOOP;
END $$;

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON organizations USING (app_bypass_rls() OR id = app_current_org()) WITH CHECK (app_bypass_rls() OR id = app_current_org());
