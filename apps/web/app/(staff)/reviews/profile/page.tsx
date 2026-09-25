import Link from 'next/link';
import { prisma } from '@/lib/server/db';
import { requirePage } from '@/lib/server/session';
import { Card, PageHeader, Tabs } from '@/components/ui';
import { CopyButton } from '@/components/client';
import { env } from '@/lib/server/env';
import { instagramBookingLink, instagramProfileLink } from '@/lib/server/adapters/instagram';
import { buildBookingRichMenu } from '@/lib/server/line';
import { ShopProfileForm, StaffProfileForm } from './forms';

export const metadata = { title: 'プロフィール編集' };

function LinkRow({ label, url, hint }: { label: string; url: string; hint?: string }) {
  return (
    <div className="list-item" style={{ alignItems: 'flex-start' }}>
      <div className="grow">
        <div style={{ fontWeight: 700, fontSize: 13 }}>{label}</div>
        <a href={url} target="_blank" rel="noreferrer" className="link mono" style={{ wordBreak: 'break-all' }}>{url}</a>
        {hint && <div className="sub">{hint}</div>}
      </div>
      <CopyButton text={url} />
    </div>
  );
}

export default async function ProfileEditPage({ searchParams }: { searchParams: Promise<{ shop?: string; member?: string }> }) {
  const ctx = await requirePage('profile.edit');
  const sp = await searchParams;
  const canShop = ctx.can('settings.shop');
  const canOthers = ctx.can('settings.staff');
  const shopId = sp.shop && ctx.shops.some((s) => s.id === sp.shop) ? sp.shop : ctx.shop.id;
  const shop = await prisma.shop.findFirstOrThrow({ where: { id: shopId, organizationId: ctx.org.id } });
  const members = canOthers
    ? await prisma.membership.findMany({ where: { organizationId: ctx.org.id, active: true }, orderBy: [{ sortOrder: 'asc' }, { displayName: 'asc' }] })
    : [];
  const memberId = canOthers && sp.member && members.some((m) => m.id === sp.member) ? sp.member : ctx.membership.id;
  const member = await prisma.membership.findFirstOrThrow({ where: { id: memberId, organizationId: ctx.org.id } });
  const self = member.id === ctx.membership.id;
  const richMenu = buildBookingRichMenu({ shopName: shop.name, bookingUrl: `${env.appUrl}/book/${shop.slug}` });
  const qs = (patch: Record<string, string>) => `/reviews/profile?${new URLSearchParams({ shop: shopId, ...(memberId !== ctx.membership.id ? { member: memberId } : {}), ...patch })}`;

  return (
    <>
      <PageHeader title="口コミ・プロフィール" sub="お客様に表示される店舗・スタイリストの公開プロフィール" actions={<a href={`/s/${shop.slug}`} target="_blank" rel="noreferrer" className="btn secondary">公開ページを見る</a>} />
      <Tabs items={[{ key: 'list', href: '/reviews', label: '口コミ' }, { key: 'profile', href: '/reviews/profile', label: 'プロフィール編集' }]} active="profile" />
      <div className="split">
        <div className="stack">
          {canShop && (
            <Card title={`店舗プロフィール：${shop.name}`} actions={ctx.shops.length > 1 ? (
              <div className="seg">{ctx.shops.map((s) => <Link key={s.id} href={qs({ shop: s.id })} className={s.id === shopId ? 'active' : ''}>{s.name}</Link>)}</div>
            ) : undefined}>
              <p className="sub" style={{ marginTop: -6 }}>店名・住所・電話番号・営業時間・メニューは「設定」で編集できます。</p>
              <ShopProfileForm shop={{ id: shop.id, name: shop.name, description: shop.description, accessInfo: shop.accessInfo, hygieneInfo: shop.hygieneInfo, imageUrl: shop.imageUrl, instagramUrl: shop.instagramUrl, websiteUrl: shop.websiteUrl }} />
            </Card>
          )}
          <Card title={self ? 'あなたのスタイリストプロフィール' : `スタイリストプロフィール：${member.displayName}`} actions={
            <div className="row-wrap">
              {canOthers && members.length > 1 && (
                <form className="row">
                  <input type="hidden" name="shop" value={shopId} />
                  <select name="member" className="select sm" defaultValue={member.id} aria-label="スタッフを選択">
                    {members.map((m) => <option key={m.id} value={m.id}>{m.displayName}{m.id === ctx.membership.id ? '（自分）' : ''}</option>)}
                  </select>
                  <button className="btn secondary sm">切替</button>
                </form>
              )}
              <a href={`/s/${shop.slug}/staff/${member.id}`} target="_blank" rel="noreferrer" className="btn ghost sm">公開ページ</a>
            </div>
          }>
            {!member.bookable && <div className="alert warn" style={{ marginBottom: 12 }}>このスタッフは「ネット予約不可」に設定されているため、公開ページには表示されません（設定 &gt; スタッフ）。</div>}
            <StaffProfileForm member={{ id: member.id, displayName: member.displayName, publicBio: member.publicBio, specialties: member.specialties, imageUrl: member.imageUrl, instagramUrl: member.instagramUrl }} self={self} />
          </Card>
        </div>
        <div className="stack">
          <Card title="集客リンク">
            <div className="list">
              <LinkRow label="店舗の公開ページ" url={`${env.appUrl}/s/${shop.slug}`} />
              <LinkRow label="ネット予約ページ" url={`${env.appUrl}/book/${shop.slug}`} />
              <LinkRow label="Instagram プロフィールのリンク" url={instagramProfileLink(shop.slug)} hint="プロフィール欄（リンク）に設定。流入元がInstagramとして記録されます。" />
              <LinkRow label="Instagram 予約ボタン・ストーリーズ" url={instagramBookingLink(shop.slug, { placement: 'action_button' })} hint="「予約する」ボタンやリンクスタンプに設定" />
              <LinkRow label={`${member.displayName} 指名予約リンク`} url={instagramBookingLink(shop.slug, { staffUserId: member.userId })} hint="スタイリスト個人のInstagram向け" />
              <LinkRow label={`${member.displayName} の公開プロフィール`} url={instagramProfileLink(shop.slug, member.id)} />
            </div>
          </Card>
          <Card title="LINE リッチメニュー（予約ボタン）">
            <p className="sub">LINE公式アカウントのリッチメニューに「予約する」ボタンを設置するための定義です。ボタンを押したお客様には、LINEと自動で紐づくお客様専用の予約リンクが返信されます。</p>
            <pre className="code-block">{JSON.stringify(richMenu, null, 2)}</pre>
            <div className="row-wrap" style={{ marginTop: 8 }}>
              <CopyButton text={JSON.stringify(richMenu)} label="JSONをコピー" />
              <span className="sub">Messaging API の <code>POST /v2/bot/richmenu</code> で登録し、2500×843pxの画像をアップロードしてください。</span>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
