-- consent_records に reservation_id カラムを追加（同意書を予約に紐付け）
ALTER TABLE consent_records ADD COLUMN reservation_id TEXT REFERENCES reservations(id);
CREATE INDEX IF NOT EXISTS idx_consent_records_reservation ON consent_records(reservation_id);
