import { Hono } from 'hono';
import type { Bindings, Variables, Message, Customer } from '../types';
import { staffAuth } from '../middleware/auth';
import { LineService, getLineUserId, getStoreLineAccessToken, buildStaffMessageFlexMessage } from '../services/lineService';
import { getApiBaseUrl, buildCustomerUrl } from './lineWebhook';

export const messagesRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Apply auth middleware
messagesRoutes.use('*', staffAuth);

// Check if staff has access to a store via staff_stores junction table
async function staffHasStoreAccess(db: D1Database, staffId: string, storeId: string): Promise<boolean> {
  const row = await db.prepare(
    'SELECT 1 FROM staff_stores WHERE staff_id = ? AND store_id = ?'
  ).bind(staffId, storeId).first();
  return !!row;
}

// List conversations (grouped by customer per store)
messagesRoutes.get('/', async (c) => {
  const staff = c.get('staff')!;
  const storeId = c.req.query('store_id') || staff.store_id;
  const unreadOnly = c.req.query('unread') === 'true';
  const mineOnly = c.req.query('mine') === 'true';

  if (!storeId && staff.role !== 'system_admin') {
    return c.json({ conversations: [] });
  }

  let query = `
    SELECT
      mg.customer_id,
      c.name as customer_name,
      c.staff_id as customer_staff_id,
      COALESCE(cs.nickname, cs.name) as customer_staff_name,
      cl.picture_url as customer_avatar,
      last_msg.content as last_message,
      last_msg.sent_at as last_message_at,
      last_msg.direction as last_message_direction,
      COALESCE(last_s.nickname, last_s.name) as last_message_staff_name,
      mg.unread_count
    FROM (
      SELECT
        customer_id,
        MAX(sent_at) as max_sent_at,
        SUM(CASE WHEN direction = 'incoming' AND is_read = 0 THEN 1 ELSE 0 END) as unread_count
      FROM messages
      WHERE store_id = ?
      GROUP BY customer_id
    ) mg
    JOIN customers c ON mg.customer_id = c.id
    LEFT JOIN staff cs ON c.staff_id = cs.id
    LEFT JOIN customer_line cl ON c.id = cl.customer_id AND cl.store_id = ?
    LEFT JOIN messages last_msg ON last_msg.customer_id = mg.customer_id
      AND last_msg.store_id = ?
      AND last_msg.sent_at = mg.max_sent_at
    LEFT JOIN staff last_s ON last_msg.staff_id = last_s.id
    WHERE 1=1
  `;
  const params: (string | number)[] = [storeId!, storeId!, storeId!];

  // Filter to show only conversations involving this staff (assigned customers OR messages addressed to this staff)
  if (mineOnly) {
    query += ` AND (c.staff_id = ? OR c.id IN (SELECT cs2.customer_id FROM customer_staff cs2 WHERE cs2.staff_id = ?)
      OR mg.customer_id IN (SELECT DISTINCT m3.customer_id FROM messages m3 WHERE m3.store_id = ? AND m3.staff_id = ?))`;
    params.push(staff.id, staff.id, storeId!, staff.id);
  }

  if (unreadOnly) {
    query += ' AND mg.unread_count > 0';
  }

  // Hide conversations that only have system messages and no LINE integration
  query += ` AND NOT (
    cl.customer_id IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM messages m2
      WHERE m2.customer_id = mg.customer_id AND m2.store_id = ?
      AND m2.direction != 'system'
    )
  )`;
  params.push(storeId!);

  query += ' ORDER BY mg.max_sent_at DESC';

  const result = await c.env.DB.prepare(query)
    .bind(...params)
    .all();

  return c.json({ conversations: result.results });
});

