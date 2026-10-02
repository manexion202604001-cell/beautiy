import { Hono } from 'hono';
import type { Bindings, Variables } from '../types';
import { staffAuth } from '../middleware/auth';

export const notificationsRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

notificationsRoutes.use('*', staffAuth);

// 自分宛の通知一覧（最新50件）
notificationsRoutes.get('/', async (c) => {
  const staff = c.get('staff')!;
  const result = await c.env.DB.prepare(
    `SELECT id, type, title, body, link_url, is_read, created_at
     FROM notifications WHERE staff_id = ? ORDER BY created_at DESC LIMIT 50`
  ).bind(staff.id).all();
  return c.json({ notifications: result.results });
});

// 未読件数
notificationsRoutes.get('/unread-count', async (c) => {
  const staff = c.get('staff')!;
  const row = await c.env.DB.prepare(
    'SELECT COUNT(*) AS count FROM notifications WHERE staff_id = ? AND is_read = 0'
  ).bind(staff.id).first<{ count: number }>();
  return c.json({ count: row?.count || 0 });
});

// 既読化（1件）
notificationsRoutes.put('/:id/read', async (c) => {
  const staff = c.get('staff')!;
  const id = c.req.param('id');
  await c.env.DB.prepare(
    'UPDATE notifications SET is_read = 1 WHERE id = ? AND staff_id = ?'
  ).bind(id, staff.id).run();
  return c.json({ success: true });
});

// 全件既読化
notificationsRoutes.put('/read-all', async (c) => {
  const staff = c.get('staff')!;
  await c.env.DB.prepare(
    'UPDATE notifications SET is_read = 1 WHERE staff_id = ? AND is_read = 0'
  ).bind(staff.id).run();
  return c.json({ success: true });
});
