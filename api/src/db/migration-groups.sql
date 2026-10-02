-- グループ概念の追加（店舗の上位の括り。会員番号の接頭辞に使う）
-- ※既存DB用。1回だけ実行する（ALTER は再実行不可）。

CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,   -- 会員番号の接頭辞（例: "A01"）
    name TEXT NOT NULL,          -- 表示名（例: "fein."）
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- fein グループ（A01）を作成
INSERT OR IGNORE INTO groups (id, code, name)
VALUES (
    lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))),
    'A01',
    'fein.'
);

-- stores に group_id を追加（NULL許容のため FK 付きで追加可能）
ALTER TABLE stores ADD COLUMN group_id TEXT REFERENCES groups(id);
CREATE INDEX IF NOT EXISTS idx_stores_group ON stores(group_id);

-- 既存の全店舗を fein(A01) に紐付け
UPDATE stores SET group_id = (SELECT id FROM groups WHERE code = 'A01') WHERE group_id IS NULL;