// Get messages for a customer (filtered by staff and store)
messagesRoutes.get('/:customerId', async (c) => {
  const staff = c.get('staff')!;
  const customerId = c.req.param('customerId');
  const storeIdParam = c.req.query('store_id');
  const limit = parseInt(c.req.query('limit') || '50');
  const before = c.req.query('before'); // cursor for pagination

  // Get customer
  const customer = await c.env.DB.prepare('SELECT * FROM customers WHERE id = ?')
    .bind(customerId)
    .first<Customer>();

  if (!customer) {
    return c.json({ error: 'Customer not found' }, 404);
  }

  // Check access - staff must belong to customer's store
  const effectiveStoreId = storeIdParam || customer.store_id;
  if (staff.role !== 'system_admin' && !(await staffHasStoreAccess(c.env.DB, staff.id, effectiveStoreId))) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  let query = `
    SELECT m.*, COALESCE(s.nickname, s.name) as staff_name,
    COALESCE(sb.nickname, sb.name) as sent_by_staff_name
    FROM messages m
    LEFT JOIN staff s ON m.staff_id = s.id
    LEFT JOIN staff sb ON m.sent_by_staff_id = sb.id
    WHERE m.customer_id = ?
  `;
  const params: (string | number)[] = [customerId];

  // Filter by store_id
  if (storeIdParam) {
    query += ' AND m.store_id = ?';
    params.push(storeIdParam);
  }

  // Note: staff_id filter removed — conversations are now per customer+store, not per staff

  if (before) {
    query += ' AND m.sent_at < ?';
    params.push(before);
  }

  query += ' ORDER BY m.sent_at DESC LIMIT ?';
  params.push(limit);

  const result = await c.env.DB.prepare(query)
    .bind(...params)
    .all<Message & { staff_name: string | null }>();

  // Get LINE info for THIS store (providers are per store; a merged customer has one
  // LINE link per store — the compose indicator must reflect the current store's link).
  const lineInfo = await c.env.DB.prepare(
    "SELECT display_name, picture_url FROM customer_line WHERE customer_id = ? AND store_id = ? AND line_user_id <> '' AND is_blocked = 0"
  )
    .bind(customerId, effectiveStoreId)
    .first();

  return c.json({
    messages: result.results.reverse(), // Return in chronological order
    customer: {
      id: customer.id,
      name: customer.name,
      staff_id: customer.staff_id,
    },
    line: lineInfo,
  });
});

// Send message to customer
messagesRoutes.post('/:customerId', async (c) => {
  const staff = c.get('staff')!;
  const customerId = c.req.param('customerId');
  const body = await c.req.json<{
    content: string;
    message_type?: Message['message_type'];
    send_to_line?: boolean;
    conversation_staff_id?: string | null;
    store_id?: string;
  }>();

  if (!body.content) {
    return c.json({ error: 'Content is required' }, 400);
  }

  // Get customer
  const customer = await c.env.DB.prepare('SELECT * FROM customers WHERE id = ?')
    .bind(customerId)
    .first<Customer>();

  if (!customer) {
    return c.json({ error: 'Customer not found' }, 404);
  }

  // Use the store_id from the request (admin's current store context), falling back to customer's store
  const effectiveStoreId = body.store_id || customer.store_id;

  // Check access - staff must belong to the effective store
  if (staff.role !== 'system_admin' && !(await staffHasStoreAccess(c.env.DB, staff.id, effectiveStoreId))) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  // Always send as the customer's assigned staff (担当者)
  // Fall back to conversation_staff_id, then to logged-in staff
  const messageStaffId = customer.staff_id
    || body.conversation_staff_id
    || staff.id;

  // Track actual sender if different from message staff
  const sentByStaffId = (messageStaffId && messageStaffId !== staff.id) ? staff.id : null;

  const id = crypto.randomUUID();

  await c.env.DB.prepare(
    `INSERT INTO messages (id, store_id, customer_id, staff_id, direction, message_type, content, source, sent_at, sent_by_staff_id)
     VALUES (?, ?, ?, ?, 'outgoing', ?, ?, 'web', datetime('now'), ?)`
  )
    .bind(
      id,
      effectiveStoreId,
      customerId,
      messageStaffId,
      body.message_type || 'text',
      body.content,
      sentByStaffId
    )
    .run();

  // Auto-assign staff to customer if not yet assigned
  if (!customer.staff_id) {
    const assignStaffId = messageStaffId || staff.id;
    await c.env.DB.prepare(
      'UPDATE customers SET staff_id = ?, updated_at = datetime(\'now\') WHERE id = ? AND staff_id IS NULL'
    ).bind(assignStaffId, customerId).run();
    await c.env.DB.prepare(
      'INSERT OR IGNORE INTO customer_staff (id, customer_id, staff_id, is_primary) VALUES (?, ?, ?, 1)'
    ).bind(crypto.randomUUID(), customerId, assignStaffId).run();
  }

  // Send via LINE API if requested and customer has LINE
  if (body.send_to_line) {
    try {
      const lineUserId = await getLineUserId(c.env.DB, customerId, effectiveStoreId);
      const accessToken = await getStoreLineAccessToken(c.env.DB, effectiveStoreId);

      if (lineUserId && accessToken) {
        const lineService = new LineService(accessToken);
        // For LINE deep-link, use the conversation's staff for routing
        const linkStaffId = messageStaffId || staff.id;
        // Get the conversation staff's info for the LINE message display
        let displayStaffName = staff.nickname || staff.name;
        let displayAvatarUrl = staff.avatar_url;
        if (messageStaffId && messageStaffId !== staff.id) {
          const convStaff = await c.env.DB.prepare('SELECT name, nickname, avatar_url FROM staff WHERE id = ?')
            .bind(messageStaffId).first<{ name: string; nickname: string | null; avatar_url: string | null }>();
          if (convStaff) {
            displayStaffName = convStaff.nickname || convStaff.name;
            displayAvatarUrl = convStaff.avatar_url;
          }
        }
        const apiBaseUrl = getApiBaseUrl(c.env);
        const customerUrl = c.env.CUSTOMER_APP_URL || 'https://example.com';
        const messagesUrl = `${customerUrl}/messages/?staff_id=${linkStaffId}&store_id=${effectiveStoreId}`;
        const avatarFullUrl = displayAvatarUrl ? `${apiBaseUrl}${displayAvatarUrl}` : null;

        const flexMessage = buildStaffMessageFlexMessage({
          staffName: displayStaffName,
          staffAvatarUrl: avatarFullUrl,
          content: body.content,
          messagesUrl,
        });

        await lineService.pushMessage(lineUserId, [flexMessage]);
      }
    } catch (error) {
      console.error('Failed to send LINE message:', error);
    }
  }

  const message = await c.env.DB.prepare('SELECT * FROM messages WHERE id = ?')
    .bind(id)
    .first<Message>();

  return c.json({ message }, 201);
});

