-- =====================================================================
-- 0005 Appointments: double-booking prevention via EXCLUDE constraints
-- =====================================================================
CREATE TABLE appointments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations(id),
  shop_id             uuid NOT NULL REFERENCES shops(id),
  customer_id         uuid REFERENCES customers(id),
  staff_id            uuid REFERENCES staffs(id),
  is_nominated        boolean NOT NULL DEFAULT false,  -- 指名(true) / フリー(false)
  booking_reference   text NOT NULL,                   -- 顧客提示用予約番号
  start_at            timestamptz NOT NULL,            -- 施術開始
  end_at              timestamptz NOT NULL,            -- 施術終了
  occupied_start_at   timestamptz NOT NULL,            -- バッファ込み占有開始
  occupied_end_at     timestamptz NOT NULL,            -- バッファ込み占有終了
  status              text NOT NULL DEFAULT 'confirmed'
                      CHECK (status IN ('tentative','confirmed','checked_in','in_service','completed','cancelled','no_show')),
  source              text NOT NULL DEFAULT 'staff'
                      CHECK (source IN ('web','line','external','phone','walk_in','staff')),
  source_detail       jsonb NOT NULL DEFAULT '{}'::jsonb, -- provider, utm, referral_code ...
  coupon_id           uuid REFERENCES coupons(id),
  is_consultation     boolean NOT NULL DEFAULT false,
  customer_note       text,
  staff_note          text,
  estimated_total     int NOT NULL DEFAULT 0,
  cancel_reason       text,
  cancelled_at        timestamptz,
  cancelled_by_type   text CHECK (cancelled_by_type IN ('customer','staff','system','external')),
  confirmed_at        timestamptz,
  checked_in_at       timestamptz,
  completed_at        timestamptz,
  no_show_at          timestamptz,
  version             int NOT NULL DEFAULT 1,           -- optimistic locking
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid,
  updated_by          uuid,
  trace_id            text,
  deleted_at          timestamptz,
  CHECK (end_at > start_at),
  CHECK (occupied_start_at <= start_at AND occupied_end_at >= end_at),
  CONSTRAINT appointments_no_staff_overlap EXCLUDE USING gist (
    staff_id WITH =,
    tstzrange(occupied_start_at, occupied_end_at, '[)') WITH &&
  ) WHERE (staff_id IS NOT NULL AND deleted_at IS NULL AND status IN ('tentative','confirmed','checked_in','in_service','completed'))
);
CREATE UNIQUE INDEX appointments_reference_idx ON appointments(organization_id, booking_reference);
CREATE INDEX appointments_shop_time_idx ON appointments(shop_id, start_at);
CREATE INDEX appointments_customer_idx ON appointments(customer_id, start_at DESC);
CREATE INDEX appointments_staff_time_idx ON appointments(staff_id, start_at);

CREATE TABLE appointment_services (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  appointment_id   uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  menu_id          uuid REFERENCES menus(id),
  name             text NOT NULL,       -- snapshot
  duration_min     int NOT NULL CHECK (duration_min > 0),
  price            int NOT NULL CHECK (price >= 0),
  tax_rate_bp      int NOT NULL DEFAULT 1000,
  staff_id         uuid REFERENCES staffs(id),
  start_offset_min int NOT NULL DEFAULT 0,
  sort_order       int NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX appointment_services_appt_idx ON appointment_services(appointment_id);

CREATE TABLE appointment_resources (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  appointment_id   uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  resource_id      uuid NOT NULL REFERENCES resources(id),
  start_at         timestamptz NOT NULL,
  end_at           timestamptz NOT NULL,
  is_active        boolean NOT NULL DEFAULT true,  -- false when appointment cancelled
  CHECK (end_at > start_at),
  CONSTRAINT appointment_resources_no_overlap EXCLUDE USING gist (
    resource_id WITH =,
    tstzrange(start_at, end_at, '[)') WITH &&
  ) WHERE (is_active)
);
CREATE INDEX appointment_resources_appt_idx ON appointment_resources(appointment_id);

-- Event-sourced history; the same model is consumed by external sync & notifications
CREATE TABLE appointment_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  appointment_id   uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  event_type       text NOT NULL,   -- created / rescheduled / updated / cancelled / no_show / checked_in / completed / restored
  actor_type       text NOT NULL CHECK (actor_type IN ('staff','customer','system','external')),
  actor_id         uuid,
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  trace_id         text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX appointment_events_appt_idx ON appointment_events(appointment_id, created_at);

CREATE TABLE coupon_redemptions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  coupon_id        uuid NOT NULL REFERENCES coupons(id),
  customer_id      uuid REFERENCES customers(id),
  appointment_id   uuid REFERENCES appointments(id),
  transaction_id   uuid,
  status           text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','redeemed','released')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX coupon_redemptions_coupon_idx ON coupon_redemptions(coupon_id, customer_id);

CREATE TRIGGER appointments_updated BEFORE UPDATE ON appointments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER coupon_redemptions_updated BEFORE UPDATE ON coupon_redemptions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
