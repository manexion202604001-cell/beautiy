import { Hono } from 'hono';
import type { Bindings, Variables, Staff } from '../types';
import { staffAuth } from '../middleware/auth';
import { getOrCreateMaster } from '../services/customerMasterService';
import { applyCounselingOverwrite } from '../services/counselingMerge';

export const walkinIntakesRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

walkinIntakesRoutes.use('*', staffAuth);

// 店舗アクセスチェック（customers.ts と同じ）
async function hasStoreAccess(db: D1Database, staff: Staff, storeId: string): Promise<boolean> {
  if (staff.role === 'system_admin') return true;
  if (staff.store_id === storeId) return true;
  const link = await db.prepare(
    'SELECT 1 FROM staff_stores WHERE staff_id = ? AND store_id = ?'
  ).bind(staff.id, storeId).first();
  return !!link;
}

interface WalkinRow {
  id: string;
  store_id: string;
  staff_id: string | null;
  consent_record_id: string | null;
  customer_name: string;
  customer_name_kana: string | null;
  customer_phone: string | null;
  customer_birthday: string | null;
  customer_gender: string | null;
  counseling_data: string | null;
  status: string;
  customer_id: string | null;
}

// 一覧（保留中の受付）
walkinIntakesRoutes.get('/', async (c) => {
  const staff = c.get('staff')!;
  const storeId = c.req.query('store_id');
  const q = c.req.query('q')?.trim();
  const status = c.req.query('status') || 'pending';

  if (!storeId) return c.json({ error: 'store_id is required' }, 400);
  if (!(await hasStoreAccess(c.env.DB, staff, storeId))) return c.json({ error: 'Forbidden' }, 403);

  let query = `
    SELECT w.id, w.customer_name, w.customer_name_kana, w.customer_phone, w.customer_birthday,
           w.staff_id, COALESCE(s.nickname, s.name) AS staff_name,
           w.status, w.consent_submitted_at, w.counseling_submitted_at,
           CASE WHEN w.counseling_data IS NOT NULL THEN 1 ELSE 0 END AS has_counseling
    FROM walkin_intakes w
    LEFT JOIN staff s ON s.id = w.staff_id
    WHERE w.store_id = ? AND w.status = ?`;
  const params: string[] = [storeId, status];
  if (q) {
    query += ' AND (w.customer_name LIKE ? OR w.customer_name_kana LIKE ? OR w.customer_phone LIKE ?)';
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  query += ' ORDER BY w.created_at DESC LIMIT 200';

  const result = await c.env.DB.prepare(query).bind(...params).all();
  return c.json({ intakes: result.results });
});

// 顧客ごとの登録履歴（紐付け済みの受付カウンセリング提出履歴）
walkinIntakesRoutes.get('/by-customer/:customerId', async (c) => {
  const staff = c.get('staff')!;
  const customerId = c.req.param('customerId');

  const customer = await c.env.DB.prepare('SELECT store_id FROM customers WHERE id = ?')
    .bind(customerId).first<{ store_id: string }>();
  if (!customer) return c.json({ error: 'Customer not found' }, 404);
  if (!(await hasStoreAccess(c.env.DB, staff, customer.store_id))) return c.json({ error: 'Forbidden' }, 403);

  const result = await c.env.DB.prepare(
    `SELECT w.id, w.customer_name, w.counseling_data, w.status,
            w.consent_submitted_at, w.counseling_submitted_at, w.updated_at
     FROM walkin_intakes w
     WHERE w.customer_id = ?
     ORDER BY w.updated_at DESC`
  ).bind(customerId).all();

  return c.json({
    intakes: result.results.map((r) => ({
      ...r,
      counseling_data: r.counseling_data ? JSON.parse(r.counseling_data as string) : null,
    })),
  });
});

// 詳細（同意書スナップショット + カウンセリング内容）
walkinIntakesRoutes.get('/:id', async (c) => {
  const staff = c.get('staff')!;
  const id = c.req.param('id');

  const w = await c.env.DB.prepare('SELECT * FROM walkin_intakes WHERE id = ?')
    .bind(id).first<WalkinRow & { template_snapshot?: string }>();
  if (!w) return c.json({ error: 'Not found' }, 404);
  if (!(await hasStoreAccess(c.env.DB, staff, w.store_id))) return c.json({ error: 'Forbidden' }, 403);

  let consentSnapshot: unknown = null;
  if (w.consent_record_id) {
    const cr = await c.env.DB.prepare('SELECT template_snapshot, agreed_at FROM consent_records WHERE id = ?')
      .bind(w.consent_record_id).first<{ template_snapshot: string; agreed_at: string }>();
    if (cr) {
      consentSnapshot = { ...JSON.parse(cr.template_snapshot), agreed_at: cr.agreed_at };
    }
  }

  return c.json({
    intake: {
      ...w,
      counseling_data: w.counseling_data ? JSON.parse(w.counseling_data) : null,
      consent_snapshot: consentSnapshot,
    },
  });
});

// 既存顧客へ紐付け（カウンセリングをカテゴリー単位で上書き）
walkinIntakesRoutes.post('/:id/link', async (c) => {
  const staff = c.get('staff')!;
  const id = c.req.param('id');
  const body = await c.req.json<{ customer_id: string }>();
  if (!body.customer_id) return c.json({ error: 'customer_id is required' }, 400);

  const w = await c.env.DB.prepare("SELECT * FROM walkin_intakes WHERE id = ? AND status = 'pending'")
    .bind(id).first<WalkinRow>();
  if (!w) return c.json({ error: 'Not found or already resolved' }, 404);
  if (!(await hasStoreAccess(c.env.DB, staff, w.store_id))) return c.json({ error: 'Forbidden' }, 403);

  const customer = await c.env.DB.prepare('SELECT id, name_kana, phone, birthday FROM customers WHERE id = ?')
    .bind(body.customer_id).first<{ id: string; name_kana: string | null; phone: string | null; birthday: string | null }>();
  if (!customer) return c.json({ error: 'Customer not found' }, 404);

  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  const incoming = w.counseling_data ? JSON.parse(w.counseling_data) : null;

  // カウンセリングを (walkin.store_id, customer_id) で upsert（カテゴリー単位上書き）
  if (incoming) {
    const existing = await c.env.DB.prepare('SELECT data FROM counseling_sheets WHERE store_id = ? AND customer_id = ?')
      .bind(w.store_id, body.customer_id).first<{ data: string }>();
    const merged = applyCounselingOverwrite(existing ? JSON.parse(existing.data || '{}') : null, incoming);
    await c.env.DB.prepare(
      `INSERT INTO counseling_sheets (id, store_id, customer_id, data, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(store_id, customer_id)
       DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
    ).bind(crypto.randomUUID(), w.store_id, body.customer_id, JSON.stringify(merged), now, now).run();
  }

  // 顧客の空欄のみ backfill
  const updates: string[] = [];
  const vals: (string | null)[] = [];
  if (!customer.name_kana && w.customer_name_kana) { updates.push('name_kana = ?'); vals.push(w.customer_name_kana); }
  if (!customer.phone && w.customer_phone) { updates.push('phone = ?'); vals.push(w.customer_phone); }
  if (!customer.birthday && w.customer_birthday) { updates.push('birthday = ?'); vals.push(w.customer_birthday); }
  if (updates.length) {
    await c.env.DB.prepare(`UPDATE customers SET ${updates.join(', ')}, updated_at = datetime('now') WHERE id = ?`)
      .bind(...vals, body.customer_id).run();
  }

  // 担当スタッフを付与（既存があれば無視）
  if (w.staff_id) {
    await c.env.DB.prepare('INSERT OR IGNORE INTO customer_staff (id, customer_id, staff_id, is_primary) VALUES (?, ?, ?, 0)')
      .bind(crypto.randomUUID(), body.customer_id, w.staff_id).run();
  }

  await c.env.DB.prepare(
    "UPDATE walkin_intakes SET status = 'linked', customer_id = ?, resolved_at = ?, resolved_by = ?, updated_at = ? WHERE id = ?"
  ).bind(body.customer_id, now, staff.id, now, id).run();

  return c.json({ success: true, customer_id: body.customer_id });
});

// 新規顧客として登録
walkinIntakesRoutes.post('/:id/create', async (c) => {
  const staff = c.get('staff')!;
  const id = c.req.param('id');
  const body = await c.req.json<{
    name?: string; name_kana?: string; phone?: string; birthday?: string; gender?: string;
  }>();

  const w = await c.env.DB.prepare("SELECT * FROM walkin_intakes WHERE id = ? AND status = 'pending'")
    .bind(id).first<WalkinRow>();
  if (!w) return c.json({ error: 'Not found or already resolved' }, 404);
  if (!(await hasStoreAccess(c.env.DB, staff, w.store_id))) return c.json({ error: 'Forbidden' }, 403);

  const name = (body.name ?? w.customer_name) || '';
  if (!name.trim()) return c.json({ error: '名前が必要です' }, 400);
  const nameKana = body.name_kana ?? w.customer_name_kana ?? null;
  const phone = body.phone ?? w.customer_phone ?? null;
  const birthday = body.birthday ?? w.customer_birthday ?? null;
  const genderRaw = body.gender ?? w.customer_gender ?? null;
  const gender = ['male', 'female', 'other'].includes(genderRaw || '') ? genderRaw : null;

  const customerId = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO customers (id, store_id, staff_id, name, name_kana, phone, gender, birthday, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'store')`
  ).bind(customerId, w.store_id, w.staff_id || null, name, nameKana, phone, gender, birthday).run();

  if (w.staff_id) {
    await c.env.DB.prepare('INSERT INTO customer_staff (id, customer_id, staff_id, is_primary) VALUES (?, ?, ?, 1)')
      .bind(crypto.randomUUID(), customerId, w.staff_id).run();
  }

  if (w.counseling_data) {
    const now = new Date().toISOString().replace('T', ' ').split('.')[0];
    await c.env.DB.prepare(
      `INSERT INTO counseling_sheets (id, store_id, customer_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(crypto.randomUUID(), w.store_id, customerId, w.counseling_data, now, now).run();
  }

  // 会員番号を付与
  try {
    await getOrCreateMaster(c.env.DB, { customerId, phone, storeId: w.store_id });
  } catch (err) {
    console.error('[walkin-create] master assign failed:', err);
  }

  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  await c.env.DB.prepare(
    "UPDATE walkin_intakes SET status = 'created', customer_id = ?, resolved_at = ?, resolved_by = ?, updated_at = ? WHERE id = ?"
  ).bind(customerId, now, staff.id, now, id).run();

  return c.json({ success: true, customer_id: customerId });
});

// 破棄
walkinIntakesRoutes.post('/:id/discard', async (c) => {
  const staff = c.get('staff')!;
  const id = c.req.param('id');
  const w = await c.env.DB.prepare('SELECT store_id, status FROM walkin_intakes WHERE id = ?')
    .bind(id).first<{ store_id: string; status: string }>();
  if (!w) return c.json({ error: 'Not found' }, 404);
  if (!(await hasStoreAccess(c.env.DB, staff, w.store_id))) return c.json({ error: 'Forbidden' }, 403);

  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  await c.env.DB.prepare(
    "UPDATE walkin_intakes SET status = 'discarded', resolved_at = ?, resolved_by = ?, updated_at = ? WHERE id = ?"
  ).bind(now, staff.id, now, id).run();
  return c.json({ success: true });
});
