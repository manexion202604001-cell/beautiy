import Link from 'next/link';
import { Download } from 'lucide-react';
import { requirePage } from '@/lib/server/session';
import { prisma } from '@/lib/server/db';
import { PageHeader, Card, Empty, Badge } from '@/components/ui';
import { fmtDateTime } from '@/lib/format';
import { actionLabel, auditWhere, parseAuditFilter } from './query';

export const metadata = { title: '監査ログ' };

const PAGE = 50;
const PRESETS = [
  { label: '個人情報', action: 'customer.pii' }, { label: '権限', action: 'permission' }, { label: 'スタッフ', action: 'staff' },
  { label: '連携', action: 'integration' }, { label: '出力', action: 'report.export' }, { label: 'ログイン', action: 'auth' },
];

export default async function AuditPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requirePage('audit.read');
  const sp = await searchParams;
  const f = parseAuditFilter(sp);
  const tz = ctx.shop.timezone;
  const page = Math.max(1, Math.min(1000, Number(sp.page) || 1));
  const where = auditWhere(ctx.org.id, f, tz);
  const [rows, count, members, types] = await Promise.all([
    prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * PAGE, take: PAGE }),
    prisma.auditLog.count({ where }),
    prisma.membership.findMany({ where: { organizationId: ctx.org.id }, select: { userId: true, displayName: true }, orderBy: { sortOrder: 'asc' } }),
    prisma.auditLog.groupBy({ by: ['resourceType'], where: { organizationId: ctx.org.id }, orderBy: { resourceType: 'asc' } }),
  ]);
  const name = new Map(members.map((m) => [m.userId, m.displayName]));
  const pages = Math.max(1, Math.ceil(count / PAGE));
  const q = (patch: Record<string, string | undefined>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...f, page: undefined, ...patch })) if (v) u.set(k, String(v));
    const s = u.toString();
    return s ? `?${s}` : '';
  };

  return (
    <>
      <PageHeader
        title="監査ログ" back={{ href: '/settings', label: '設定' }}
        sub="個人情報の閲覧・出力、権限や連携の変更などの操作記録です（改ざんできない追記専用の記録）。"
        actions={<a className="btn secondary" href={`/settings/audit/export${q({})}`} download><Download size={16} />CSV出力</a>}
      />
      <Card>
        <form method="get" action="/settings/audit" className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}>
          <div className="field"><label htmlFor="af-action">操作（前方一致）</label><input id="af-action" name="action" className="input" defaultValue={f.action ?? ''} placeholder="例：customer.pii" /></div>
          <div className="field"><label htmlFor="af-user">ユーザー</label>
            <select id="af-user" name="user" className="select" defaultValue={f.user ?? ''}>
              <option value="">すべて</option>{members.map((m) => <option key={m.userId} value={m.userId}>{m.displayName}</option>)}<option value="system">システム・外部</option>
            </select>
          </div>
          <div className="field"><label htmlFor="af-type">対象の種類</label>
            <select id="af-type" name="type" className="select" defaultValue={f.type ?? ''}>
              <option value="">すべて</option>{types.map((t) => <option key={t.resourceType} value={t.resourceType}>{t.resourceType}</option>)}
            </select>
          </div>
          <div className="field"><label htmlFor="af-from">開始日</label><input id="af-from" name="from" type="date" className="input" defaultValue={f.from ?? ''} /></div>
          <div className="field"><label htmlFor="af-to">終了日</label><input id="af-to" name="to" type="date" className="input" defaultValue={f.to ?? ''} /></div>
          <div className="field" style={{ justifyContent: 'flex-end' }}><div className="row"><button className="btn" type="submit">絞り込み</button><Link className="btn ghost" href="/settings/audit">クリア</Link></div></div>
        </form>
        <div className="row-wrap" style={{ marginTop: 10 }}>
          <span className="sub">よく使う条件：</span>
          {PRESETS.map((p) => <Link key={p.action} className={`btn sm ${f.action === p.action ? '' : 'secondary'}`} href={`/settings/audit${q({ action: p.action })}`}>{p.label}</Link>)}
        </div>
      </Card>

      <Card className="section" flush title={`${count.toLocaleString('ja-JP')}件`}>
        {rows.length === 0 ? <Empty title="該当する記録はありません" /> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>日時</th><th>ユーザー</th><th>操作</th><th>対象</th><th>詳細</th><th>IP</th></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const meta = r.metadata ? JSON.stringify(r.metadata) : '';
                  return (
                    <tr key={r.id}>
                      <td className="nowrap">{fmtDateTime(r.createdAt, tz)}</td>
                      <td className="nowrap">{r.userId ? name.get(r.userId) ?? <span className="sub">（削除済み）</span> : <span className="sub">システム</span>}</td>
                      <td><span className="mono">{r.action}</span>{actionLabel(r.action) && <div><Badge tone={r.action.startsWith('customer.pii') || r.action.includes('export') ? 'violet' : r.action.startsWith('permission') ? 'amber' : 'gray'}>{actionLabel(r.action)}</Badge></div>}</td>
                      <td><span className="sub">{r.resourceType}</span>{r.resourceId && <div className="mono sub">{r.resourceId.slice(0, 26)}</div>}</td>
                      <td style={{ maxWidth: 380 }}>{meta ? <details><summary className="sub" style={{ cursor: 'pointer' }}>{meta.length > 70 ? meta.slice(0, 70) + '…' : meta}</summary><pre className="json-box" style={{ marginTop: 6 }}>{JSON.stringify(r.metadata, null, 2)}</pre></details> : <span className="sub">—</span>}</td>
                      <td className="mono sub nowrap">{r.ip ?? '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {pages > 1 && (
          <div className="between" style={{ padding: '10px 16px' }}>
            <span className="sub">{page} / {pages} ページ</span>
            <div className="row">
              {page > 1 && <Link className="btn secondary sm" href={`/settings/audit${q({ page: String(page - 1) })}`}>前へ</Link>}
              {page < pages && <Link className="btn secondary sm" href={`/settings/audit${q({ page: String(page + 1) })}`}>次へ</Link>}
            </div>
          </div>
        )}
      </Card>
    </>
  );
}
