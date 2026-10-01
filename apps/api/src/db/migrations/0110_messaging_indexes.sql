-- =====================================================================
-- 0110 messaging: access-path indexes for delivery, reminders, inbox and campaigns
-- =====================================================================
-- cancel queued reminders by appointment (cancelQueuedMessages)
CREATE INDEX messages_appointment_idx ON messages(appointment_id) WHERE appointment_id IS NOT NULL;
-- cancel queued messages by dedupe-key prefix ('appt:<id>:reminder:' / 'campaign:<id>:')
CREATE INDEX messages_dedupe_prefix_idx ON messages(organization_id, dedupe_key text_pattern_ops) WHERE dedupe_key IS NOT NULL AND status = 'queued';
-- inbox (latest message per customer) and unread inbound counts
CREATE INDEX messages_org_created_idx ON messages(organization_id, created_at DESC);
CREATE INDEX messages_unread_idx ON messages(customer_id) WHERE direction = 'inbound' AND status = 'received';
-- campaign fan-out / stats
CREATE INDEX messages_campaign_status_idx ON messages(campaign_id, status) WHERE campaign_id IS NOT NULL;
-- automation runs per customer
CREATE INDEX automation_runs_customer_idx ON automation_runs(customer_id);
-- LINE identity lookup at delivery time
CREATE INDEX customer_identities_line_idx ON customer_identities(customer_id, provider) WHERE unlinked_at IS NULL;
