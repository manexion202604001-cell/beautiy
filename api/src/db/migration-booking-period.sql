-- 受付期間設定: stores テーブル
ALTER TABLE stores ADD COLUMN booking_cutoff_type TEXT DEFAULT 'same_day';
ALTER TABLE stores ADD COLUMN booking_cutoff_days_before INTEGER DEFAULT 0;
ALTER TABLE stores ADD COLUMN booking_cutoff_time TEXT DEFAULT NULL;
ALTER TABLE stores ADD COLUMN booking_cutoff_same_day_minutes INTEGER DEFAULT 60;
ALTER TABLE stores ADD COLUMN booking_calc_method TEXT DEFAULT 'calendar';

-- 受付期間設定: staff_reservation_settings テーブル (NULL = 店舗設定にフォールバック)
ALTER TABLE staff_reservation_settings ADD COLUMN booking_cutoff_type TEXT DEFAULT NULL;
ALTER TABLE staff_reservation_settings ADD COLUMN booking_cutoff_days_before INTEGER DEFAULT NULL;
ALTER TABLE staff_reservation_settings ADD COLUMN booking_cutoff_time TEXT DEFAULT NULL;
ALTER TABLE staff_reservation_settings ADD COLUMN booking_cutoff_same_day_minutes INTEGER DEFAULT NULL;
ALTER TABLE staff_reservation_settings ADD COLUMN booking_calc_method TEXT DEFAULT NULL;

-- 既存データの移行: same_day_cutoff_hours → booking_cutoff_same_day_minutes
UPDATE stores SET booking_cutoff_same_day_minutes = same_day_cutoff_hours * 60 WHERE same_day_cutoff_hours IS NOT NULL AND same_day_cutoff_hours > 0;
UPDATE staff_reservation_settings SET booking_cutoff_same_day_minutes = same_day_cutoff_hours * 60 WHERE same_day_cutoff_hours IS NOT NULL AND same_day_cutoff_hours > 0;
