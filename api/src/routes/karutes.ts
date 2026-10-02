import { Hono } from 'hono';
import type { Bindings, Variables, Karute, KaruteImage, KaruteMenu, Staff } from '../types';
import { staffAuth } from '../middleware/auth';
import { signImageRows, signImageUrl } from '../utils/imageSign';

export const karutesRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Apply auth middleware
karutesRoutes.use('*', staffAuth);

async function hasStoreAccess(db: D1Database, staff: Staff, storeId: string): Promise<boolean> {
  if (staff.role === 'system_admin') return true;
  if (staff.store_id === storeId) return true;
  const link = await db.prepare(
    'SELECT 1 FROM staff_stores WHERE staff_id = ? AND store_id = ?'
  ).bind(staff.id, storeId).first();
  return !!link;
}

// List karutes
karutesRoutes.get('/', async (c) => {
  const staff = c.get('staff')!;
  const storeId = c.req.query('store_id') || staff.store_id;
  const customerId = c.req.query('customer_id');
  const staffId = c.req.query('staff_id');
  const reservationId = c.req.query('reservation_id');
  const startDate = c.req.query('start_date');
  const endDate = c.req.query('end_date');

  if (!storeId && staff.role !== 'system_admin') {
    return c.json({ karutes: [] });
  }

  let query = `
    SELECT k.*,
           c.name as customer_name,
           COALESCE(s.nickname, s.name) as staff_name,
           st.name as store_name,
           (SELECT COUNT(*) FROM karute_images WHERE karute_id = k.id) as image_count,
           CASE WHEN EXISTS (SELECT 1 FROM consent_records cr WHERE cr.reservation_id = k.reservation_id AND k.reservation_id IS NOT NULL) THEN 1 ELSE 0 END as has_consent,
           CASE WHEN k.menu_content IS NULL AND k.reservation_id IS NOT NULL THEN
             (SELECT GROUP_CONCAT(rm.menu_name, '、') FROM reservation_menus rm WHERE rm.reservation_id = k.reservation_id ORDER BY rm.sort_order)
           ELSE k.menu_content END as menu_content
    FROM karutes k
    LEFT JOIN customers c ON k.customer_id = c.id
    LEFT JOIN staff s ON k.staff_id = s.id
    LEFT JOIN stores st ON k.store_id = st.id
    WHERE 1=1
  `;
  const params: string[] = [];

  // When viewing a specific customer, show karutes across all stores (group-wide unified
  // customer) with a per-card store label. Otherwise scope to the store being browsed.
  if (storeId && !customerId) {
    query += ' AND k.store_id = ?';
    params.push(storeId);
  }

  // Staff role restrictions
  if (staff.role === 'staff') {
    // Staff can only see karutes for their assigned customers
    query += ' AND (c.staff_id = ? OR c.id IN (SELECT cs.customer_id FROM customer_staff cs WHERE cs.staff_id = ?))';
    params.push(staff.id, staff.id);
  } else if (staffId) {
    query += ' AND k.staff_id = ?';
    params.push(staffId);
  }

  if (customerId) {
    query += ' AND k.customer_id = ?';
    params.push(customerId);
  }

  if (reservationId) {
    query += ' AND k.reservation_id = ?';
    params.push(reservationId);
  }

  if (startDate && endDate) {
    query += ' AND k.visit_date >= ? AND k.visit_date <= ?';
    params.push(startDate, endDate);
  }

  query += ' ORDER BY k.visit_date DESC LIMIT 100';

  const result = await c.env.DB.prepare(query)
    .bind(...params)
    .all();

  return c.json({ karutes: result.results });
});

// Get karute by ID
karutesRoutes.get('/:id', async (c) => {
  const staff = c.get('staff')!;
  const id = c.req.param('id');

  const karute = await c.env.DB.prepare(
    `SELECT k.*,
            c.name as customer_name, c.staff_id as customer_staff_id,
            COALESCE(s.nickname, s.name) as staff_name
     FROM karutes k
     LEFT JOIN customers c ON k.customer_id = c.id
     LEFT JOIN staff s ON k.staff_id = s.id
     WHERE k.id = ?`
  )
    .bind(id)
    .first<Karute & { customer_name: string; customer_staff_id: string | null; staff_name: string }>();

  if (!karute) {
    return c.json({ error: 'Karute not found' }, 404);
  }

  // Check access - staff can only see their own customers' karutes
  if (staff.role === 'staff' && karute.customer_staff_id !== staff.id) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  // Get images
  const images = await c.env.DB.prepare(
    'SELECT * FROM karute_images WHERE karute_id = ? ORDER BY sort_order, created_at'
  )
    .bind(id)
    .all<KaruteImage>();

  // Get karute menus
  const karuteMenus = await c.env.DB.prepare(
    'SELECT * FROM karute_menus WHERE karute_id = ? ORDER BY sort_order'
  )
    .bind(id)
    .all<KaruteMenu>();

  // Check consent status
  let hasConsent = false;
  if (karute.reservation_id) {
    const consent = await c.env.DB.prepare(
      'SELECT 1 FROM consent_records WHERE reservation_id = ? LIMIT 1'
    )
      .bind(karute.reservation_id)
      .first();
    hasConsent = !!consent;
  }

  const signedImages = await signImageRows(images.results, c.env.JWT_SECRET);
  return c.json({ karute: { ...karute, has_consent: hasConsent ? 1 : 0 }, images: signedImages, menus: karuteMenus.results });
});

