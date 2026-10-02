import { Hono } from 'hono';
import type { Bindings, Variables } from '../types';
import { staffAuth } from '../middleware/auth';

export const consentTemplatesRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

consentTemplatesRoutes.use('*', staffAuth);

// List consent templates for a store
consentTemplatesRoutes.get('/', async (c) => {
  const staff = c.get('staff')!;
  const storeId = c.req.query('store_id') || staff.store_id;

  if (!storeId) {
    return c.json({ error: 'store_id is required' }, 400);
  }

  const templates = await c.env.DB.prepare(
    `SELECT id, store_id, title, description, version, is_active, created_at, updated_at
     FROM consent_templates
     WHERE store_id = ?
     ORDER BY created_at DESC`
  )
    .bind(storeId)
    .all();

  return c.json({ templates: templates.results });
});

// Create consent template
consentTemplatesRoutes.post('/', async (c) => {
  const staff = c.get('staff')!;
  const body = await c.req.json<{
    store_id?: string;
    title: string;
    description?: string;
    sections: Array<{ title: string; items: string[] }>;
    form_fields?: Array<{ name: string; label: string; type: string; required: boolean }>;
    version?: string;
  }>();

  const storeId = body.store_id || staff.store_id;
  if (!storeId) {
    return c.json({ error: 'store_id is required' }, 400);
  }

  if (!body.title || !body.sections) {
    return c.json({ error: 'title and sections are required' }, 400);
  }

  const id = crypto.randomUUID();

  await c.env.DB.prepare(
    `INSERT INTO consent_templates (id, store_id, title, description, sections, form_fields, version)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      storeId,
      body.title,
      body.description || null,
      JSON.stringify(body.sections),
      body.form_fields ? JSON.stringify(body.form_fields) : null,
      body.version || null
    )
    .run();

  const template = await c.env.DB.prepare(
    'SELECT * FROM consent_templates WHERE id = ?'
  )
    .bind(id)
    .first();

  return c.json({ template }, 201);
});

// Update consent template
consentTemplatesRoutes.put('/:id', async (c) => {
  const id = c.req.param('id');

  const existing = await c.env.DB.prepare(
    'SELECT id FROM consent_templates WHERE id = ?'
  )
    .bind(id)
    .first();

  if (!existing) {
    return c.json({ error: 'Template not found' }, 404);
  }

  const body = await c.req.json<{
    title?: string;
    description?: string;
    sections?: Array<{ title: string; items: string[] }>;
    form_fields?: Array<{ name: string; label: string; type: string; required: boolean }>;
    version?: string;
    is_active?: number;
  }>();

  const updates: string[] = [];
  const values: (string | number | null)[] = [];

  if (body.title !== undefined) {
    updates.push('title = ?');
    values.push(body.title);
  }
  if (body.description !== undefined) {
    updates.push('description = ?');
    values.push(body.description || null);
  }
  if (body.sections !== undefined) {
    updates.push('sections = ?');
    values.push(JSON.stringify(body.sections));
  }
  if (body.form_fields !== undefined) {
    updates.push('form_fields = ?');
    values.push(JSON.stringify(body.form_fields));
  }
  if (body.version !== undefined) {
    updates.push('version = ?');
    values.push(body.version || null);
  }
  if (body.is_active !== undefined) {
    updates.push('is_active = ?');
    values.push(body.is_active);
  }

  if (updates.length === 0) {
    return c.json({ error: 'No updates provided' }, 400);
  }

  updates.push("updated_at = datetime('now')");
  values.push(id);

  await c.env.DB.prepare(
    `UPDATE consent_templates SET ${updates.join(', ')} WHERE id = ?`
  )
    .bind(...values)
    .run();

  const template = await c.env.DB.prepare(
    'SELECT * FROM consent_templates WHERE id = ?'
  )
    .bind(id)
    .first();

  return c.json({ template });
});

// List consent records for a store
consentTemplatesRoutes.get('/records', async (c) => {
  const staff = c.get('staff')!;
  const storeId = c.req.query('store_id') || staff.store_id;

  if (!storeId) {
    return c.json({ error: 'store_id is required' }, 400);
  }

  const records = await c.env.DB.prepare(
    `SELECT cr.*, ct.title as template_title, ct.version as template_version
     FROM consent_records cr
     LEFT JOIN consent_templates ct ON cr.template_id = ct.id
     WHERE cr.store_id = ?
     ORDER BY cr.agreed_at DESC`
  )
    .bind(storeId)
    .all();

  return c.json({ records: records.results });
});
