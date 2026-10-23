-- =====================================================================
-- 0184 サロンボード スタッフ名 / スタッフID (SALOGIC スタッフ編集)
--   salonboard_name     : the stylist's name on SALON BOARD (booking mails, the schedule screen).
--                         Kept in sync with the shop's hotpepper_mail connector staffMap.
--   salonboard_staff_id : SALON BOARD's own stylist id (the number after staffId= in the URL of a
--                         new booking, e.g. W000123456). The 自動枠止め helper matches stylists by it
--                         before trying names.
--   Backfill: stylists already mapped on a hotpepper_mail connector get that name (shortest key
--   when several names point to the same stylist).
-- =====================================================================
ALTER TABLE staffs
  ADD COLUMN salonboard_name text,
  ADD COLUMN salonboard_staff_id text;

UPDATE staffs s
SET salonboard_name = m.name
FROM (
  SELECT DISTINCT ON (e.value) e.value AS staff_id, e.key AS name
  FROM integration_accounts ia
  CROSS JOIN LATERAL jsonb_each_text(
    CASE WHEN jsonb_typeof(ia.config -> 'staffMap') = 'object' THEN ia.config -> 'staffMap' ELSE '{}'::jsonb END
  ) e
  WHERE ia.provider = 'hotpepper_mail'
  ORDER BY e.value, length(e.key), e.key
) m
WHERE s.id::text = m.staff_id
  AND s.salonboard_name IS NULL
  AND s.deleted_at IS NULL;