// Extract dates from image using Claude Vision
karutesRoutes.post('/extract-dates', async (c) => {
  const apiKey = c.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return c.json({ error: 'ANTHROPIC_API_KEY not configured' }, 500);
  }

  const { image, mediaType } = await c.req.json<{
    image: string;
    mediaType: string;
  }>();

  if (!image) {
    return c.json({ error: 'image is required' }, 400);
  }

  const prompt = `あなたは美容サロンのアシスタントです。
添付された画像はサロン管理アプリの予約履歴や来店履歴のスクリーンショットです。

画像に表示されている全ての来店・予約の日付と時間、施術内容を抽出してJSON形式で返してください。

ルール:
- date は YYYY-MM-DD 形式（必須）
- time は HH:MM 形式（不明な場合は省略）
- description は施術メニュー名や内容（不明な場合は省略）
- 日付が新しい順に並べる
- JSONのみ返す。説明文は不要。

出力形式:
[
  { "date": "2025-04-28", "time": "14:00", "description": "カット+カラー" },
  { "date": "2025-03-15", "time": "11:30" }
]`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: mediaType, data: image },
              },
              { type: 'text', text: prompt },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Claude API error:', response.status, errorText);
      return c.json({ error: 'AI processing failed' }, 502);
    }

    const result = await response.json() as {
      content: Array<{ type: string; text?: string }>;
    };

    const textContent = result.content.find((b) => b.type === 'text');
    if (!textContent?.text) {
      return c.json({ error: 'No text response from AI' }, 502);
    }

    let jsonStr = textContent.text.trim();
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim();
    }

    const visits = JSON.parse(jsonStr) as Array<{
      date: string;
      time?: string;
      description?: string;
    }>;

    return c.json({ visits });
  } catch (error) {
    console.error('Extract dates error:', error);
    return c.json({ error: 'Failed to process image' }, 500);
  }
});

// Create karute
karutesRoutes.post('/', async (c) => {
  const staff = c.get('staff')!;
  const body = await c.req.json<{
    store_id?: string;
    customer_id: string;
    reservation_id?: string;
    visit_date: string;
    menu_ids?: string[];
    memo?: string;
    assistant_memo?: string;
    face_drawing?: string;
    // Legacy fields (backward compat)
    menu_content?: string;
    hair_condition?: string;
    color_formula?: string;
    perm_info?: string;
    styling_notes?: string;
    customer_feedback?: string;
    next_suggestion?: string;
    internal_memo?: string;
  }>();

  if (!body.customer_id || !body.visit_date) {
    return c.json({ error: 'Customer ID and visit date are required' }, 400);
  }

  const storeId = body.store_id || staff.store_id;
  if (!storeId) {
    return c.json({ error: 'Store ID is required' }, 400);
  }

  // Check store access
  if (!await hasStoreAccess(c.env.DB, staff, storeId)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const id = crypto.randomUUID();

  await c.env.DB.prepare(
    `INSERT INTO karutes (id, store_id, customer_id, reservation_id, staff_id, visit_date,
       menu_content, hair_condition, color_formula, perm_info, styling_notes,
       customer_feedback, next_suggestion, internal_memo, face_drawing,
       memo, assistant_memo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      storeId,
      body.customer_id,
      body.reservation_id || null,
      staff.id,
      body.visit_date,
      body.menu_content || null,
      body.hair_condition || null,
      body.color_formula || null,
      body.perm_info || null,
      body.styling_notes || null,
      body.customer_feedback || null,
      body.next_suggestion || null,
      body.internal_memo || null,
      body.face_drawing || null,
      body.memo || null,
      body.assistant_memo || null
    )
    .run();

  // Insert karute_menus
  const menuIds = body.menu_ids || [];
  for (let i = 0; i < menuIds.length; i++) {
    const mid = menuIds[i];
    const menuRow = await c.env.DB.prepare('SELECT name, price FROM menus WHERE id = ?')
      .bind(mid).first<{ name: string; price: number }>();
    if (menuRow) {
      await c.env.DB.prepare(
        `INSERT INTO karute_menus (id, karute_id, menu_id, menu_name, price, sort_order)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(crypto.randomUUID(), id, mid, menuRow.name, menuRow.price, i).run();
    }
  }

  const karute = await c.env.DB.prepare('SELECT * FROM karutes WHERE id = ?')
    .bind(id)
    .first<Karute>();

  return c.json({ karute }, 201);
});

