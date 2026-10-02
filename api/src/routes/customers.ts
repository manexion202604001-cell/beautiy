import { Hono } from 'hono';
import type { Bindings, Variables, Customer, Staff } from '../types';
import { staffAuth, requireRole } from '../middleware/auth';
import { importLimeCustomersToDb } from '../services/limeService';
import { getOrCreateMaster, allocateMaster } from '../services/customerMasterService';
import { sanitizeCustomer, sanitizeCustomers } from '../utils/sanitize';

export const customersRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Apply auth middleware
customersRoutes.use('*', staffAuth);

// Kana normalization helpers so name search matches regardless of hiragana/katakana form.
function toKatakana(s: string): string {
  return s.replace(/[ぁ-ゖ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0x60));
}
function toHiragana(s: string): string {
  return s.replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

// Build a WHERE fragment that matches a customer whatever kana form / spacing the searcher
// used. Columns are space-stripped in SQL; the query is expanded into hiragana + katakana
// variants so "きのした" finds "キノシタルリ" and vice versa. Phone/email match the raw query.
function buildNameSearchClause(search: string): { sql: string; params: string[] } | null {
  const raw = search.trim();
  if (!raw) return null;
  // Strip half/full-width spaces from the query
  const stripped = raw.replace(/[\s　]/g, '');
  // Space-stripped column expressions (mirror the query normalization)
  const nameExpr = "REPLACE(REPLACE(COALESCE(c.name,''),' ',''),'　','')";
  const kanaExpr = "REPLACE(REPLACE(COALESCE(c.name_kana,''),' ',''),'　','')";
  // Dedup kana variants (kanji/digits are unchanged by the conversions)
  const variants = [...new Set([stripped, toHiragana(stripped), toKatakana(stripped)])].filter(Boolean);

  const conds: string[] = [];
  const params: string[] = [];
  for (const v of variants) {
    conds.push(`${nameExpr} LIKE ?`);
    params.push(`%${v}%`);
    conds.push(`${kanaExpr} LIKE ?`);
    params.push(`%${v}%`);
  }
  conds.push('c.phone LIKE ?');
  params.push(`%${raw}%`);
  conds.push('c.email LIKE ?');
  params.push(`%${raw}%`);

  return { sql: conds.join(' OR '), params };
}

// Check if staff has access to a store (via staff_stores)
async function hasStoreAccess(db: D1Database, staff: Staff, storeId: string): Promise<boolean> {
  if (staff.role === 'system_admin') return true;
  if (staff.store_id === storeId) return true;
  const link = await db.prepare(
    'SELECT 1 FROM staff_stores WHERE staff_id = ? AND store_id = ?'
  ).bind(staff.id, storeId).first();
  return !!link;
}

// Group-level access: the staff belongs to the group (via their primary store or any linked
// store in that group). Used for group-scoped identity operations like member-number linking,
// which must not require per-store access to every record's store.
async function hasGroupAccess(db: D1Database, staff: Staff, groupId: string): Promise<boolean> {
  if (staff.role === 'system_admin') return true;
  const own = await db.prepare(
    'SELECT 1 FROM stores WHERE id = ? AND group_id = ?'
  ).bind(staff.store_id, groupId).first();
  if (own) return true;
  const linked = await db.prepare(
    'SELECT 1 FROM staff_stores ss JOIN stores s ON s.id = ss.store_id WHERE ss.staff_id = ? AND s.group_id = ? LIMIT 1'
  ).bind(staff.id, groupId).first();
  return !!linked;
}

// List customers
customersRoutes.get('/', async (c) => {
  const storeId = c.req.query('store_id');
  const search = c.req.query('search');
  const staffId = c.req.query('staff_id');
  const unassigned = c.req.query('unassigned');
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 200);
  const offset = parseInt(c.req.query('offset') || '0', 10);

  let query = `
    SELECT c.*, COALESCE(s.nickname, s.name) as staff_name,
      (SELECT DATE(r.start_at) FROM reservations r
        WHERE r.customer_id = c.id AND r.status IN ('completed', 'confirmed')
        ORDER BY r.start_at DESC LIMIT 1) as last_visit_date,
      (SELECT COALESCE(ls.nickname, ls.name) FROM reservations r
        JOIN staff ls ON r.staff_id = ls.id
        WHERE r.customer_id = c.id AND r.status IN ('completed', 'confirmed')
        ORDER BY r.start_at DESC LIMIT 1) as last_staff_nickname,
      st.name as store_name,
      cm.member_no as member_no,
      (CASE WHEN EXISTS (SELECT 1 FROM customer_line cl
        WHERE cl.customer_id = c.id AND cl.line_user_id IS NOT NULL
          AND cl.line_user_id <> '' AND cl.is_blocked = 0) THEN 1 ELSE 0 END) as has_line,
      (SELECT GROUP_CONCAT(COALESCE(s2.nickname, s2.name), ', ')
       FROM customer_staff cs2
       JOIN staff s2 ON cs2.staff_id = s2.id
       WHERE cs2.customer_id = c.id
       ORDER BY cs2.is_primary DESC, cs2.created_at ASC
      ) as staff_names
    FROM customers c
    LEFT JOIN staff s ON c.staff_id = s.id
    LEFT JOIN stores st ON c.store_id = st.id
    LEFT JOIN customer_master cm ON cm.id = c.master_id
    WHERE 1=1
  `;
  const params: (string | number)[] = [];

  // Store filter
  if (storeId) {
    query += ' AND c.store_id = ?';
    params.push(storeId);
  }

  // Customer visibility: all roles (including 'staff') can view all customers across
  // every store. The optional filters below narrow the list and apply to any role.
  if (unassigned === 'true') {
    // Show unassigned customers - no entries in customer_staff AND no staff_id
    query += ' AND c.staff_id IS NULL AND c.id NOT IN (SELECT cs.customer_id FROM customer_staff cs)';
  } else if (staffId) {
    // Filter by specific staff (via customer_staff or legacy staff_id)
    query += ' AND (c.staff_id = ? OR c.id IN (SELECT cs.customer_id FROM customer_staff cs WHERE cs.staff_id = ?))';
    params.push(staffId, staffId);
  }

  // Search filter — match regardless of kana form (hiragana/katakana) and spaces so a
  // customer stored as「木下瑠梨 / キノシタルリ」is found by "きのした", "キノシタ", "木下", etc.
  if (search) {
    const clause = buildNameSearchClause(search);
    if (clause) {
      query += ` AND (${clause.sql})`;
      params.push(...clause.params);
    }
  }

  query += ' ORDER BY c.updated_at DESC';

  // Count total before applying LIMIT — strip the SELECT list and all JOINs so the
  // count is a plain customers scan (no reservations correlation / no join fan-out).
  const countQuery = query.replace(/SELECT c\.\*.*?WHERE 1=1/s, 'SELECT COUNT(*) as total FROM customers c WHERE 1=1');
  const countResult = await c.env.DB.prepare(countQuery)
    .bind(...params)
    .first<{ total: number }>();
  const total = countResult?.total || 0;

  query += ' LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const result = await c.env.DB.prepare(query)
    .bind(...params)
    .all<Customer & { staff_name: string | null }>();

  return c.json({ customers: sanitizeCustomers(result.results), total, limit, offset });
});

