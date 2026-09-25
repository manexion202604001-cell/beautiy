import { NextRequest } from 'next/server';
import { getStaffContext } from '@/lib/server/session';
import { exportCustomersCsv, parseCustomerQuery } from '@/lib/server/crm';
import { AppError } from '@/lib/server/errors';

// GET /customers/export?<list filters> → CSV (UTF-8 BOM). Requires customer.export and
// PII visibility (role default or an active temporary unlock). Audited with row count.
export async function GET(req: NextRequest) {
  const ctx = await getStaffContext();
  if (!ctx) return Response.redirect(new URL('/login', req.url), 303);
  try {
    const { csv, count } = await exportCustomersCsv(ctx, parseCustomerQuery(req.nextUrl.searchParams));
    const stamp = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 16).replace(/[-:T]/g, '');
    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="customers-${stamp}.csv"; filename*=UTF-8''${encodeURIComponent(`顧客一覧_${stamp}.csv`)}`,
        'Cache-Control': 'no-store',
        'X-Row-Count': String(count),
      },
    });
  } catch (e) {
    const msg = e instanceof AppError ? e.message : 'エクスポートに失敗しました';
    if (!(e instanceof AppError)) console.error('[customers.export]', e);
    const back = new URL('/customers', req.url);
    back.searchParams.set('error', msg);
    return Response.redirect(back, 303);
  }
}
