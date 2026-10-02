-- 既存顧客への会員番号バックフィル
-- ※ migration-groups.sql / migration-customer-master.sql を先に実行しておくこと。
-- 冪等: master_id IS NULL の顧客のみ対象。再実行すると残りのNULLにのみ付番。
--
-- バケット規則: 同一グループ内で正規化電話が一致する顧客は同じマスタ（会員番号）。
--   電話なし / 単独電話は個別マスタ。連番はグループごと、min(created_at)順。

DROP TABLE IF EXISTS _backfill_buckets;
DROP TABLE IF EXISTS _backfill_masters;

-- 1) 各顧客のバケットキーを算出（正規化電話: 空白/ハイフン/括弧除去 + +81→0）
CREATE TABLE _backfill_buckets (
    customer_id TEXT,
    group_id TEXT,
    bucket_key TEXT,
    created_at TEXT
);

INSERT INTO _backfill_buckets (customer_id, group_id, bucket_key, created_at)
SELECT c.id, s.group_id,
  s.group_id || '|' || CASE
    WHEN c.phone IS NOT NULL AND TRIM(c.phone) <> '' THEN
      'PH:' || (
        WITH cleaned(v) AS (
          SELECT REPLACE(REPLACE(REPLACE(REPLACE(c.phone,' ',''),'-',''),'(',''),')','')
        )
        SELECT CASE
          WHEN (SELECT v FROM cleaned) LIKE '+81%' THEN '0' || substr((SELECT v FROM cleaned), 4)
          WHEN (SELECT v FROM cleaned) LIKE '81%' AND length((SELECT v FROM cleaned)) >= 12 THEN '0' || substr((SELECT v FROM cleaned), 3)
          ELSE (SELECT v FROM cleaned)
        END
      )
    ELSE 'ID:' || c.id
  END,
  c.created_at
FROM customers c
JOIN stores s ON s.id = c.store_id
WHERE c.master_id IS NULL AND s.group_id IS NOT NULL;

-- 2) 一意なバケットごとにマスタを生成（グループ内 min(created_at)順に既存next_valから連番）
CREATE TABLE _backfill_masters (
    bucket_key TEXT PRIMARY KEY,
    group_id TEXT,
    master_id TEXT,
    seq INTEGER,
    member_no TEXT
);

INSERT INTO _backfill_masters (bucket_key, group_id, master_id, seq)
SELECT bucket_key, group_id,
  lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))),
  base_next - 1 + ROW_NUMBER() OVER (PARTITION BY group_id ORDER BY min_created, bucket_key)
FROM (
  SELECT b.bucket_key, b.group_id, MIN(b.created_at) AS min_created,
         (SELECT next_val FROM customer_master_seq WHERE group_id = b.group_id) AS base_next
  FROM _backfill_buckets b
  GROUP BY b.bucket_key, b.group_id
);

-- 3) member_no を組み立て（code-M-7桁ゼロ埋め）
UPDATE _backfill_masters
SET member_no = (SELECT code FROM groups WHERE groups.id = _backfill_masters.group_id)
  || '-M-' || substr('0000000' || seq, -7, 7);

-- 4) customer_master へ投入
INSERT INTO customer_master (id, group_id, seq, member_no)
SELECT master_id, group_id, seq, member_no FROM _backfill_masters;

-- 5) customers.master_id をリンク
UPDATE customers
SET master_id = (
  SELECT m.master_id FROM _backfill_buckets b
  JOIN _backfill_masters m ON m.bucket_key = b.bucket_key
  WHERE b.customer_id = customers.id
)
WHERE master_id IS NULL
  AND id IN (SELECT customer_id FROM _backfill_buckets);

-- 6) 採番カウンタを更新（次の採番が衝突しないよう MAX(seq)+1 に）
UPDATE customer_master_seq
SET next_val = 1 + COALESCE(
  (SELECT MAX(seq) FROM customer_master WHERE customer_master.group_id = customer_master_seq.group_id),
  next_val - 1
);

DROP TABLE _backfill_buckets;
DROP TABLE _backfill_masters;