// Normalize customer name for duplicate detection
// Strips parenthetical content (kana readings), spaces, and trims
function normalizeName(name: string): string {
  return name
    .replace(/[（(][^）)]*[）)]/g, '') // Strip parenthetical content (full-width and half-width)
    .replace(/[\s\u3000]/g, '')  // Strip all whitespace (half-width and full-width)
    .trim();
}

// Unified duplicate detection: name, phone, LINE ID across all stores
// Uses SQL to find duplicate IDs first, then fetches only those customers
customersRoutes.get('/duplicates', async (c) => {
  const staff = c.get('staff')!;
  const search = c.req.query('search')?.trim();
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200);
  const offset = parseInt(c.req.query('offset') || '0');

  // 1. Find duplicate customer IDs via SQL (phone duplicates + LINE duplicates)
  // Phone duplicates (normalize: strip +81 prefix in SQL)
  const phoneDups = await c.env.DB.prepare(`
    SELECT REPLACE(REPLACE(phone, '+81', '0'), '-', '') as norm_phone, GROUP_CONCAT(id) as ids
    FROM customers WHERE phone IS NOT NULL AND phone != ''
    GROUP BY norm_phone HAVING COUNT(*) >= 2
  `).all<{ norm_phone: string; ids: string }>();

  // LINE ID duplicates
  const lineDups = await c.env.DB.prepare(`
    SELECT line_user_id, GROUP_CONCAT(customer_id) as ids
    FROM customer_line
    GROUP BY line_user_id HAVING COUNT(*) >= 2
  `).all<{ line_user_id: string; ids: string }>();

  // Name duplicates — use SQL to find names appearing 2+ times
  const nameDups = await c.env.DB.prepare(`
    SELECT REPLACE(REPLACE(REPLACE(REPLACE(name, ' ', ''), '　', ''), '（', ''), '）', '') as norm_name,
           GROUP_CONCAT(id) as ids
    FROM customers WHERE name IS NOT NULL AND name != ''
    GROUP BY norm_name HAVING COUNT(*) >= 2 AND COUNT(*) <= 20
  `).all<{ norm_name: string; ids: string }>();

  // Get dismissed names
  const dismissed = await c.env.DB.prepare('SELECT normalized_name FROM name_duplicate_dismissed').all();
  const dismissedNames = new Set(dismissed.results.map(r => r.normalized_name as string));

  // Union-Find on IDs
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x)!)!); x = parent.get(x)!; }
    return x;
  };
  const unite = (a: string, b: string) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  const matchReasons = new Map<string, Set<string>>();
  const addReason = (id: string, reason: string) => {
    if (!matchReasons.has(id)) matchReasons.set(id, new Set());
    matchReasons.get(id)!.add(reason);
  };

  // Process phone duplicates
  for (const row of phoneDups.results) {
    const ids = row.ids.split(',');
    for (const id of ids) { if (!parent.has(id)) parent.set(id, id); }
    for (let i = 1; i < ids.length; i++) {
      unite(ids[0], ids[i]);
      addReason(ids[0], '電話番号一致');
      addReason(ids[i], '電話番号一致');
    }
  }

  // Process LINE duplicates
  for (const row of lineDups.results) {
    const ids = row.ids.split(',');
    for (const id of ids) { if (!parent.has(id)) parent.set(id, id); }
    for (let i = 1; i < ids.length; i++) {
      unite(ids[0], ids[i]);
      addReason(ids[0], 'LINE一致');
      addReason(ids[i], 'LINE一致');
    }
  }

  // Process name duplicates (skip dismissed)
  for (const row of nameDups.results) {
    if (dismissedNames.has(row.norm_name)) continue;
    const ids = row.ids.split(',');
    for (const id of ids) { if (!parent.has(id)) parent.set(id, id); }
    for (let i = 1; i < ids.length; i++) {
      unite(ids[0], ids[i]);
      addReason(ids[0], '名前一致');
      addReason(ids[i], '名前一致');
    }
  }

  // Collect groups (only IDs involved in duplicates)
  const groupMap = new Map<string, string[]>();
  for (const id of parent.keys()) {
    const root = find(id);
    if (!groupMap.has(root)) groupMap.set(root, []);
    groupMap.get(root)!.push(id);
  }

  // Filter to groups with 2+ members
  let groupEntries = [...groupMap.values()].filter(g => g.length >= 2);

  // Search: find matching customer IDs via SQL, then keep only groups containing them
  if (search) {
    const searchLike = `%${search}%`;
    const matchResult = await c.env.DB.prepare(
      `SELECT id FROM customers WHERE (name LIKE ? OR name_kana LIKE ? OR phone LIKE ?) LIMIT 5000`
    ).bind(searchLike, searchLike, searchLike).all<{ id: string }>();
    const matchIds = new Set(matchResult.results.map(r => r.id));
    groupEntries = groupEntries.filter(g => g.some(id => matchIds.has(id)));
  }

  // Count total before pagination
  const total = groupEntries.length;
  if (limit === 0) return c.json({ groups: [], total });

  // Paginate group IDs first
  groupEntries = groupEntries.slice(offset, offset + limit);

  // Collect all customer IDs we need to fetch
  const neededIds = new Set<string>();
  for (const g of groupEntries) for (const id of g) neededIds.add(id);
  if (neededIds.size === 0) return c.json({ groups: [], total });

  // Batch-fetch customer details + reservation counts
  const customerById = new Map<string, Record<string, unknown>>();
  const reservationCounts = new Map<string, number>();
  const CHUNK = 50;
  const idArray = [...neededIds];

  for (let i = 0; i < idArray.length; i += CHUNK) {
    const chunk = idArray.slice(i, i + CHUNK);
    const chPh = chunk.map(() => '?').join(',');

    const [custResult, rcResult] = await Promise.all([
      c.env.DB.prepare(`
        SELECT c.id, c.name, c.name_kana, c.phone, c.email, c.store_id,
          c.staff_id, c.visit_count, c.last_visit_at, c.master_id,
          COALESCE(s.nickname, s.name) as staff_name, st.name as store_name,
          cl.line_user_id, cl.display_name as line_display_name,
          cm.member_no as member_no
        FROM customers c
        LEFT JOIN staff s ON c.staff_id = s.id
        LEFT JOIN stores st ON c.store_id = st.id
        LEFT JOIN customer_line cl ON c.id = cl.customer_id
        LEFT JOIN customer_master cm ON cm.id = c.master_id
        WHERE c.id IN (${chPh})
      `).bind(...chunk).all(),
      c.env.DB.prepare(
        `SELECT customer_id, COUNT(*) as cnt FROM reservations WHERE customer_id IN (${chPh}) AND status NOT IN ('cancelled', 'noshow') GROUP BY customer_id`
      ).bind(...chunk).all<{ customer_id: string; cnt: number }>(),
    ]);

    for (const r of custResult.results) customerById.set((r as Record<string, unknown>).id as string, r as Record<string, unknown>);
    for (const r of rcResult.results) reservationCounts.set(r.customer_id, r.cnt);
  }

  // Build response groups
  const groups = groupEntries.map(ids => {
    const members = ids
      .map(id => customerById.get(id))
      .filter(Boolean) as Record<string, unknown>[];

    // Sort: most visits first
    members.sort((a, b) =>
      ((b.visit_count as number) || 0) - ((a.visit_count as number) || 0) ||
      (b.phone ? 1 : 0) - (a.phone ? 1 : 0) ||
      (b.line_user_id ? 1 : 0) - (a.line_user_id ? 1 : 0)
    );

    const reasons = new Set<string>();
    for (const m of members) {
      m.match_reasons = [...(matchReasons.get(m.id as string) || [])];
      m.reservation_count = reservationCounts.get(m.id as string) || 0;
      for (const r of (m.match_reasons as string[])) reasons.add(r);
    }

    return { customers: members, reasons: [...reasons] };
  });

  return c.json({ groups, total });
});


