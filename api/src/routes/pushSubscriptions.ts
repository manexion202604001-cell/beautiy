import { Hono } from 'hono';
import type { Bindings, Variables } from '../types';
import { staffAuth } from '../middleware/auth';

export const pushRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Get VAPID public key
pushRoutes.get('/vapid-public-key', staffAuth, async (c) => {
  const publicKey = c.env.VAPID_PUBLIC_KEY;
  if (!publicKey) {
    return c.json({ error: 'VAPID keys not configured' }, 500);
  }
  return c.json({ publicKey });
});

// Save push subscription
pushRoutes.post('/subscriptions', staffAuth, async (c) => {
  const staff = c.get('staff')!;
  const { subscription, device_name } = await c.req.json<{
    subscription: { endpoint: string; keys: { auth: string; p256dh: string } };
    device_name?: string;
  }>();

  if (!subscription?.endpoint || !subscription?.keys) {
    return c.json({ error: 'Invalid subscription' }, 400);
  }

  const id = crypto.randomUUID();

  await c.env.DB.prepare(`
    INSERT INTO push_subscriptions (id, staff_id, endpoint, subscription_json, user_agent, device_name, is_active, last_used_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))
    ON CONFLICT(staff_id, endpoint) DO UPDATE SET
      subscription_json = excluded.subscription_json,
      user_agent = excluded.user_agent,
      device_name = excluded.device_name,
      is_active = 1,
      last_used_at = datetime('now')
  `).bind(
    id,
    staff.id,
    subscription.endpoint,
    JSON.stringify(subscription),
    c.req.header('User-Agent') || null,
    device_name || null,
  ).run();

  return c.json({ success: true });
});

// Delete push subscription by endpoint
pushRoutes.delete('/subscriptions', staffAuth, async (c) => {
  const staff = c.get('staff')!;
  const { endpoint } = await c.req.json<{ endpoint: string }>();

  await c.env.DB.prepare(
    'DELETE FROM push_subscriptions WHERE staff_id = ? AND endpoint = ?'
  ).bind(staff.id, endpoint).run();

  return c.json({ success: true });
});

// List staff's push subscriptions
pushRoutes.get('/subscriptions', staffAuth, async (c) => {
  const staff = c.get('staff')!;

  const subs = await c.env.DB.prepare(
    'SELECT id, device_name, user_agent, is_active, last_used_at, created_at FROM push_subscriptions WHERE staff_id = ? AND is_active = 1 ORDER BY last_used_at DESC'
  ).bind(staff.id).all();

  return c.json({ subscriptions: subs.results });
});

// Remove a specific subscription by ID
pushRoutes.delete('/subscriptions/:id', staffAuth, async (c) => {
  const staff = c.get('staff')!;
  const id = c.req.param('id');

  await c.env.DB.prepare(
    'DELETE FROM push_subscriptions WHERE id = ? AND staff_id = ?'
  ).bind(id, staff.id).run();

  return c.json({ success: true });
});

// Test push notification (debug endpoint)
pushRoutes.post('/test', staffAuth, async (c) => {
  const staff = c.get('staff')!;
  const vapidPublicKey = c.env.VAPID_PUBLIC_KEY;
  const vapidPrivateKey = c.env.VAPID_PRIVATE_KEY;

  if (!vapidPublicKey || !vapidPrivateKey) {
    return c.json({ error: 'VAPID keys not configured', vapidPublicKey: !!vapidPublicKey, vapidPrivateKey: !!vapidPrivateKey }, 500);
  }

  // Decode and validate VAPID key sizes
  const b64ToBuf = (b64url: string) => {
    const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
    const pad = '='.repeat((4 - b64.length % 4) % 4);
    const binary = atob(b64 + pad);
    return Uint8Array.from(binary, c => c.charCodeAt(0));
  };
  const pubKeyBytes = b64ToBuf(vapidPublicKey);
  const privKeyBytes = b64ToBuf(vapidPrivateKey);

  const diagnostics = {
    vapidPublicKeyLength: pubKeyBytes.length,
    vapidPrivateKeyLength: privKeyBytes.length,
    vapidPublicKeyFirstByte: pubKeyBytes[0],
    staffId: staff.id,
    staffNotifyPush: null as number | null,
    subscriptionCount: 0,
    subscriptions: [] as Array<{ id: string; endpoint: string; isActive: number }>,
    pushResults: null as unknown,
  };

  // Check staff notify_push
  const staffRecord = await c.env.DB.prepare(
    'SELECT notify_push FROM staff WHERE id = ?'
  ).bind(staff.id).first<{ notify_push: number }>();
  diagnostics.staffNotifyPush = staffRecord?.notify_push ?? null;

  // Get subscriptions
  const subs = await c.env.DB.prepare(
    'SELECT id, endpoint, is_active FROM push_subscriptions WHERE staff_id = ?'
  ).bind(staff.id).all<{ id: string; endpoint: string; is_active: number }>();
  diagnostics.subscriptionCount = subs.results?.length || 0;
  diagnostics.subscriptions = (subs.results || []).map(s => ({
    id: s.id,
    endpoint: s.endpoint.substring(0, 80) + '...',
    isActive: s.is_active,
  }));

  // Send test push
  try {
    const { PushNotificationService } = await import('../services/pushService');
    const result = await PushNotificationService.notifyStaff(
      c.env.DB,
      staff.id,
      {
        title: 'テスト通知',
        body: 'プッシュ通知のテストです',
        url: '/messages',
        tag: 'test',
      },
      vapidPublicKey,
      vapidPrivateKey,
    );
    diagnostics.pushResults = result;
  } catch (error) {
    diagnostics.pushResults = { error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined };
  }

  return c.json(diagnostics);
});
