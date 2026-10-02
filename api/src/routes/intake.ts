import { Hono } from 'hono';
import type { Bindings, Variables } from '../types';

export const intakeRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Initialize intake session (called from LIFF page)
intakeRoutes.post('/init', async (c) => {
  const body = await c.req.json<{
    liff_access_token: string;
    staff_id: string;
  }>();

  if (!body.liff_access_token || !body.staff_id) {
    return c.json({ error: 'Missing required fields' }, 400);
  }

  // Verify token by getting LINE profile (works for both LIFF and mini app tokens)
  const profileRes = await fetch('https://api.line.me/v2/profile', {
    headers: { Authorization: `Bearer ${body.liff_access_token}` },
  });
  if (!profileRes.ok) {
    const errBody = await profileRes.text();
    console.error('LINE profile error:', profileRes.status, errBody);
    return c.json({ error: 'LINEの認証に失敗しました' }, 401);
  }
  const profile = await profileRes.json<{ userId: string; displayName: string; pictureUrl?: string }>();

  // Find staff and their store (with line_friend_url)
  const staff = await c.env.DB.prepare(
    `SELECT s.id, ss.store_id, st.line_friend_url FROM staff s
     JOIN staff_stores ss ON s.id = ss.staff_id
     JOIN stores st ON ss.store_id = st.id
     WHERE s.id = ? LIMIT 1`
  ).bind(body.staff_id).first<{ id: string; store_id: string; line_friend_url: string | null }>();

  if (!staff) {
    return c.json({ error: 'Staff not found' }, 404);
  }

  // Check if customer already exists for this LINE user + store
  // 1. Same store via customer_line
  let existingCustomer = await c.env.DB.prepare(
    `SELECT c.id, c.name FROM customers c
     JOIN customer_line cl ON c.id = cl.customer_id
     WHERE cl.line_user_id = ? AND c.store_id = ?`
  ).bind(profile.userId, staff.store_id).first<{ id: string; name: string }>();

  if (!existingCustomer) {
    // 2. Same store via intake_sessions
    existingCustomer = await c.env.DB.prepare(
      `SELECT c.id, c.name FROM customers c
       JOIN intake_sessions is2 ON is2.customer_id = c.id
       WHERE is2.line_user_id = ? AND is2.store_id = ?
       ORDER BY is2.created_at DESC LIMIT 1`
    ).bind(profile.userId, staff.store_id).first<{ id: string; name: string }>();
  }


  // Check for previous counseling data and consent
  let hasPreviousCounseling = false;
  let hasConsent = false;
  if (existingCustomer) {
    const sheet = await c.env.DB.prepare(
      'SELECT id FROM counseling_sheets WHERE customer_id = ? AND store_id = ?'
    ).bind(existingCustomer.id, staff.store_id).first();
    hasPreviousCounseling = !!sheet;

    const consent = await c.env.DB.prepare(
      'SELECT id FROM consent_records WHERE store_id = ? AND customer_name = ? LIMIT 1'
    ).bind(staff.store_id, existingCustomer.name).first();
    hasConsent = !!consent;
  }

  // Create or reuse intake session
  const sessionId = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO intake_sessions (id, store_id, staff_id, line_user_id, customer_id, status)
     VALUES (?, ?, ?, ?, ?, 'pending')`
  ).bind(sessionId, staff.store_id, staff.id, profile.userId, existingCustomer?.id || null).run();

  return c.json({
    session_id: sessionId,
    store_id: staff.store_id,
    customer_exists: !!existingCustomer,
    customer_name: existingCustomer?.name || null,
    has_previous_counseling: hasPreviousCounseling,
    has_consent: hasConsent,
    line_friend_url: staff.line_friend_url,
  });
});

// Set session type (new or returning)
intakeRoutes.post('/:sessionId/type', async (c) => {
  const sessionId = c.req.param('sessionId');
  const body = await c.req.json<{ type: 'new' | 'returning' }>();

  if (!body.type || !['new', 'returning'].includes(body.type)) {
    return c.json({ error: 'Invalid type' }, 400);
  }

  const session = await c.env.DB.prepare(
    'SELECT * FROM intake_sessions WHERE id = ?'
  ).bind(sessionId).first<{ id: string; store_id: string; line_user_id: string; customer_id: string | null }>();

  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }

  const nextStatus = body.type === 'new' ? 'name_input' : 'consent';

  await c.env.DB.prepare(
    "UPDATE intake_sessions SET session_type = ?, status = ?, updated_at = datetime('now') WHERE id = ?"
  ).bind(body.type, nextStatus, sessionId).run();

  return c.json({ success: true, next_status: nextStatus });
});

// Submit profile (new customer: name, kana, gender)
intakeRoutes.post('/:sessionId/profile', async (c) => {
  const sessionId = c.req.param('sessionId');
  const body = await c.req.json<{
    name: string;
    name_kana: string;
    gender: 'male' | 'female' | 'other';
  }>();

  if (!body.name?.trim() || !body.name_kana?.trim() || !body.gender) {
    return c.json({ error: 'Missing required fields' }, 400);
  }

  const session = await c.env.DB.prepare(
    'SELECT * FROM intake_sessions WHERE id = ?'
  ).bind(sessionId).first<{
    id: string; store_id: string; staff_id: string | null;
    line_user_id: string; customer_id: string | null;
  }>();

  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }

  // Create customer if not exists
  let customerId = session.customer_id;
  if (!customerId) {
    customerId = crypto.randomUUID();
    await c.env.DB.prepare(
      `INSERT INTO customers (id, store_id, name, name_kana, gender, staff_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
    ).bind(customerId, session.store_id, body.name.trim(), body.name_kana.trim(), body.gender, session.staff_id).run();
    // Sync to customer_staff junction table
    if (session.staff_id) {
      await c.env.DB.prepare(
        'INSERT OR IGNORE INTO customer_staff (id, customer_id, staff_id, is_primary) VALUES (?, ?, ?, 1)'
      ).bind(crypto.randomUUID(), customerId, session.staff_id).run();
    }

    // Create customer_line record
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO customer_line (id, customer_id, store_id, line_user_id, registration_status)
       VALUES (?, ?, ?, ?, 'completed')`
    ).bind(crypto.randomUUID(), customerId, session.store_id, session.line_user_id).run();
  } else {
    // Update existing customer
    await c.env.DB.prepare(
      "UPDATE customers SET name = ?, name_kana = ?, gender = ?, staff_id = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(body.name.trim(), body.name_kana.trim(), body.gender, session.staff_id, customerId).run();
    if (session.staff_id) {
      await c.env.DB.prepare(
        'INSERT OR IGNORE INTO customer_staff (id, customer_id, staff_id, is_primary) VALUES (?, ?, ?, 1)'
      ).bind(crypto.randomUUID(), customerId, session.staff_id).run();
    }
  }

  await c.env.DB.prepare(
    "UPDATE intake_sessions SET customer_id = ?, name = ?, name_kana = ?, gender = ?, status = 'consent', updated_at = datetime('now') WHERE id = ?"
  ).bind(customerId, body.name.trim(), body.name_kana.trim(), body.gender, sessionId).run();

  return c.json({ success: true, customer_id: customerId });
});

// Get session status
intakeRoutes.get('/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId');

  const session = await c.env.DB.prepare(
    'SELECT * FROM intake_sessions WHERE id = ?'
  ).bind(sessionId).first();

  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }

  return c.json({ session });
});

// Get counseling data for intake (pre-filled for returning customers)
intakeRoutes.get('/:sessionId/counseling', async (c) => {
  const sessionId = c.req.param('sessionId');

  const session = await c.env.DB.prepare(
    'SELECT customer_id, store_id FROM intake_sessions WHERE id = ?'
  ).bind(sessionId).first<{ customer_id: string | null; store_id: string }>();

  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }

  if (!session.customer_id) {
    return c.json({ data: null });
  }

  const sheet = await c.env.DB.prepare(
    'SELECT data FROM counseling_sheets WHERE customer_id = ? AND store_id = ?'
  ).bind(session.customer_id, session.store_id).first<{ data: string }>();

  return c.json({ data: sheet ? JSON.parse(sheet.data) : null });
});

// Save counseling data and complete intake
intakeRoutes.put('/:sessionId/counseling', async (c) => {
  const sessionId = c.req.param('sessionId');
  const body = await c.req.json<{ data: Record<string, unknown> }>();

  const session = await c.env.DB.prepare(
    'SELECT customer_id, store_id FROM intake_sessions WHERE id = ?'
  ).bind(sessionId).first<{ customer_id: string | null; store_id: string }>();

  if (!session || !session.customer_id) {
    return c.json({ error: 'Session not found or customer not linked' }, 404);
  }

  // Upsert counseling sheet
  const existing = await c.env.DB.prepare(
    'SELECT id FROM counseling_sheets WHERE customer_id = ? AND store_id = ?'
  ).bind(session.customer_id, session.store_id).first<{ id: string }>();

  if (existing) {
    await c.env.DB.prepare(
      "UPDATE counseling_sheets SET data = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(JSON.stringify(body.data), existing.id).run();
  } else {
    await c.env.DB.prepare(
      `INSERT INTO counseling_sheets (id, store_id, customer_id, data, created_at, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`
    ).bind(crypto.randomUUID(), session.store_id, session.customer_id, JSON.stringify(body.data)).run();
  }

  // Mark session completed
  await c.env.DB.prepare(
    "UPDATE intake_sessions SET status = 'completed', updated_at = datetime('now') WHERE id = ?"
  ).bind(sessionId).run();

  // Notify staff via Web Push
  try {
    const intakeSession = await c.env.DB.prepare(
      `SELECT is2.staff_id, is2.store_id, is2.name as customer_name, c.name as c_name
       FROM intake_sessions is2
       LEFT JOIN customers c ON is2.customer_id = c.id
       WHERE is2.id = ?`
    ).bind(sessionId).first<{ staff_id: string | null; store_id: string; customer_name: string | null; c_name: string | null }>();

    if (intakeSession?.staff_id) {
      const { PushNotificationService } = await import('../services/pushService');
      const customerName = intakeSession.customer_name || intakeSession.c_name || 'お客様';
      // Get customer_id for URL
      const sessionForUrl = await c.env.DB.prepare(
        'SELECT customer_id FROM intake_sessions WHERE id = ?'
      ).bind(sessionId).first<{ customer_id: string | null }>();
      await PushNotificationService.notifyStaff(
        c.env.DB,
        intakeSession.staff_id,
        {
          title: 'カウンセリングシート完了',
          body: `${customerName}様の同意書・カウンセリングシートの記入が完了しました。`,
          url: sessionForUrl?.customer_id ? `/customers?id=${sessionForUrl.customer_id}&tab=counseling` : undefined,
        },
        c.env.VAPID_PUBLIC_KEY!,
        c.env.VAPID_PRIVATE_KEY!,
      );
    }
  } catch (e) {
    console.error('Staff push notification error:', e);
  }

  return c.json({ success: true });
});

// Update session status
intakeRoutes.put('/:sessionId/status', async (c) => {
  const sessionId = c.req.param('sessionId');
  const body = await c.req.json<{ status: string }>();

  await c.env.DB.prepare(
    "UPDATE intake_sessions SET status = ?, updated_at = datetime('now') WHERE id = ?"
  ).bind(body.status, sessionId).run();

  return c.json({ success: true });
});
