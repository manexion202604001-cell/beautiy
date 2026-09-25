import Link from 'next/link';
import { Star } from 'lucide-react';
import type { Prisma } from '@salonos/db';
import { prisma } from '@/lib/server/db';
import { requirePage } from '@/lib/server/session';
import { reviewStats } from '@/lib/server/reviews';
import { Badge, Bar, Card, Empty, PageHeader, Stars, Stat, Tabs } from '@/components/ui';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { setReviewPublishedAction, syncGoogleReviewsAction } from './actions';
import { ReplyButton, ResultButton } from './ui';

export const metadata = { title: '口コミ' };

type SP = { shop?: string; staff?: string; rating?: string; status?: string; source?: string; page?: string };
const PAGE = 30;

export default async function ReviewsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const ctx = await requirePage('review.reply');
  const sp = await searchParams;
  const tz = ctx.shop.timezone;
  const shopIds = ctx.shops.map((s) => s.id);
  const shop = sp.shop && shopIds.includes(sp.shop) ? sp.shop : undefined;
  const rating = sp.rating && /^[1-5]$/.test(sp.rating) ? Number(sp.rating) : undefined;
  const status = ['unreplied', 'replied', 'hidden'].includes(sp.status ?? '') ? sp.status : undefined;
  const source = sp.source === 'INTERNAL' || sp.source === 'GOOGLE' ? sp.source : undefined;
  const page = Math.max(1, Math.min(500, Number(sp.page) || 1));

  const staffList = await prisma.membership.findMany({ where: { organizationId: ctx.org.id }, orderBy: [{ sortOrder: 'asc' }], select: { userId: true, displayName: true, active: true } });
  const staffName = new Map(staffList.map((s) => [s.userId, s.displayName]));
  const staff = sp.staff && staffName.has(sp.staff) ? sp.staff : undefined;

  const base: Prisma.ReviewWhereInput = { organizationId: ctx.org.id, shopId: shop ? shop : { in: shopIds }, ...(staff ? { staffId: staff } : {}), ...(source ? { source } : {}) };
  const where: Prisma.ReviewWhereInput = {
    ...base, ...(rating ? { rating } : {}),
    ...(status === 'unreplied' ? { reply: null } : status === 'replied' ? { reply: { not: null } } : status === 'hidden' ? { published: false } : {}),
  };
  const [stats, reviews, total, unreplied, hidden] = await Promise.all([
    reviewStats(base),
    prisma.review.findMany({ where, include: { shop: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * PAGE, take: PAGE }),
    prisma.review.count({ where }),
    prisma.review.count({ where: { ...base, reply: null } }),
    prisma.review.count({ where: { ...base, published: false } }),
  ]);
  const replierIds = [...new Set(reviews.map((r) => r.repliedById).filter(Boolean))] as string[];
  const repliers = replierIds.length ? await prisma.membership.findMany({ where: { organizationId: ctx.org.id, userId: { in: replierIds } }, select: { userId: true, displayName: true } }) : [];
  const replierName = new Map(repliers.map((r) => [r.userId, r.displayName]));
  const maxDist = Math.max(1, ...Object.values(stats.dist));
  const replyRate = stats.total ? Math.round(((stats.total - unreplied) / stats.total) * 100) : 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const qs = (patch: Partial<SP>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ shop, staff, rating: rating?.toString(), status, source, ...patch })) if (v) p.set(k, v);
    const s = p.toString();
    return `/reviews${s ? `?${s}` : ''}`;
  };
  const filtered = !!(shop || staff || rating || status || source);

  return (
    <>
      <PageHeader title="口コミ・プロフィール" sub="お客様の声への返信と公開ページの管理"
        actions={<>
          <ResultButton action={syncGoogleReviewsAction} fields={{ shopId: ctx.shop.id }} className="btn secondary">Google口コミを同期（{ctx.shop.name}）</ResultButton>
          <a href={`/s/${ctx.shop.slug}`} target="_blank" rel="noreferrer" className="btn secondary">公開ページを見る</a>
        </>} />
      <Tabs items={[{ key: 'list', href: '/reviews', label: '口コミ' }, { key: 'profile', href: '/reviews/profile', label: 'プロフィール編集' }]} active="list" />

      <div className="grid-2" style={{ marginBottom: 14 }}>
        <Card title="評価サマリー">
          {stats.total === 0 ? <Empty title="まだ口コミがありません" icon={<Star size={20} />}>来店後の口コミ依頼を自動配信で設定できます。</Empty> : (
            <div className="rating-summary">
              <div className="rating-big">
                <div className="value">{stats.average.toFixed(1)}</div>
                <Stars value={stats.average} />
                <div className="sub">{stats.total}件の口コミ</div>
              </div>
              <div className="stack-sm">
                {[5, 4, 3, 2, 1].map((n) => (
                  <Link key={n} href={qs({ rating: rating === n ? undefined : String(n), page: undefined })} className="dist-row" aria-label={`星${n}で絞り込み`}>
                    <span className={rating === n ? 'link' : ''}>★{n}</span><Bar value={stats.dist[n]} max={maxDist} /><span className="right sub">{stats.dist[n]}</span>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </Card>
        <div className="grid-2">
          <Stat label="未返信" value={unreplied} sub={unreplied ? <Link className="link" href={qs({ status: 'unreplied', page: undefined })}>未返信を表示</Link> : 'すべて返信済み'} tone={unreplied ? 'down' : 'up'} />
          <Stat label="返信率" value={`${replyRate}%`} />
          <Stat label="非公開" value={hidden} />
          <Stat label="低評価（★1–2）" value={stats.dist[1] + stats.dist[2]} />
        </div>
      </div>

      <form className="card pad-sm row-wrap" style={{ marginBottom: 12 }} role="search">
        <select name="shop" className="select sm" defaultValue={shop ?? ''} style={{ width: 'auto' }} aria-label="店舗">
          <option value="">全店舗</option>
          {ctx.shops.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select name="staff" className="select sm" defaultValue={staff ?? ''} style={{ width: 'auto' }} aria-label="スタッフ">
          <option value="">全スタッフ</option>
          {staffList.filter((s) => s.active).map((s) => <option key={s.userId} value={s.userId}>{s.displayName}</option>)}
        </select>
        <select name="rating" className="select sm" defaultValue={rating?.toString() ?? ''} style={{ width: 'auto' }} aria-label="評価">
          <option value="">全評価</option>
          {[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>★{n}</option>)}
        </select>
        <select name="status" className="select sm" defaultValue={status ?? ''} style={{ width: 'auto' }} aria-label="状態">
          <option value="">全状態</option>
          <option value="unreplied">未返信</option>
          <option value="replied">返信済み</option>
          <option value="hidden">非公開</option>
        </select>
        <select name="source" className="select sm" defaultValue={source ?? ''} style={{ width: 'auto' }} aria-label="投稿元">
          <option value="">全投稿元</option>
          <option value="INTERNAL">自社</option>
          <option value="GOOGLE">Google</option>
        </select>
        <button className="btn secondary sm">絞り込み</button>
        {filtered && <Link href="/reviews" className="btn ghost sm">クリア</Link>}
      </form>

      <Card flush>
        {reviews.length === 0 ? (
          <Empty title={filtered ? '条件に一致する口コミはありません' : '口コミはまだありません'} icon={<Star size={20} />}>
            {filtered ? <Link href="/reviews" className="link">条件をクリア</Link> : 'ご来店後にお客様へ届く口コミ依頼リンクから投稿されます。'}
          </Empty>
        ) : reviews.map((r) => (
          <article key={r.id} className={`review-item ${r.published ? '' : 'hidden-review'}`}>
            <div className="between" style={{ alignItems: 'flex-start' }}>
              <div style={{ minWidth: 0 }}>
                <div className="row-wrap" style={{ gap: 8 }}>
                  <Stars value={r.rating} />
                  {r.title && <strong>{r.title}</strong>}
                  <Badge tone={r.source === 'GOOGLE' ? 'violet' : 'blue'}>{r.source === 'GOOGLE' ? 'Google' : '自社'}</Badge>
                  {!r.published && <Badge tone="gray">非公開</Badge>}
                  {!r.reply && <Badge tone="amber">未返信</Badge>}
                </div>
                <div className="sub">
                  {r.authorName}様 · {fmtDate(r.createdAt, tz)} · {r.shop.name}{r.staffId && staffName.get(r.staffId) ? ` · 担当 ${staffName.get(r.staffId)}` : ''}
                  {r.customerId && <> · <Link className="link" href={`/customers/${r.customerId}`}>顧客情報</Link></>}
                </div>
              </div>
              <div className="toolbar">
                <ReplyButton reviewId={r.id} reply={r.reply} author={r.authorName} source={r.source} />
                <ResultButton action={setReviewPublishedAction} fields={{ reviewId: r.id, published: String(!r.published) }} className="btn ghost sm"
                  confirm={r.published ? 'この口コミを公開ページから非表示にしますか？' : undefined}>{r.published ? '非公開にする' : '公開する'}</ResultButton>
              </div>
            </div>
            {r.body && <p className="review-body">{r.body}</p>}
            {r.reply && (
              <div className="review-reply">
                <div className="sub" style={{ marginBottom: 2 }}>サロンからの返信{r.repliedAt ? ` · ${fmtDateTime(r.repliedAt, tz)}` : ''}{r.repliedById && replierName.get(r.repliedById) ? ` · ${replierName.get(r.repliedById)}` : ''}</div>
                {r.reply}
              </div>
            )}
          </article>
        ))}
      </Card>
      {pages > 1 && (
        <div className="between" style={{ marginTop: 12 }}>
          <span className="sub">{total}件中 {(page - 1) * PAGE + 1}–{Math.min(total, page * PAGE)}件</span>
          <div className="toolbar">
            {page > 1 && <Link className="btn secondary sm" href={qs({ page: String(page - 1) })}>前へ</Link>}
            {page < pages && <Link className="btn secondary sm" href={qs({ page: String(page + 1) })}>次へ</Link>}
          </div>
        </div>
      )}
    </>
  );
}
