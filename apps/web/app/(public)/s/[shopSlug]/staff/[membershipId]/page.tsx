import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { CalendarCheck, Instagram, Star } from 'lucide-react';
import { Avatar } from '@/components/ui';
import { yen } from '@/lib/format';
import { loadStaffProfile, specialtiesOf } from '../../data';
import { RatingInline, ReviewList } from '../../parts';

type Params = Promise<{ shopSlug: string; membershipId: string }>;
type SP = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { shopSlug, membershipId } = await params;
  const d = await loadStaffProfile(shopSlug, membershipId);
  if (!d) return { title: 'スタイリストが見つかりません' };
  const title = `${d.member.displayName}｜${d.shop.name}`;
  const description = (d.member.publicBio ?? `${d.shop.name}のスタイリスト ${d.member.displayName} のプロフィール・口コミ。指名でネット予約できます。`).replace(/\s+/g, ' ').slice(0, 140);
  return {
    title, description, alternates: { canonical: `/s/${d.shop.slug}/staff/${d.member.id}` },
    openGraph: { title, description, type: 'profile', locale: 'ja_JP', ...(d.member.imageUrl ? { images: [d.member.imageUrl] } : {}) },
    twitter: { card: 'summary', title, description },
  };
}

export default async function StaffProfilePage({ params, searchParams }: { params: Params; searchParams: SP }) {
  const { shopSlug, membershipId } = await params;
  const sp = await searchParams;
  const d = await loadStaffProfile(shopSlug, membershipId);
  if (!d) notFound();
  const { shop, member, memberStats, memberReviews } = d;
  const src = typeof sp.src === 'string' && /^[a-z_]{1,20}$/.test(sp.src) ? sp.src : null;
  const book = `/book/${shop.slug}?${new URLSearchParams({ staff: member.userId, ...(src ? { src } : {}) })}`;
  const tags = specialtiesOf(member.specialties);

  return (
    <main className="public-body" style={{ paddingTop: 16 }}>
      <Link href={`/s/${shop.slug}${src ? `?src=${src}` : ''}`} className="sub link">← {shop.name}</Link>
      <section className="card pp-section center">
        <div style={{ display: 'grid', placeItems: 'center', gap: 8 }}>
          <span className="avatar" style={{ width: 112, height: 112, fontSize: 38 }}>{member.imageUrl ? <img src={member.imageUrl} alt={member.displayName} /> : member.displayName.slice(0, 1)}</span>
          <h1>{member.displayName}</h1>
          <div className="sub">{shop.name}</div>
          <RatingInline average={memberStats.average} total={memberStats.total} />
          {member.nominationFee > 0 && <div className="sub">指名料 {yen(member.nominationFee)}</div>}
          {tags.length > 0 && <div className="row-wrap" style={{ justifyContent: 'center' }}>{tags.map((t) => <span key={t} className="badge blue">{t}</span>)}</div>}
          {member.instagramUrl && <a href={member.instagramUrl} target="_blank" rel="noopener noreferrer" className="btn secondary sm"><Instagram size={14} />Instagram</a>}
        </div>
      </section>

      <Link href={book} className="btn lg block" style={{ marginTop: 14 }}><CalendarCheck size={18} />{member.displayName}を指名して予約</Link>

      {member.publicBio && (
        <section className="card pp-section"><h2>プロフィール</h2><p className="prewrap" style={{ margin: 0 }}>{member.publicBio}</p></section>
      )}

      <section className="card pp-section">
        <h2><Star size={16} />{member.displayName}の口コミ</h2>
        <ReviewList reviews={memberReviews} tz={shop.timezone} />
      </section>

      {d.staff.length > 1 && (
        <section className="card pp-section">
          <h2>ほかのスタイリスト</h2>
          <div className="pp-staff-cards">
            {d.staff.filter((m) => m.id !== member.id).map((m) => (
              <Link key={m.id} href={`/s/${shop.slug}/staff/${m.id}${src ? `?src=${src}` : ''}`} className="pp-staff-card">
                <Avatar name={m.displayName} src={m.imageUrl} size="lg" />
                <strong>{m.displayName}</strong>
              </Link>
            ))}
          </div>
        </section>
      )}

      <div className="pp-cta"><Link href={book} className="btn lg block"><CalendarCheck size={18} />ネット予約</Link></div>
    </main>
  );
}
