-- minimo予約IDをhotpepper_idから分離して独自カラムに保存
ALTER TABLE reservations ADD COLUMN minimo_id TEXT;
CREATE INDEX IF NOT EXISTS idx_reservations_minimo_id ON reservations(minimo_id);

-- 既存データの移行: hotpepper_id が 'minimo_' で始まるものを minimo_id に移動
UPDATE reservations
SET minimo_id = SUBSTR(hotpepper_id, 8),
    hotpepper_id = NULL
WHERE hotpepper_id LIKE 'minimo_%';
