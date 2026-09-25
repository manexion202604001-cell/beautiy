import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Trash2, UserRound } from 'lucide-react';
import { prisma } from '@/lib/server/db';
import { requirePage } from '@/lib/server/session';
import { fullName } from '@/lib/server/customers';
import { getKarte, previousKarte } from '@/lib/server/karte';
import { NotFoundError } from '@/lib/server/errors';
import { env } from '@/lib/server/env';
import { fileUrl } from '@/lib/server/storage';
import { Card, PageHeader, Badge } from '@/components/ui';
import { ConfirmAction } from '@/components/client';
import { toLocalParts } from '@salonos/core';
import { fmtDate, fmtDateTime, fmtRange } from '@/lib/format';
import { KarteEditor } from '../_components/KarteEditor';
import { PhotoPanel, SharePanel } from '../_components/KartePanels';
import type { Sketch } from '../_components/SketchCanvas';
import { deleteKarteAction } from '../actions';

export const metadata = { title: 'カルテ' };

export default async function KartePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ created?: string }> }) {
  const ctx = await requirePage('karte.read');
  const { id } = await params;
  const { created } = await searchParams;
  const k = await getKarte(ctx.org.id, id).catch((e) => { if (e instanceof NotFoundError) return null; throw e; });
  if (!k) notFound();
  const tz = ctx.shop.timezone;
  const canEdit = ctx.can('karte.write') && ctx.shops.some((s) => s.id === k.shopId);
  const [templates, prev, history, shop, author, reachRow] = await Promise.all([
    canEdit ? prisma.karteTemplate.findMany({ where: { organizationId: ctx.org.id }, orderBy: { name: 'asc' }, select: { id: true, name: true, treatmentNote: true, formulaNote: true, careMemo: true } }) : [],
    previousKarte(ctx.org.id, k.customerId, { before: k.visitDate, excludeId: k.id }),
    prisma.karte.findMany({ where: { organizationId: ctx.org.id, customerId: k.customerId, NOT: { id: k.id } }, orderBy: { visitDate: 'desc' }, take: 6, select: { id: true, visitDate: true, treatmentNote: true, formulaNote: true } }),
    prisma.shop.findFirst({ where: { id: k.shopId, organizationId: ctx.org.id }, select: { name: true } }),
    prisma.membership.findFirst({ where: { organizationId: ctx.org.id, userId: k.authorId }, select: { displayName: true } }),
    prisma.customer.findFirst({ where: { id: k.customerId, organizationId: ctx.org.id }, select: { lineOptIn: true, emailOptIn: true, emailHash: true, identities: { where: { provider: 'LINE' }, select: { id: true }, take: 1 } } }),
  ]);
  const reach = { line: !!reachRow?.lineOptIn && !!reachRow.identities.length, email: !!reachRow?.emailOptIn && !!reachRow.emailHash };
  const customerGone = !!(k.customer.deletedAt || k.customer.mergedIntoId);
  const sketch = k.sketchJson && typeof k.sketchJson === 'object' ? (k.sketchJson as unknown as Sketch) : null;

  return (
    <>
      <PageHeader
        back={{ href: `/customers/${k.customer.mergedIntoId ?? k.customer.id}?tab=karte`, label: '顧客詳細' }}
        title={<>{fullName(k.customer)} 様のカルテ</>}
        sub={<span className="row-wrap" style={{ gap: 6 }}>
          <span>{fmtDate(k.visitDate, tz)}</span>
          {k.appointment && <span>予約 {fmtRange(k.appointment.startAt, k.appointment.endAt, tz)} {k.appointment.menus.map((m) => m.name).join('・')}</span>}
          <span>・ {shop?.name} ・ 記入者 {author?.displayName ?? k.author.name}</span>
          {!canEdit && <Badge>閲覧のみ</Badge>}
        </span>}
        actions={<>
          <Link href={`/customers/${k.customer.id}`} className="btn secondary"><UserRound />顧客情報</Link>
          {canEdit && <ConfirmAction action={deleteKarteAction} fields={{ id: k.id }} confirm={'このカルテを削除しますか？\n写真・スケッチも削除され、元に戻せません。'} className="btn danger-outline"><Trash2 size={14} />削除</ConfirmAction>}
        </>}
      />
      {created && <div className="alert success" style={{ marginBottom: 12 }}>カルテを作成しました。写真の追加やお客様への共有ができます。</div>}
      {customerGone && <div className="alert warn" style={{ marginBottom: 12 }}>この顧客は統合または削除されています。</div>}
      {k.customer.notes && <div className="alert warn" style={{ marginBottom: 12 }}><strong>顧客メモ:</strong> {k.customer.notes}</div>}

      <div className="split">
        <KarteEditor
          karteId={k.id} customerId={k.customerId} appointmentId={k.appointmentId} visitDate={toLocalParts(k.visitDate, tz).date}
          initial={{ treatmentNote: k.treatmentNote ?? '', formulaNote: k.formulaNote ?? '', assistantNote: k.assistantNote ?? '', careMemo: k.careMemo ?? '' }}
          sketch={sketch} templates={templates} readOnly={!canEdit}
          previous={prev ? { ...prev, visitDate: fmtDate(prev.visitDate, tz) } : null}
        />
        <div className="stack">
          <PhotoPanel karteId={k.id} canEdit={canEdit} photos={k.photos.map((p) => ({ id: p.id, kind: p.kind, caption: p.caption, shareable: p.shareable, url: fileUrl(p.storageKey) }))} />
          <SharePanel
            karteId={k.id} enabled={k.shareEnabled} url={k.shareEnabled && k.shareToken ? `${env.appUrl}/k/${k.shareToken}` : null}
            sharedAt={k.sharedAt ? fmtDateTime(k.sharedAt, tz) : null} careMemo={!!k.careMemo?.trim()} shareablePhotos={k.photos.filter((p) => p.shareable).length}
            canEdit={canEdit && !customerGone} canSend={ctx.can('message.send')} reach={reach}
          />
          <Card title="過去のカルテ" flush>
            {history.length === 0 ? <p className="sub" style={{ padding: '0 18px 16px', margin: 0 }}>他のカルテはありません。</p> : (
              <div className="list" style={{ padding: '0 18px' }}>
                {history.map((h) => (
                  <Link key={h.id} href={`/karte/${h.id}`} className="list-item">
                    <div className="crm-date-box"><strong>{fmtDate(h.visitDate, tz).slice(5)}</strong><small>{fmtDate(h.visitDate, tz).slice(0, 4)}</small></div>
                    <div className="grow">
                      <div className="crm-clamp">{h.treatmentNote || '（記入なし）'}</div>
                      {h.formulaNote && <div className="sub crm-clamp mono">{h.formulaNote}</div>}
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
