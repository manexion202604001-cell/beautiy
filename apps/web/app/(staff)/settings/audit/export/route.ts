// Audit log CSV export (audit.read). The export itself is audited.
import { NextResponse } from 'next/server';
import { toCsv } from '@salonos/core';
import { requireStaff } from '@/lib/server/session';
import { prisma } from '@/lib/server/db';
import { audit } from '@/lib/server/audit';
import { AppError } from '@/lib/server/errors';
import { fmtDateTime } from '@/lib/format';
import { actionLabel, auditWhere, parseAuditFilter } from '../query';

export const dynamic = 'force-dynamic';
const MAX_ROWS = 20_000;

export async function GET(req: Request) {
  let ctx;
  try { ctx = await requireStaff('audit.read'); } catch (e) {
    if (e instanceof AppError) return new NextResponse(e.message, { status: e.status });
    throw e;
  }
  const f = parseAuditFilter(Object.fromEntries(new URL(req.url).searchParams.entries()));
  const tz = ctx.shop.timezone;
  const [rows, members] = await Promise.all([
    prisma.auditLog.findMany({ where: auditWhere(ctx.org.id, f, tz), orderBy: { createdAt: 'desc' }, take: MAX_ROWS }),
    prisma.membership.findMany({ where: { organizationId: ctx.org.id }, select: { userId: true, displayName: true } }),
  ]);
  const name = new Map(members.map((m) => [m.userId, m.displayName]));
  const csv = toCsv(
    ['日時', 'ユーザー', 'ユーザーID', '操作', '操作（説明）', '対象の種類', '対象ID', '詳細', 'IP', 'ユーザーエージェント'],
    rows.map((r) => [fmtDateTime(r.createdAt, tz), r.userId ? name.get(r.userId) ?? '' : 'システム', r.userId ?? '', r.action, actionLabel(r.action), r.resourceType, r.resourceId ?? '', r.metadata ? JSON.stringify(r.metadata) : '', r.ip ?? '', r.userAgent ?? '']),
  );
  await audit(ctx, 'audit.export', 'AuditLog', null, { filter: f, rows: rows.length });
  return new NextResponse(csv, {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="audit_${new Date().toISOString().slice(0, 10)}.csv"`, 'Cache-Control': 'no-store' },
  });
}
