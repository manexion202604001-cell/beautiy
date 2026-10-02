-- 予定ブロックの変更/削除でSalonboardの既存予定を特定するため、
-- 「最後にSalonboardに登録したスロット（日付・開始時刻）」を記録するカラムを追加。
-- ※既存DB用。手動で1回実行。

ALTER TABLE staff_blocks ADD COLUMN salonboard_synced_date TEXT;
ALTER TABLE staff_blocks ADD COLUMN salonboard_synced_start_time TEXT;
