-- HPBフリー予約のスタッフ確認フラグ
-- 0 = 不要/完了, 1 = 確認待ち（VPSがSalonboardで担当スタッフを確認する必要あり）
ALTER TABLE reservations ADD COLUMN hpb_staff_check INTEGER NOT NULL DEFAULT 0;
