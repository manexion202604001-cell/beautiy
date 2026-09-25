import Link from 'next/link';
import { maskEmail, maskPhone, normalizePhone, todayIn } from '@salonos/core';
import { prisma } from '@/lib/server/db';
import type { StaffContext } from '@/lib/server/session';
import { Badge, Card, Empty } from '@/components/ui';
import { ConfirmAction } from '@/components/client';
import { fmtDateW } from '@/lib/format';
import { deleteWaitlistAction } from './actions';
import { WaitlistAddButton, WaitlistStatusSelect } from './WaitlistClient';
import { WAIT_STATUS_LABEL, WAIT_STATUS_TONE } from './labels';

const FILTERS = [
  { key: 'open', label: '対応中' },
  { key: 'BOOKED', label: '予約済み' },
  { key: 'CLOSED', label: 'クローズ' },
  { key: 'all', label: 'すべて' },
] as const;

function maskContact(v: string | null, full: boolean) {
  if (!v) return '—';
  if (full) return v;
  if (v.includes('@')) return maskEmail(v);
  return maskPhone(normalizePhone(v) ?? v);
}

export async function WaitlistSection({ ctx, status }: { ctx: StaffContext; status?: string }) {
  const filter = FILTERS.some((f) => f.key === status) ? status! : 'open';
  const shop = ctx.shop;
  const today = todayIn(shop.timezone);
  const where = {
    shopId: shop.id,
    ...(filter === 'open' ? { status: { in: ['WAITING', 'CONTACTED'] } } : filter === 'all' ? {} : { status: filter }),
  };
  const [entries, staff] = await Promise.all([
    prisma.waitlistEntry.findMany({ where, orderBy: [{ desiredDate: 'asc' }, { createdAt: 'asc' }], take: 300 }),
    prisma.membership.findMany({ where: { organizationId: ctx.org.id, active: true, shops: { some: { shopId: shop.id } } }, orderBy: [{ sortOrder: 'asc' }, { displayName: 'asc' }] }),
  ]);
  const staffName = new Map(staff.map((s) => [s.userId, s.displayName]));
  const customerIds = entries.map((e) => e.customerId).filter((x): x is string => !!x);
  const customers = customerIds.length ? await prisma.customer.findMany({ where: { id: { in: customerIds }, organizationId: ctx.org.id }, select: { id: true, lastName: true, firstName: true } }) : [];
  const custName = new Map(customers.map((c) => [c.id, `${c.lastName} ${c.firstName}`.trim()]));
  const canWrite = ctx.can('appointment.write');
  // Waitlist contact is staff-entered free text; show in full only to roles that see PII by default.
  const fullContact = ctx.piiByDefault;

  return (
    <Card
      flush
      title={<div><h2>キャンセル待ち</h2><div className="sub">空きが出たらご連絡するお客様のリストです。「予約に変換」で台帳に登録できます。</div></div>}
      actions={canWrite ? <WaitlistAddButton staff={staff.map((s) => ({ userId: s.userId, name: s.displayName }))} defaultDate={today} /> : undefined}
    >
      <div style={{ padding: '10px 18px 0' }}>
        <div className="seg">
          {FILTERS.map((f) => <Link key={f.key} href={`/reservations?tab=waitlist&status=${f.key}`} className={filter === f.key ? 'active' : ''}>{f.label}</Link>)}
        </div>
      </div>
      {entries.length === 0 ? (
        <Empty title="キャンセル待ちはありません">{filter === 'open' ? '満席の日にご希望があれば「追加」から登録してください。' : '該当する登録はありません。'}</Empty>
      ) : (
        <div className="table-wrap" style={{ marginTop: 12 }}>
          <table className="table">
            <thead>
              <tr><th>希望日</th><th>お名前</th><th>連絡先</th><th>希望時間・メニュー</th><th>担当希望</th><th>ステータス</th><th /></tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td className="nowrap">
                    {fmtDateW(`${e.desiredDate}T12:00:00Z`, 'UTC')}
                    {e.desiredDate < today && e.status !== 'BOOKED' && e.status !== 'CLOSED' && <div><Badge tone="red">期限切れ</Badge></div>}
                  </td>
                  <td>
                    {e.customerId ? <Link className="link" href={`/customers/${e.customerId}`}>{custName.get(e.customerId) ?? e.name}</Link> : e.name}
                    {!e.customerId && <div className="sub">未登録</div>}
                  </td>
                  <td className="nowrap">{maskContact(e.contact, fullContact)}</td>
                  <td>
                    {e.timeNote && <div>{e.timeNote}</div>}
                    {e.menuNote && <div className="sub">{e.menuNote}</div>}
                    {!e.timeNote && !e.menuNote && <span className="sub">指定なし</span>}
                  </td>
                  <td className="nowrap">{e.staffId ? staffName.get(e.staffId) ?? '—' : <span className="sub">指名なし</span>}</td>
                  <td>
                    {canWrite ? <WaitlistStatusSelect id={e.id} status={e.status} /> : <Badge tone={WAIT_STATUS_TONE[e.status]}>{WAIT_STATUS_LABEL[e.status] ?? e.status}</Badge>}
                  </td>
                  <td className="nowrap right">
                    {canWrite && (
                      <span className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
                        {e.status !== 'BOOKED' && e.status !== 'CLOSED' && (
                          <Link className="btn sm" href={`/reservations?view=day&date=${e.desiredDate >= today ? e.desiredDate : today}&waitlist=${e.id}`}>予約に変換</Link>
                        )}
                        <ConfirmAction action={deleteWaitlistAction} fields={{ id: e.id }} confirm="このキャンセル待ちを削除しますか？" className="btn ghost sm">削除</ConfirmAction>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
