/**
 * Static web demo backend (VITE_DEMO builds only).
 *
 * The demo runs without a server: every `/v1/*` request is answered from responses recorded from the
 * real API against the seeded demo data (scripts/build-demo-fixtures.py). The clock is frozen to the
 * recording date (keeping the real time of day) so date-based screens line up with the recorded data.
 * Writes are rejected with a read-only notice; sign-in and token refresh replay the recorded session.
 */
import fixtures from './fixtures.json';

type Fixtures = { recordedDate: string; responses: Record<string, unknown> };
const data = fixtures as unknown as Fixtures;

// ---------------------------------------------------------------- frozen clock
const RealDate = Date;
const jstDate = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new RealDate(ms));
// shift whole days only, so the time of day stays real (current-time line, greetings)
const offsetMs = RealDate.parse(`${data.recordedDate}T00:00:00+09:00`) - RealDate.parse(`${jstDate(RealDate.now())}T00:00:00+09:00`);

class DemoDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(RealDate.now() + offsetMs);
    else super(...(args as [number]));
  }
  static override now() {
    return RealDate.now() + offsetMs;
  }
}
if (offsetMs !== 0) globalThis.Date = DemoDate as unknown as DateConstructor;

// ---------------------------------------------------------------- recorded API
const byPath = new Map<string, unknown>();
for (const [key, body] of Object.entries(data.responses)) {
  const [method, url] = key.split(' ');
  if (method !== 'GET') continue;
  const path = url!.split('?')[0]!;
  if (!byPath.has(path)) byPath.set(path, body);
}

function json(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

const readOnly = () =>
  json(403, {
    error: {
      code: 'DEMO_READ_ONLY',
      category: 'authorization',
      message: 'デモ版は閲覧専用のため、変更は保存されません。',
      requestId: 'demo',
    },
  });

const realFetch = window.fetch.bind(window);

window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw, window.location.href);
  const at = url.pathname.indexOf('/v1/');
  if (at < 0) return realFetch(input, init);
  const path = url.pathname.slice(at);
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  await new Promise((r) => setTimeout(r, 120));

  if (method === 'POST' && (path === '/v1/auth/login' || path === '/v1/auth/refresh')) {
    const session = data.responses['POST /v1/auth/login'] ?? data.responses['POST /v1/auth/refresh'];
    return session ? json(200, session) : readOnly();
  }
  if (method === 'POST' && path === '/v1/auth/logout') return json(204, null);
  if (method === 'POST' && /\/auth\/line$/.test(path)) {
    const line = Object.entries(data.responses).find(([k]) => k.startsWith('POST ') && k.endsWith('/auth/line'));
    return line ? json(200, line[1]) : readOnly();
  }
  if (method !== 'GET') return readOnly();

  const exact = data.responses[`GET ${path}${url.search}`];
  if (exact !== undefined) return json(200, exact);
  const samePath = byPath.get(path);
  if (samePath !== undefined) return json(200, samePath);
  return json(404, {
    error: {
      code: 'DEMO_NOT_RECORDED',
      category: 'not_found',
      message: 'デモ版にはこの表示用のデータが含まれていません。',
      requestId: 'demo',
    },
  });
};

// ---------------------------------------------------------------- demo notice
function showNotice() {
  const el = document.createElement('div');
  el.setAttribute('role', 'note');
  el.textContent = `デモ版（閲覧専用・${data.recordedDate.replace(/-/g, '/')} 時点のデータ）`;
  el.style.cssText =
    'position:fixed;left:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:9999;' +
    'padding:6px 12px;border-radius:999px;font:12px/1.4 system-ui,sans-serif;pointer-events:none;' +
    'background:rgba(15,118,110,.92);color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.2)';
  document.body.appendChild(el);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', showNotice);
else showNotice();
