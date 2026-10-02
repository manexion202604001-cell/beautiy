import { Hono } from 'hono';
import type { Bindings, Variables } from '../types';
import { requirePublicToken } from '../utils/publicToken';

export const publicConsentRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Get active consent template by store_id (public, no auth)
publicConsentRoutes.get('/by-store/:storeId', async (c) => {
  const storeId = c.req.param('storeId');

  const template = await c.env.DB.prepare(
    `SELECT id, store_id, title, description, sections, form_fields, version
     FROM consent_templates
     WHERE store_id = ? AND is_active = 1
     ORDER BY created_at DESC
     LIMIT 1`
  )
    .bind(storeId)
    .first<{
      id: string;
      store_id: string;
      title: string;
      description: string | null;
      sections: string;
      form_fields: string | null;
      version: string | null;
    }>();

  if (!template) {
    return c.json({ error: 'Consent template not found for this store' }, 404);
  }

  const store = await c.env.DB.prepare(
    'SELECT name FROM stores WHERE id = ?'
  )
    .bind(template.store_id)
    .first<{ name: string }>();

  return c.json({
    template: {
      ...template,
      sections: JSON.parse(template.sections),
      form_fields: template.form_fields ? JSON.parse(template.form_fields) : null,
    },
    store_name: store?.name || null,
  });
});

// Get consent template (public, no auth)
publicConsentRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');

  const template = await c.env.DB.prepare(
    `SELECT id, store_id, title, description, sections, form_fields, version
     FROM consent_templates
     WHERE id = ? AND is_active = 1`
  )
    .bind(id)
    .first<{
      id: string;
      store_id: string;
      title: string;
      description: string | null;
      sections: string;
      form_fields: string | null;
      version: string | null;
    }>();

  if (!template) {
    return c.json({ error: 'Consent template not found' }, 404);
  }

  // Get store name for display
  const store = await c.env.DB.prepare(
    'SELECT name FROM stores WHERE id = ?'
  )
    .bind(template.store_id)
    .first<{ name: string }>();

  return c.json({
    template: {
      ...template,
      sections: JSON.parse(template.sections),
      form_fields: template.form_fields ? JSON.parse(template.form_fields) : null,
    },
    store_name: store?.name || null,
  });
});

// Submit consent (no token required - customer submits their own data)
publicConsentRoutes.post('/:id/submit', async (c) => {
  const templateId = c.req.param('id');

  const template = await c.env.DB.prepare(
    `SELECT id, store_id, title, sections, version
     FROM consent_templates
     WHERE id = ? AND is_active = 1`
  )
    .bind(templateId)
    .first<{
      id: string;
      store_id: string;
      title: string;
      sections: string;
      version: string | null;
    }>();

  if (!template) {
    return c.json({ error: 'Consent template not found' }, 404);
  }

  const body = await c.req.json<{
    customer_name: string;
    customer_birthday?: string;
    customer_phone?: string;
    customer_occupation?: string;
    customer_visit_reason?: string;
    reservation_id?: string;
    // 受付QR（スタッフ別・純Web）フロー用
    walkin?: boolean;
    staff_id?: string;
    customer_name_kana?: string;
    customer_gender?: string;
  }>();

  // customer_name is optional for returning customers (re-consent)
  // If not provided, skip creating a consent record name issue
  const customerName = body.customer_name || '';


  const id = crypto.randomUUID();

  // Store a snapshot of the template at time of consent
  const snapshot = JSON.stringify({
    title: template.title,
    version: template.version,
    sections: JSON.parse(template.sections),
  });

  await c.env.DB.prepare(
    `INSERT INTO consent_records (id, template_id, store_id, customer_name, customer_birthday, customer_phone, customer_occupation, customer_visit_reason, template_snapshot, reservation_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      templateId,
      template.store_id,
      customerName,
      body.customer_birthday || null,
      body.customer_phone || null,
      body.customer_occupation || null,
      body.customer_visit_reason || null,
      snapshot,
      body.reservation_id || null
    )
    .run();

  // 受付QR（純Web）フロー: 保留レコードを作成し、紐づくスタッフに通知
  if (body.walkin) {
    const walkinId = crypto.randomUUID();
    const now = new Date().toISOString().replace('T', ' ').split('.')[0];
    const gender = ['male', 'female', 'other'].includes(body.customer_gender || '') ? body.customer_gender : null;
    await c.env.DB.prepare(
      `INSERT INTO walkin_intakes (id, store_id, staff_id, consent_record_id, customer_name, customer_name_kana, customer_phone, customer_birthday, customer_gender, status, consent_submitted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
    ).bind(
      walkinId,
      template.store_id,
      body.staff_id || null,
      id,
      customerName,
      body.customer_name_kana || null,
      body.customer_phone || null,
      body.customer_birthday || null,
      gender,
      now, now, now
    ).run();

    // 紐づくスタッフへ Web Push ＋ アプリ内通知
    if (body.staff_id) {
      try {
        const title = '同意書が提出されました';
        const notifBody = `${customerName || 'お客様'}様が同意書を提出しました`;
        const linkUrl = `/walkin-intakes?id=${walkinId}`;
        await c.env.DB.prepare(
          `INSERT INTO notifications (id, staff_id, type, title, body, link_url, is_read, created_at)
           VALUES (?, ?, 'system', ?, ?, ?, 0, ?)`
        ).bind(crypto.randomUUID(), body.staff_id, title, notifBody, linkUrl, now).run();

        if (c.env.VAPID_PUBLIC_KEY && c.env.VAPID_PRIVATE_KEY) {
          const { PushNotificationService } = await import('../services/pushService');
          await PushNotificationService.notifyStaff(
            c.env.DB, body.staff_id,
            { title, body: notifBody, url: linkUrl, tag: `walkin-${walkinId}` },
            c.env.VAPID_PUBLIC_KEY, c.env.VAPID_PRIVATE_KEY
          );
        }
      } catch (e) {
        console.error('Walk-in consent notification error:', e);
      }
    }

    return c.json({ success: true, record_id: id, walkin_id: walkinId }, 201);
  }

  return c.json({ success: true, record_id: id }, 201);
});
