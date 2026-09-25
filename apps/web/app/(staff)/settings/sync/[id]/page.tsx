import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePage } from '@/lib/server/session';
import { prisma } from '@/lib/server/db';
import { readConfig } from '@/lib/server/integrations';
import { PageHeader, Card, Badge, Empty, Field } from '@/components/ui';
import { fmtDate, fmtDateTime, fmtRange, yen } from '@/lib/format';
import { STATUS_LABEL } from '@/lib/server/booking';
import { conflictCandidates, SYNC_STATUS_LABEL, type StoredNormalized, type SyncOutcome } from '@/lib/server/sync';
import { FormModal, InlineAction } from '../../_components/client';
import { ACTION_LABEL, displayEventId, maskPayload, providerLabel, SYNC_TONE } from '../labels';
import { forceSyncAction, ignoreSyncAction, linkSyncAction, retrySyncAction } from '../actions';

export const metadata = { title: '同期イベントの詳細' };

export default async function SyncEventPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePage('settings.integrations');
  const { id } = await params;
  const ev = await prisma.syncEvent.findFirst({ where: { id, organizationId: ctx.org.id } });
  if (!ev) notFound();
  const tz = ctx.shop.timezone;
  const integration = ev.integrationId ? await prisma.integration.findFirst({ where: { id: ev.integrationId, organizationId: ctx.org.id } }) : null;
  const n = ev.normalized as unknown as StoredNormalized | null;
  const outcome = n?.outcome as SyncOutcome | undefined;
  const bookings = n?.bookings ?? [];
  const staffMap = (integration ? readConfig(integration.configEnc).staffMap : null) as Record<string, string> | null;
  const [members, appt, candidates] = await Promise.all([
    prisma.membership.findMany({ where: { organizationId: ctx.org.id }, select: { userId: true, displayName: true } }),
    ev.appointmentId ? prisma.appointment.findFirst({ where: { id: ev.appointmentId, organizationId: ctx.org.id }, include: { customer: { select: { id: true, lastName: true, firstName: true } }, menus: { select: { name: true } } } }) : null,
    ev.status === 'CONFLICT' || ev.status === 'FAILED' || ev.status === 'DEAD' ? conflictCandidates(ctx.org.id, ev) : Promise.resolve([]),
  ]);
  const staffName = new Map(members.map((m) => [m.userId, m.displayName]));
  const shopName = new Map(ctx.shops.map((s) => [s.id, s.name]));
  const conflict = outcome?.conflict;
  const actionable = ev.status !== 'DONE' && ev.status !== 'PROCESSING';
  const b0 = bookings[0];

  return (
    <>
      <PageHeader
        title="同期イベントの詳細" back={{ href: '/settings/sync', label: '同期状況' }}
        sub={<>{providerLabel(ev.provider)} ・ <span className="mono">{displayEventId(ev.externalEventId, ev.integrationId)}</span></>}
        actions={actionable ? <>
          <InlineAction action={retrySyncAction} fields={{ id: ev.id }} className="btn secondary">今すぐ再試行</InlineAction>
          <FormModal label="無視する" className="btn ghost" title="このイベントを無視（対応済み）にする" action={ignoreSyncAction} submitLabel="無視する">
            <input type="hidden" name="id" value={ev.id} />
            <Field label="メモ（対応内容）" htmlFor="ign-note" hint="例：電話で別日に振替済み"><input id="ign-note" name="note" className="input" maxLength={200} /></Field>
            <p className="sub" style={{ marginTop: 8 }}>予約には反映されません。以降、同じ予約の新しい通知は通常どおり処理されます。</p>
          </FormModal>
        </> : undefined}
      />

      {ev.status === 'CONFLICT' && (
        <div className="alert warn" style={{ marginBottom: 14 }}>
          <b>予約が重なっているため登録を保留しています。</b> {conflict?.message ?? ev.lastError}
          {conflict && <div className="sub" style={{ color: 'inherit' }}>{shopName.get(conflict.shopId) ?? ''} ・ {fmtDate(conflict.startAt, tz)} {fmtRange(conflict.startAt, conflict.endAt, tz)}{conflict.staffId ? ` ・ 担当 ${staffName.get(conflict.staffId) ?? ''}` : ''}</div>}
        </div>
      )}

      <div className="split">
        <div className="stack">
          <Card title="外部予約の内容">
            {bookings.length === 0 ? <Empty title="正規化された予約データがありません">通知の形式が正しくない可能性があります。下の受信データを確認してください。</Empty> : bookings.map((b) => (
              <dl key={b.externalId} className="kv">
                <dt>予約ID</dt><dd className="mono">{b.externalId}{b.version !== undefined && <span className="sub"> ・ version {b.version}</span>}</dd>
                <dt>状態</dt><dd>{b.status === 'cancelled' ? <Badge tone="red">キャンセル</Badge> : <Badge tone="blue">確定</Badge>}</dd>
                <dt>日時</dt><dd>{fmtDate(b.startAt, tz)} {fmtRange(b.startAt, b.endAt, tz)}</dd>
                <dt>お客様</dt><dd>{b.customer?.name}{b.customer?.kana && <span className="sub">（{b.customer.kana}）</span>}{b.customer?.externalCustomerId && <div className="sub mono">外部顧客ID {b.customer.externalCustomerId}</div>}</dd>
                <dt>担当</dt><dd>{b.staffExternalId ? <>{b.staffExternalId} → {staffMap?.[b.staffExternalId] ? staffName.get(staffMap[b.staffExternalId]) ?? '（不明なスタッフ）' : <span className="sub">対応表に未登録（指名なしで登録）</span>}</> : <span className="sub">指定なし</span>}</dd>
                <dt>メニュー</dt><dd>{b.menuNames?.join('・') || '—'}{b.totalPrice !== undefined && <span className="sub"> ・ {yen(b.totalPrice)}</span>}</dd>
                {b.note && <><dt>備考</dt><dd>{b.note}</dd></>}
              </dl>
            ))}
          </Card>

          {ev.status === 'CONFLICT' && b0 && (
            <Card flush title="重なっている予約（前後1時間）">
              {candidates.length === 0 ? <Empty title="重なっている予約は見つかりません">既存の予約が変更・キャンセルされた可能性があります。「今すぐ再試行」を押してください。</Empty> : (
                <div className="table-wrap">
                  <table className="table">
                    <thead><tr><th>時間</th><th>お客様</th><th>担当</th><th>状態</th><th /></tr></thead>
                    <tbody>
                      {candidates.map((a) => (
                        <tr key={a.id}>
                          <td className="nowrap">{fmtRange(a.startAt, a.endAt, tz)}<div className="sub">{shopName.get(a.shopId)}</div></td>
                          <td>{a.customer ? `${a.customer.lastName} ${a.customer.firstName}` : a.guestName ?? a.title ?? '—'}<div className="sub">{a.menus.map((m) => m.name).join('・')}</div></td>
                          <td>{a.staffId ? staffName.get(a.staffId) ?? a.staff?.name : 'フリー'}</td>
                          <td><Badge>{STATUS_LABEL[a.status]}</Badge>{a.externalProvider && <div className="sub">{providerLabel(a.externalProvider)}連携済</div>}</td>
                          <td className="right">{!a.externalRef && <InlineAction action={linkSyncAction} fields={{ id: ev.id, appointmentId: a.id }}>この予約と紐付け</InlineAction>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="stack-sm" style={{ padding: 16, borderTop: '1px solid var(--line)' }}>
                <b>解消方法</b>
                <ul className="sub" style={{ margin: 0, paddingLeft: 18 }}>
                  <li>同じお客様の予約が店頭・電話等で既に登録済みなら「この予約と紐付け」（以降の変更通知もその予約に反映）</li>
                  <li>席に余裕がある運用なら「強制登録（席数超過を許可）」</li>
                  <li>担当スタッフの予定と重なる場合は「担当者なしで登録」してから予約台帳で担当を調整</li>
                  <li>外部サイト側でお断りした場合は「無視する」</li>
                </ul>
                <div className="row-wrap" style={{ marginTop: 6 }}>
                  {conflict?.reason !== 'STAFF_CONFLICT' && <InlineAction action={forceSyncAction} fields={{ id: ev.id }} className="btn">強制登録（席数超過を許可）</InlineAction>}
                  {conflict?.staffId && <InlineAction action={forceSyncAction} fields={{ id: ev.id, dropStaff: '1' }} className={conflict.reason === 'STAFF_CONFLICT' ? 'btn' : 'btn secondary'}>担当者なしで登録{conflict.reason !== 'STAFF_CONFLICT' ? '（席数超過を許可）' : ''}</InlineAction>}
                </div>
              </div>
            </Card>
          )}

          <Card title="受信データ" actions={<span className="sub">電話番号・メールはマスク表示</span>}>
            <pre className="json-box">{JSON.stringify(maskPayload(ev.payload), null, 2)}</pre>
          </Card>
        </div>

        <div className="stack">
          <Card title="処理状況">
            <dl className="kv">
              <dt>状態</dt><dd><Badge tone={SYNC_TONE[ev.status]}>{SYNC_STATUS_LABEL[ev.status]}</Badge></dd>
              <dt>方向</dt><dd>{ev.direction === 'OUTBOUND' ? '送信（このシステム → 外部）' : '受信（外部 → このシステム）'}</dd>
              <dt>連携</dt><dd>{integration ? `${providerLabel(integration.provider)}（${integration.shopId ? shopName.get(integration.shopId) ?? '他店舗' : '全店舗共通'}）` : <span className="sub">連携設定なし</span>}</dd>
              <dt>種別</dt><dd className="mono">{ev.type}</dd>
              <dt>受信日時</dt><dd>{fmtDateTime(ev.createdAt, tz)}</dd>
              <dt>処理日時</dt><dd>{fmtDateTime(ev.processedAt, tz)}</dd>
              <dt>試行回数</dt><dd>{ev.attempts}回</dd>
              {ev.status === 'FAILED' && <><dt>次回の再試行</dt><dd>{fmtDateTime(ev.nextAttemptAt, tz)}</dd></>}
              {ev.lastError && <><dt>エラー・メモ</dt><dd style={{ color: ev.status === 'DONE' ? undefined : 'var(--red)' }}>{ev.lastError}</dd></>}
            </dl>
          </Card>
          <Card title="反映された予約">
            {appt ? (
              <div className="stack-sm">
                <div><b>{fmtDate(appt.startAt, tz)} {fmtRange(appt.startAt, appt.endAt, tz)}</b> <Badge>{STATUS_LABEL[appt.status]}</Badge></div>
                <div>{appt.customer ? <Link className="link" href={`/customers/${appt.customer.id}`}>{appt.customer.lastName} {appt.customer.firstName}</Link> : appt.guestName ?? '—'}</div>
                <div className="sub">{appt.menus.map((m) => m.name).join('・')} ・ {appt.staffId ? staffName.get(appt.staffId) : 'フリー'} ・ {shopName.get(appt.shopId)}</div>
                <Link className="btn secondary sm" href={`/reservations?date=${fmtDate(appt.startAt, tz).replaceAll('/', '-')}`}>予約台帳で開く</Link>
              </div>
            ) : <p className="sub">まだ予約には反映されていません。</p>}
          </Card>
          {outcome && (outcome.items.length > 0 || outcome.note) && (
            <Card title="処理結果">
              <ul className="list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {outcome.items.map((i, k) => (
                  <li key={k} className="list-item"><div className="grow"><span className="mono">{i.externalId}</span><div className="sub">{i.note ?? ''}</div></div><Badge tone="blue">{ACTION_LABEL[i.action] ?? i.action}</Badge></li>
                ))}
              </ul>
              {outcome.note && <p className="sub">{outcome.note}</p>}
              <p className="sub">{fmtDateTime(outcome.at, tz)}</p>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
