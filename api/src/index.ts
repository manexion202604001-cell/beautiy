import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { Bindings, Variables } from './types';
import { authRoutes } from './routes/auth';
import { storesRoutes } from './routes/stores';
import { staffRoutes } from './routes/staff';
import { customersRoutes } from './routes/customers';
import { menusRoutes } from './routes/menus';
import { menuCategoriesRoutes } from './routes/menu-categories';
import { equipmentRoutes } from './routes/equipment';
import { staffBlocksRoutes } from './routes/staffBlocks';
import { reservationsRoutes } from './routes/reservations';
import { karutesRoutes } from './routes/karutes';
import { counselingSheetsRoutes } from './routes/counselingSheets';
import { messagesRoutes } from './routes/messages';
import { mergeCandidatesRoutes } from './routes/mergeCandidates';
import { customerAuthRoutes } from './routes/customerAuth';
import { customerRoutes } from './routes/customer';
import { publicKaruteRoutes } from './routes/publicKarute';
import { publicConsentRoutes } from './routes/publicConsent';
import { intakeRoutes } from './routes/intake';
import { publicCounselingRoutes } from './routes/publicCounseling';
import { consentTemplatesRoutes } from './routes/consentTemplates';
import { lineWebhookRoutes } from './routes/lineWebhook';
import { pushRoutes } from './routes/pushSubscriptions';
import { salonboardRoutes } from './routes/salonboard';
import { staffMenusRoutes } from './routes/staffMenus';
import { walkinIntakesRoutes } from './routes/walkinIntakes';
import { notificationsRoutes } from './routes/notifications';
import { sendReminders } from './services/reminderService';
import { reconcileCustomerMasters } from './services/customerMasterService';
import { auditLog } from './middleware/audit';
import { storeAccessMonitor } from './middleware/storeAccessMonitor';
import { generatePublicToken } from './utils/publicToken';
import { isProtectedImageKey, verifyImageSig } from './utils/imageSign';
import { staffAuth } from './middleware/auth';

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Middleware
app.use('*', logger());
app.use(
  '*',
  cors({
    origin: (origin, c) => {
      const allowedOrigins = [
        c.env.CUSTOMER_APP_URL,
        c.env.ADMIN_APP_URL,
        c.env.STAFF_APP_URL,
        // Additional origins (e.g. other environments), comma-separated
        ...String(c.env.CORS_ORIGINS || '').split(',').map((o: string) => o.trim()).filter(Boolean),
        'http://localhost:3000',
        'http://localhost:3001',
        'http://localhost:3002',
        'http://localhost:3003',
      ];
      if (allowedOrigins.includes(origin)) {
        return origin;
      }
      return null;
    },
    credentials: true,
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-RPI-API-Key'],
  })
);

// Audit logging (POST/PUT/DELETE only, fire-and-forget)
app.use('/api/*', auditLog);

// Store access monitor (warn-only: logs cross-store access that would be denied)
app.use('/api/*', storeAccessMonitor);

// Health check
app.get('/', (c) => {
  return c.json({ status: 'ok', message: 'Salon API is running' });
});

// API Routes
app.route('/api/auth', authRoutes);
app.route('/api/stores', storesRoutes);
app.route('/api/staff', staffRoutes);
app.route('/api/customers', customersRoutes);
app.route('/api/menus', menusRoutes);
app.route('/api/menu-categories', menuCategoriesRoutes);
app.route('/api/equipment', equipmentRoutes);
app.route('/api/staff-blocks', staffBlocksRoutes);
app.route('/api/reservations', reservationsRoutes);
app.route('/api/karutes', karutesRoutes);
app.route('/api/counseling-sheets', counselingSheetsRoutes);
app.route('/api/messages', messagesRoutes);
app.route('/api/merge-candidates', mergeCandidatesRoutes);
app.route('/api/staff-menus', staffMenusRoutes);
app.route('/api/push', pushRoutes);
app.route('/api/walkin-intakes', walkinIntakesRoutes);
app.route('/api/notifications', notificationsRoutes);

// Customer API Routes
app.route('/api/customer/auth', customerAuthRoutes);
app.route('/api/customer', customerRoutes);

// Public API Routes (no auth required)
app.route('/api/public/karute', publicKaruteRoutes);
app.route('/api/public/consent', publicConsentRoutes);
app.route('/api/public/counseling', publicCounselingRoutes);
app.route('/api/public/intake', intakeRoutes);

// Public store info (limited fields, no auth)
app.get('/api/public/store/:id', async (c) => {
  const id = c.req.param('id');
  const store = await c.env.DB.prepare(
    'SELECT id, name, line_friend_url FROM stores WHERE id = ?'
  ).bind(id).first<{ id: string; name: string; line_friend_url: string | null }>();
  if (!store) return c.json({ error: 'Not found' }, 404);
  return c.json({ store });
});

// Consent template management (staff auth)
app.route('/api/consent-templates', consentTemplatesRoutes);

// Generate public token for sharing links (staff auth required)
app.post('/api/public-token', staffAuth, async (c) => {
  const { resource, expiresInHours } = await c.req.json<{ resource: string; expiresInHours?: number }>();
  if (!resource) {
    return c.json({ error: 'resource is required' }, 400);
  }
  const token = await generatePublicToken(resource, c.env.JWT_SECRET, expiresInHours || 72);
  return c.json({ token });
});

// Salonboard RPi sync (API key auth)
app.route('/api/salonboard', salonboardRoutes);

// LINE Webhook (no auth, uses signature verification)
app.route('/api/webhook/line', lineWebhookRoutes);
app.route('/api/webhook/line/', lineWebhookRoutes);

// Serve images from R2
app.get('/images/*', async (c) => {
  const key = c.req.path.replace('/images/', '');

  // Protected images (karute photos) require a valid signed URL
  if (isProtectedImageKey(key)) {
    const valid = await verifyImageSig(key, c.req.query('exp'), c.req.query('sig'), c.env.JWT_SECRET);
    if (!valid) {
      return c.json({ error: 'Forbidden' }, 403);
    }
  }

  const object = await c.env.IMAGES.get(key);

  if (!object) {
    return c.json({ error: 'Image not found' }, 404);
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Cache-Control', isProtectedImageKey(key) ? 'private, max-age=86400' : 'public, max-age=31536000');

  return new Response(object.body, { headers });
});

// Error handling — log details server-side, return a fixed message to clients
app.onError((err, c) => {
  console.error('Error:', err instanceof Error ? (err.stack || err.message) : err, c.req.method, c.req.path);
  return c.json({ error: 'Internal Server Error' }, 500);
});

app.notFound((c) => {
  return c.json({ error: 'Not Found' }, 404);
});

// Scheduled handler for Cron Triggers
export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    console.log(`[Cron] Triggered at ${new Date().toISOString()}, cron: ${event.cron}`);

    // Run reminder service at 9:00 AM JST (0:00 UTC) and 6:00 PM JST (9:00 UTC)
    // The cron "0 0 * * *" runs at midnight UTC = 9:00 AM JST
    // The cron "0 9 * * *" runs at 9:00 UTC = 6:00 PM JST
    if (event.cron === '0 0 * * *' || event.cron === '0 9 * * *') {
      ctx.waitUntil(sendReminders(env));
      // 会員番号(master)未割当の顧客を一括付番（取りこぼし解消）
      ctx.waitUntil(
        reconcileCustomerMasters(env.DB).then(
          (n) => n > 0 && console.log(`[customer-master] reconciled ${n} customers`)
        ).catch((err) => console.error('[customer-master] reconcile failed:', err))
      );
    }
  },
};
