-- =====================================================================
-- 0010 Reviews, referral links, SNS assets
-- =====================================================================
CREATE TABLE review_requests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  shop_id          uuid NOT NULL REFERENCES shops(id),
  customer_id      uuid NOT NULL REFERENCES customers(id),
  appointment_id   uuid REFERENCES appointments(id),
  transaction_id   uuid REFERENCES transactions(id),
  staff_id         uuid REFERENCES staffs(id),
  access_token_id  uuid REFERENCES access_tokens(id),
  message_id       uuid REFERENCES messages(id),
  status           text NOT NULL DEFAULT 'created' CHECK (status IN ('created','sent','opened','submitted','expired')),
  opened_at        timestamptz,
  submitted_at     timestamptz,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX review_requests_tx_idx ON review_requests(transaction_id) WHERE transaction_id IS NOT NULL;

CREATE TABLE reviews (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations(id),
  shop_id            uuid NOT NULL REFERENCES shops(id),
  customer_id        uuid REFERENCES customers(id),
  staff_id           uuid REFERENCES staffs(id),
  appointment_id     uuid REFERENCES appointments(id),
  review_request_id  uuid REFERENCES review_requests(id),
  source             text NOT NULL DEFAULT 'internal' CHECK (source IN ('internal','google','external')),
  external_review_id text,
  rating             smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title              text,
  body               text,
  reviewer_name      text,               -- display name (nickname)
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','published','hidden')),
  reply_body         text,
  replied_at         timestamptz,
  replied_by         uuid,
  reply_synced_at    timestamptz,        -- pushed to Google
  posted_at          timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX reviews_external_idx ON reviews(organization_id, source, external_review_id) WHERE external_review_id IS NOT NULL;
CREATE INDEX reviews_shop_idx ON reviews(shop_id, posted_at DESC);
CREATE INDEX reviews_staff_idx ON reviews(staff_id, posted_at DESC);

CREATE TABLE referral_links (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  shop_id          uuid REFERENCES shops(id),
  staff_id         uuid REFERENCES staffs(id),
  customer_id      uuid REFERENCES customers(id),  -- お客様紹介
  code             text NOT NULL UNIQUE,
  name             text NOT NULL,
  target           text NOT NULL DEFAULT 'booking' CHECK (target IN ('booking','product','profile','review')),
  target_id        uuid,
  utm              jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {source, medium, campaign}
  is_active        boolean NOT NULL DEFAULT true,
  click_count      int NOT NULL DEFAULT 0,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE referral_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id),
  referral_link_id  uuid NOT NULL REFERENCES referral_links(id),
  event_type        text NOT NULL CHECK (event_type IN ('click','booking','purchase','signup')),
  appointment_id    uuid REFERENCES appointments(id),
  order_id          uuid REFERENCES orders(id),
  customer_id       uuid REFERENCES customers(id),
  amount            int,
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX referral_events_link_idx ON referral_events(referral_link_id, created_at DESC);

ALTER TABLE orders ADD CONSTRAINT orders_referral_fk FOREIGN KEY (referral_link_id) REFERENCES referral_links(id);

CREATE TABLE sns_assets (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  staff_id         uuid REFERENCES staffs(id),
  karte_asset_id   uuid REFERENCES karte_assets(id),
  template         text NOT NULL,     -- square_style / before_after / review_quote
  caption          text,
  hashtags         text[] NOT NULL DEFAULT '{}',
  file_id          uuid REFERENCES files(id),
  content          jsonb NOT NULL DEFAULT '{}'::jsonb,
  customer_consent boolean NOT NULL DEFAULT false, -- 写真掲載同意
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER review_requests_updated BEFORE UPDATE ON review_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER reviews_updated BEFORE UPDATE ON reviews FOR EACH ROW EXECUTE FUNCTION set_updated_at();
