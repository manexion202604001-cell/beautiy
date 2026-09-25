import Link from 'next/link';
import { Phone } from 'lucide-react';

/** Shop header used on the customer booking / manage pages. */
export function PublicHeader({ name, slug, phone, imageUrl, sub }: { name: string; slug?: string; phone?: string | null; imageUrl?: string | null; sub?: string }) {
  const title = <h1>{name}</h1>;
  return (
    <header className="public-head">
      <div className="bk-shop">
        <span className="avatar lg" style={{ width: 44, height: 44, fontSize: 17 }}>{imageUrl ? <img src={imageUrl} alt="" /> : name.slice(0, 1)}</span>
        <div>
          {slug ? <Link href={`/book/${slug}`}>{title}</Link> : title}
          <div className="sub">{sub ?? 'ネット予約'}</div>
        </div>
      </div>
      {phone && <a className="btn secondary sm" href={`tel:${phone.replace(/[^\d+]/g, '')}`}><Phone size={14} />電話</a>}
    </header>
  );
}

export function PublicFooter() {
  return <p className="bk-foot">会員登録なしでご予約いただけます・Powered by MANEXION Salon OS</p>;
}
