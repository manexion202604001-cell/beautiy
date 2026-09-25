import Link from 'next/link';
import { Zap } from 'lucide-react';
import { prisma } from '@/lib/server/db';
import { requirePage } from '@/lib/server/session';
import { Badge, Card, Empty, PageHeader } from '@/components/ui';
import { fmtDateTime } from '@/lib/format';
import { MessagesNav } from '../nav';
import { deleteRuleAction, runAutomationsNowAction, toggleRuleAction } from '../actions';
import { CHANNEL_LABEL, STATUS_SHORT, STATUS_TONE, TRIGGER_HELP, TRIGGER_LABEL, TRIGGER_UNIT } from '../labels';
import { InlineAction } from '../ui';
import { RuleButton } from './RuleForm';

export const metadata = { title: '自動配信' };

export default async function AutomationsPage({ searchParams }: { searchParams: Promise<{ rule?: string }> }) {
  const ctx = await requirePage('message.automation');
  const sp = await searchParams;
  const tz = ctx.shop.timezone;
  const rules = await prisma.automationRule.findMany({ where: { organizationId: ctx.org.id }, orderBy: { createdAt: 'asc' } });
  const ruleIds = rules.map((r) => r.id);
  const filterRule = sp.rule && ruleIds.includes(sp.rule) ? sp.rule : undefined;
  const since = new Date(Date.now() - 30 * 86400000);
  const [dispatchCounts, dispatches] = await Promise.all([
    ruleIds.length ? prisma.automationDispatch.groupBy({ by: ['ruleId'], where: { ruleId: { in: ruleIds }, createdAt: { gte: since } }, _count: { _all: true } }) : [],
    ruleIds.length ? prisma.automationDispatch.findMany({ where: { ruleId: filterRule ? filterRule : { in: ruleIds } }, orderBy: { createdAt: 'desc' }, take: 100 }) : [],
  ]);
  const countMap = new Map(dispatchCounts.map((d) => [d.ruleId, d._count._all]));
  const msgIds = dispatches.map((d) => d.messageId).filter(Boolean) as string[];
  const custIds = [...new Set(dispatches.map((d) => d.customerId))];
  const [msgs, custs] = await Promise.all([
    msgIds.length ? prisma.message.findMany({ where: { id: { in: msgIds }, organizationId: ctx.org.id }, select: { id: true, status: true, error: true, channel: true } }) : [],
    custIds.length ? prisma.customer.findMany({ where: { id: { in: custIds }, organizationId: ctx.org.id }, select: { id: true, lastName: true, firstName: true } }) : [],
  ]);
  const msgMap = new Map(msgs.map((m) => [m.id, m]));
  const custMap = new Map(custs.map((c) => [c.id, `${c.lastName} ${c.firstName}`.trim()]));
  const ruleMap = new Map(rules.map((r) => [r.id, r]));
  const shops = ctx.shops.map((s) => ({ id: s.id, name: s.name }));
  const shopName = new Map(shops.map((s) => [s.id, s.name]));

  return (
    <>
      <PageHeader title="メッセージ" sub="リマインド・来店周期・口コミ依頼などを条件に合わせて自動送信"
        actions={<>
          {rules.some((r) => r.active) && <InlineAction action={runAutomationsNowAction} className="btn secondary" confirm="有効なルールを今すぐ実行しますか？（送信済みの対象には再送されません）">今すぐ実行</InlineAction>}
          <RuleButton label="＋ ルールを作成" shops={shops} />
        </>} />
      <MessagesNav active="automations" can={{ broadcast: ctx.can('message.broadcast'), automation: true }} />
      <div className="alert info" style={{ marginBottom: 14 }}>
        自動配信は定期実行ジョブ（<code>/api/cron</code>）で処理されます。同じお客様・同じ条件に二重送信されることはありません。配信停止中のお客様には送信されず「対象外」として記録されます。
      </div>
      {rules.length === 0 ? (
        <Card><Empty title="自動配信ルールがありません" icon={<Zap size={20} />} action={<RuleButton label="ルールを作成" shops={shops} />}>
          予約前日のリマインドや来店周期に合わせたフォローを自動化できます。
        </Empty></Card>
      ) : (
        <div className="rule-grid">
          {rules.map((r) => (
            <Card key={r.id} className={`rule-card ${r.active ? '' : 'inactive'}`}>
              <div className="between" style={{ alignItems: 'flex-start' }}>
                <div style={{ minWidth: 0 }}>
                  <div className="row-wrap" style={{ gap: 6 }}>
                    <h2>{r.name}</h2>
                    <Badge tone={r.active ? 'green' : 'gray'}>{r.active ? '有効' : '停止中'}</Badge>
                  </div>
                  <div className="sub">
                    {TRIGGER_LABEL[r.trigger]}{r.trigger !== 'BIRTHDAY' && `：${r.offsetValue}${TRIGGER_UNIT[r.trigger]}`} · {CHANNEL_LABEL[r.channel]} · {r.shopId ? shopName.get(r.shopId) ?? '他店舗' : '全店舗'}
                  </div>
                </div>
                <InlineAction action={toggleRuleAction} fields={{ id: r.id, active: String(!r.active) }} className={`msg-switch ${r.active ? 'on' : ''}`} showSuccess={false}>
                  <span className="sr-only">{r.active ? '停止する' : '有効にする'}</span>
                </InlineAction>
              </div>
              <p className="sub" style={{ margin: '8px 0' }}>{TRIGGER_HELP[r.trigger]}</p>
              <div className="tpl-body clamp">{r.body}</div>
              <div className="between" style={{ marginTop: 10 }}>
                <div className="sub">直近30日 {countMap.get(r.id) ?? 0}件 · 最終実行 {r.lastRunAt ? fmtDateTime(r.lastRunAt, tz) : '未実行'}</div>
                <div className="toolbar">
                  <Link href={`/messages/automations?rule=${r.id}#log`} className="btn ghost sm">ログ</Link>
                  {r.active && <InlineAction action={runAutomationsNowAction} fields={{ ruleId: r.id }} confirm={`「${r.name}」を今すぐ実行しますか？`} className="btn ghost sm">実行</InlineAction>}
                  <RuleButton rule={{ id: r.id, name: r.name, trigger: r.trigger, offsetValue: r.offsetValue, body: r.body, channel: r.channel, shopId: r.shopId, active: r.active }} shops={shops} label="編集" className="btn secondary sm" />
                  <InlineAction action={deleteRuleAction} fields={{ id: r.id }} confirm={`「${r.name}」を削除しますか？送信履歴（重複防止記録）も削除されます。`} className="btn ghost sm" showSuccess={false}>削除</InlineAction>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
      <div id="log" className="section">
        <Card title={filterRule ? `送信ログ：${ruleMap.get(filterRule)?.name}` : '送信ログ（直近100件）'} flush actions={filterRule ? <Link href="/messages/automations#log" className="btn ghost sm">すべて表示</Link> : undefined}>
          {dispatches.length === 0 ? <Empty title="まだ自動送信の記録はありません" /> : (
            <div className="table-wrap"><table className="table">
              <thead><tr><th>日時</th><th>ルール</th><th>お客様</th><th>結果</th></tr></thead>
              <tbody>
                {dispatches.map((d) => {
                  const m = d.messageId ? msgMap.get(d.messageId) : null;
                  return (
                    <tr key={d.id}>
                      <td className="nowrap sub">{fmtDateTime(d.createdAt, tz)}</td>
                      <td>{ruleMap.get(d.ruleId)?.name}</td>
                      <td><Link className="link" href={`/messages?customerId=${d.customerId}`}>{custMap.get(d.customerId) ?? '（削除済み）'}</Link></td>
                      <td>{m ? <><Badge tone={STATUS_TONE[m.status]}>{STATUS_SHORT[m.status]}</Badge>{m.error && m.error !== 'sandbox' && <span className="sub"> {m.error}</span>}</> : <span className="sub">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table></div>
          )}
        </Card>
      </div>
    </>
  );
}
