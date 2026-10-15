-- =====================================================================
-- 0179 同時刻に予約可能な人数 (SALOGIC parity, docs/salogic-parity.md 8章 スタッフ別の予約設定)
--   A staff member may be set to take more than one booking at the same time. The double-booking
--   guard stays in the database: each booking occupies one "lane" of its staff member and two
--   bookings in the same lane may not overlap. Staff with the default of one booking at a time
--   only ever use lane 0, which is exactly the previous constraint.
-- =====================================================================
ALTER TABLE appointments ADD COLUMN staff_lane smallint NOT NULL DEFAULT 0 CHECK (staff_lane BETWEEN 0 AND 9);

ALTER TABLE appointments DROP CONSTRAINT appointments_no_staff_overlap;
ALTER TABLE appointments
  ADD CONSTRAINT appointments_no_staff_overlap EXCLUDE USING gist (
    staff_id WITH =,
    staff_lane WITH =,
    tstzrange(occupied_start_at, occupied_end_at, '[)') WITH &&
  ) WHERE (staff_id IS NOT NULL AND deleted_at IS NULL AND status IN ('tentative','confirmed','checked_in','in_service','completed'));