// Name-based duplicate detection (legacy)
customersRoutes.get('/name-duplicates', async (c) => {
  const staff = c.get('staff')!;
  const storeId = c.req.query('store_id');
  const search = c.req.query('search')?.trim();
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200);
  const offset = parseInt(c.req.query('offset') || '0');

  // Fetch all customers with basic info
  let query = `
    SELECT c.id, c.name, c.name_kana, c.phone, c.email, c.store_id,
      c.staff_id, c.visit_count, c.memo, c.master_id,
      COALESCE(s.nickname, s.name) as staff_name, st.name as store_name,
      cm.member_no as member_no
    FROM customers c
    LEFT JOIN staff s ON c.staff_id = s.id
    LEFT JOIN stores st ON c.store_id = st.id
    LEFT JOIN customer_master cm ON cm.id = c.master_id
    WHERE 1=1
  `;
  const params: string[] = [];

  if (storeId) {
    query += ' AND c.store_id = ?';
    params.push(storeId);
  }

  if (staff.role === 'staff') {
    query += ' AND (c.staff_id = ? OR c.id IN (SELECT cs.customer_id FROM customer_staff cs WHERE cs.staff_id = ?))';
    params.push(staff.id, staff.id);
  }

  query += ' ORDER BY c.visit_count DESC, c.updated_at DESC';

  const result = await c.env.DB.prepare(query)
    .bind(...params)
    .all();

  // Get dismissed normalized names
  const dismissedQuery = storeId
    ? c.env.DB.prepare('SELECT normalized_name FROM name_duplicate_dismissed WHERE store_id = ?').bind(storeId)
    : c.env.DB.prepare('SELECT DISTINCT normalized_name FROM name_duplicate_dismissed');
  const dismissed = await dismissedQuery.all();
  const dismissedNames = new Set(dismissed.results.map(r => r.normalized_name as string));

  // Group by normalized name in JS
  const groups: Record<string, Array<Record<string, unknown>>> = {};
  for (const row of result.results) {
    const r = row as Record<string, unknown>;
    const key = normalizeName(r.name as string);
    if (!key) continue;
    if (!groups[key]) groups[key] = [];
    groups[key].push(r);
  }

  // Filter: 2+ members, at least one without phone, not dismissed
  let groupArray = Object.entries(groups)
    .filter(([key, customers]) =>
      customers.length >= 2 &&
      customers.some(c => !c.phone || c.phone === '') &&
      !dismissedNames.has(key)
    );

  // Server-side search (case-insensitive)
  if (search) {
    const searchLower = search.toLowerCase();
    groupArray = groupArray.filter(([, customers]) =>
      customers.some(c =>
        (c.name as string)?.toLowerCase().includes(searchLower) ||
        (c.name_kana as string)?.toLowerCase().includes(searchLower) ||
        (c.phone as string)?.includes(search)
      )
    );
  }

  const total = groupArray.length;

  // Paginate
  const paged = groupArray
    .slice(offset, offset + limit)
    .map(([key, customers]) => ({
      normalized_name: key,
      customers,
    }));

  return c.json({ groups: paged, total });
});

// Dismiss a name duplicate group
customersRoutes.post('/name-duplicates/dismiss', requireRole('system_admin', 'owner', 'manager'), async (c) => {
  const staff = c.get('staff')!;
  const body = await c.req.json<{ store_id: string; normalized_name: string }>();

  if (!body.store_id || !body.normalized_name) {
    return c.json({ error: 'store_id and normalized_name are required' }, 400);
  }

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    'INSERT OR IGNORE INTO name_duplicate_dismissed (id, store_id, normalized_name, dismissed_by) VALUES (?, ?, ?, ?)'
  ).bind(id, body.store_id, body.normalized_name, staff.id).run();

  return c.json({ success: true });
});

