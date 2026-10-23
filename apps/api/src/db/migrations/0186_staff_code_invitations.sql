-- =====================================================================
-- 0186 スタッフID・招待の辞退・初回ログイン時のパスワード変更 (SALOGIC parity, docs/salogic-parity.md)
--   staffs.staff_code   6-digit staff ID (「ID: 123456」). A staff member tells it to the owner, who
--                       searches it on the スタッフ / 設定 screen to add them to a shop. Unique across
--                       the whole table (not per organization), like SALOGIC's code.
--                       Codes come from a sequence through a bijection of 0..899999 onto
--                       100000..999999, so they never collide and need no lookup across tenants
--                       (which RLS would hide anyway), and consecutive staff do not get
--                       consecutive codes.
--   staff_invitations.declined_at   the invitee chose 「辞退」 on the invitation page.
--   users.must_change_password      set when someone else registered a temporary password
--                       (「ログイン情報を設定」); the user must choose their own before using the app.
-- =====================================================================
CREATE SEQUENCE staff_code_seq MINVALUE 0 START 0;

CREATE FUNCTION next_staff_code() RETURNS text
LANGUAGE sql VOLATILE AS $$
  -- 524287 is prime and does not divide 900000 = 2^5 * 3^2 * 5^5, so n -> (n * 524287 + 271828) mod 900000 is a bijection
  SELECT (100000 + ((nextval('staff_code_seq') % 900000) * 524287 + 271828) % 900000)::text
$$;

ALTER TABLE staffs ADD COLUMN staff_code text;
UPDATE staffs SET staff_code = next_staff_code() WHERE staff_code IS NULL;
ALTER TABLE staffs
  ALTER COLUMN staff_code SET DEFAULT next_staff_code(),
  ALTER COLUMN staff_code SET NOT NULL,
  ADD CONSTRAINT staffs_staff_code_format CHECK (staff_code ~ '^[0-9]{6}$');
CREATE UNIQUE INDEX staffs_staff_code_key ON staffs(staff_code);

ALTER TABLE staff_invitations ADD COLUMN declined_at timestamptz;

ALTER TABLE users ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;
ALTER TABLE staff_invitations ALTER COLUMN email DROP NOT NULL;
