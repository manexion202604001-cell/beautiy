// 店舗跨ぎ会員番号（人物マスタ / customer_master）の中央サービス。
// 顧客作成時に電話番号の完全一致（同一グループ内・正規化後）で既存マスタへ自動リンク、
// 無ければ新規採番する。LINE user_id は店舗ごとに別IDのため判定には使わない。

// 電話番号の正規化: 空白/ハイフン/括弧除去 + +81→0（customer.ts / バックフィルSQLと同一ロジック）
export function normalizePhone(phone: string): string {
  let p = phone.replace(/[\s\-()]/g, '');
  if (p.startsWith('+81')) p = '0' + p.slice(3);
  if (p.startsWith('81') && p.length >= 12) p = '0' + p.slice(2);
  return p;
}

// SQL側で同じ正規化を行う式（バックフィルSQLと一致）。?col に列名を埋め込んで使う。
export function sqlNormalizedPhone(col: string): string {
  const cleaned = `REPLACE(REPLACE(REPLACE(REPLACE(${col},' ',''),'-',''),'(',''),')','')`;
  return `(CASE
    WHEN ${cleaned} LIKE '+81%' THEN '0' || substr(${cleaned}, 4)
    WHEN ${cleaned} LIKE '81%' AND length(${cleaned}) >= 12 THEN '0' || substr(${cleaned}, 3)
    ELSE ${cleaned}
  END)`;
}

function genUuid(): string {
  return crypto.randomUUID();
}

function buildMemberNo(code: string, seq: number): string {
  return `${code}-M-${String(seq).padStart(7, '0')}`;
}

export interface MasterResult {
  masterId: string;
  memberNo: string;
}

/**
 * グループに新しいマスタ（会員番号）を1つ採番して作成する（既存リンクは見ない）。
 * link-master / unlink-master / getOrCreateMaster の新規採番で共用。
 */
export async function allocateMaster(db: D1Database, groupId: string): Promise<MasterResult | null> {
  await db
    .prepare(`INSERT OR IGNORE INTO customer_master_seq (group_id, next_val) VALUES (?, 1)`)
    .bind(groupId)
    .run();
  const seqRow = await db
    .prepare(`UPDATE customer_master_seq SET next_val = next_val + 1 WHERE group_id = ? RETURNING next_val - 1 AS seq`)
    .bind(groupId)
    .first<{ seq: number }>();
  if (!seqRow) return null;
  const group = await db.prepare(`SELECT code FROM groups WHERE id = ?`).bind(groupId).first<{ code: string }>();
  if (!group) return null;

  const masterId = genUuid();
  const memberNo = buildMemberNo(group.code, seqRow.seq);
  await db
    .prepare(`INSERT INTO customer_master (id, group_id, seq, member_no) VALUES (?, ?, ?, ?)`)
    .bind(masterId, groupId, seqRow.seq, memberNo)
    .run();
  return { masterId, memberNo };
}

/**
 * 顧客に会員番号（master）を割り当てる。
 * - 既に master_id があればそれを返す（冪等）
 * - 同一グループ内で正規化電話が一致する既存顧客のマスタがあれば、それにリンク
 * - 無ければ新規採番してマスタを作成
 * グループ未割当（store.group_id が NULL）の場合は何もせず null を返す（cron が後で拾う）。
 */
export async function getOrCreateMaster(
  db: D1Database,
  args: { customerId: string; phone?: string | null; storeId: string }
): Promise<MasterResult | null> {
  const { customerId, storeId } = args;

  // 0) 既にマスタがあればそれを返す
  const existing = await db
    .prepare(
      `SELECT cm.id AS master_id, cm.member_no
       FROM customers c JOIN customer_master cm ON cm.id = c.master_id
       WHERE c.id = ?`
    )
    .bind(customerId)
    .first<{ master_id: string; member_no: string }>();
  if (existing) {
    return { masterId: existing.master_id, memberNo: existing.member_no };
  }

  // 1) 店舗からグループを解決
  const store = await db
    .prepare(`SELECT group_id FROM stores WHERE id = ?`)
    .bind(storeId)
    .first<{ group_id: string | null }>();
  const groupId = store?.group_id;
  if (!groupId) return null; // グループ未割当 → スキップ（cron で後日付番）

  // 2) 同一グループ内で正規化電話が一致する既存マスタを探す
  const phone = args.phone && args.phone.trim() ? normalizePhone(args.phone) : null;
  if (phone) {
    const match = await db
      .prepare(
        `SELECT cm.id AS master_id, cm.member_no
         FROM customers c
         JOIN stores s ON s.id = c.store_id
         JOIN customer_master cm ON cm.id = c.master_id
         WHERE s.group_id = ?1
           AND c.id != ?2
           AND c.phone IS NOT NULL AND TRIM(c.phone) <> ''
           AND ${sqlNormalizedPhone('c.phone')} = ?3
         LIMIT 1`
      )
      .bind(groupId, customerId, phone)
      .first<{ master_id: string; member_no: string }>();
    if (match) {
      await db
        .prepare(`UPDATE customers SET master_id = ?, updated_at = datetime('now') WHERE id = ? AND master_id IS NULL`)
        .bind(match.master_id, customerId)
        .run();
      return { masterId: match.master_id, memberNo: match.member_no };
    }
  }

  // 3) 新規採番してリンク
  const created = await allocateMaster(db, groupId);
  if (!created) return null;
  await db
    .prepare(`UPDATE customers SET master_id = ?, updated_at = datetime('now') WHERE id = ? AND master_id IS NULL`)
    .bind(created.masterId, customerId)
    .run();

  return created;
}

/**
 * master_id 未設定の顧客を一括で付番（cron リコンサイル用）。
 * 取りこぼし（email-worker / 一括インポート等）を確実に解消する。
 * 1回あたり limit 件まで処理。
 */
export async function reconcileCustomerMasters(db: D1Database, limit = 500): Promise<number> {
  const rows = await db
    .prepare(
      `SELECT c.id, c.phone, c.store_id
       FROM customers c JOIN stores s ON s.id = c.store_id
       WHERE c.master_id IS NULL AND s.group_id IS NOT NULL
       LIMIT ?`
    )
    .bind(limit)
    .all<{ id: string; phone: string | null; store_id: string }>();

  let count = 0;
  for (const r of rows.results) {
    const res = await getOrCreateMaster(db, { customerId: r.id, phone: r.phone, storeId: r.store_id });
    if (res) count++;
  }
  return count;
}
