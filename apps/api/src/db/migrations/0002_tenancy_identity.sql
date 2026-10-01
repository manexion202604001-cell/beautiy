-- =====================================================================
-- 0002 Tenancy & identity: organizations, shops, users, staffs, roles
-- =====================================================================
CREATE TABLE organizations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  slug          citext NOT NULL UNIQUE,
  plan          text NOT NULL DEFAULT 'standard' CHECK (plan IN ('solo','standard','pro','enterprise')),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('trial','active','suspended','cancelled')),
  currency      char(3) NOT NULL DEFAULT 'JPY',
  timezone      text NOT NULL DEFAULT 'Asia/Tokyo',
  invoice_registration_number text, -- 適格請求書発行事業者登録番号 (T+13桁)
  settings      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);

CREATE TABLE shops (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  name             text NOT NULL,
  slug             citext NOT NULL,
  timezone         text NOT NULL DEFAULT 'Asia/Tokyo',
  phone            text,
  email            text,
  postal_code      text,
  prefecture       text,
  city             text,
  address_line     text,
  description      text,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','closed')),
  public_booking_enabled boolean NOT NULL DEFAULT true,
  -- booking/reminder/pos settings; validated in application layer
  settings         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_by       uuid,
  trace_id         text,
  deleted_at       timestamptz,
  UNIQUE (organization_id, slug)
);
CREATE INDEX shops_org_idx ON shops(organization_id);
CREATE UNIQUE INDEX shops_public_slug_idx ON shops(slug) WHERE deleted_at IS NULL;

-- Global authentication identity (not tenant scoped; membership via staffs)
CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          citext NOT NULL UNIQUE,
  password_hash  text,
  display_name   text NOT NULL,
  auth_provider  text NOT NULL DEFAULT 'password' CHECK (auth_provider IN ('password','google','line')),
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','locked','disabled')),
  mfa_enabled    boolean NOT NULL DEFAULT false,
  failed_login_count int NOT NULL DEFAULT 0,
  locked_until   timestamptz,
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE roles (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid REFERENCES organizations(id), -- NULL = system role template
  key              text NOT NULL,
  name             text NOT NULL,
  description      text,
  is_system        boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX roles_org_key_idx ON roles(coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), key);

CREATE TABLE role_permissions (
  role_id          uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  organization_id  uuid REFERENCES organizations(id),
  permission_key   text NOT NULL,
  PRIMARY KEY (role_id, permission_key)
);

CREATE TABLE staffs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  user_id          uuid REFERENCES users(id),
  role_id          uuid NOT NULL REFERENCES roles(id),
  display_name     text NOT NULL,
  display_name_kana text,
  email            citext,
  phone            text,
  employment_type  text NOT NULL DEFAULT 'full_time' CHECK (employment_type IN ('full_time','part_time','contractor','owner')),
  title            text,             -- 役職: スタイリスト/アシスタント等
  color            text NOT NULL DEFAULT '#7c3aed',
  is_bookable      boolean NOT NULL DEFAULT true,
  nomination_fee   int NOT NULL DEFAULT 0 CHECK (nomination_fee >= 0),
  public_profile   jsonb NOT NULL DEFAULT '{}'::jsonb, -- bio, specialties, instagram, photo_file_id
  public_slug      citext,
  sort_order       int NOT NULL DEFAULT 0,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('invited','active','inactive','retired')),
  hired_on         date,
  retired_on       date,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_by       uuid,
  trace_id         text,
  deleted_at       timestamptz
);
CREATE INDEX staffs_org_idx ON staffs(organization_id);
CREATE UNIQUE INDEX staffs_org_user_idx ON staffs(organization_id, user_id) WHERE user_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX staffs_org_public_slug_idx ON staffs(organization_id, public_slug) WHERE public_slug IS NOT NULL;

CREATE TABLE staff_shop_assignments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  staff_id         uuid NOT NULL REFERENCES staffs(id),
  shop_id          uuid NOT NULL REFERENCES shops(id),
  is_primary       boolean NOT NULL DEFAULT false,
  started_on       date NOT NULL DEFAULT current_date,
  ended_on         date,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (ended_on IS NULL OR ended_on >= started_on)
);
CREATE INDEX ssa_staff_idx ON staff_shop_assignments(staff_id);
CREATE INDEX ssa_shop_idx ON staff_shop_assignments(shop_id);
CREATE UNIQUE INDEX ssa_active_unique ON staff_shop_assignments(staff_id, shop_id) WHERE ended_on IS NULL;

-- Refresh-token sessions (rotation with reuse detection). Accessed only via system transactions.
CREATE TABLE auth_sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  staff_id         uuid NOT NULL REFERENCES staffs(id),
  refresh_token_hash text NOT NULL UNIQUE,
  user_agent       text,
  ip               inet,
  expires_at       timestamptz NOT NULL,
  revoked_at       timestamptz,
  rotated_from     uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_used_at     timestamptz
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions(user_id);

-- OTP challenges for staff MFA and customer phone/email verification
CREATE TABLE otp_challenges (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid REFERENCES organizations(id),
  user_id          uuid REFERENCES users(id),
  purpose          text NOT NULL CHECK (purpose IN ('staff_mfa','customer_login','customer_verify','password_reset')),
  channel          text NOT NULL CHECK (channel IN ('email','sms','line')),
  destination      text NOT NULL,
  code_hash        text NOT NULL,
  attempts         int NOT NULL DEFAULT 0,
  max_attempts     int NOT NULL DEFAULT 5,
  expires_at       timestamptz NOT NULL,
  consumed_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX otp_destination_idx ON otp_challenges(destination, created_at DESC);

CREATE TRIGGER organizations_updated BEFORE UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER shops_updated BEFORE UPDATE ON shops FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER users_updated BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER roles_updated BEFORE UPDATE ON roles FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER staffs_updated BEFORE UPDATE ON staffs FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER ssa_updated BEFORE UPDATE ON staff_shop_assignments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
