import type { Context, Next } from 'hono';
import type { Bindings, Variables, AuditContext } from '../types';

const AUDITED_METHODS = new Set(['POST', 'PUT', 'DELETE']);

const EXCLUDED_PREFIXES = [
  '/api/auth/login',
  '/api/auth/logout',
  '/api/webhook/',
  '/api/customer/',
  '/api/customer/auth/',
  '/api/public/',
];

const ENTITY_MAP: Record<string, string> = {
  'customers': 'customer',
  'reservations': 'reservation',
  'karutes': 'karute',
  'menus': 'menu',
  'menu-categories': 'menu_category',
  'equipment': 'equipment',
  'staff-blocks': 'staff_block',
  'staff': 'staff',
  'stores': 'store',
  'messages': 'message',
  'merge-candidates': 'merge_candidate',
  'counseling-sheets': 'counseling_sheet',
  'auth': 'auth',
  'push': 'push_subscription',
};

const METHOD_ACTION: Record<string, string> = {
  'POST': 'create',
  'PUT': 'update',
  'DELETE': 'delete',
};

const SENSITIVE_KEYS = [
  'password', 'password_hash', 'token', 'secret', 'access_token',
  'channel_secret', 'line_access_token', 'salonboard_password', 'lime_password',
];

function isUUID(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function deriveAction(method: string, path: string): { action: string; entityType: string; entityId: string | null } {
  const segments = path.replace(/^\/api\//, '').split('/');
  const entityType = ENTITY_MAP[segments[0]] || segments[0];

  // Extract entity ID (first UUID-like segment after the entity name)
  let entityId: string | null = null;
  for (let i = 1; i < segments.length; i++) {
    if (isUUID(segments[i])) {
      entityId = segments[i];
      break;
    }
  }

  // Check for sub-action like /reservations/:id/confirm
  const lastSegment = segments[segments.length - 1];
  if (lastSegment && !isUUID(lastSegment) && segments.length > 2) {
    return { action: `${lastSegment}_${entityType}`, entityType, entityId };
  }

  const action = `${METHOD_ACTION[method] || method.toLowerCase()}_${entityType}`;
  return { action, entityType, entityId };
}

function sanitizeBody(body: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!body) return null;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (SENSITIVE_KEYS.some(sk => key.toLowerCase().includes(sk))) {
      result[key] = '[REDACTED]';
    } else if (typeof value === 'string' && value.length > 200) {
      result[key] = value.substring(0, 200) + '...';
    } else if (Array.isArray(value) && value.length > 10) {
      result[key] = `[Array(${value.length})]`;
    } else {
      result[key] = value;
    }
  }
  return result;
}

export async function auditLog(
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
  next: Next
) {
  const method = c.req.method;

  if (!AUDITED_METHODS.has(method)) {
    await next();
    return;
  }

  const path = c.req.path;
  if (EXCLUDED_PREFIXES.some(ep => path.startsWith(ep))) {
    await next();
    return;
  }

  const startTime = Date.now();

  // Clone request body before handler consumes it
  let requestBody: Record<string, unknown> | null = null;
  try {
    const contentType = c.req.header('content-type') || '';
    if (contentType.includes('application/json')) {
      const cloned = c.req.raw.clone();
      requestBody = await cloned.json();
    }
  } catch {
    // Body parsing failed - skip
  }

  await next();

  // After response
  const staff = c.get('staff');
  if (!staff) return;

  const statusCode = c.res.status;
  // Skip client errors (no data was changed)
  if (statusCode >= 400 && statusCode < 500) return;

  const duration = Date.now() - startTime;
  const auditContext = c.get('auditContext') as AuditContext | undefined;
  const { action: derivedAction, entityType: derivedEntityType, entityId: derivedEntityId } = deriveAction(method, path);

  const logEntry = {
    id: crypto.randomUUID(),
    staff_id: staff.id,
    staff_name: staff.name,
    staff_role: staff.role,
    store_id: staff.store_id || null,
    method,
    path,
    route_pattern: path.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id'),
    action: auditContext?.action || derivedAction,
    entity_type: auditContext?.entityType || derivedEntityType,
    entity_id: auditContext?.entityId || derivedEntityId,
    status_code: statusCode,
    request_summary: JSON.stringify(auditContext?.summary || sanitizeBody(requestBody)),
    ip_address: c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || null,
    user_agent: c.req.header('user-agent') || null,
    duration_ms: duration,
  };

  c.executionCtx.waitUntil(
    c.env.DB.prepare(
      `INSERT INTO audit_logs (id, staff_id, staff_name, staff_role, store_id, method, path, route_pattern, action, entity_type, entity_id, status_code, request_summary, ip_address, user_agent, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        logEntry.id,
        logEntry.staff_id,
        logEntry.staff_name,
        logEntry.staff_role,
        logEntry.store_id,
        logEntry.method,
        logEntry.path,
        logEntry.route_pattern,
        logEntry.action,
        logEntry.entity_type,
        logEntry.entity_id,
        logEntry.status_code,
        logEntry.request_summary,
        logEntry.ip_address,
        logEntry.user_agent,
        logEntry.duration_ms,
      )
      .run()
      .catch((err) => {
        console.error('[AuditLog] Failed to write:', err);
      })
  );
}
