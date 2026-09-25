import { NextRequest } from 'next/server';
import { prisma } from '@/lib/server/db';
import { getStaffContext } from '@/lib/server/session';
import { getObject } from '@/lib/server/storage';

// Access rules:
//  - org/<orgId>/public/...  → anyone (product images, profile images)
//  - share token ?t=...      → photos of a karte whose share link is enabled
//  - otherwise               → signed-in staff of the same organization
export async function GET(req: NextRequest, { params }: { params: Promise<{ key: string[] }> }) {
  const { key: parts } = await params;
  const key = parts.map(decodeURIComponent).join('/');
  const m = /^org\/([^/]+)\/([^/]+)\//.exec(key);
  if (!m || key.includes('..')) return new Response('Not found', { status: 404 });
  const [, orgId, area] = m;
  let allowed = area === 'public';
  const t = req.nextUrl.searchParams.get('t');
  if (!allowed && t) {
    const photo = await prisma.kartePhoto.findFirst({ where: { storageKey: key, shareable: true, karte: { shareToken: t, shareEnabled: true, organizationId: orgId } } });
    allowed = !!photo;
  }
  if (!allowed) {
    const ctx = await getStaffContext();
    allowed = !!ctx && ctx.org.id === orgId && ctx.can('karte.read');
  }
  if (!allowed) return new Response('Forbidden', { status: 403 });
  const obj = await getObject(key);
  if (!obj) return new Response('Not found', { status: 404 });
  return new Response(Buffer.from(obj.data), {
    headers: {
      'Content-Type': obj.contentType,
      'Cache-Control': area === 'public' ? 'public, max-age=86400' : 'private, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
