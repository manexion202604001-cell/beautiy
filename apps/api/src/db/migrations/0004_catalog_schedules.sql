-- =====================================================================
-- 0004 Catalog (menus, resources, coupons) & schedules
-- =====================================================================
CREATE TABLE menu_categories (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  shop_id          uuid REFERENCES shops(id),
  name             text NOT NULL,
  sort_order       int NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz
);

-- shop_id NULL = 法人共通メニュー; overrides per shop in menu_shop_overrides
CREATE TABLE menus (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations(id),
  shop_id            uuid REFERENCES shops(id),
  category_id        uuid REFERENCES menu_categories(id),
  name               text NOT NULL,
  description        text,
  duration_min       int NOT NULL CHECK (duration_min > 0 AND duration_min <= 720),
  buffer_before_min  int NOT NULL DEFAULT 0 CHECK (buffer_before_min >= 0),
  buffer_after_min   int NOT NULL DEFAULT 0 CHECK (buffer_after_min >= 0),
  price              int NOT NULL CHECK (price >= 0),
  price_tax_included boolean NOT NULL DEFAULT true,
  tax_rate_bp        int NOT NULL DEFAULT 1000 CHECK (tax_rate_bp >= 0), -- basis points: 1000 = 10.00%
  is_public          boolean NOT NULL DEFAULT true,   -- Web/LINE予約に表示
  is_consultation    boolean NOT NULL DEFAULT false,  -- 相談予約
  new_customer_only  boolean NOT NULL DEFAULT false,
  image_file_id      uuid,
  sort_order         int NOT NULL DEFAULT 0,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid,
  updated_by         uuid,
  trace_id           text,
  deleted_at         timestamptz
);
CREATE INDEX menus_org_shop_idx ON menus(organization_id, shop_id);

CREATE TABLE menu_shop_overrides (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  menu_id          uuid NOT NULL REFERENCES menus(id),
  shop_id          uuid NOT NULL REFERENCES shops(id),
  price            int CHECK (price >= 0),
  duration_min     int CHECK (duration_min > 0),
  is_available     boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (menu_id, shop_id)
);

-- Which staff can perform which menu (empty for a staff = all menus)
CREATE TABLE staff_menus (
  staff_id         uuid NOT NULL REFERENCES staffs(id) ON DELETE CASCADE,
  menu_id          uuid NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  duration_min     int CHECK (duration_min > 0),  -- per-staff duration override
  price            int CHECK (price >= 0),        -- per-staff price (ランク別料金)
  PRIMARY KEY (staff_id, menu_id)
);

-- Seats / shampoo stations / rooms / equipment. Each row is ONE unit (capacity 1).
CREATE TABLE resources (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  shop_id          uuid NOT NULL REFERENCES shops(id),
  name             text NOT NULL,
  resource_type    text NOT NULL,  -- seat / shampoo / room / equipment
  sort_order       int NOT NULL DEFAULT 0,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz
);
CREATE INDEX resources_shop_idx ON resources(shop_id, resource_type);

CREATE TABLE menu_resource_requirements (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  menu_id          uuid NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
  resource_type    text NOT NULL,
  offset_min       int NOT NULL DEFAULT 0 CHECK (offset_min >= 0),
  duration_min     int CHECK (duration_min > 0), -- NULL = whole menu duration
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Weekly business hours (multiple rows per weekday allowed: e.g. lunch break)
CREATE TABLE shop_business_hours (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  shop_id          uuid NOT NULL REFERENCES shops(id),
  weekday          smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6), -- 0=Sunday
  open_time        time NOT NULL,
  close_time       time NOT NULL,
  CHECK (close_time > open_time)
);
CREATE INDEX sbh_shop_idx ON shop_business_hours(shop_id, weekday);

-- Holidays / special hours
CREATE TABLE shop_calendar_exceptions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  shop_id          uuid NOT NULL REFERENCES shops(id),
  date             date NOT NULL,
  is_closed        boolean NOT NULL DEFAULT true,
  open_time        time,
  close_time       time,
  note             text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, date),
  CHECK (is_closed OR (open_time IS NOT NULL AND close_time IS NOT NULL AND close_time > open_time))
);

-- Default weekly working pattern per staff per shop
CREATE TABLE staff_weekly_schedules (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  staff_id         uuid NOT NULL REFERENCES staffs(id),
  shop_id          uuid NOT NULL REFERENCES shops(id),
  weekday          smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time       time NOT NULL,
  end_time         time NOT NULL,
  CHECK (end_time > start_time)
);
CREATE INDEX sws_staff_idx ON staff_weekly_schedules(staff_id, weekday);

-- Date-specific shifts. If any row exists for (staff, date), it replaces the weekly pattern.
CREATE TABLE staff_shifts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  staff_id         uuid NOT NULL REFERENCES staffs(id),
  shop_id          uuid NOT NULL REFERENCES shops(id),
  date             date NOT NULL,
  shift_type       text NOT NULL DEFAULT 'work' CHECK (shift_type IN ('work','off')),
  start_time       time,
  end_time         time,
  note             text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (shift_type = 'off' OR (start_time IS NOT NULL AND end_time IS NOT NULL AND end_time > start_time))
);
CREATE INDEX staff_shifts_staff_date_idx ON staff_shifts(staff_id, date);

-- Ad-hoc blocks (meetings, training, breaks)
CREATE TABLE schedule_blocks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  shop_id          uuid NOT NULL REFERENCES shops(id),
  staff_id         uuid REFERENCES staffs(id),
  resource_id      uuid REFERENCES resources(id),
  start_at         timestamptz NOT NULL,
  end_at           timestamptz NOT NULL,
  reason           text,
  source           text NOT NULL DEFAULT 'manual', -- manual / external
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > start_at),
  CHECK (staff_id IS NOT NULL OR resource_id IS NOT NULL)
);
CREATE INDEX schedule_blocks_staff_idx ON schedule_blocks USING gist (staff_id, tstzrange(start_at, end_at));

CREATE TABLE coupons (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations(id),
  shop_id             uuid REFERENCES shops(id),
  code                citext,
  name                text NOT NULL,
  description         text,
  discount_type       text NOT NULL CHECK (discount_type IN ('amount','percent','fixed_price')),
  discount_value      int NOT NULL CHECK (discount_value >= 0),
  applicable_menu_ids uuid[] NOT NULL DEFAULT '{}',
  min_amount          int NOT NULL DEFAULT 0,
  valid_from          timestamptz,
  valid_until         timestamptz,
  usage_limit         int,
  per_customer_limit  int,
  new_customer_only   boolean NOT NULL DEFAULT false,
  is_public           boolean NOT NULL DEFAULT true,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  CHECK (discount_type <> 'percent' OR discount_value <= 100)
);
CREATE UNIQUE INDEX coupons_code_idx ON coupons(organization_id, code) WHERE code IS NOT NULL AND deleted_at IS NULL;

CREATE TRIGGER menu_categories_updated BEFORE UPDATE ON menu_categories FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER menus_updated BEFORE UPDATE ON menus FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER mso_updated BEFORE UPDATE ON menu_shop_overrides FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER resources_updated BEFORE UPDATE ON resources FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER staff_shifts_updated BEFORE UPDATE ON staff_shifts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER coupons_updated BEFORE UPDATE ON coupons FOR EACH ROW EXECUTE FUNCTION set_updated_at();
