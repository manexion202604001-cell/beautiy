-- =====================================================================
-- 0008 LINE CRM / messaging: channels, templates, messages, campaigns, automations
-- =====================================================================
-- A LINE official account may belong to the organization (shop_id NULL) or to one shop.
CREATE TABLE line_channels (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         uuid NOT NULL REFERENCES organizations(id),
  shop_id                 uuid REFERENCES shops(id),
  channel_id              text NOT NULL UNIQUE,  -- Messaging API channel id (webhook "destination" maps via bot_user_id)
  bot_user_id             text UNIQUE,           -- webhook destination
  name                    text NOT NULL,
  basic_id                text,                  -- @xxxx
  liff_id                 text,
  login_channel_id        text,                  -- LINE Login channel for LIFF id token verification
  encrypted_channel_secret text NOT NULL,
  encrypted_access_token  text NOT NULL,
  status                  text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','error')),
  webhook_verified_at     timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE message_templates (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  shop_id          uuid REFERENCES shops(id),
  key              text,             -- system templates: booking_confirmed / reminder_day_before ...
  name             text NOT NULL,
  channel          text NOT NULL DEFAULT 'line' CHECK (channel IN ('line','email','sms')),
  category         text NOT NULL CHECK (category IN ('transactional','marketing','followup','review','other')),
  subject          text,             -- email
  body             text NOT NULL,    -- supports {{customer.name}} style variables
  payload          jsonb,            -- optional LINE flex/template json
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX message_templates_key_idx ON message_templates(organization_id, coalesce(shop_id, '00000000-0000-0000-0000-000000000000'::uuid), key, channel) WHERE key IS NOT NULL;

CREATE TABLE segments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  name             text NOT NULL,
  description      text,
  rule             jsonb NOT NULL,   -- segment DSL (see messaging/segments.ts)
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE campaigns (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  shop_id          uuid REFERENCES shops(id),
  name             text NOT NULL,
  channel          text NOT NULL DEFAULT 'line' CHECK (channel IN ('line','email','sms')),
  segment_id       uuid REFERENCES segments(id),
  segment_rule     jsonb NOT NULL,   -- snapshot of the rule used
  template_id      uuid REFERENCES message_templates(id),
  body             text,             -- inline body when no template
  scheduled_at     timestamptz,
  status           text NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','scheduled','running','completed','cancelled','failed')),
  stats            jsonb NOT NULL DEFAULT '{}'::jsonb, -- {targets, queued, sent, failed, skipped}
  approved_by      uuid,
  approved_at      timestamptz,
  started_at       timestamptz,
  completed_at     timestamptz,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE automations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  shop_id          uuid REFERENCES shops(id),
  name             text NOT NULL,
  trigger_type     text NOT NULL CHECK (trigger_type IN (
                     'days_since_last_visit',          -- 休眠
                     'no_return_after_first_visit',    -- 初回後未再来
                     'visit_cycle_due',                -- 来店周期到来
                     'after_visit',                    -- 来店後フォロー
                     'birthday_month')),
  config           jsonb NOT NULL DEFAULT '{}'::jsonb, -- {days: 45, require_no_future_appointment: true, send_hour: 11}
  channel          text NOT NULL DEFAULT 'line' CHECK (channel IN ('line','email','sms')),
  template_id      uuid REFERENCES message_templates(id),
  is_active        boolean NOT NULL DEFAULT false,
  last_run_at      timestamptz,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations(id),
  shop_id             uuid REFERENCES shops(id),
  customer_id         uuid REFERENCES customers(id),
  channel             text NOT NULL CHECK (channel IN ('line','email','sms')),
  direction           text NOT NULL CHECK (direction IN ('outbound','inbound')),
  category            text NOT NULL DEFAULT 'transactional' CHECK (category IN ('transactional','marketing','conversation','system')),
  message_type        text NOT NULL DEFAULT 'text',
  body                text,
  payload             jsonb,
  template_id         uuid REFERENCES message_templates(id),
  campaign_id         uuid REFERENCES campaigns(id),
  automation_id       uuid REFERENCES automations(id),
  appointment_id      uuid REFERENCES appointments(id),
  line_channel_id     uuid REFERENCES line_channels(id),
  recipient           text,              -- LINE userId / email / phone at send time
  status              text NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued','sending','sent','failed','skipped','received','read','cancelled')),
  skip_reason         text,              -- opted_out / no_identity / quiet_hours
  provider_message_id text,
  error               text,
  attempts            int NOT NULL DEFAULT 0,
  next_attempt_at     timestamptz,
  scheduled_at        timestamptz,
  sent_at             timestamptz,
  read_at             timestamptz,
  sent_by_staff_id    uuid REFERENCES staffs(id),
  dedupe_key          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX messages_dedupe_idx ON messages(organization_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX messages_customer_idx ON messages(customer_id, created_at DESC);
CREATE INDEX messages_campaign_idx ON messages(campaign_id);
CREATE INDEX messages_status_idx ON messages(status, next_attempt_at) WHERE status IN ('queued','failed');

CREATE TABLE automation_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  automation_id    uuid NOT NULL REFERENCES automations(id),
  customer_id      uuid NOT NULL REFERENCES customers(id),
  dedupe_key       text NOT NULL,   -- prevents duplicate sends for the same visit cycle
  message_id       uuid REFERENCES messages(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (automation_id, dedupe_key)
);

CREATE TRIGGER line_channels_updated BEFORE UPDATE ON line_channels FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER message_templates_updated BEFORE UPDATE ON message_templates FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER segments_updated BEFORE UPDATE ON segments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER campaigns_updated BEFORE UPDATE ON campaigns FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER automations_updated BEFORE UPDATE ON automations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER messages_updated BEFORE UPDATE ON messages FOR EACH ROW EXECUTE FUNCTION set_updated_at();
