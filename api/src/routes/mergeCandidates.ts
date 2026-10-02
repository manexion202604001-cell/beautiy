import { Hono } from 'hono';
import type { Bindings, Variables, Customer } from '../types';
import { staffAuth } from '../middleware/auth';

export const mergeCandidatesRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Apply auth middleware
mergeCandidatesRoutes.use('*', staffAuth);

// Check store access
async function staffHasStoreAccess(db: D1Database, staffId: string, storeId: string): Promise<boolean> {
  const row = await db.prepare(
    'SELECT 1 FROM staff_stores WHERE staff_id = ? AND store_id = ?'
  ).bind(staffId, storeId).first();
  return !!row;
}

// List merge candidates (pending only)
mergeCandidatesRoutes.get('/', async (c) => {
  const staff = c.get('staff')!;
  const storeId = c.req.query('store_id');

  if (!storeId) {
    return c.json({ error: 'store_id is required' }, 400);
  }

  if (staff.role !== 'system_admin' && !(await staffHasStoreAccess(c.env.DB, staff.id, storeId))) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const customerId = c.req.query('customer_id');

  let query = `
    SELECT
      mc.id,
      mc.store_id,
      mc.line_customer_id,
      mc.existing_customer_id,
      mc.line_display_name,
      mc.match_type,
      mc.status,
      mc.created_at,
      lc.name as line_customer_name,
      lc.phone as line_customer_phone,
      lc.visit_count as line_customer_visit_count,
      cl.picture_url as line_customer_avatar,
      ec.name as existing_customer_name,
      ec.name_kana as existing_customer_name_kana,
      ec.phone as existing_customer_phone,
      ec.email as existing_customer_email,
      ec.visit_count as existing_customer_visit_count,
      ec.last_visit_at as existing_customer_last_visit_at,
      ec.staff_id as existing_customer_staff_id,
      es.name as existing_customer_staff_name,
      ecs.name as existing_customer_store_name
    FROM customer_merge_candidates mc
    JOIN customers lc ON mc.line_customer_id = lc.id
    JOIN customers ec ON mc.existing_customer_id = ec.id
    LEFT JOIN stores ecs ON ec.store_id = ecs.id
    LEFT JOIN customer_line cl ON lc.id = cl.customer_id
    LEFT JOIN staff es ON ec.staff_id = es.id
    WHERE mc.store_id = ? AND mc.status = 'pending'
  `;
  const params: string[] = [storeId];

  if (customerId) {
    query += ' AND (mc.line_customer_id = ? OR mc.existing_customer_id = ?)';
    params.push(customerId, customerId);
  }

  query += ' ORDER BY mc.created_at DESC';

  const result = await c.env.DB.prepare(query).bind(...params).all();

  return c.json({ candidates: result.results });
});

// Get count of pending merge candidates (for badge)
mergeCandidatesRoutes.get('/count', async (c) => {
  const staff = c.get('staff')!;
  const storeId = c.req.query('store_id');

  if (!storeId) {
    return c.json({ count: 0 });
  }

  if (staff.role !== 'system_admin' && !(await staffHasStoreAccess(c.env.DB, staff.id, storeId))) {
    return c.json({ count: 0 });
  }

  const result = await c.env.DB.prepare(
    "SELECT COUNT(*) as count FROM customer_merge_candidates WHERE store_id = ? AND status = 'pending'"
  ).bind(storeId).first<{ count: number }>();

  return c.json({ count: result?.count || 0 });
});

// Merge: transfer all data from LINE customer to existing customer, then delete LINE customer
mergeCandidatesRoutes.post('/:id/merge', async (c) => {
  const staff = c.get('staff')!;
  const candidateId = c.req.param('id');

  const candidate = await c.env.DB.prepare(
    'SELECT * FROM customer_merge_candidates WHERE id = ? AND status = ?'
  ).bind(candidateId, 'pending').first<{
    id: string;
    store_id: string;
    line_customer_id: string;
    existing_customer_id: string;
  }>();

  if (!candidate) {
    return c.json({ error: 'Candidate not found or already resolved' }, 404);
  }

  if (staff.role !== 'system_admin' && !(await staffHasStoreAccess(c.env.DB, staff.id, candidate.store_id))) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const lineCustomerId = candidate.line_customer_id;
  const existingCustomerId = candidate.existing_customer_id;

  // Move LINE links per store: the keeper may already hold a link for the same store
  // (UNIQUE(customer_id, store_id)), so drop those duplicates instead of moving them.
  const statements = [
    c.env.DB.prepare(
      `DELETE FROM customer_line
       WHERE customer_id = ?1
         AND store_id IN (SELECT store_id FROM customer_line WHERE customer_id = ?2)`
    ).bind(lineCustomerId, existingCustomerId),
    c.env.DB.prepare(
      "UPDATE customer_line SET customer_id = ?, updated_at = datetime('now') WHERE customer_id = ?"
    ).bind(existingCustomerId, lineCustomerId),
    // Move messages
    c.env.DB.prepare(
      'UPDATE messages SET customer_id = ? WHERE customer_id = ?'
    ).bind(existingCustomerId, lineCustomerId),
    // Move reservations
    c.env.DB.prepare(
      'UPDATE reservations SET customer_id = ? WHERE customer_id = ?'
    ).bind(existingCustomerId, lineCustomerId),
    // Move karutes
    c.env.DB.prepare(
      'UPDATE karutes SET customer_id = ? WHERE customer_id = ?'
    ).bind(existingCustomerId, lineCustomerId),
    // Delete empty counseling sheets for LINE customer
    c.env.DB.prepare(
      'DELETE FROM counseling_sheets WHERE customer_id = ?'
    ).bind(lineCustomerId),
    // Mark this candidate as merged
    c.env.DB.prepare(
      "UPDATE customer_merge_candidates SET status = 'merged', resolved_by = ?, resolved_at = datetime('now') WHERE id = ?"
    ).bind(staff.id, candidateId),
    // Auto-skip other pending candidates for the same LINE customer
    c.env.DB.prepare(
      "UPDATE customer_merge_candidates SET status = 'skipped', resolved_by = ?, resolved_at = datetime('now') WHERE line_customer_id = ? AND id != ? AND status = 'pending'"
    ).bind(staff.id, lineCustomerId, candidateId),
    // Delete the LINE customer record
    c.env.DB.prepare(
      'DELETE FROM customers WHERE id = ?'
    ).bind(lineCustomerId),
  ];

  await c.env.DB.batch(statements);

  return c.json({ success: true });
});

// Skip: dismiss this candidate
mergeCandidatesRoutes.post('/:id/skip', async (c) => {
  const staff = c.get('staff')!;
  const candidateId = c.req.param('id');

  const candidate = await c.env.DB.prepare(
    'SELECT * FROM customer_merge_candidates WHERE id = ? AND status = ?'
  ).bind(candidateId, 'pending').first<{
    id: string;
    store_id: string;
  }>();

  if (!candidate) {
    return c.json({ error: 'Candidate not found or already resolved' }, 404);
  }

  if (staff.role !== 'system_admin' && !(await staffHasStoreAccess(c.env.DB, staff.id, candidate.store_id))) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  await c.env.DB.prepare(
    "UPDATE customer_merge_candidates SET status = 'skipped', resolved_by = ?, resolved_at = datetime('now') WHERE id = ?"
  ).bind(staff.id, candidateId).run();

  return c.json({ success: true });
});
