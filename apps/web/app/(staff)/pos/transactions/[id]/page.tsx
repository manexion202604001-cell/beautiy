import Link from 'next/link';
import { notFound } from 'next/navigation';
import { todayIn, toLocalParts } from '@salonos/core';
import { requirePage } from '@/lib/server/session';
import { prisma } from '@/lib/server/db';
import { actorOf, getTicket } from '@/lib/server/pos';
import { Badge, Card, PageHeader } from '@/components/ui';
import { fmtDateTime, yen } from '@/lib/format';
import { LINE_KIND_LABEL, METHOD_LABEL, cashTendered, paymentLabel, type PaymentMethodName } from '@/lib/pos-shared';
import { TxStatusBadge } from '../../_components/TxStatusBadge';
import { RefundButton, VoidButton } from './TxActions';

export const metadata = { title: '取引詳細' };

const ACTION_LABEL: Record<string, string> = {
  'pos.checkout': '会計確定', 'pos.refund': '返金', 'pos.void': '取消', 'pos.payment_link': 'オンライン決済開始',
};

export default async function TransactionDetail({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePage('pos.checkout');
  const { id } = await params;
  const t = await getTicket(actorOf(ctx), id).catch(() => null);
  if (!t) notFound();
  const tz = t.shop.timezone;
  const staffIds = [...new Set([t.staffId, t.createdById, ...t.items.map((i) => i.staffId), ...t.refunds.map((r) => r.createdById)].filter(Boolean) as string[])];
  const [members, ledger, logs] = await Promise.all([
    staffIds.length ? prisma.membership.findMany({ where: { organizationId: ctx.org.id, userId: { in: staffIds } }, select: { userId: true, displayName: true } }) : [],
    prisma.pointLedger.findMany({ where: { transactionId: t.id, organizationId: ctx.org.id }, orderBy: { createdAt: 'asc' } }),
    prisma.auditLog.findMany({ where: { organizationId: ctx.org.id, resourceType: 'Transaction', resourceId: t.id }, orderBy: { createdAt: 'asc' } }),
  ]);
  const logUsers = await prisma.membership.findMany({ where: { organizationId: ctx.org.id, userId: { in: logs.map((l) => l.userId).filter(Boolean) as string[] } }, select: { userId: true, displayName: true } });
  const name = (uid: string | null | undefined) => (uid ? [...members, ...logUsers].find((m) => m.userId === uid)?.displayName ?? '—' : '—');

  const restocked = new Map<string, number>();
  for (const l of logs) if (l.action === 'pos.refund') for (const r of ((l.metadata as any)?.restock ?? []) as { itemId: string; quantity: number }[]) restocked.set(r.itemId, (restocked.get(r.itemId) ?? 0) + r.quantity);
  const refundable = t.total - t.refundedTotal;
  const canRefund = ctx.can('pos.refund') && (t.status === 'PAID' || t.status === 'PARTIALLY_REFUNDED') && refundable > 0;
  const sameDay = t.paidAt ? toLocalParts(t.paidAt, tz).date === todayIn(tz) : false;
  const canVoid = (t.status === 'DRAFT') || (ctx.can('pos.refund') && t.status === 'PAID' && sameDay);
  const primaryMethod = [...t.payments].sort((a, b) => b.amount - a.amount)[0]?.method ?? 'CASH';

  return (
    <>
      <PageHeader
        title={<>取引 No.{t.number} <TxStatusBadge status={t.status} /></>}
        sub={`${t.shop.name} ・ ${fmtDateTime(t.paidAt ?? t.createdAt, tz)}`}
        back={{ href: '/pos/transactions', label: '取引履歴' }}
        actions={<>
          {t.status === 'DRAFT' && <Link className="btn" href={`/pos/checkout?transactionId=${t.id}`}>会計を再開</Link>}
          {t.status !== 'DRAFT' && <Link className="btn secondary" href={`/pos/receipt/${t.id}`}>レシート</Link>}
          {canRefund && <RefundButton transactionId={t.id} refundable={refundable} defaultMethod={primaryMethod}
            retailItems={t.items.filter((i) => i.kind === 'RETAIL' && i.productId).map((i) => ({ id: i.id, name: i.name, quantity: i.quantity, restockable: i.quantity - (restocked.get(i.id) ?? 0) }))} />}
          {canVoid && <VoidButton transactionId={t.id} draft={t.status === 'DRAFT'} />}
        </>}
      />
      {t.status === 'PAID' && !sameDay && ctx.can('pos.refund') && <div className="alert info" style={{ marginBottom: 14 }}>前日以前の会計は取消できません。返金をご利用ください。</div>}

      <div className="split">
        <div className="stack">
          <Card title="明細" flush>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>区分</th><th>品目</th><th>担当</th><th className="num">単価</th><th className="num">数量</th><th className="num">値引き</th><th className="num">金額</th></tr></thead>
                <tbody>
                  {t.items.map((i) => (
                    <tr key={i.id}>
                      <td><Badge tone={i.kind === 'RETAIL' ? 'violet' : i.kind === 'SERVICE' ? 'blue' : 'gray'}>{LINE_KIND_LABEL[i.kind as keyof typeof LINE_KIND_LABEL] ?? i.kind}</Badge></td>
                      <td>{i.name}{i.nominated && <> <Badge tone="amber">指名</Badge></>}{restocked.get(i.id) ? <span className="sub"> （返品 {restocked.get(i.id)}）</span> : null}</td>
                      <td>{name(i.staffId)}</td>
                      <td className="num">{yen(i.unitPrice)}</td>
                      <td className="num">{i.quantity}</td>
                      <td className="num">{i.discount ? `−${yen(i.discount)}` : ''}</td>
                      <td className="num">{yen(Math.max(0, i.unitPrice * i.quantity - i.discount))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card title="支払い" flush>
            {t.payments.length === 0 ? <div className="empty"><h3>支払い記録はありません</h3></div> : (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>方法</th><th>参照</th><th>状態</th><th className="num">金額</th></tr></thead>
                  <tbody>
                    {t.payments.map((p) => (
                      <tr key={p.id}>
                        <td>{paymentLabel(p)}</td>
                        <td className="mono sub">{p.method === 'CASH' ? `お預り ${yen(cashTendered(p))}` : p.externalRef ?? '—'}</td>
                        <td>{p.status === 'SUCCEEDED' ? <Badge tone="green">成功</Badge> : p.status === 'REFUNDED' ? <Badge tone="gray">取消</Badge> : <Badge tone="amber">{p.status}</Badge>}</td>
                        <td className="num">{yen(p.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {t.refunds.length > 0 && (
            <Card title="返金履歴" flush>
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>日時</th><th>方法</th><th>理由</th><th>処理者</th><th className="num">金額</th></tr></thead>
                  <tbody>
                    {t.refunds.map((r) => (
                      <tr key={r.id}>
                        <td>{fmtDateTime(r.createdAt, tz)}</td>
                        <td>{METHOD_LABEL[r.method as PaymentMethodName]}</td>
                        <td>{r.reason ?? '—'}</td>
                        <td>{r.createdById ? name(r.createdById) : 'システム'}</td>
                        <td className="num">−{yen(r.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </div>

        <div className="stack">
          <Card title="金額">
            <dl className="kv">
              <dt>小計</dt><dd className="num">{yen(t.subtotal)}</dd>
              <dt>明細値引き</dt><dd className="num">{t.lineDiscounts ? `−${yen(t.lineDiscounts)}` : '—'}</dd>
              <dt>クーポン</dt><dd>{t.coupon ? `${t.coupon.name}（−${yen(t.couponDiscount)}）` : '—'}</dd>
              <dt>割引</dt><dd className="num">{t.manualDiscount ? `−${yen(t.manualDiscount)}` : '—'}</dd>
              <dt>ポイント利用</dt><dd className="num">{t.pointsUsed ? `−${t.pointsUsed.toLocaleString()}pt` : '—'}</dd>
              <dt>合計（税込）</dt><dd className="num" style={{ fontWeight: 800 }}>{yen(t.total)}</dd>
              <dt>うち消費税</dt><dd className="num">{yen(t.taxTotal)}</dd>
              <dt>返金済み</dt><dd className="num">{t.refundedTotal ? `−${yen(t.refundedTotal)}` : '—'}</dd>
            </dl>
          </Card>
          <Card title="情報">
            <dl className="kv">
              <dt>お客様</dt><dd>{t.customer ? <Link className="link" href={`/customers/${t.customer.id}`}>{t.customer.lastName} {t.customer.firstName}</Link> : 'ゲスト'}</dd>
              <dt>担当</dt><dd>{name(t.staffId)}</dd>
              <dt>予約</dt><dd>{t.appointment ? fmtDateTime(t.appointment.startAt, tz) : '—'}</dd>
              <dt>レジ</dt><dd>{t.registerSession ? `${fmtDateTime(t.registerSession.openedAt, tz)} 開局分` : '—'}</dd>
              <dt>作成者</dt><dd>{name(t.createdById)}</dd>
              {t.voidedAt && <><dt>取消日時</dt><dd>{fmtDateTime(t.voidedAt, tz)}</dd></>}
              {t.note && <><dt>メモ</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{t.note}</dd></>}
            </dl>
          </Card>
          <Card title="ポイント">
            {ledger.length === 0 ? <div className="sub">ポイントの増減はありません</div> : (
              <div className="list">
                {ledger.map((l) => <div key={l.id} className="list-item"><div className="grow">{l.reason}<div className="sub">{fmtDateTime(l.createdAt, tz)}</div></div><strong className={l.delta >= 0 ? 'diff-plus' : 'diff-minus'}>{l.delta > 0 ? '+' : ''}{l.delta.toLocaleString()}pt</strong></div>)}
              </div>
            )}
          </Card>
          <Card title="操作履歴">
            {logs.length === 0 ? <div className="sub">記録はありません</div> : (
              <div className="timeline">
                {logs.map((l) => (
                  <div key={l.id} className="timeline-item">
                    <div style={{ fontWeight: 700 }}>{ACTION_LABEL[l.action] ?? l.action}</div>
                    <div className="sub">{fmtDateTime(l.createdAt, tz)} ・ {l.userId ? name(l.userId) : 'システム'}{(l.metadata as any)?.amount ? ` ・ ${yen((l.metadata as any).amount)}` : ''}{(l.metadata as any)?.reason ? ` ・ ${(l.metadata as any).reason}` : ''}</div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
