// Social share image (Open Graph / X card) for the public shop profile: shop name + rating.
import { ImageResponse } from 'next/og';
import { loadShopProfile } from './data';

export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'サロンのプロフィール';
export const revalidate = 3600;

/** Load a Noto Sans JP subset containing just the glyphs we render (Google Fonts CSS API). */
async function loadJaFont(text: string): Promise<ArrayBuffer | null> {
  try {
    const css = await fetch(`https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@700&text=${encodeURIComponent(text)}`, {
      signal: AbortSignal.timeout(3000),
    }).then((r) => (r.ok ? r.text() : ''));
    const url = /src:\s*url\(([^)]+)\)\s*format\('(?:opentype|truetype|woff)'\)/.exec(css)?.[1];
    if (!url) return null;
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return res.ok ? await res.arrayBuffer() : null;
  } catch { return null; }
}

export default async function Image({ params }: { params: Promise<{ shopSlug: string }> | { shopSlug: string } }) {
  const { shopSlug } = await Promise.resolve(params);
  const data = await loadShopProfile(shopSlug);
  const name = data?.shop.name ?? 'Salon';
  const org = data?.shop.organization.name ?? '';
  const stats = data?.stats ?? { average: 0, total: 0 };
  const stars = '★'.repeat(Math.round(stats.average)) + '☆'.repeat(5 - Math.round(stats.average));
  const ratingText = stats.total ? `${stats.average.toFixed(1)}（口コミ${stats.total}件）` : '口コミ募集中';
  const cta = 'ネット予約 24時間受付';
  const font = await loadJaFont(`${name}${org}${ratingText}${cta}★☆`);
  const hasJa = !!font;

  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: 72, background: 'linear-gradient(135deg, #2a45c8 0%, #0b1428 70%)', color: '#fff', fontFamily: hasJa ? 'NotoSansJP' : 'sans-serif' }}>
        <div style={{ display: 'flex', fontSize: 30, color: '#c9d3ea' }}>{hasJa ? org : shopSlug}</div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', fontSize: name.length > 14 ? 64 : 84, fontWeight: 700, lineHeight: 1.15 }}>{hasJa ? name : shopSlug}</div>
          <div style={{ display: 'flex', alignItems: 'center', marginTop: 28, fontSize: 40 }}>
            <span style={{ color: '#f7b733', letterSpacing: 4 }}>{hasJa ? stars : ''}</span>
            <span style={{ marginLeft: 20 }}>{hasJa ? ratingText : stats.total ? `${stats.average.toFixed(1)} / 5 (${stats.total})` : ''}</span>
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', background: '#fff', color: '#2a45c8', borderRadius: 999, padding: '14px 34px', fontSize: 32, fontWeight: 700 }}>{hasJa ? cta : 'Book online'}</div>
          <div style={{ display: 'flex', fontSize: 24, color: '#8fa0cc', letterSpacing: 4 }}>MANEXION</div>
        </div>
      </div>
    ),
    { ...size, ...(font ? { fonts: [{ name: 'NotoSansJP', data: font, weight: 700 as const, style: 'normal' as const }] } : {}) },
  );
}
