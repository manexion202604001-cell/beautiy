-- =====================================================================
-- 0150 Analytics / AI: refund column on daily aggregates + read-path indexes
--   (no new tables → no new RLS policies needed)
-- =====================================================================

-- Refunds attributed to the original transaction's sales date (sales_total is already net of refunds)
ALTER TABLE analytics_daily_shop ADD COLUMN refund_total bigint NOT NULL DEFAULT 0;

-- Customer-level analytics (LTV / cohorts / new-repeat-lost) scan counted visits per customer
CREATE INDEX transactions_counted_customer_idx
  ON transactions(organization_id, customer_id, completed_at)
  WHERE status IN ('completed', 'partially_refunded') AND customer_id IS NOT NULL;

-- Range scans of aggregates across shops of an organization
CREATE INDEX analytics_daily_shop_org_date_idx ON analytics_daily_shop(organization_id, date);
CREATE INDEX analytics_daily_staff_org_date_idx ON analytics_daily_staff(organization_id, date);

-- AI
CREATE INDEX customer_scores_level_idx ON customer_scores(organization_id, churn_risk_level, churn_risk DESC);
CREATE INDEX ai_suggestions_org_created_idx ON ai_suggestions(organization_id, created_at DESC, id DESC);
