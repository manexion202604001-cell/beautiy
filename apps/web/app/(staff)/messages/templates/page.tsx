import { FileText } from 'lucide-react';
import { prisma } from '@/lib/server/db';
import { requirePage } from '@/lib/server/session';
import { Badge, Card, Empty, PageHeader } from '@/components/ui';
import { fmtDate } from '@/lib/format';
import { MessagesNav } from '../nav';
import { deleteTemplateAction } from '../actions';
import { TEMPLATE_CATEGORIES } from '../labels';
import { InlineAction } from '../ui';
import { TemplateButton } from './TemplateForm';

export const metadata = { title: 'メッセージテンプレート' };

const AUTO_USED = new Set(['BOOKING_CONFIRMED', 'BOOKING_REQUESTED', 'BOOKING_CHANGED', 'BOOKING_CANCELLED', 'REMINDER']);

export default async function TemplatesPage({ searchParams }: { searchParams: Promise<{ category?: string }> }) {
  const ctx = await requirePage('message.send');
  const sp = await searchParams;
  const canEdit = ctx.can('message.broadcast');
  const category = sp.category && sp.category in TEMPLATE_CATEGORIES ? sp.category : undefined;
  const [templates, counts] = await Promise.all([
    prisma.messageTemplate.findMany({ where: { organizationId: ctx.org.id, ...(category ? { category } : {}) }, orderBy: [{ category: 'asc' }, { createdAt: 'desc' }] }),
    prisma.messageTemplate.groupBy({ by: ['category'], where: { organizationId: ctx.org.id }, _count: { _all: true } }),
  ]);
  const countMap = new Map(counts.map((c) => [c.category, c._count._all]));
  const total = counts.reduce((s, c) => s + c._count._all, 0);
  // the newest template per auto-used category is the one used for booking notifications
  const inUse = new Set<string>();
  const seen = new Set<string>();
  for (const t of templates) if (AUTO_USED.has(t.category) && !seen.has(t.category)) { seen.add(t.category); inUse.add(t.id); }

  return (
    <>
      <PageHeader title="メッセージ" sub="テンプレートは受信箱・一斉配信・予約通知で使えます" actions={canEdit ? <TemplateButton label="＋ テンプレート作成" /> : undefined} />
      <MessagesNav active="templates" can={{ broadcast: ctx.can('message.broadcast'), automation: ctx.can('message.automation') }} />
      <div className="row-wrap" style={{ marginBottom: 14 }}>
        <a href="/messages/templates" className={`msg-chip ${!category ? 'active' : ''}`}>すべて <span className="sub">{total}</span></a>
        {Object.entries(TEMPLATE_CATEGORIES).map(([k, v]) => (
          <a key={k} href={`/messages/templates?category=${k}`} className={`msg-chip ${category === k ? 'active' : ''}`}>{v} <span className="sub">{countMap.get(k) ?? 0}</span></a>
        ))}
      </div>
      {templates.length === 0 ? (
        <Card><Empty title="テンプレートがありません" icon={<FileText size={20} />} action={canEdit ? <TemplateButton label="テンプレートを作成" /> : undefined}>
          よく使う文面を登録すると、受信箱からワンクリックで差し込めます。
        </Empty></Card>
      ) : (
        <div className="tpl-grid">
          {templates.map((t) => (
            <Card key={t.id} className="tpl-card" title={<div className="stack-sm" style={{ gap: 2 }}><h2>{t.name}</h2><div className="row-wrap" style={{ gap: 4 }}><Badge tone="blue">{TEMPLATE_CATEGORIES[t.category] ?? t.category}</Badge>{inUse.has(t.id) && <Badge tone="green">予約通知で使用中</Badge>}</div></div>}
              actions={canEdit ? <>
                <TemplateButton template={{ id: t.id, name: t.name, category: t.category, body: t.body }} label="編集" className="btn secondary sm" />
                <InlineAction action={deleteTemplateAction} fields={{ id: t.id }} confirm={`「${t.name}」を削除しますか？`} className="btn ghost sm" showSuccess={false}>削除</InlineAction>
              </> : undefined}>
              <div className="tpl-body">{t.body}</div>
              <div className="sub" style={{ marginTop: 8 }}>作成日 {fmtDate(t.createdAt, ctx.shop.timezone)}</div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