// Mark messages as read
messagesRoutes.put('/:customerId/read', async (c) => {
  const staff = c.get('staff')!;
  const customerId = c.req.param('customerId');
  const storeIdParam = c.req.query('store_id');

  // Get customer
  const customer = await c.env.DB.prepare('SELECT * FROM customers WHERE id = ?')
    .bind(customerId)
    .first<Customer>();

  if (!customer) {
    return c.json({ error: 'Customer not found' }, 404);
  }

  // Check access - staff must belong to customer's store
  const effectiveStoreId = storeIdParam || customer.store_id;
  if (staff.role !== 'system_admin' && !(await staffHasStoreAccess(c.env.DB, staff.id, effectiveStoreId))) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  // Mark all incoming messages for this customer as read (per store)
  let updateQuery = "UPDATE messages SET is_read = 1 WHERE customer_id = ? AND direction = 'incoming' AND is_read = 0";
  const params: string[] = [customerId];

  if (storeIdParam) {
    updateQuery += ' AND store_id = ?';
    params.push(storeIdParam);
  }

  await c.env.DB.prepare(updateQuery)
    .bind(...params)
    .run();

  return c.json({ success: true });
});

// Get unread count
messagesRoutes.get('/unread/count', async (c) => {
  const staff = c.get('staff')!;
  const storeId = c.req.query('store_id');

  if (staff.role === 'system_admin') {
    // System admin: count all or by specific store
    let query = `
      SELECT COUNT(*) as count
      FROM messages m
      WHERE m.direction = 'incoming' AND m.is_read = 0
    `;
    const params: string[] = [];
    if (storeId) {
      query += ' AND m.store_id = ?';
      params.push(storeId);
    }
    const result = await c.env.DB.prepare(query).bind(...params).first<{ count: number }>();
    return c.json({ count: result?.count || 0 });
  }

  // Regular staff: count across all stores they belong to (or specific store)
  let query = `
    SELECT COUNT(*) as count
    FROM messages m
    JOIN customers c ON m.customer_id = c.id
    JOIN staff_stores ss ON c.store_id = ss.store_id AND ss.staff_id = ?
    WHERE m.direction = 'incoming' AND m.is_read = 0
  `;
  const params: (string)[] = [staff.id];

  if (storeId) {
    query += ' AND m.store_id = ?';
    params.push(storeId);
  }

  const result = await c.env.DB.prepare(query)
    .bind(...params)
    .first<{ count: number }>();

  return c.json({ count: result?.count || 0 });
});
