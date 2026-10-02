-- 予約の確認済みフラグ（オペレーターが変更を確認した日時）
ALTER TABLE reservations ADD COLUMN reviewed_at TEXT;
