-- スタッフ個人LINE公式アカウント連携用カラム追加
ALTER TABLE staff ADD COLUMN staff_line_channel_id TEXT;
ALTER TABLE staff ADD COLUMN staff_line_channel_secret TEXT;
ALTER TABLE staff ADD COLUMN staff_line_access_token TEXT;
