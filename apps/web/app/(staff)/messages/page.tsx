import Link from 'next/link';
import { MessageCircle, Search } from 'lucide-react';
import { prisma } from '@/lib/server/db';
import { requirePage } from '@/lib/server/session';
import { decryptField, maskedContact } from '@/lib/server/pii';
import { customerVars, listConversations, markThreadRead } from '@/lib/server/messaging';
import { Avatar, Badge, Empty, PageHeader } from '@/components/ui';
import { fmtDateTime, fmtTime, fmtDate } from '@/lib/format';
import { MessagesNav } from './nav';
import { Composer, InlineAction, NewThreadButton } from './ui';
import { retryMessageAction, setConsentAction } from './actions';
import { CHANNEL_LABEL, CHANNEL_TONE, STATUS_SHORT, STATUS_TONE } from './labels';

export const metadata = { title: 'メッセージ' };

function relTime(d: Date, tz: string) {
  const diff = Date.now() - d.getTime();
  if (diff < 86400000 && fmtDate(d, tz) === fmtDate(new Date(), tz)) return fmtTime(d, tz);
  return fmtDate(d, tz).slice(5);
}

export default async function InboxPage({ searchParams }: { searchParams: Promise<{ customerId?: string; q?: string; unread?: string }> }) {
  const ctx = await requirePage('message.send');
  const sp = await searchParams;
  const tz = ctx.shop.timezone;
  const q = (sp.q ?? '').slice(0, 40);
  const unreadOnly = sp.unread === '1';

  const selected = sp.customerId
    ? await prisma.customer.findFirst({
      where: { id: sp.customerId, organizationId: ctx.org.id, deletedAt: null },
      include: { identities: { where: { provider: 'LINE' }, take: 1 }, tags: { include: { tag: true } } },
    })
    : null;
  if (selected) await markThreadRead(ctx.org.id, selected.id);

  const conversations = await listConversations(ctx.org.id, { q, unreadOnly });
  const totalUnread = conversations.reduce((s, c) => s + c.unread, 0);

  let thread: React.ReactNode = null;
  if (selected) {
    const [messages, templates, vars] = await Promise.all([
      prisma.message.findMany({ where: { organizationId: ctx.org.id, customerId: selected.id }, orderBy: { createdAt: 'desc' }, take: 200 }),
      prisma.messageTemplate.findMany({ where: { organizationId: ctx.org.id }, orderBy: [{ category: 'asc' }, { name: 'asc' }] }),
      customerVars(ctx.org.id, selected.id, ctx.shop.id),
    ]);
    messages.reverse();
    const ruleIds = [...new Set(messages.map((m) => m.automationRuleId).filter(Boolean))] as string[];
    const bcIds = [...new Set(messages.map((m) => m.broadcastId).filter(Boolean))] as string[];
    const staffIds = [...new Set(messages.map((m) => m.createdById).filter(Boolean))] as string[];
    const [rules, bcs, staff] = await Promise.all([
      ruleIds.length ? prisma.automationRule.findMany({ where: { id: { in: ruleIds }, organizationId: ctx.org.id }, select: { id: true, name: true } }) : [],
      bcIds.length ? prisma.broadcast.findMany({ where: { id: { in: bcIds }, organizationId: ctx.org.id }, select: { id: true, name: true } }) : [],
      staffIds.length ? prisma.membership.findMany({ where: { organizationId: ctx.org.id, userId: { in: staffIds } }, select: { userId: true, displayName: true } }) : [],
    ]);
    const ruleName = new Map(rules.map((r) => [r.id, r.name]));
    const bcName = new Map(bcs.map((b) => [b.id, b.name]));
    const staffName = new Map(staff.map((s) => [s.userId, s.displayName]));

    const lineLinked = selected.identities.length > 0;
    const hasEmail = !!decryptField(selected.emailEnc);
    const lineOk = lineLinked && selected.lineOptIn;
    const emailOk = hasEmail && selected.emailOptIn;
    const blockedReason = lineOk || emailOk ? null
      : (lineLinked && !selected.lineOptIn) || (hasEmail && !selected.emailOptIn)
        ? 'このお客様は配信停止中のため送信できません。お客様の同意を得た場合のみ配信を再開してください。'
        : 'LINE未連携かつメールアドレス未登録のため送信できません。';
    const masked = maskedContact(selected);
    const name = `${selected.lastName} ${selected.firstName}`.trim();
    const canConsent = ctx.can('customer.write');

    thread = (
      <section className="thread card flush" aria-label={`${name}様とのメッセージ`}>
        <header className="thread-head">
          <Link href="/messages" className="icon-btn show-sm" aria-label="一覧へ戻る">←</Link>
          <Avatar name={name} />
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="row-wrap" style={{ gap: 6 }}>
              <strong>{name}</strong>
              {selected.identities[0]?.displayName && <span className="sub">LINE: {selected.identities[0].displayName}</span>}
              {selected.tags.slice(0, 3).map((t) => <span key={t.tagId} className="badge" style={{ background: `${t.tag.color}1a`, color: t.tag.color }}>{t.tag.name}</span>)}
            </div>
            <div className="row-wrap" style={{ gap: 6, marginTop: 2 }}>
              <Badge tone={lineLinked ? (selected.lineOptIn ? 'green' : 'red') : 'gray'}>LINE {lineLinked ? (selected.lineOptIn ? '配信可' : '配信停止') : '未連携'}</Badge>
              <Badge tone={hasEmail ? (selected.emailOptIn ? 'blue' : 'red') : 'gray'}>メール {hasEmail ? (selected.emailOptIn ? `配信可 ${masked.email ?? ''}` : '配信停止') : '未登録'}</Badge>
            </div>
          </div>
          <div className="toolbar">
            {canConsent && lineLinked && (
              <InlineAction action={setConsentAction} fields={{ customerId: selected.id, channel: 'LINE', optIn: String(!selected.lineOptIn) }}
                confirm={selected.lineOptIn ? 'LINE配信を停止しますか？' : 'お客様の同意を確認済みですか？LINE配信を再開します。'} className="btn ghost sm">
                {selected.lineOptIn ? 'LINE停止' : 'LINE再開'}
              </InlineAction>
            )}
            {canConsent && hasEmail && (
              <InlineAction action={setConsentAction} fields={{ customerId: selected.id, channel: 'EMAIL', optIn: String(!selected.emailOptIn) }}
                confirm={selected.emailOptIn ? 'メール配信を停止しますか？' : 'お客様の同意を確認済みですか？メール配信を再開します。'} className="btn ghost sm">
                {selected.emailOptIn ? 'メール停止' : 'メール再開'}
              </InlineAction>
            )}
            <Link href={`/customers/${selected.id}`} className="btn secondary sm">顧客詳細</Link>
          </div>
        </header>
        <div className="thread-body">
          {messages.length === 0 ? (
            <Empty title="まだメッセージはありません" icon={<MessageCircle size={20} />}>下の入力欄から最初のメッセージを送信できます。</Empty>
          ) : (
            <div className="chat">
              {messages.map((m) => {
                const out = m.direction === 'OUTBOUND';
                const origin = m.automationRuleId ? `自動：${ruleName.get(m.automationRuleId) ?? 'ルール'}` : m.broadcastId ? `一斉配信：${bcName.get(m.broadcastId) ?? ''}` : m.createdById ? staffName.get(m.createdById) ?? 'スタッフ' : out ? 'システム' : null;
                return (
                  <div key={m.id} className={`msg ${out ? 'out' : 'in'}`}>
                    <div className={`bubble ${out ? 'out' : 'in'} ${m.status === 'FAILED' ? 'failed' : ''} ${m.status === 'SKIPPED' ? 'skipped' : ''}`}>{m.body}</div>
                    <div className="bubble-meta">
                      {fmtDateTime(m.createdAt, tz)}
                      {' · '}<span>{CHANNEL_LABEL[m.channel]}</span>
                      {origin && <> · {origin}</>}
                      {out && <> · <Badge tone={STATUS_TONE[m.status]}>{STATUS_SHORT[m.status]}</Badge></>}
                      {out && m.error === 'sandbox' && <> · <span title="プロバイダ未設定のため送信をシミュレートしました">サンドボックス</span></>}
                    </div>
                    {m.status === 'FAILED' && (
                      <div className="bubble-error">
                        <span>{m.error ?? '送信に失敗しました'}</span>
                        <InlineAction action={retryMessageAction} fields={{ messageId: m.id }} className="btn danger-outline sm">再送</InlineAction>
                      </div>
                    )}
                    {m.status === 'SKIPPED' && m.error && <div className="bubble-meta">{m.error}</div>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <footer className="thread-foot">
          <Composer
            key={selected.id}
            customerId={selected.id}
            templates={templates.map((t) => ({ id: t.id, name: t.name, category: t.category, body: t.body }))}
            vars={vars}
            channels={{ line: lineOk, email: emailOk }}
            blockedReason={blockedReason}
          />
        </footer>
      </section>
    );
  } else if (sp.customerId) {
    thread = <div className="card thread"><Empty title="お客様が見つかりません">削除または統合された可能性があります。</Empty></div>;
  }

  return (
    <>
      <PageHeader title="メッセージ" sub={`LINE・メールでのお客様とのやり取り${totalUnread ? ` / 未読 ${totalUnread}件` : ''}`} actions={<NewThreadButton />} />
      <MessagesNav active="inbox" can={{ broadcast: ctx.can('message.broadcast'), automation: ctx.can('message.automation') }} />
      <div className={`inbox ${selected || sp.customerId ? 'has-thread' : ''}`}>
        <aside className="conv-list card flush" aria-label="会話一覧">
          <form className="conv-search" role="search">
            <div className="input-icon">
              <Search size={15} />
              <input className="input sm" name="q" defaultValue={q} placeholder="氏名・カナで検索" aria-label="会話を検索" />
            </div>
            <label className="checkbox" style={{ fontSize: 12 }}><input type="checkbox" name="unread" value="1" defaultChecked={unreadOnly} />未読のみ</label>
            <button className="btn secondary sm">検索</button>
          </form>
          {conversations.length === 0 ? (
            <Empty title={q || unreadOnly ? '該当する会話がありません' : 'メッセージはまだありません'}>
              {q || unreadOnly ? <Link href="/messages" className="link">条件をクリア</Link> : 'LINE連携済みのお客様からのメッセージがここに届きます。'}
            </Empty>
          ) : (
            <ul className="conv-items">
              {conversations.map((c) => {
                const name = `${c.lastName} ${c.firstName}`.trim();
                const active = c.customerId === selected?.id;
                const params = new URLSearchParams({ customerId: c.customerId, ...(q ? { q } : {}), ...(unreadOnly ? { unread: '1' } : {}) });
                return (
                  <li key={c.customerId}>
                    <Link href={`/messages?${params}`} className={`conv-item ${active ? 'active' : ''} ${c.unread ? 'unread' : ''}`} aria-current={active ? 'true' : undefined}>
                      <Avatar name={name} />
                      <span className="grow">
                        <span className="between">
                          <strong className="ellipsis">{name}</strong>
                          <span className="sub nowrap">{relTime(new Date(c.createdAt), tz)}</span>
                        </span>
                        <span className="between">
                          <span className="conv-preview ellipsis">{c.direction === 'OUTBOUND' ? 'あなた: ' : ''}{c.body}</span>
                          {c.unread > 0 && <span className="unread-count" aria-label={`未読${c.unread}件`}>{c.unread}</span>}
                        </span>
                        <span className="row-wrap" style={{ gap: 4, marginTop: 2 }}>
                          <Badge tone={CHANNEL_TONE[c.channel]}>{CHANNEL_LABEL[c.channel]}</Badge>
                          {c.channel === 'LINE' && !c.lineOptIn && <Badge tone="red">配信停止</Badge>}
                          {c.direction === 'OUTBOUND' && c.status === 'FAILED' && <Badge tone="red">送信失敗</Badge>}
                        </span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>
        {thread ?? (
          <div className="card thread hide-sm">
            <Empty title="会話を選択してください" icon={<MessageCircle size={20} />}>左の一覧からお客様を選ぶか、「新規メッセージ」から送信先を選択します。</Empty>
          </div>
        )}
      </div>
    </>
  );
}
