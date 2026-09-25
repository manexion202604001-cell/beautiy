import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { CalendarPlus, ClipboardPlus, CreditCard, MessageCircle, Pencil, Star, Phone, Mail, MapPin, ShieldCheck, Trash2, GitMerge } from 'lucide-react';
import { LIFECYCLE_LABEL, ROLE_LABEL, type RoleName } from '@salonos/core';
import { prisma } from '@/lib/server/db';
import { requirePage } from '@/lib/server/session';
import { piiAccess, readCustomerContact } from '@/lib/server/pii';
import { fullName } from '@/lib/server/customers';
import { customerDetailStats, customerTimeline, LIFECYCLE_TONE, tagOptions, type TimelineKind } from '@/lib/server/crm';
import { formatAnswer, parseFormFields } from '@/lib/server/karte';
import { Badge, Card, Empty, PageHeader, Stat, Tabs } from '@/components/ui';
import { ConfirmAction } from '@/components/client';
import { fmtDate, fmtDateTime, yen } from '@/lib/format';
import { deleteCustomerAction, toggleFavoriteAction, unlinkIdentityAction } from '../actions';
import { IssueCounselingButton, PiiUnlockButton, PointAdjustButton, TagEditor } from '../_components/DetailClient';

export const metadata = { title: '顧客詳細' };

const KIND_LABEL: Record<TimelineKind, string> = { appointment: '予約', transaction: '会計', karte: 'カルテ', message: 'メッセージ', counseling: 'カウンセリング', review: '口コミ' };
const PROVIDER_LABEL: Record<string, string> = { LINE: 'LINE', HOTPEPPER: '外部予約サイト', MINIMO: '外部予約サイト', RAKUTEN: '外部予約サイト', GOOGLE: 'Google', INSTAGRAM: 'Instagram', WEB: 'ネット予約' };

type Props = { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> };

