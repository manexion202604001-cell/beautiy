import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { CalendarCheck, Clock, Globe, Instagram, MapPin, Phone, ShieldCheck, Sparkles, Star, Users } from 'lucide-react';
import { Avatar } from '@/components/ui';
import { yen } from '@/lib/format';
import { loadShopProfile, specialtiesOf } from './data';
import { HoursTable, RatingInline, ReviewList } from './parts';

type Params = Promise<{ shopSlug: string }>;
type SP = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { shopSlug } = await params;
  const data = await loadShopProfile(shopSlug);
  if (!data) return { title: '店舗が見つかりません' };
  const { shop, stats } = data;
  const description = (shop.description ?? `${shop.name}のメニュー・料金・スタッフ・口コミ。ネット予約は24時間受付。`).replace(/\s+/g, ' ').slice(0, 140);
  const title = `${shop.name}${stats.total ? `（★${stats.average.toFixed(1)}）` : ''}`;
  return {
    title, description,
    alternates: { canonical: `/s/${shop.slug}` },
    openGraph: { title, description, type: 'website', locale: 'ja_JP', siteName: shop.name },
    twitter: { card: 'summary_large_image', title, description },
  };
}

function bookHref(slug: string, src: string | null, staffUserId?: string) {
  const p = new URLSearchParams();
  if (staffUserId) p.set('staff', staffUserId);
  if (src && /^[a-z_]{1,20}$/.test(src)) p.set('src', src);
  const s = p.toString();
  return `/book/${slug}${s ? `?${s}` : ''}`;
}

export default async function ShopProfilePage({ params, searchParams }: { params: Params; searchParams: SP }) {
  const { shopSlug } = await params;
  const sp = await searchParams;
  const src = typeof sp.src === 'string' ? sp.src : null;
  const data = await loadShopProfile(shopSlug);
  if (!data) notFound();
  const { shop, staff, stats, reviews, holidays, staffName } = data;
  const tz = shop.timezone;
  const categories = new Map<string, typeof shop.menus>();
  for (const m of shop.menus) { const list = categories.get(m.category) ?? []; list.push(m); categories.set(m.category, list); }
  const staffQs = src ? `?src=${encodeURIComponent(src)}` : '';

  return (
    <main className="public-body" style={{ paddingTop: 16 }}>
      <section className="pp-hero">
        {shop.imageUrl && <img src={shop.imageUrl} alt={`${shop.name}の店内`} />}
        <div className="pp-hero-inner">
          <div className="sub">{shop.organization.name}</div>
          <h1>{shop.name}</h1>
          <div className="row-wrap" style={{ marginTop: 6, gap: 12 }}>
            <RatingInline average={stats.average} total={stats.total} />
            {shop.address && <span className="sub"><MapPin size={13} style={{ verticalAlign: -2 }} /> {shop.address}</span>}
          </div>
        </div>
      </section>

      <Link href={bookHref(shop.slug, src)} className="btn lg block"><CalendarCheck size={18} />ネット予約（24時間受付）</Link>

      {shop.description && (
        <section className="card pp-section"><h2 className="sr-only">サロン紹介</h2><p className="prewrap" style={{ margin: 0 }}>{shop.description}</p></section>
      )}

      <section className="card pp-section">
        <h2><Sparkles size={16} />メニュー・料金</h2>
        {shop.menus.length === 0 ? <p className="sub">メニューは準備中です。</p> : [...categories.entries()].map(([cat, menus]) => (
          <div key={cat}>
            <div className="pp-menu-cat">{cat}</div>
            {menus.map((m) => (
              <div key={m.id} className="pp-menu-row">
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700 }}>{m.name}</div>
                  {m.description && <div className="sub prewrap">{m.description}</div>}
                  <div className="sub"><Clock size={12} style={{ verticalAlign: -2 }} /> 約{m.durationMin}分</div>
                </div>
                <div className="nowrap" style={{ fontWeight: 800 }}>{m.price === 0 ? '無料' : yen(m.price)}</div>
              </div>
            ))}
          </div>
        ))}
        <p className="sub" style={{ marginTop: 8 }}>表示価格は税込です。</p>
      </section>

      {staff.length > 0 && (
        <section className="card pp-section">
          <h2><Users size={16} />スタイリスト</h2>
          <div className="pp-staff-cards">
            {staff.map((m) => (
              <Link key={m.id} href={`/s/${shop.slug}/staff/${m.id}${staffQs}`} className="pp-staff-card">
                <Avatar name={m.displayName} src={m.imageUrl} size="lg" />
                <strong>{m.displayName}</strong>
                {specialtiesOf(m.specialties).length > 0 && <span className="sub">{specialtiesOf(m.specialties).slice(0, 3).join('・')}</span>}
                {m.nominationFee > 0 && <span className="sub">指名料 {yen(m.nominationFee)}</span>}
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="card pp-section">
        <h2><Star size={16} />口コミ{stats.total > 0 && <span className="sub" style={{ fontWeight: 500 }}>平均 {stats.average.toFixed(1)} / {stats.total}件</span>}</h2>
        <ReviewList reviews={reviews} staffName={staffName} tz={tz} />
      </section>

      <section className="card pp-section">
        <h2><Clock size={16} />営業時間</h2>
        <HoursTable hours={shop.businessHours} tz={tz} />
        {holidays.length > 0 && <p className="sub" style={{ marginTop: 8 }}>臨時休業：{holidays.map((h) => h.date.slice(5).replace('-', '/')).join('、')}</p>}
      </section>

      {(shop.accessInfo || shop.address || shop.phone) && (
        <section className="card pp-section">
          <h2><MapPin size={16} />アクセス</h2>
          {shop.address && <p style={{ margin: '0 0 6px' }}>{shop.address}</p>}
          {shop.accessInfo && <p className="prewrap sub" style={{ margin: 0 }}>{shop.accessInfo}</p>}
          {shop.phone && <p style={{ marginTop: 8 }}><a className="link" href={`tel:${shop.phone.replace(/[^\d+]/g, '')}`}><Phone size={13} style={{ verticalAlign: -2 }} /> {shop.phone}</a></p>}
        </section>
      )}

      {shop.hygieneInfo && (
        <section className="card pp-section">
          <h2><ShieldCheck size={16} />衛生管理・サロン情報</h2>
          <p className="prewrap" style={{ margin: 0 }}>{shop.hygieneInfo}</p>
        </section>
      )}

      {(shop.instagramUrl || shop.websiteUrl) && (
        <section className="pp-section pp-social">
          {shop.instagramUrl && <a href={shop.instagramUrl} target="_blank" rel="noopener noreferrer" className="btn secondary"><Instagram size={16} />Instagram</a>}
          {shop.websiteUrl && <a href={shop.websiteUrl} target="_blank" rel="noopener noreferrer" className="btn secondary"><Globe size={16} />Webサイト</a>}
        </section>
      )}

      <div className="pp-cta">
        <Link href={bookHref(shop.slug, src)} className="btn lg block"><CalendarCheck size={18} />ネット予約</Link>
      </div>
      <p className="sub center" style={{ marginTop: 18 }}>会員登録なしでご予約いただけます</p>
    </main>
  );
}