// Merge two customers
customersRoutes.post('/merge', requireRole('system_admin', 'owner', 'manager'), async (c) => {
  const staff = c.get('staff')!;
  const body = await c.req.json<{
    keep_id: string;
    merge_id: string;
  }>();

  if (!body.keep_id || !body.merge_id || body.keep_id === body.merge_id) {
    return c.json({ error: 'Invalid customer IDs' }, 400);
  }

  const keep = await c.env.DB.prepare('SELECT c.*, st.name as store_name, COALESCE(s.nickname, s.name) as staff_name FROM customers c LEFT JOIN stores st ON c.store_id = st.id LEFT JOIN staff s ON c.staff_id = s.id WHERE c.id = ?')
    .bind(body.keep_id).first<Customer & { store_name: string; staff_name: string }>();
  const merge = await c.env.DB.prepare('SELECT c.*, st.name as store_name, COALESCE(s.nickname, s.name) as staff_name FROM customers c LEFT JOIN stores st ON c.store_id = st.id LEFT JOIN staff s ON c.staff_id = s.id WHERE c.id = ?')
    .bind(body.merge_id).first<Customer & { store_name: string; staff_name: string }>();

  if (!keep || !merge) {
    return c.json({ error: 'Customer not found' }, 404);
  }

  // Check access to both customers
  if (!await hasStoreAccess(c.env.DB, staff, keep.store_id) ||
      !await hasStoreAccess(c.env.DB, staff, merge.store_id)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  // Cross-store physical merge is allowed: the person is consolidated into one customer
  // record, while store-scoped data (karutes, reservations, messages, LINE links) keeps its
  // own store_id so each店舗's history/連絡 stays attributable and per-store.

  // Build memo addition from merged record
  const memoParts: string[] = [];
  if (merge.store_name) memoParts.push(merge.store_name);
  if (merge.staff_name) memoParts.push(`担当:${merge.staff_name}`);
  if (merge.name !== keep.name) memoParts.push(`名前:${merge.name}`);
  if (merge.phone && keep.phone && merge.phone !== keep.phone) memoParts.push(`電話:${merge.phone}`);
  const memoAddition = memoParts.length > 0 ? memoParts.join(' / ') : '';

  // Fill missing fields
  const updates: string[] = [];
  const updateValues: (string | null)[] = [];
  const fillFields: (keyof Customer)[] = ['name_kana', 'phone', 'email', 'gender', 'birthday', 'address', 'postal_code', 'staff_id'];
  for (const field of fillFields) {
    if (!keep[field] && merge[field]) {
      updates.push(`${field} = ?`);
      updateValues.push(merge[field] as string);
    }
  }

  // Update memo
  if (memoAddition) {
    const newMemo = keep.memo ? `${keep.memo}\n${memoAddition}` : memoAddition;
    updates.push('memo = ?');
    updateValues.push(newMemo);
  }

  // Combine visit stats: counts add up, first/last visit span both records
  updates.push('visit_count = ?');
  updateValues.push(String((keep.visit_count || 0) + (merge.visit_count || 0)));
  const firstVisits = [keep.first_visit_at, merge.first_visit_at].filter((v): v is string => !!v);
  if (firstVisits.length > 0) {
    updates.push('first_visit_at = ?');
    updateValues.push(firstVisits.sort()[0]);
  }
  const lastVisits = [keep.last_visit_at, merge.last_visit_at].filter((v): v is string => !!v);
  if (lastVisits.length > 0) {
    updates.push('last_visit_at = ?');
    updateValues.push(lastVisits.sort().reverse()[0]);
  }

  updates.push("updated_at = datetime('now')");

  const batch: D1PreparedStatement[] = [];

  // Merge karutes: if same visit_date + staff_id exists in both, merge memo fields
  const keepKarutes = await c.env.DB.prepare('SELECT id, store_id, visit_date, staff_id, memo, internal_memo, menu_content, hair_condition, color_formula, perm_info, styling_notes, customer_feedback, next_suggestion FROM karutes WHERE customer_id = ?')
    .bind(body.keep_id).all<Record<string, string | null>>();
  const mergeKarutes = await c.env.DB.prepare('SELECT id, store_id, visit_date, staff_id, memo, internal_memo, menu_content, hair_condition, color_formula, perm_info, styling_notes, customer_feedback, next_suggestion FROM karutes WHERE customer_id = ?')
    .bind(body.merge_id).all<Record<string, string | null>>();

  // Key by store_id + visit_date + staff_id — karutes at different stores are distinct
  // visits and must never dedup-merge across stores.
  const keepByKey = new Map<string, Record<string, string | null>>();
  for (const k of keepKarutes.results) keepByKey.set(`${k.store_id}_${k.visit_date}_${k.staff_id}`, k);

  const textFields = ['memo', 'internal_memo', 'menu_content', 'hair_condition', 'color_formula', 'perm_info', 'styling_notes', 'customer_feedback', 'next_suggestion'];

  const dupKaruteIds: string[] = [];
  for (const mk of mergeKarutes.results) {
    const existing = keepByKey.get(`${mk.store_id}_${mk.visit_date}_${mk.staff_id}`);
    if (existing) {
      dupKaruteIds.push(mk.id as string);
      // Same visit_date + staff_id — merge text fields
      const mergeUpdates: string[] = [];
      const mergeValues: (string | null)[] = [];
      for (const field of textFields) {
        if (mk[field] && mk[field] !== existing[field]) {
          const combined = existing[field] ? `${existing[field]}\n---\n${mk[field]}` : mk[field];
          mergeUpdates.push(`${field} = ?`);
          mergeValues.push(combined);
        }
      }
      if (mergeUpdates.length > 0) {
        mergeUpdates.push("updated_at = datetime('now')");
        batch.push(c.env.DB.prepare(`UPDATE karutes SET ${mergeUpdates.join(', ')} WHERE id = ?`).bind(...mergeValues, existing.id));
      }
      // Delete the duplicate karute
      batch.push(c.env.DB.prepare('DELETE FROM karute_images WHERE karute_id = ?').bind(mk.id));
      batch.push(c.env.DB.prepare('DELETE FROM karutes WHERE id = ?').bind(mk.id));
    } else {
      // No conflict — just move
      batch.push(c.env.DB.prepare('UPDATE karutes SET customer_id = ? WHERE id = ?').bind(body.keep_id, mk.id));
    }
  }

  // Move related records
  batch.push(c.env.DB.prepare('UPDATE reservations SET customer_id = ? WHERE customer_id = ?').bind(body.keep_id, body.merge_id));
  batch.push(c.env.DB.prepare('UPDATE messages SET customer_id = ? WHERE customer_id = ?').bind(body.keep_id, body.merge_id));

  // Update kept record
  if (updates.length > 0) {
    batch.push(c.env.DB.prepare(`UPDATE customers SET ${updates.join(', ')} WHERE id = ?`).bind(...updateValues, body.keep_id));
  }

  // LINE links are per store (each store = separate provider = separate line_user_id).
  // Move each of merge's store-scoped links to the keeper, unless the keeper already has a
  // link for that same store (then drop the duplicate). A merged customer keeps one LINE per store.
  const mergeLines = await c.env.DB.prepare('SELECT id, store_id FROM customer_line WHERE customer_id = ?').bind(body.merge_id).all<{ id: string; store_id: string | null }>();
  const keepLines = await c.env.DB.prepare('SELECT store_id FROM customer_line WHERE customer_id = ?').bind(body.keep_id).all<{ store_id: string | null }>();
  const keepLineStores = new Set(keepLines.results.map((r) => r.store_id));
  for (const ml of mergeLines.results) {
    if (keepLineStores.has(ml.store_id)) {
      // Keeper already linked for this store — drop merge's duplicate link
      batch.push(c.env.DB.prepare('DELETE FROM customer_line WHERE id = ?').bind(ml.id));
    } else {
      batch.push(c.env.DB.prepare("UPDATE customer_line SET customer_id = ?, updated_at = datetime('now') WHERE id = ?").bind(body.keep_id, ml.id));
      keepLineStores.add(ml.store_id);
    }
  }

  // Move staff assignments the keeper doesn't have yet (as non-primary), drop the rest
  batch.push(c.env.DB.prepare(
    `UPDATE customer_staff SET customer_id = ?, is_primary = 0
     WHERE customer_id = ?
     AND staff_id NOT IN (SELECT staff_id FROM customer_staff WHERE customer_id = ?)`
  ).bind(body.keep_id, body.merge_id, body.keep_id));
  batch.push(c.env.DB.prepare('DELETE FROM customer_staff WHERE customer_id = ?').bind(body.merge_id));

  // Merge counseling_sheets: if same store_id exists in both, merge data JSON
  const keepSheets = await c.env.DB.prepare('SELECT id, store_id, data FROM counseling_sheets WHERE customer_id = ?')
    .bind(body.keep_id).all<{ id: string; store_id: string; data: string }>();
  const mergeSheets = await c.env.DB.prepare('SELECT id, store_id, data FROM counseling_sheets WHERE customer_id = ?')
    .bind(body.merge_id).all<{ id: string; store_id: string; data: string }>();

  const keepSheetByStore = new Map<string, { id: string; data: string }>();
  for (const s of keepSheets.results) keepSheetByStore.set(s.store_id, s);

  for (const ms of mergeSheets.results) {
    const existing = keepSheetByStore.get(ms.store_id);
    if (existing) {
      // Same store — merge data JSON (keep's fields win, add merge's missing fields)
      try {
        const keepData = JSON.parse(existing.data || '{}');
        const mergeData = JSON.parse(ms.data || '{}');
        let changed = false;
        for (const [key, val] of Object.entries(mergeData)) {
          if (val && !keepData[key]) {
            keepData[key] = val;
            changed = true;
          }
        }
        if (changed) {
          batch.push(c.env.DB.prepare("UPDATE counseling_sheets SET data = ?, updated_at = datetime('now') WHERE id = ?")
            .bind(JSON.stringify(keepData), existing.id));
        }
      } catch { /* ignore parse errors */ }
      batch.push(c.env.DB.prepare('DELETE FROM counseling_sheets WHERE id = ?').bind(ms.id));
    } else {
      // No conflict — move
      batch.push(c.env.DB.prepare('UPDATE counseling_sheets SET customer_id = ? WHERE id = ?').bind(body.keep_id, ms.id));
    }
  }
  batch.push(c.env.DB.prepare('DELETE FROM customer_merge_candidates WHERE line_customer_id = ? OR existing_customer_id = ?').bind(body.merge_id, body.merge_id));
  // Move intake/walk-in history to the keeper (same store — see store check above)
  batch.push(c.env.DB.prepare('UPDATE intake_sessions SET customer_id = ? WHERE customer_id = ?').bind(body.keep_id, body.merge_id));
  batch.push(c.env.DB.prepare('UPDATE walkin_intakes SET customer_id = ? WHERE customer_id = ?').bind(body.keep_id, body.merge_id));

  // 会員番号(master)の統合: keeper 側の番号を残す。新番号は発番しない。
  const keepMaster = (keep as Customer & { master_id?: string | null }).master_id || null;
  const mergeMaster = (merge as Customer & { master_id?: string | null }).master_id || null;
  if (mergeMaster && keepMaster && mergeMaster !== keepMaster) {
    // merge 側マスタの全顧客を keeper 側マスタへ付け替え、旧マスタは削除せず統合先を指して残す
    // （旧番号でSalonboardに登録済みの顧客を引き当て直せるようにするため）
    batch.push(c.env.DB.prepare("UPDATE customers SET master_id = ?, updated_at = datetime('now') WHERE master_id = ?").bind(keepMaster, mergeMaster));
    batch.push(c.env.DB.prepare("UPDATE customer_master SET merged_into = ?, updated_at = datetime('now') WHERE id = ?").bind(keepMaster, mergeMaster));

    // merge 側の店舗のSBには旧番号で顧客が登録されている可能性がある。番号が実際に変わる
    // ときだけ、その店舗のSB顧客情報を新番号に書き換えるようVPSのキューに積む。
    const nos = await c.env.DB.prepare(
      `SELECT (SELECT member_no FROM customer_master WHERE id = ?1) AS old_no,
              (SELECT member_no FROM customer_master WHERE id = ?2) AS new_no`
    ).bind(mergeMaster, keepMaster).first<{ old_no: string | null; new_no: string | null }>();
    if (nos?.old_no && nos?.new_no && nos.old_no !== nos.new_no) {
      batch.push(c.env.DB.prepare(
        `INSERT INTO sb_member_no_updates (id, store_id, customer_id, customer_name, old_member_no, new_member_no)
         SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM stores WHERE id = ? AND salonboard_enabled = 1)`
      ).bind(crypto.randomUUID(), merge.store_id, body.keep_id, merge.name, nos.old_no, nos.new_no, merge.store_id));
    }
  } else if (mergeMaster && !keepMaster) {
    // keeper に番号が無ければ merge 側の番号を引き継ぐ
    batch.push(c.env.DB.prepare("UPDATE customers SET master_id = ?, updated_at = datetime('now') WHERE id = ?").bind(mergeMaster, body.keep_id));
  }

  // Delete merged record
  batch.push(c.env.DB.prepare('DELETE FROM customers WHERE id = ?').bind(body.merge_id));

  // Collect R2 keys of images on duplicate karutes BEFORE the batch deletes the rows
  let orphanImageKeys: string[] = [];
  if (dupKaruteIds.length > 0) {
    const placeholders = dupKaruteIds.map(() => '?').join(',');
    const imgs = await c.env.DB.prepare(
      `SELECT image_url FROM karute_images WHERE karute_id IN (${placeholders})`
    ).bind(...dupKaruteIds).all<{ image_url: string }>();
    orphanImageKeys = imgs.results
      .map((r) => r.image_url.replace(/^\/images\//, '').split('?')[0])
      .filter((k) => k.length > 0);
  }

  await c.env.DB.batch(batch);

  // Delete the now-orphaned image files from R2 (DB rows are already gone)
  if (orphanImageKeys.length > 0) {
    c.executionCtx.waitUntil(
      Promise.allSettled(orphanImageKeys.map((k) => c.env.IMAGES.delete(k)))
        .then((results) => {
          const failed = results.filter((r) => r.status === 'rejected').length;
          if (failed > 0) console.error(`Merge: failed to delete ${failed}/${orphanImageKeys.length} R2 images`);
        })
    );
  }

  return c.json({ success: true });
});

// 同一人物として会員番号を統合（物理マージはせず番号だけ共有）
customersRoutes.post('/link-master', requireRole('system_admin', 'owner', 'manager'), async (c) => {
  const staff = c.get('staff')!;
  const body = await c.req.json<{ customer_ids: string[] }>();
  const ids = [...new Set((body.customer_ids || []).filter(Boolean))];
  if (ids.length < 2) return c.json({ error: 'customer_ids は2件以上必要です' }, 400);

  const placeholders = ids.map(() => '?').join(',');
  const rows = await c.env.DB.prepare(
    `SELECT c.id, c.store_id, c.master_id, s.group_id, cm.seq AS master_seq
     FROM customers c JOIN stores s ON s.id = c.store_id
     LEFT JOIN customer_master cm ON cm.id = c.master_id
     WHERE c.id IN (${placeholders})`
  ).bind(...ids).all<{ id: string; store_id: string; master_id: string | null; group_id: string | null; master_seq: number | null }>();

  const custs = rows.results;
  if (custs.length !== ids.length) return c.json({ error: 'Customer not found' }, 404);

  // 同一グループチェック
  const groupSet = new Set(custs.map((x) => x.group_id));
  if (groupSet.size !== 1 || custs.some((x) => !x.group_id)) {
    return c.json({ error: '異なるグループの顧客はリンクできません' }, 400);
  }
  const groupId = custs[0].group_id!;

  // 会員番号統合はグループレベルの識別操作（master_id/customer_master のみ変更、店舗固有データは
  // 動かさない）。関係する全店舗への個別アクセス権ではなく「同一グループ所属」を要件にする。
  // これがないと、自店しか権限のないスタッフが店舗跨ぎの重複を統合できない（物理マージは同一店舗
  // 限定なので cross-store は link-master に誘導される作りと矛盾していた）。
  if (!(await hasGroupAccess(c.env.DB, staff, groupId))) {
    return c.json({ error: 'この会員番号統合を行う権限がありません（対象グループ外）' }, 403);
  }

  // keeper マスタを決定: 既存マスタのうち seq 最小（最古番号）。無ければ新規採番。
  const withMaster = custs.filter((x) => x.master_id);
  let keeperMasterId: string;
  if (withMaster.length > 0) {
    withMaster.sort((a, b) => (a.master_seq ?? Infinity) - (b.master_seq ?? Infinity));
    keeperMasterId = withMaster[0].master_id!;
  } else {
    const created = await allocateMaster(c.env.DB, groupId);
    if (!created) return c.json({ error: 'Failed to allocate member number' }, 500);
    keeperMasterId = created.masterId;
  }

  const batch = [] as ReturnType<typeof c.env.DB.prepare>[];
  // 他マスタの全顧客を keeper へ付け替え、旧マスタは削除せず統合先を指して残す
  // （旧番号でSalonboardに登録済みの顧客を引き当て直せるようにするため）
  const otherMasters = [...new Set(withMaster.map((x) => x.master_id!).filter((m) => m !== keeperMasterId))];
  const keeperNoRow = otherMasters.length > 0
    ? await c.env.DB.prepare('SELECT member_no FROM customer_master WHERE id = ?').bind(keeperMasterId).first<{ member_no: string }>()
    : null;
  for (const m of otherMasters) {
    batch.push(c.env.DB.prepare("UPDATE customers SET master_id = ?, updated_at = datetime('now') WHERE master_id = ?").bind(keeperMasterId, m));
    batch.push(c.env.DB.prepare("UPDATE customer_master SET merged_into = ?, updated_at = datetime('now') WHERE id = ?").bind(keeperMasterId, m));

    // 番号を失う側の顧客がいる各店舗のSB顧客番号を新番号へ書き換えるようキューに積む
    // （物理マージ時と同じ扱い。SB連携が有効な店舗のみ。該当顧客なしはVPS側で「対応不要」扱い）
    if (keeperNoRow?.member_no) {
      const oldRow = await c.env.DB.prepare('SELECT member_no FROM customer_master WHERE id = ?').bind(m).first<{ member_no: string }>();
      if (oldRow?.member_no && oldRow.member_no !== keeperNoRow.member_no) {
        const affected = await c.env.DB.prepare(
          `SELECT DISTINCT c.store_id, c.id AS customer_id, c.name FROM customers c
           JOIN stores s ON s.id = c.store_id
           WHERE c.master_id = ? AND s.salonboard_enabled = 1`
        ).bind(m).all<{ store_id: string; customer_id: string; name: string }>();
        for (const a of affected.results || []) {
          batch.push(c.env.DB.prepare(
            `INSERT INTO sb_member_no_updates (id, store_id, customer_id, customer_name, old_member_no, new_member_no)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).bind(crypto.randomUUID(), a.store_id, a.customer_id, a.name, oldRow.member_no, keeperNoRow.member_no));
        }
      }
    }
  }
  // 未付番の選択顧客を keeper に付与
  for (const x of custs.filter((y) => !y.master_id)) {
    batch.push(c.env.DB.prepare("UPDATE customers SET master_id = ?, updated_at = datetime('now') WHERE id = ?").bind(keeperMasterId, x.id));
  }
  if (batch.length) await c.env.DB.batch(batch);

  const master = await c.env.DB.prepare('SELECT member_no FROM customer_master WHERE id = ?').bind(keeperMasterId).first<{ member_no: string }>();
  return c.json({ success: true, master_id: keeperMasterId, member_no: master?.member_no });
});

// 会員番号のリンクを解除（その顧客に新しい会員番号を採番）
customersRoutes.post('/unlink-master', requireRole('system_admin', 'owner', 'manager'), async (c) => {
  const staff = c.get('staff')!;
  const body = await c.req.json<{ customer_id: string }>();
  if (!body.customer_id) return c.json({ error: 'customer_id は必須です' }, 400);

  const cust = await c.env.DB.prepare(
    `SELECT c.id, c.store_id, s.group_id FROM customers c JOIN stores s ON s.id = c.store_id WHERE c.id = ?`
  ).bind(body.customer_id).first<{ id: string; store_id: string; group_id: string | null }>();
  if (!cust) return c.json({ error: 'Customer not found' }, 404);
  if (!(await hasStoreAccess(c.env.DB, staff, cust.store_id))) return c.json({ error: 'Forbidden' }, 403);
  if (!cust.group_id) return c.json({ error: 'グループ未設定の店舗です' }, 400);

  const created = await allocateMaster(c.env.DB, cust.group_id);
  if (!created) return c.json({ error: 'Failed to allocate member number' }, 500);
  await c.env.DB.prepare("UPDATE customers SET master_id = ?, updated_at = datetime('now') WHERE id = ?").bind(created.masterId, body.customer_id).run();

  return c.json({ success: true, master_id: created.masterId, member_no: created.memberNo });
});

// Cross-store phone lookup
customersRoutes.get('/cross-store-matches', async (c) => {
  const phone = c.req.query('phone');
  const excludeStoreId = c.req.query('exclude_store_id');

  if (!phone) {
    return c.json({ matches: [] });
  }

  let query = `
    SELECT c.id, c.name, c.name_kana, c.phone, c.visit_count, c.last_visit_at,
           c.store_id, st.name as store_name
    FROM customers c
    JOIN stores st ON c.store_id = st.id
    WHERE c.phone = ?
  `;
  const params: string[] = [phone];

  if (excludeStoreId) {
    query += ' AND c.store_id != ?';
    params.push(excludeStoreId);
  }

  query += ' ORDER BY st.name, c.name';

  const result = await c.env.DB.prepare(query)
    .bind(...params)
    .all();

  return c.json({
    matches: (result.results || []).map((row: Record<string, unknown>) => ({
      customer_id: row.id,
      customer_name: row.name,
      customer_name_kana: row.name_kana,
      phone: row.phone,
      visit_count: row.visit_count,
      last_visit_at: row.last_visit_at,
      store_id: row.store_id,
      store_name: row.store_name,
    })),
  });
});

// Get customer by ID
customersRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');

  const customer = await c.env.DB.prepare(
    `SELECT c.*, COALESCE(s.nickname, s.name) as staff_name, cm.member_no as member_no
     FROM customers c
     LEFT JOIN staff s ON c.staff_id = s.id
     LEFT JOIN customer_master cm ON cm.id = c.master_id
     WHERE c.id = ?`
  )
    .bind(id)
    .first<Customer & { staff_name: string | null }>();

  if (!customer) {
    return c.json({ error: 'Customer not found' }, 404);
  }

  // Visibility: all roles (including 'staff') can view any customer across stores.
  // (Editing remains restricted to assigned customers for the 'staff' role.)

  // Get assigned staff list from customer_staff junction table
  const assignedStaff = await c.env.DB.prepare(
    `SELECT cs.staff_id, cs.is_primary, COALESCE(s.nickname, s.name) as staff_name
     FROM customer_staff cs
     JOIN staff s ON cs.staff_id = s.id
     WHERE cs.customer_id = ?
     ORDER BY cs.is_primary DESC, cs.created_at ASC`
  ).bind(id).all<{ staff_id: string; is_primary: number; staff_name: string }>();

  // Get LINE info if exists
  const lineInfo = await c.env.DB.prepare(
    'SELECT display_name, picture_url, is_blocked FROM customer_line WHERE customer_id = ? AND store_id = ?'
  )
    .bind(id, customer.store_id)
    .first();

  // Get recent reservations
  const reservations = await c.env.DB.prepare(
    `SELECT r.*, m.name as menu_name, COALESCE(s.nickname, s.name) as staff_name, st.name as store_name
     FROM reservations r
     LEFT JOIN menus m ON r.menu_id = m.id
     LEFT JOIN staff s ON r.staff_id = s.id
     LEFT JOIN stores st ON r.store_id = st.id
     WHERE r.customer_id = ?
     ORDER BY r.start_at DESC
     LIMIT 10`
  )
    .bind(id)
    .all();

  // Get recent karutes (across all stores — unified customer — with store label)
  const karutes = await c.env.DB.prepare(
    `SELECT k.*, COALESCE(s.nickname, s.name) as staff_name, st.name as store_name
     FROM karutes k
     LEFT JOIN staff s ON k.staff_id = s.id
     LEFT JOIN stores st ON k.store_id = st.id
     WHERE k.customer_id = ?
     ORDER BY k.visit_date DESC
     LIMIT 10`
  )
    .bind(id)
    .all();

  // Get consent records (match by name or phone)
  const consentRecords = await c.env.DB.prepare(
    `SELECT id, store_id, customer_name, customer_birthday, customer_phone, customer_occupation, customer_visit_reason, template_snapshot, created_at
     FROM consent_records WHERE (customer_name = ? OR (customer_phone IS NOT NULL AND customer_phone != '' AND customer_phone = ?))
     ORDER BY created_at DESC`
  ).bind(customer.name, customer.phone || '').all();

  // Linked records at other group stores (same customer_master = same person)
  let linkedCustomers: unknown[] = [];
  const masterId = (customer as Customer & { master_id?: string | null }).master_id;
  if (masterId) {
    const linked = await c.env.DB.prepare(
      `SELECT c.id, c.store_id, st.name as store_name, c.name, c.visit_count, c.last_visit_at,
              COALESCE(s.nickname, s.name) as staff_name,
              (SELECT COUNT(*) FROM karutes k WHERE k.customer_id = c.id) as karute_count,
              (SELECT MAX(r.start_at) FROM reservations r WHERE r.customer_id = c.id AND r.status NOT IN ('cancelled','noshow')) as last_reservation_at
       FROM customers c
       JOIN stores st ON st.id = c.store_id
       LEFT JOIN staff s ON s.id = c.staff_id
       WHERE c.master_id = ? AND c.id != ?
       ORDER BY c.last_visit_at DESC`
    ).bind(masterId, id).all();
    linkedCustomers = linked.results;
  }

  return c.json({
    customer: sanitizeCustomer(customer),
    assigned_staff: assignedStaff.results,
    line: lineInfo,
    reservations: reservations.results,
    karutes: karutes.results,
    consent_records: consentRecords.results,
    linked_customers: linkedCustomers,
  });
});

// Create customer
customersRoutes.post('/', async (c) => {
  const staff = c.get('staff')!;
  const body = await c.req.json<{
    store_id?: string;
    name: string;
    name_kana?: string;
    phone?: string;
    email?: string;
    gender?: Customer['gender'];
    birthday?: string;
    occupation?: string;
    postal_code?: string;
    address?: string;
    memo?: string;
    staff_id?: string;
    origin?: 'staff' | 'store';
  }>();

  if (!body.name) {
    return c.json({ error: 'Name is required' }, 400);
  }

  const storeId = body.store_id || staff.store_id;
  if (!storeId) {
    return c.json({ error: 'Store ID is required' }, 400);
  }

  // Check store access
  if (!await hasStoreAccess(c.env.DB, staff, storeId)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  // Staff/manager role assigns themselves by default
  const assignedStaffId = (staff.role === 'staff' || staff.role === 'manager') ? staff.id : (body.staff_id || null);
  const origin = body.origin || 'store';

  const id = crypto.randomUUID();

  await c.env.DB.prepare(
    `INSERT INTO customers (id, store_id, staff_id, name, name_kana, phone, email, gender, birthday, occupation, postal_code, address, memo, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      storeId,
      assignedStaffId,
      body.name,
      body.name_kana || null,
      body.phone || null,
      body.email || null,
      body.gender || null,
      body.birthday || null,
      body.occupation || null,
      body.postal_code || null,
      body.address || null,
      body.memo || null,
      origin
    )
    .run();

  // Also insert into customer_staff junction table
  if (assignedStaffId) {
    await c.env.DB.prepare(
      'INSERT INTO customer_staff (id, customer_id, staff_id, is_primary) VALUES (?, ?, ?, 1)'
    ).bind(crypto.randomUUID(), id, assignedStaffId).run();
  }

  // 店舗跨ぎ会員番号を割り当て（電話一致で既存マスタにリンク / 無ければ新規採番）
  try {
    await getOrCreateMaster(c.env.DB, { customerId: id, phone: body.phone || null, storeId });
  } catch (err) {
    console.error('[customer-master] staff create assign failed:', err);
  }

  const customer = await c.env.DB.prepare('SELECT * FROM customers WHERE id = ?')
    .bind(id)
    .first<Customer>();

  return c.json({ customer: sanitizeCustomer(customer) }, 201);
});

// Update customer
customersRoutes.put('/:id', async (c) => {
  const staff = c.get('staff')!;
  const id = c.req.param('id');

  const customer = await c.env.DB.prepare('SELECT * FROM customers WHERE id = ?')
    .bind(id)
    .first<Customer>();

  if (!customer) {
    return c.json({ error: 'Customer not found' }, 404);
  }

  // Check access - owners, system_admin, managers can edit all customers
  // staff role: only their assigned customers
  if (staff.role === 'staff') {
    const isAssigned = customer.staff_id === staff.id ||
      !!(await c.env.DB.prepare('SELECT 1 FROM customer_staff WHERE customer_id = ? AND staff_id = ?').bind(id, staff.id).first());
    if (!isAssigned) {
      return c.json({ error: 'Forbidden' }, 403);
    }
  }

  const body = await c.req.json<{
    name?: string;
    name_kana?: string;
    phone?: string;
    email?: string;
    gender?: Customer['gender'];
    birthday?: string;
    occupation?: string;
    postal_code?: string;
    address?: string;
    memo?: string;
    is_minimo?: number;
  }>();

  const updates: string[] = [];
  const values: (string | null)[] = [];

  if (body.name !== undefined) {
    updates.push('name = ?');
    values.push(body.name);
  }
  if (body.name_kana !== undefined) {
    updates.push('name_kana = ?');
    values.push(body.name_kana || null);
  }
  if (body.phone !== undefined) {
    updates.push('phone = ?');
    values.push(body.phone || null);
  }
  if (body.email !== undefined) {
    updates.push('email = ?');
    values.push(body.email || null);
  }
  if (body.gender !== undefined) {
    updates.push('gender = ?');
    values.push(body.gender || null);
  }
  if (body.birthday !== undefined) {
    updates.push('birthday = ?');
    values.push(body.birthday || null);
  }
  if (body.occupation !== undefined) {
    updates.push('occupation = ?');
    values.push(body.occupation || null);
  }
  if (body.postal_code !== undefined) {
    updates.push('postal_code = ?');
    values.push(body.postal_code || null);
  }
  if (body.address !== undefined) {
    updates.push('address = ?');
    values.push(body.address || null);
  }
  if (body.memo !== undefined) {
    updates.push('memo = ?');
    values.push(body.memo || null);
  }
  if (body.is_minimo !== undefined) {
    updates.push('is_minimo = ?');
    values.push(String(body.is_minimo ? 1 : 0));
  }

  if (updates.length === 0) {
    return c.json({ error: 'No updates provided' }, 400);
  }

  updates.push("updated_at = datetime('now')");
  values.push(id);

  await c.env.DB.prepare(`UPDATE customers SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();

  const updated = await c.env.DB.prepare('SELECT * FROM customers WHERE id = ?')
    .bind(id)
    .first<Customer>();

  // Propagate personal attributes to linked records at other group stores
  // (same customer_master = same person). Fill EMPTY fields only — never overwrite.
  if (updated?.master_id) {
    const shareFields: { key: 'name_kana' | 'phone' | 'email' | 'gender' | 'birthday'; value: string | null }[] = [
      { key: 'name_kana', value: updated.name_kana },
      { key: 'phone', value: updated.phone },
      { key: 'email', value: updated.email },
      { key: 'gender', value: updated.gender },
      { key: 'birthday', value: updated.birthday },
    ];
    for (const f of shareFields) {
      if (body[f.key] !== undefined && f.value) {
        c.executionCtx.waitUntil(
          c.env.DB.prepare(
            `UPDATE customers SET ${f.key} = ?, updated_at = datetime('now')
             WHERE master_id = ? AND id != ? AND (${f.key} IS NULL OR ${f.key} = '')`
          ).bind(f.value, updated.master_id, id).run()
            .catch((e) => console.error('Failed to propagate customer field:', f.key, e))
        );
      }
    }
  }

  return c.json({ customer: sanitizeCustomer(updated as unknown as Record<string, unknown>) });
});

// Assign staff to customer (manager+ only)
// Accepts either { staff_id: string | null } (legacy) or { staff_ids: string[] }
customersRoutes.put('/:id/staff', requireRole('system_admin', 'owner', 'manager'), async (c) => {
  const id = c.req.param('id');

  const customer = await c.env.DB.prepare('SELECT * FROM customers WHERE id = ?')
    .bind(id)
    .first<Customer>();

  if (!customer) {
    return c.json({ error: 'Customer not found' }, 404);
  }

  const body = await c.req.json<{ staff_id?: string | null; staff_ids?: string[] }>();

  // Normalize to staff_ids array
  let staffIds: string[];
  if (body.staff_ids !== undefined) {
    staffIds = body.staff_ids.filter(Boolean);
  } else {
    staffIds = body.staff_id ? [body.staff_id] : [];
  }

  // Verify all staff exist
  for (const sid of staffIds) {
    const targetStaff = await c.env.DB.prepare('SELECT id FROM staff WHERE id = ?')
      .bind(sid)
      .first();

    if (!targetStaff) {
      return c.json({ error: `Invalid staff ID: ${sid}` }, 400);
    }
  }

  const batch: D1PreparedStatement[] = [];

  // Update customers.staff_id (primary = first in array, for backward compat)
  const primaryStaffId = staffIds.length > 0 ? staffIds[0] : null;
  batch.push(
    c.env.DB.prepare("UPDATE customers SET staff_id = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(primaryStaffId, id)
  );

  // Replace customer_staff entries
  batch.push(
    c.env.DB.prepare('DELETE FROM customer_staff WHERE customer_id = ?').bind(id)
  );

  for (let i = 0; i < staffIds.length; i++) {
    batch.push(
      c.env.DB.prepare(
        'INSERT INTO customer_staff (id, customer_id, staff_id, is_primary) VALUES (?, ?, ?, ?)'
      ).bind(crypto.randomUUID(), id, staffIds[i], i === 0 ? 1 : 0)
    );
  }

  await c.env.DB.batch(batch);

  const updated = await c.env.DB.prepare('SELECT * FROM customers WHERE id = ?')
    .bind(id)
    .first<Customer>();

  return c.json({ customer: sanitizeCustomer(updated as unknown as Record<string, unknown>) });
});

// Delete all customers for a store (owner+ only, dev use)
customersRoutes.delete('/all', requireRole('system_admin', 'owner'), async (c) => {
  const currentStaff = c.get('staff')!;
  const storeId = c.req.query('store_id') || currentStaff.store_id;

  if (!storeId) {
    return c.json({ error: 'Store ID is required' }, 400);
  }

  if (currentStaff.role !== 'system_admin' && currentStaff.store_id !== storeId) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const result = await c.env.DB.prepare(
    'DELETE FROM customers WHERE store_id = ?'
  ).bind(storeId).run();

  return c.json({
    success: true,
    deleted: result.meta.changes,
  });
});

// Delete customer (manager+ only)
customersRoutes.delete('/:id', requireRole('system_admin', 'owner', 'manager'), async (c) => {
  const staff = c.get('staff')!;
  const id = c.req.param('id');

  const customer = await c.env.DB.prepare('SELECT * FROM customers WHERE id = ?')
    .bind(id)
    .first<Customer>();

  if (!customer) {
    return c.json({ error: 'Customer not found' }, 404);
  }

  // Check access
  if (!await hasStoreAccess(c.env.DB, staff, customer.store_id)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  await c.env.DB.prepare('DELETE FROM customers WHERE id = ?').bind(id).run();

  return c.json({ success: true });
});

// Import customers from JSON (manager+ only)
customersRoutes.post('/import/json', requireRole('system_admin', 'owner', 'manager'), async (c) => {
  const currentStaff = c.get('staff')!;
  const body = await c.req.json<{
    store_id?: string;
    customers: {
      staffName: string;
      customerName: string;
      nameKana?: string;
      gender?: string;
      birthday?: string;
      origin?: string;
      occupation?: string;
      postalCode?: string;
      phone?: string;
      email?: string;
      address?: string;
    }[];
  }>();

  const storeId = body.store_id || currentStaff.store_id;
  if (!storeId) {
    return c.json({ error: 'Store ID is required' }, 400);
  }

  if (!(await hasStoreAccess(c.env.DB, currentStaff, storeId))) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  if (!Array.isArray(body.customers) || body.customers.length === 0) {
    return c.json({ error: '顧客データが空です' }, 400);
  }

  const { created, updated, skipped, staffNotFound } = await importLimeCustomersToDb(
    c.env.DB, storeId, body.customers
  );

  let message = `${body.customers.length}件中${created}件を新規登録`;
  if (updated > 0) {
    message += `、${updated}件を更新`;
  }
  message += 'しました。';
  if (skipped > 0) {
    message += `（${skipped}件は変更なしのため省略）`;
  }
  if (staffNotFound.length > 0) {
    message += `\n担当者が見つからなかった名前: ${staffNotFound.join(', ')}`;
  }

  return c.json({
    success: true,
    message,
    created,
    updated,
    skipped,
    staffNotFound,
    total: body.customers.length,
  });
});
