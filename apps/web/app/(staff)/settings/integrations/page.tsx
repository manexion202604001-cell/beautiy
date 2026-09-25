import Link from 'next/link';
import { requirePage } from '@/lib/server/session';
import { prisma } from '@/lib/server/db';
import { env } from '@/lib/server/env';
import { readConfig } from '@/lib/server/integrations';
import { instagramBookingLink, instagramProfileLink } from '@/lib/server/adapters/instagram';
import { PageHeader, Card, Field, Badge, Empty } from '@/components/ui';
import { ConfirmAction, CopyButton } from '@/components/client';
import { fmtDateTime } from '@/lib/format';
import { FormModal, InlineAction, RevealModal } from '../_components/client';
import { maskSecret } from '../_components/guard';
import { GENERIC_EXAMPLE, GROUP_LABEL, PROVIDERS, type ProviderDef } from './providers';
import {
  createIntegrationAction, deleteIntegrationAction, rotateWebhookSecretAction, setIntegrationStatusAction, testIntegrationAction, updateIntegrationAction,
} from './actions';

export const metadata = { title: '外部連携' };

type Row = Awaited<ReturnType<typeof prisma.integration.findMany>>[number];

export default async function IntegrationsPage() {
  const ctx = await requirePage('settings.integrations');
  const [rows, shops, members, syncStats] = await Promise.all([
    prisma.integration.findMany({ where: { organizationId: ctx.org.id }, orderBy: { createdAt: 'asc' } }),
    prisma.shop.findMany({ where: { organizationId: ctx.org.id }, select: { id: true, name: true, slug: true }, orderBy: { createdAt: 'asc' } }),
    prisma.membership.findMany({ where: { organizationId: ctx.org.id, active: true }, select: { userId: true, displayName: true }, orderBy: { sortOrder: 'asc' } }),
    prisma.syncEvent.groupBy({ by: ['integrationId', 'status'], where: { organizationId: ctx.org.id, createdAt: { gte: new Date(Date.now() - 7 * 86400000) } }, _count: true }),
  ]);
  const shopName = new Map(shops.map((s) => [s.id, s.name]));
  const tz = ctx.shop.timezone;
  const groups = (['messaging', 'payment', 'listing', 'booking'] as const);

  const scopeLabel = (r: Row) => (r.shopId ? shopName.get(r.shopId) ?? '（削除済み店舗）' : '全店舗共通');
  const webhookUrl = (def: ProviderDef, r: Row) => (def.webhookPath ? `${env.appUrl}${def.webhookPath.replace('{key}', r.webhookKey)}` : null);

  const editFields = (def: ProviderDef, r: Row) => {
    const cfg = readConfig(r.configEnc);
    return (
      <>
        <input type="hidden" name="id" value={r.id} />
        <div className="form-grid">
          {def.fields.filter((f) => !(f.key === 'shopMap' && r.shopId)).map((f) => {
            const id = `${r.id}-${f.key}`;
            if (f.secret) {
              return (
                <Field key={f.key} label={f.label} htmlFor={id} full hint={cfg[f.key] ? `設定済み（${maskSecret(cfg[f.key])}）— 変更する場合のみ入力` : f.hint ?? '未設定'}>
                  <input id={id} name={f.key} type="password" className="input" autoComplete="off" placeholder={cfg[f.key] ? '変更しない場合は空欄' : ''} />
                  {cfg[f.key] && <label className="checkbox" style={{ marginTop: 4 }}><input type="checkbox" name={`clear_${f.key}`} />この値を削除する</label>}
                </Field>
              );
            }
            if (f.kind === 'json') {
              return (
                <Field key={f.key} label={f.label} htmlFor={id} full hint={f.hint}>
                  <textarea id={id} name={f.key} className="textarea mono" placeholder={f.placeholder} defaultValue={cfg[f.key] ? JSON.stringify(cfg[f.key], null, 2) : ''} />
                </Field>
              );
            }
            if (f.kind === 'select') {
              return (
                <Field key={f.key} label={f.label} htmlFor={id}>
                  <select id={id} name={f.key} className="select" defaultValue={cfg[f.key] ?? f.options?.[0]?.value}>{f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
                </Field>
              );
            }
            return <Field key={f.key} label={f.label} htmlFor={id} hint={f.hint}><input id={id} name={f.key} className="input" defaultValue={cfg[f.key] ?? ''} placeholder={f.placeholder} maxLength={500} /></Field>;
          })}
          <Field label="状態" htmlFor={`${r.id}-status`}>
            <select id={`${r.id}-status`} name="status" className="select" defaultValue={r.status === 'PAUSED' ? 'PAUSED' : 'ACTIVE'}><option value="ACTIVE">有効</option><option value="PAUSED">一時停止</option></select>
          </Field>
        </div>
        {def.fields.some((f) => f.key === 'staffMap') && (
          <details style={{ marginTop: 12 }}>
            <summary className="link" style={{ fontSize: 12.5 }}>スタッフ・店舗のIDを表示</summary>
            <div className="grid-2" style={{ marginTop: 8 }}>
              <div className="json-box">{members.map((m) => `${m.displayName}: ${m.userId}`).join('\n')}</div>
              <div className="json-box">{shops.map((s) => `${s.name}: ${s.id}`).join('\n')}</div>
            </div>
          </details>
        )}
      </>
    );
  };

  const statusBadge = (r: Row) => (r.status === 'PAUSED' ? <Badge>一時停止</Badge> : r.lastError ? <Badge tone="red">エラーあり</Badge> : <Badge tone="green">有効</Badge>);

  const card = (def: ProviderDef) => {
    const list = rows.filter((r) => r.provider === def.provider);
    const usedScopes = new Set(list.map((r) => r.shopId ?? 'org'));
    const scopes = [{ id: 'org', name: '全店舗共通' }, ...(def.perShop ? shops : [])].filter((s) => def.multiple || !usedScopes.has(s.id));
    const addForm = (
      <>
        <input type="hidden" name="provider" value={def.provider} />
        <Field label="適用範囲" htmlFor={`scope-${def.provider}`} hint="店舗ごとの設定がある場合はそちらが優先されます">
          <select id={`scope-${def.provider}`} name="scope" className="select" defaultValue={scopes.some((s) => s.id === ctx.shop.id) ? ctx.shop.id : scopes[0]?.id}>
            {scopes.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
      </>
    );
    return (
      <Card key={def.provider} title={<div><h2>{def.label}</h2><div className="sub" style={{ fontWeight: 400, marginTop: 2 }}>{def.description}</div></div>}
        actions={scopes.length > 0 ? (def.group === 'booking'
          ? <RevealModal label="追加" className="btn secondary sm" title={`${def.label} の連携を追加`} action={createIntegrationAction} submitLabel="追加">{addForm}</RevealModal>
          : <FormModal label="追加" className="btn secondary sm" title={`${def.label} の連携を追加`} action={createIntegrationAction} submitLabel="追加">{addForm}</FormModal>) : undefined}>
        {list.length === 0 ? <p className="sub">未設定です。</p> : (
          <div className="stack">
            {list.map((r) => {
              const cfg = readConfig(r.configEnc);
              const url = webhookUrl(def, r);
              const st = syncStats.filter((s) => s.integrationId === r.id);
              const total = st.reduce((a, s) => a + s._count, 0), bad = st.filter((s) => ['FAILED', 'DEAD', 'CONFLICT'].includes(s.status)).reduce((a, s) => a + s._count, 0);
              return (
                <div key={r.id} className="card pad-sm" style={{ boxShadow: 'none' }}>
                  <div className="between" style={{ flexWrap: 'wrap' }}>
                    <div className="row-wrap"><b>{scopeLabel(r)}</b>{statusBadge(r)}</div>
                    <div className="row-wrap">
                      <FormModal label="設定" className="btn secondary sm" title={`${def.label}（${scopeLabel(r)}）`} action={updateIntegrationAction} wide>{editFields(def, r)}</FormModal>
                      {def.group === 'booking' && (
                        <RevealModal label="シークレット再生成" className="btn ghost sm" title="Webhook署名シークレットの再生成" action={rotateWebhookSecretAction} submitLabel="再生成する">
                          <input type="hidden" name="id" value={r.id} />
                          <p>新しいシークレットを生成します。<b>現在のシークレットで署名された通知は受け付けられなくなります。</b>送信側の設定も更新してください。</p>
                        </RevealModal>
                      )}
                      {r.status === 'PAUSED'
                        ? <ConfirmAction action={setIntegrationStatusAction} fields={{ id: r.id, status: 'ACTIVE' }} className="btn ghost sm">有効にする</ConfirmAction>
                        : <ConfirmAction action={setIntegrationStatusAction} fields={{ id: r.id, status: 'PAUSED' }} confirm="この連携を一時停止しますか？受信・送信が止まります。" className="btn ghost sm">一時停止</ConfirmAction>}
                      <ConfirmAction action={deleteIntegrationAction} fields={{ id: r.id }} confirm={`${def.label}（${scopeLabel(r)}）の連携を削除しますか？保存された認証情報も削除されます。`} className="btn ghost sm">削除</ConfirmAction>
                    </div>
                  </div>
                  {def.group === 'booking' && !cfg.webhookSecret && <div className="alert warn" style={{ marginTop: 10 }}>Webhook署名シークレットが未設定のため、予約通知を受信できません。「シークレット再生成」で発行してください。</div>}
                  <dl className="kv" style={{ marginTop: 10 }}>
                    {def.fields.filter((f) => f.kind !== 'json').map((f) => (
                      <div key={f.key} style={{ display: 'contents' }}>
                        <dt>{f.label}</dt>
                        <dd className={f.secret ? 'mono' : ''}>{cfg[f.key] ? (f.secret ? maskSecret(cfg[f.key]) : f.options?.find((o) => o.value === cfg[f.key])?.label ?? String(cfg[f.key])) : <span className="sub">未設定</span>}</dd>
                      </div>
                    ))}
                    {def.fields.some((f) => f.key === 'staffMap') && <><dt>スタッフ対応</dt><dd>{cfg.staffMap ? `${Object.keys(cfg.staffMap).length}件` : <span className="sub">未設定（指名なしで登録）</span>}</dd></>}
                    {url && <><dt>Webhook URL</dt><dd><div className="url-box"><input className="input" readOnly value={url} aria-label="Webhook URL" /><CopyButton text={url} /></div></dd></>}
                    {def.group === 'booking' && <><dt>直近7日</dt><dd>{total}件受信{bad > 0 && <> ・ <Link className="link" href="/settings/sync?status=problem">要対応 {bad}件</Link></>}{r.lastSyncAt && <span className="sub"> ・ 最終同期 {fmtDateTime(r.lastSyncAt, tz)}</span>}</dd></>}
                    {r.lastError && <><dt>直近のエラー</dt><dd style={{ color: 'var(--red)' }}>{r.lastError}</dd></>}
                  </dl>
                  {def.testable && <div style={{ marginTop: 10 }}><InlineAction action={testIntegrationAction} fields={{ id: r.id }}>接続テスト</InlineAction></div>}
                  {def.provider === 'INSTAGRAM' && (
                    <div className="stack-sm" style={{ marginTop: 10 }}>
                      {(r.shopId ? shops.filter((s) => s.id === r.shopId) : shops).map((s) => {
                        const link = instagramBookingLink(s.slug, { placement: 'bio' }), prof = instagramProfileLink(s.slug);
                        return (
                          <div key={s.id}>
                            <div className="label">{s.name}：プロフィールの「予約する」ボタン／リンク</div>
                            <div className="url-box"><input className="input" readOnly value={link} aria-label="Instagram用予約リンク" /><CopyButton text={link} /></div>
                            <div className="url-box" style={{ marginTop: 4 }}><input className="input" readOnly value={prof} aria-label="Instagram用プロフィールリンク" /><CopyButton text={prof} /></div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>
    );
  };

  return (
    <>
      <PageHeader title="外部連携" back={{ href: '/settings', label: '設定' }} sub="認証情報は暗号化して保存され、画面には再表示されません。変更はすべて監査ログに記録されます。" actions={<Link className="btn secondary" href="/settings/sync">外部予約の同期状況</Link>} />
      {groups.map((g) => (
        <section key={g} className="section">
          <h2 style={{ margin: '8px 0 10px' }}>{GROUP_LABEL[g]}</h2>
          <div className={g === 'booking' ? 'stack' : 'grid-2'}>{PROVIDERS.filter((p) => p.group === g).map(card)}</div>
          {g === 'booking' && (
            <Card className="section" title="外部予約の共通JSON形式">
              <p className="sub">予約の作成・変更・キャンセルごとに送信してください。同じ event_id の再送は無視され、version が古い通知は破棄されます。席数やスタッフの予定と重なる予約は「要確認（競合）」として保留され、<Link className="link" href="/settings/sync">同期状況</Link>から解消できます。</p>
              <pre className="code-block">{GENERIC_EXAMPLE.replace('{url}', `${env.appUrl}/api/webhooks/booking/<連携ごとのキー>`)}</pre>
              <p className="sub" style={{ marginTop: 8 }}>応答：200 受付済み（重複時は duplicate: true）／401 署名不正／404 連携が無効／400 形式エラー（内容は同期状況に記録されます）。5xx の場合は再送してください。</p>
            </Card>
          )}
        </section>
      ))}
      {rows.length === 0 && <Card className="section"><Empty title="まだ連携はありません">必要な連携の「追加」から設定を始めてください。</Empty></Card>}
    </>
  );
}