// Update karute
karutesRoutes.put('/:id', async (c) => {
  const staff = c.get('staff')!;
  const id = c.req.param('id');

  const karute = await c.env.DB.prepare('SELECT * FROM karutes WHERE id = ?')
    .bind(id)
    .first<Karute>();

  if (!karute) {
    return c.json({ error: 'Karute not found' }, 404);
  }

  // Only the creator (or system_admin) can edit
  if (staff.role !== 'system_admin' && karute.staff_id !== staff.id) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const body = await c.req.json<{
    visit_date?: string;
    menu_ids?: string[];
    memo?: string;
    assistant_memo?: string;
    face_drawing?: string;
    // Legacy fields (backward compat)
    menu_content?: string;
    hair_condition?: string;
    color_formula?: string;
    perm_info?: string;
    styling_notes?: string;
    customer_feedback?: string;
    next_suggestion?: string;
    internal_memo?: string;
  }>();

  // Handle karute_menus update
  if (body.menu_ids !== undefined) {
    await c.env.DB.prepare('DELETE FROM karute_menus WHERE karute_id = ?')
      .bind(id).run();
    for (let i = 0; i < body.menu_ids.length; i++) {
      const mid = body.menu_ids[i];
      const menuRow = await c.env.DB.prepare('SELECT name, price FROM menus WHERE id = ?')
        .bind(mid).first<{ name: string; price: number }>();
      if (menuRow) {
        await c.env.DB.prepare(
          `INSERT INTO karute_menus (id, karute_id, menu_id, menu_name, price, sort_order)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(crypto.randomUUID(), id, mid, menuRow.name, menuRow.price, i).run();
      }
    }
  }

  const updates: string[] = [];
  const values: (string | null)[] = [];

  if (body.visit_date !== undefined) {
    updates.push('visit_date = ?');
    values.push(body.visit_date);
  }
  if (body.memo !== undefined) {
    updates.push('memo = ?');
    values.push(body.memo || null);
  }
  if (body.assistant_memo !== undefined) {
    updates.push('assistant_memo = ?');
    values.push(body.assistant_memo || null);
  }
  if (body.face_drawing !== undefined) {
    updates.push('face_drawing = ?');
    values.push(body.face_drawing || null);
  }
  // Legacy fields
  if (body.menu_content !== undefined) {
    updates.push('menu_content = ?');
    values.push(body.menu_content || null);
  }
  if (body.hair_condition !== undefined) {
    updates.push('hair_condition = ?');
    values.push(body.hair_condition || null);
  }
  if (body.color_formula !== undefined) {
    updates.push('color_formula = ?');
    values.push(body.color_formula || null);
  }
  if (body.perm_info !== undefined) {
    updates.push('perm_info = ?');
    values.push(body.perm_info || null);
  }
  if (body.styling_notes !== undefined) {
    updates.push('styling_notes = ?');
    values.push(body.styling_notes || null);
  }
  if (body.customer_feedback !== undefined) {
    updates.push('customer_feedback = ?');
    values.push(body.customer_feedback || null);
  }
  if (body.next_suggestion !== undefined) {
    updates.push('next_suggestion = ?');
    values.push(body.next_suggestion || null);
  }
  if (body.internal_memo !== undefined) {
    updates.push('internal_memo = ?');
    values.push(body.internal_memo || null);
  }

  if (updates.length === 0 && body.menu_ids === undefined) {
    return c.json({ error: 'No updates provided' }, 400);
  }

  if (updates.length > 0) {
    updates.push("updated_at = datetime('now')");
    values.push(id);

    await c.env.DB.prepare(`UPDATE karutes SET ${updates.join(', ')} WHERE id = ?`)
      .bind(...values)
      .run();
  } else {
    // Only menu_ids changed, still update timestamp
    await c.env.DB.prepare("UPDATE karutes SET updated_at = datetime('now') WHERE id = ?")
      .bind(id).run();
  }

  const updated = await c.env.DB.prepare('SELECT * FROM karutes WHERE id = ?')
    .bind(id)
    .first<Karute>();

  return c.json({ karute: updated });
});

// Share karute with customer
karutesRoutes.post('/:id/share', async (c) => {
  const staff = c.get('staff')!;
  const id = c.req.param('id');

  const karute = await c.env.DB.prepare('SELECT * FROM karutes WHERE id = ?')
    .bind(id)
    .first<Karute>();

  if (!karute) {
    return c.json({ error: 'Karute not found' }, 404);
  }

  if (!await hasStoreAccess(c.env.DB, staff, karute.store_id)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  await c.env.DB.prepare(
    "UPDATE karutes SET is_shared_to_customer = 1, shared_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
  )
    .bind(id)
    .run();

  // Future: Send LINE notification to customer when karute is shared

  return c.json({ success: true });
});

// Upload image
karutesRoutes.post('/:id/images', async (c) => {
  const staff = c.get('staff')!;
  const id = c.req.param('id');

  const karute = await c.env.DB.prepare('SELECT * FROM karutes WHERE id = ?')
    .bind(id)
    .first<Karute>();

  if (!karute) {
    return c.json({ error: 'Karute not found' }, 404);
  }

  if (!await hasStoreAccess(c.env.DB, staff, karute.store_id)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const formData = await c.req.formData();
  const file = formData.get('file') as File | null;
  const imageType = formData.get('image_type') as KaruteImage['image_type'] || 'other';
  const caption = formData.get('caption') as string || null;

  if (!file) {
    return c.json({ error: 'File is required' }, 400);
  }

  // Upload to R2
  const fileName = `karutes/${id}/${crypto.randomUUID()}-${file.name}`;
  await c.env.IMAGES.put(fileName, file.stream(), {
    httpMetadata: {
      contentType: file.type,
    },
  });

  // Get the count for sort_order
  const count = await c.env.DB.prepare(
    'SELECT COUNT(*) as count FROM karute_images WHERE karute_id = ?'
  )
    .bind(id)
    .first<{ count: number }>();

  const imageId = crypto.randomUUID();
  const imageUrl = `/images/${fileName}`;

  await c.env.DB.prepare(
    `INSERT INTO karute_images (id, karute_id, image_url, image_type, caption, sort_order)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(imageId, id, imageUrl, imageType, caption, count?.count || 0)
    .run();

  const image = await c.env.DB.prepare('SELECT * FROM karute_images WHERE id = ?')
    .bind(imageId)
    .first<KaruteImage>();

  const signedImage = image ? { ...image, image_url: await signImageUrl(image.image_url, c.env.JWT_SECRET) } : image;
  return c.json({ image: signedImage }, 201);
});

// Delete image
karutesRoutes.delete('/:id/images/:imageId', async (c) => {
  const staff = c.get('staff')!;
  const id = c.req.param('id');
  const imageId = c.req.param('imageId');

  const karute = await c.env.DB.prepare('SELECT * FROM karutes WHERE id = ?')
    .bind(id)
    .first<Karute>();

  if (!karute) {
    return c.json({ error: 'Karute not found' }, 404);
  }

  if (!await hasStoreAccess(c.env.DB, staff, karute.store_id)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const image = await c.env.DB.prepare('SELECT * FROM karute_images WHERE id = ? AND karute_id = ?')
    .bind(imageId, id)
    .first<KaruteImage>();

  if (!image) {
    return c.json({ error: 'Image not found' }, 404);
  }

  // Delete from R2
  const r2Key = image.image_url.replace('/images/', '');
  await c.env.IMAGES.delete(r2Key);

  // Delete from database
  await c.env.DB.prepare('DELETE FROM karute_images WHERE id = ?').bind(imageId).run();

  return c.json({ success: true });
});

// Delete karute
karutesRoutes.delete('/:id', async (c) => {
  const staff = c.get('staff')!;
  const id = c.req.param('id');

  const karute = await c.env.DB.prepare('SELECT * FROM karutes WHERE id = ?')
    .bind(id)
    .first<Karute>();

  if (!karute) {
    return c.json({ error: 'Karute not found' }, 404);
  }

  if (!await hasStoreAccess(c.env.DB, staff, karute.store_id)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  // Delete images from R2
  const images = await c.env.DB.prepare('SELECT * FROM karute_images WHERE karute_id = ?')
    .bind(id)
    .all<KaruteImage>();

  for (const image of images.results) {
    const r2Key = image.image_url.replace('/images/', '');
    await c.env.IMAGES.delete(r2Key);
  }

  // Delete karute (cascade will delete images)
  await c.env.DB.prepare('DELETE FROM karutes WHERE id = ?').bind(id).run();

  return c.json({ success: true });
});
