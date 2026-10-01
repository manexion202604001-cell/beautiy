-- =====================================================================
-- 0003 Customers (CRM), identities, relations, merge history
-- =====================================================================
CREATE TABLE customers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations(id),
  customer_number    text,                    -- 店舗運用上の顧客番号(任意)
  last_name          text NOT NULL DEFAULT '',
  first_name         text NOT NULL DEFAULT '',
  last_name_kana     text NOT NULL DEFAULT '',
  first_name_kana    text NOT NULL DEFAULT '',
  gender             text CHECK (gender IN ('female','male','other','unknown')),
  birthday           date,
  phone              text,
  phone_normalized   text,                    -- E.164 (+81...)
  email              citext,
  postal_code        text,
  address            text,
  occupation         text,
  acquisition_source text,                    -- 来店きっかけ
  primary_shop_id    uuid REFERENCES shops(id),
  primary_staff_id   uuid REFERENCES staffs(id),
  marketing_opt_in   boolean NOT NULL DEFAULT true,
  -- denormalized visit stats (maintained by application on transaction completion)
  first_visit_at     timestamptz,
  last_visit_at      timestamptz,
  visit_count        int NOT NULL DEFAULT 0,
  total_sales        bigint NOT NULL DEFAULT 0,
  avg_cycle_days     numeric(8,2),
  next_appointment_at timestamptz,
  point_balance      int NOT NULL DEFAULT 0,
  no_show_count      int NOT NULL DEFAULT 0,
  cancel_count       int NOT NULL DEFAULT 0,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','merged','blocked','deleted')),
  merged_into_id     uuid REFERENCES customers(id),
  attributes         jsonb NOT NULL DEFAULT '{}'::jsonb, -- 髪質・アレルギー等の構造化属性
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid,
  updated_by         uuid,
  trace_id           text,
  deleted_at         timestamptz,
  search_text        text GENERATED ALWAYS AS (
    normalize_search_text(last_name || first_name || ' ' || last_name_kana || first_name_kana || ' ' || coalesce(phone_normalized,'') || ' ' || coalesce(email::text,'') || ' ' || coalesce(customer_number,''))
  ) STORED
);
CREATE INDEX customers_org_idx ON customers(organization_id) WHERE deleted_at IS NULL;
CREATE INDEX customers_phone_idx ON customers(organization_id, phone_normalized) WHERE phone_normalized IS NOT NULL;
CREATE INDEX customers_email_idx ON customers(organization_id, email) WHERE email IS NOT NULL;
CREATE INDEX customers_search_trgm ON customers USING gin (search_text gin_trgm_ops);
CREATE INDEX customers_last_visit_idx ON customers(organization_id, last_visit_at);
CREATE INDEX customers_birthday_month_idx ON customers(organization_id, (extract(month FROM birthday)));
CREATE UNIQUE INDEX customers_number_idx ON customers(organization_id, customer_number) WHERE customer_number IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE tags (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  name             text NOT NULL,
  color            text NOT NULL DEFAULT '#64748b',
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

CREATE TABLE customer_tags (
  customer_id      uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  tag_id           uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, tag_id)
);
CREATE INDEX customer_tags_tag_idx ON customer_tags(tag_id);

CREATE TABLE customer_memos (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  customer_id      uuid NOT NULL REFERENCES customers(id),
  staff_id         uuid NOT NULL REFERENCES staffs(id),
  body             text NOT NULL,
  -- private: author only (even owner cannot read) / shared: anyone with customer.read
  visibility       text NOT NULL DEFAULT 'shared' CHECK (visibility IN ('shared','private')),
  pinned           boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz
);
CREATE INDEX customer_memos_customer_idx ON customer_memos(customer_id, created_at DESC);

-- External identifiers: LINE userId, booking-media member id, etc.
CREATE TABLE customer_identities (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations(id),
  customer_id         uuid NOT NULL REFERENCES customers(id),
  provider            text NOT NULL,   -- line / mock_booking / hotpepper / google / web
  provider_account_id text NOT NULL DEFAULT '', -- e.g. LINE channel id (userId is per provider)
  external_id         text NOT NULL,
  display_name        text,
  profile             jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_following        boolean,         -- LINE follow state
  linked_at           timestamptz NOT NULL DEFAULT now(),
  unlinked_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX customer_identities_unique ON customer_identities(organization_id, provider, provider_account_id, external_id);
CREATE INDEX customer_identities_customer_idx ON customer_identities(customer_id);

CREATE TABLE customer_shop_relations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  customer_id      uuid NOT NULL REFERENCES customers(id),
  shop_id          uuid NOT NULL REFERENCES shops(id),
  staff_id         uuid REFERENCES staffs(id),
  relation_type    text NOT NULL CHECK (relation_type IN ('primary_staff','assigned','visited')),
  started_at       timestamptz NOT NULL DEFAULT now(),
  ended_at         timestamptz,
  end_reason       text,  -- transfer / retire / customer_request
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX csr_customer_idx ON customer_shop_relations(customer_id);
CREATE INDEX csr_staff_idx ON customer_shop_relations(staff_id) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX csr_active_unique ON customer_shop_relations(customer_id, shop_id, relation_type, coalesce(staff_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE ended_at IS NULL;

CREATE TABLE customer_channel_preferences (
  customer_id            uuid NOT NULL REFERENCES customers(id),
  organization_id        uuid NOT NULL REFERENCES organizations(id),
  channel                text NOT NULL CHECK (channel IN ('line','email','sms')),
  marketing_allowed      boolean NOT NULL DEFAULT true,
  transactional_allowed  boolean NOT NULL DEFAULT true,
  source                 text,   -- unfollow / customer_request / staff
  updated_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, channel)
);

CREATE TABLE customer_merge_logs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations(id),
  source_customer_id  uuid NOT NULL REFERENCES customers(id),
  target_customer_id  uuid NOT NULL REFERENCES customers(id),
  reason              text,
  match_rule          text,               -- exact_phone / exact_line / manual ...
  -- {table: [row ids moved]} + source snapshot, enables undo
  relinked            jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_snapshot     jsonb NOT NULL,
  target_snapshot     jsonb NOT NULL,
  merged_by           uuid,
  merged_at           timestamptz NOT NULL DEFAULT now(),
  undone_at           timestamptz,
  undone_by           uuid
);
CREATE INDEX cml_target_idx ON customer_merge_logs(target_customer_id);

CREATE TABLE customer_duplicate_dismissals (
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  customer_a_id    uuid NOT NULL REFERENCES customers(id),
  customer_b_id    uuid NOT NULL REFERENCES customers(id),
  dismissed_by     uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_a_id, customer_b_id),
  CHECK (customer_a_id < customer_b_id)
);

CREATE TRIGGER customers_updated BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER customer_memos_updated BEFORE UPDATE ON customer_memos FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER customer_identities_updated BEFORE UPDATE ON customer_identities FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER csr_updated BEFORE UPDATE ON customer_shop_relations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