export default async function CustomerDetailPage({ params, searchParams }: Props) {
  const ctx = await requirePage('customer.read');
  const { id } = await params;
  const sp = await searchParams;
  const tab = ['timeline', 'karte', 'counseling', 'points'].includes(sp.tab ?? '') ? sp.tab! : 'timeline';
  const c = await prisma.customer.findFirst({
    where: { id, organizationId: ctx.org.id },
    include: { tags: { include: { tag: true } }, identities: { orderBy: { createdAt: 'asc' } } },
  });
  if (!c) notFound();
  if (c.mergedIntoId) redirect(`/customers/${c.mergedIntoId}`);
  if (c.deletedAt) notFound();

  const tz = ctx.shop.timezone;
  const [stats, contact, access, allTags, staffMember, primaryShop] = await Promise.all([
    customerDetailStats(ctx.org.id, c.id),
    readCustomerContact(ctx, c, 'detail'),
    piiAccess(ctx),
    tagOptions(ctx.org.id),
    c.assignedStaffId ? prisma.membership.findFirst({ where: { organizationId: ctx.org.id, userId: c.assignedStaffId }, select: { displayName: true, role: true } }) : null,
    c.primaryShopId ? prisma.shop.findFirst({ where: { id: c.primaryShopId, organizationId: ctx.org.id }, select: { name: true } }) : null,
  ]);
  const canWrite = ctx.can('customer.write');
  const canKarte = ctx.can('karte.write');
  const [forms, upcoming] = canKarte ? await Promise.all([
    prisma.counselingForm.findMany({ where: { organizationId: ctx.org.id, active: true }, select: { id: true, name: true }, orderBy: { createdAt: 'asc' } }),
    prisma.appointment.findMany({ where: { organizationId: ctx.org.id, customerId: c.id, startAt: { gte: new Date(Date.now() - 86400000) }, status: { in: ['REQUESTED', 'CONFIRMED', 'ARRIVED', 'IN_SERVICE'] } }, orderBy: { startAt: 'asc' }, take: 5, include: { menus: { select: { name: true } } } }),
  ]) : [[], []];

  const name = fullName(c) || '（名前未登録）';
  const kana = `${c.lastNameKana ?? ''} ${c.firstNameKana ?? ''}`.trim();
  const age = c.birthday ? Math.floor((Date.now() - new Date(`${c.birthday}T00:00:00+09:00`).getTime()) / (365.2425 * 86400000)) : null;
  const tabHref = (t: string) => `/customers/${c.id}${t === 'timeline' ? '' : `?tab=${t}`}`;

  return (
    <>
      <PageHeader
        back={{ href: '/customers', label: '顧客一覧' }}
        title={<span className="row" style={{ gap: 8 }}>{name}<span className="sub" style={{ fontSize: 14, fontWeight: 500 }}>様</span>{c.favorite && <Star size={18} className="crm-fav" aria-label="お気に入り" />}</span>}
        sub={<span className="row-wrap" style={{ gap: 6 }}>{kana && <span>{kana}</span>}<Badge tone={LIFECYCLE_TONE[stats.lifecycle]}>{LIFECYCLE_LABEL[stats.lifecycle]}</Badge>{c.identities.some((i) => i.provider === 'LINE') && <Badge tone="green">LINE連携</Badge>}</span>}
        actions={<>
          {ctx.can('appointment.write') && <Link href={`/reservations?customerId=${c.id}`} className="btn secondary"><CalendarPlus />予約</Link>}
          {canKarte && <Link href={`/karte/new?customerId=${c.id}`} className="btn secondary"><ClipboardPlus />カルテ</Link>}
          {ctx.can('pos.checkout') && <Link href={`/pos/checkout?customerId=${c.id}`} className="btn secondary"><CreditCard />会計</Link>}
          {ctx.can('message.send') && <Link href={`/messages?customerId=${c.id}`} className="btn secondary"><MessageCircle />メッセージ</Link>}
          {canWrite && <Link href={`/customers/${c.id}/edit`} className="btn"><Pencil />編集</Link>}
        </>}
      />
      {sp.created && <div className="alert success" style={{ marginBottom: 12 }}>顧客を登録しました。</div>}
      {sp.saved && <div className="alert success" style={{ marginBottom: 12 }}>顧客情報を保存しました。</div>}
      {sp.merged && <div className="alert success" style={{ marginBottom: 12 }}>顧客を統合しました。来店履歴・カルテ・会計・連携情報はこの顧客に集約されています。</div>}

      <div className="grid-4 crm-stats">
        <Stat label="来店回数" value={`${stats.visitCount}回`} sub={stats.firstVisitAt ? `初回 ${fmtDate(stats.firstVisitAt, tz)}` : '来店履歴なし'} />
        <Stat label="累計売上（LTV）" value={yen(stats.ltv)} sub={`平均単価 ${yen(stats.avgSpend)}`} />
        <Stat label="最終来店" value={stats.lastVisitAt ? fmtDate(stats.lastVisitAt, tz) : '—'} sub={stats.avgIntervalDays !== null ? `平均来店周期 ${Math.round(stats.avgIntervalDays)}日` : '周期データなし'} />
        <Stat label="ポイント残高" value={`${stats.points.toLocaleString('ja-JP')}pt`} sub={<>無断キャンセル {stats.noShowCount}回 / キャンセル {stats.cancelCount}回</>} tone={stats.noShowCount > 0 ? 'down' : undefined} />
      </div>

      <div className="split section">
        <div className="stack">
          <Tabs active={tab} items={[
            { key: 'timeline', label: '来店・履歴', href: tabHref('timeline') },
            { key: 'karte', label: 'カルテ', href: tabHref('karte') },
            { key: 'counseling', label: 'カウンセリング', href: tabHref('counseling') },
            { key: 'points', label: 'ポイント', href: tabHref('points') },
          ]} />
          {tab === 'timeline' && <TimelineTab orgId={ctx.org.id} customerId={c.id} tz={tz} />}
          {tab === 'karte' && <KarteTab orgId={ctx.org.id} customerId={c.id} tz={tz} canWrite={canKarte} canRead={ctx.can('karte.read')} />}
          {tab === 'counseling' && <CounselingTab orgId={ctx.org.id} customerId={c.id} tz={tz} />}
          {tab === 'points' && <PointsTab orgId={ctx.org.id} customerId={c.id} tz={tz} balance={stats.points} canAdjust={ctx.can('settings.shop')} />}
        </div>

        <div className="stack">
          <Card title="連絡先" actions={contact.masked
            ? <PiiUnlockButton />
            : access.via === 'unlock' && access.unlockExpiresAt ? <Badge tone="amber">一時解除中（{fmtDateTime(access.unlockExpiresAt, tz).slice(11)}まで）</Badge> : <Badge tone="green"><ShieldCheck size={12} />閲覧権限あり</Badge>}>
            <dl className="kv">
              <dt><Phone size={13} /> 電話</dt><dd className="mono">{contact.phone ? (contact.masked ? contact.phone : <a className="link" href={`tel:${contact.phone}`}>{contact.phone}</a>) : <span className="sub">未登録</span>}</dd>
              <dt><Mail size={13} /> メール</dt><dd className="mono">{contact.email ? (contact.masked ? contact.email : <a className="link" href={`mailto:${contact.email}`}>{contact.email}</a>) : <span className="sub">未登録</span>}</dd>
              <dt><MapPin size={13} /> 住所</dt><dd>{contact.address ?? <span className="sub">未登録</span>}</dd>
              <dt>配信設定</dt><dd className="row-wrap" style={{ gap: 4 }}><Badge tone={c.lineOptIn ? 'green' : 'gray'}>LINE {c.lineOptIn ? '可' : '停止'}</Badge><Badge tone={c.emailOptIn ? 'green' : 'gray'}>メール {c.emailOptIn ? '可' : '停止'}</Badge></dd>
            </dl>
            {contact.masked && <p className="sub" style={{ marginTop: 10, marginBottom: 0 }}>個人情報は権限のあるスタッフのみ表示されます。閲覧が必要な場合はロック解除してください（記録されます）。</p>}
          </Card>

          <Card title="プロフィール" actions={canWrite ? <ConfirmAction action={toggleFavoriteAction} fields={{ id: c.id, favorite: c.favorite ? '0' : '1' }} className="btn ghost sm"><Star size={14} className={c.favorite ? 'crm-fav' : ''} />{c.favorite ? 'お気に入り解除' : 'お気に入り'}</ConfirmAction> : undefined}>
            <dl className="kv">
              <dt>誕生日</dt><dd>{c.birthday ? `${c.birthday.replace(/-/g, '/')}${age !== null ? `（${age}歳）` : ''}` : <span className="sub">—</span>}</dd>
              <dt>性別</dt><dd>{c.gender ?? <span className="sub">—</span>}</dd>
              <dt>担当</dt><dd>{staffMember ? `${staffMember.displayName}（${ROLE_LABEL[staffMember.role as RoleName]}）` : <span className="sub">担当なし</span>}</dd>
              <dt>主な店舗</dt><dd>{primaryShop?.name ?? <span className="sub">—</span>}</dd>
              <dt>登録日</dt><dd>{fmtDate(c.createdAt, tz)}</dd>
            </dl>
            {c.notes && <div className="crm-note">{c.notes}</div>}
          </Card>

          <Card title="タグ">
            <TagEditor customerId={c.id} tags={c.tags.map((t) => t.tag)} allTags={allTags} canEdit={canWrite} />
          </Card>

          <Card title="外部ID連携">
            {c.identities.length === 0 ? <p className="sub" style={{ margin: 0 }}>LINE・外部予約サイト等との連携はありません。</p> : (
              <div className="list">
                {c.identities.map((i) => (
                  <div key={i.id} className="list-item">
                    <div className="grow">
                      <div style={{ fontWeight: 700 }}>{PROVIDER_LABEL[i.provider] ?? i.provider}{i.displayName && <span className="sub">（{i.displayName}）</span>}</div>
                      <div className="sub mono" title={i.externalId}>{i.externalId.length > 14 ? `${i.externalId.slice(0, 6)}…${i.externalId.slice(-4)}` : i.externalId} ・ {fmtDate(i.createdAt, tz)} 連携</div>
                    </div>
                    {canWrite && <ConfirmAction action={unlinkIdentityAction} fields={{ customerId: c.id, identityId: i.id }} confirm={`${PROVIDER_LABEL[i.provider] ?? i.provider}との連携を解除しますか？\n解除後、このIDからの予約・メッセージは新しい顧客として扱われる可能性があります。`} className="btn ghost sm">解除</ConfirmAction>}
                  </div>
                ))}
              </div>
            )}
          </Card>

          {(canKarte || ctx.can('customer.merge')) && (
            <Card title="その他の操作">
              <div className="row-wrap">
                {canKarte && <IssueCounselingButton customerId={c.id} forms={forms} canSend={ctx.can('message.send')} appointments={upcoming.map((a) => ({ id: a.id, label: `${fmtDateTime(a.startAt, tz)} ${a.menus.map((m) => m.name).join('・')}` }))} />}
                {ctx.can('customer.merge') && <Link href={`/customers/duplicates?focus=${c.id}`} className="btn secondary sm"><GitMerge size={14} />重複・統合</Link>}
                {ctx.can('customer.merge') && <ConfirmAction action={deleteCustomerAction} fields={{ id: c.id, reason: '顧客詳細から削除' }} confirm={`${name} 様を削除しますか？\n一覧・検索に表示されなくなります（履歴データは保持され、監査ログに記録されます）。`} className="btn danger-outline sm"><Trash2 size={14} />削除</ConfirmAction>}
              </div>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

async function TimelineTab({ orgId, customerId, tz }: { orgId: string; customerId: string; tz: string }) {
  const items = await customerTimeline(orgId, customerId);
  if (!items.length) return <Card><Empty title="履歴はまだありません">予約・会計・カルテ・メッセージがここに時系列で表示されます。</Empty></Card>;
  return (
    <Card>
      <div className="timeline">
        {items.map((t) => (
          <div key={t.id} className={`timeline-item crm-tl crm-tl-${t.kind}`}>
            <div className="between" style={{ alignItems: 'flex-start' }}>
              <div style={{ minWidth: 0 }}>
                <div className="sub">{fmtDateTime(t.at, tz)} ・ {KIND_LABEL[t.kind]}</div>
                <div style={{ fontWeight: 700 }}>{t.href ? <Link href={t.href} className="crm-tl-link">{t.title}</Link> : t.title}</div>
                {t.detail && <div className="sub crm-clamp">{t.detail}</div>}
              </div>
              <div className="row-wrap" style={{ gap: 4, justifyContent: 'flex-end' }}>{t.badges?.map((b) => <Badge key={b.label} tone={b.tone}>{b.label}</Badge>)}</div>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

async function KarteTab({ orgId, customerId, tz, canWrite, canRead }: { orgId: string; customerId: string; tz: string; canWrite: boolean; canRead: boolean }) {
  if (!canRead) return <Card><Empty title="カルテを表示する権限がありません" /></Card>;
  const kartes = await prisma.karte.findMany({
    where: { organizationId: orgId, customerId }, orderBy: { visitDate: 'desc' }, take: 50,
    include: { _count: { select: { photos: true } }, author: { select: { name: true } }, appointment: { select: { menus: { select: { name: true } } } } },
  });
  if (!kartes.length) return <Card><Empty title="カルテはまだありません" action={canWrite ? <Link href={`/karte/new?customerId=${customerId}`} className="btn sm">カルテを作成</Link> : undefined} /></Card>;
  return (
    <Card flush title="カルテ履歴" actions={canWrite ? <Link href={`/karte/new?customerId=${customerId}`} className="btn sm">新規カルテ</Link> : undefined}>
      <div className="list" style={{ padding: '0 18px' }}>
        {kartes.map((k) => (
          <Link key={k.id} href={`/karte/${k.id}`} className="list-item crm-karte-row">
            <div className="crm-date-box"><strong>{fmtDate(k.visitDate, tz).slice(5)}</strong><small>{fmtDate(k.visitDate, tz).slice(0, 4)}</small></div>
            <div className="grow">
              <div style={{ fontWeight: 700 }}>{k.appointment?.menus.map((m) => m.name).join('・') || '施術記録'}</div>
              <div className="sub crm-clamp">{k.treatmentNote || k.careMemo || '（記入なし）'}</div>
              {k.formulaNote && <div className="sub crm-clamp mono">薬剤: {k.formulaNote}</div>}
            </div>
            <div className="stack-sm" style={{ alignItems: 'flex-end' }}>
              <span className="sub">{k.author.name}</span>
              <span className="row-wrap" style={{ gap: 4 }}>
                {k._count.photos > 0 && <Badge tone="violet">写真{k._count.photos}</Badge>}
                {k.shareEnabled && <Badge tone="green">共有中</Badge>}
              </span>
            </div>
          </Link>
        ))}
      </div>
    </Card>
  );
}

async function CounselingTab({ orgId, customerId, tz }: { orgId: string; customerId: string; tz: string }) {
  const responses = await prisma.counselingResponse.findMany({ where: { organizationId: orgId, customerId }, orderBy: { createdAt: 'desc' }, take: 30, include: { form: true } });
  if (!responses.length) return <Card><Empty title="カウンセリングの記録はありません">右側の「カウンセリング依頼」からお客様用の記入リンクを発行できます。</Empty></Card>;
  return (
    <div className="stack">
      {responses.map((r) => {
        const fields = parseFormFields(r.form.fields);
        const answers = (r.answers ?? {}) as Record<string, unknown>;
        return (
          <Card key={r.id} title={<div><h2>{r.form.name}</h2><div className="sub">{r.status === 'SUBMITTED' ? `回答日時 ${fmtDateTime(r.submittedAt, tz)}` : `発行 ${fmtDateTime(r.createdAt, tz)}・お客様の回答待ち`}</div></div>}
            actions={r.status === 'SUBMITTED' ? <Badge tone="green">回答済</Badge> : <Badge tone="amber">未回答</Badge>}>
            {r.status === 'SUBMITTED' ? (
              <>
                <dl className="kv crm-answers">
                  {fields.map((f) => <div key={f.id} style={{ display: 'contents' }}><dt>{f.label}</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{formatAnswer(f, answers[f.id])}</dd></div>)}
                </dl>
                {(r.signatureData || r.signedName) && (
                  <div className="crm-sign">
                    <div className="sub">同意・署名{r.signedAt && `（${fmtDateTime(r.signedAt, tz)}）`}</div>
                    {r.form.consentText && <p className="sub crm-clamp" style={{ margin: '4px 0' }}>{r.form.consentText}</p>}
                    <div className="row" style={{ alignItems: 'flex-end', gap: 16 }}>
                      {r.signatureData?.startsWith('data:image/png;base64,') && <img src={r.signatureData} alt="署名" className="crm-sign-img" />}
                      {r.signedName && <span>署名者: <strong>{r.signedName}</strong></span>}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <p className="sub" style={{ margin: 0 }}>リンク: <span className="mono">/c/{r.token.slice(0, 6)}…</span>（お客様の回答後にここへ表示されます）</p>
            )}
          </Card>
        );
      })}
    </div>
  );
}

async function PointsTab({ orgId, customerId, tz, balance, canAdjust }: { orgId: string; customerId: string; tz: string; balance: number; canAdjust: boolean }) {
  const rows = await prisma.pointLedger.findMany({ where: { organizationId: orgId, customerId }, orderBy: { createdAt: 'desc' }, take: 100 });
  return (
    <Card flush title={<div><h2>ポイント履歴</h2><div className="sub">残高 {balance.toLocaleString('ja-JP')}pt</div></div>} actions={canAdjust ? <PointAdjustButton customerId={customerId} balance={balance} /> : undefined}>
      {rows.length === 0 ? <Empty title="ポイントの履歴はありません">会計時に付与・利用されたポイントが表示されます。</Empty> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>日時</th><th>内容</th><th className="num">ポイント</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="nowrap">{fmtDateTime(r.createdAt, tz)}</td>
                  <td>{r.transactionId ? <Link className="link" href={`/pos/transactions/${r.transactionId}`}>{r.reason}</Link> : r.reason}</td>
                  <td className="num" style={{ color: r.delta < 0 ? 'var(--red)' : 'var(--green)', fontWeight: 700 }}>{r.delta > 0 ? '+' : ''}{r.delta.toLocaleString('ja-JP')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
