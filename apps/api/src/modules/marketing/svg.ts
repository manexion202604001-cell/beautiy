/**
 * SNS share material renderer (SNS共有用素材生成). Pure function → 1080x1080 SVG string.
 * Every piece of user-provided text is XML-escaped (and control characters removed) so captions,
 * hashtags, review bodies or names can never inject markup/script into the SVG.
 */
export type SnsTemplate = 'square_style' | 'before_after' | 'review_quote';

export interface SnsSvgInput {
  template: SnsTemplate;
  shopName: string;
  staffName?: string | null;
  caption?: string | null;
  hashtags?: string[];
  /** image hrefs (data: URIs produced by the server); [before, after] for before_after */
  photos?: { href: string; label?: string }[];
  review?: { rating: number; body: string | null; reviewerName: string | null } | null;
}

export const SNS_SIZE = 1080;

// XML 1.0 disallows most C0 controls; also drop lone surrogates and U+FFFE/U+FFFF
// eslint-disable-next-line no-control-regex
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function escapeXml(value: unknown): string {
  return String(value ?? '')
    .replace(INVALID_XML, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Approximate rendered width in em: full-width (CJK, kana, symbols) = 1, half-width ≈ 0.55 */
function charWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp < 0x2e80 || (cp >= 0xff61 && cp <= 0xff9f)) return 0.55;
  return 1;
}

/** Greedy wrap by visual width; truncates with … after maxLines */
export function wrapText(text: string, maxEm: number, maxLines: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
    let line = '';
    let width = 0;
    for (const ch of Array.from(paragraph)) {
      const w = charWidth(ch);
      if (width + w > maxEm && line) {
        lines.push(line);
        line = '';
        width = 0;
      }
      line += ch;
      width += w;
    }
    lines.push(line);
  }
  const trimmed = lines.filter((l, i) => l.length > 0 || (i > 0 && i < lines.length - 1));
  if (trimmed.length <= maxLines) return trimmed;
  const out = trimmed.slice(0, maxLines);
  const last = Array.from(out[maxLines - 1]!);
  out[maxLines - 1] = `${last.slice(0, Math.max(0, last.length - 1)).join('')}…`;
  return out;
}

const PALETTE: Record<SnsTemplate, { bg1: string; bg2: string; text: string; accent: string; panel: string }> = {
  square_style: { bg1: '#f8f4ef', bg2: '#efe6dc', text: '#3b302a', accent: '#b0896b', panel: '#ffffff' },
  before_after: { bg1: '#f3f4f6', bg2: '#e5e7eb', text: '#1f2937', accent: '#7c3aed', panel: '#ffffff' },
  review_quote: { bg1: '#fdf2f8', bg2: '#fce7f3', text: '#3f2a37', accent: '#db2777', panel: '#ffffff' },
};

const FONT = `'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Noto Sans JP', 'Yu Gothic', YuGothic, Meiryo, sans-serif`;

function textLines(lines: string[], x: number, y: number, size: number, opts: { anchor?: 'start' | 'middle' | 'end'; weight?: number; fill?: string; lineHeight?: number; cls?: string } = {}) {
  const lh = opts.lineHeight ?? Math.round(size * 1.45);
  return lines
    .map(
      (l, i) =>
        `<text x="${x}" y="${y + i * lh}" font-size="${size}"${opts.anchor ? ` text-anchor="${opts.anchor}"` : ''}${opts.weight ? ` font-weight="${opts.weight}"` : ''}${opts.fill ? ` fill="${opts.fill}"` : ''}${opts.cls ? ` class="${opts.cls}"` : ''}>${escapeXml(l)}</text>`,
    )
    .join('');
}

function photo(id: string, href: string, x: number, y: number, w: number, h: number) {
  return `<clipPath id="${id}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="24"/></clipPath><image href="${escapeXml(href)}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${id})"/>`;
}

function placeholder(x: number, y: number, w: number, h: number, label: string, color: string) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="24" fill="${color}" opacity="0.18"/>${textLines([label], x + w / 2, y + h / 2 + 18, 48, { anchor: 'middle', weight: 700, fill: color })}`;
}

function hashtagLine(tags: string[]): string {
  return tags.map((t) => `#${t}`).join(' ');
}

export function renderSnsSvg(input: SnsSvgInput): string {
  const S = SNS_SIZE;
  const c = PALETTE[input.template];
  const photos = input.photos ?? [];
  const tags = input.hashtags ?? [];
  const footer = [input.shopName, input.staffName ? `Stylist ${input.staffName}` : null].filter(Boolean).join('  |  ');
  const parts: string[] = [];

  parts.push(
    `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c.bg1}"/><stop offset="1" stop-color="${c.bg2}"/></linearGradient></defs>`,
    `<style>text{font-family:${FONT};}</style>`,
    `<rect width="${S}" height="${S}" fill="url(#bg)"/>`,
  );

  if (input.template === 'review_quote') {
    const r = input.review;
    const rating = Math.max(0, Math.min(5, Math.round(r?.rating ?? 0)));
    parts.push(`<rect x="60" y="60" width="${S - 120}" height="${S - 120}" rx="40" fill="${c.panel}"/>`);
    parts.push(textLines(['“'], 120, 230, 200, { fill: c.accent, weight: 700 }));
    parts.push(textLines(['★'.repeat(rating) + '☆'.repeat(5 - rating)], S / 2, 210, 64, { anchor: 'middle', fill: '#f59e0b' }));
    const body = wrapText(r?.body?.trim() || 'ご来店ありがとうございました。', 20, 8);
    parts.push(textLines(body, S / 2, 330, 40, { anchor: 'middle', fill: c.text, lineHeight: 60 }));
    parts.push(textLines([`— ${r?.reviewerName?.trim() || '匿名'} 様`], S - 140, 330 + body.length * 60 + 40, 32, { anchor: 'end', fill: c.text }));
    if (input.caption) parts.push(textLines(wrapText(input.caption, 26, 2), S / 2, 850, 30, { anchor: 'middle', fill: c.text, weight: 700 }));
    if (tags.length) parts.push(textLines(wrapText(hashtagLine(tags), 34, 1), S / 2, 935, 26, { anchor: 'middle', fill: c.accent }));
    parts.push(textLines([footer], S / 2, 995, 26, { anchor: 'middle', fill: c.text }));
  } else {
    const top = 60;
    const photoH = 640;
    if (input.template === 'before_after') {
      const w = (S - 150) / 2;
      const [before, after] = photos.length >= 2 ? photos : [undefined, photos[0]];
      parts.push(before ? photo('p0', before.href, 60, top, w, photoH) : placeholder(60, top, w, photoH, 'BEFORE', c.accent));
      parts.push(after ? photo('p1', after.href, 90 + w, top, w, photoH) : placeholder(90 + w, top, w, photoH, 'AFTER', c.accent));
      parts.push(`<rect x="80" y="${top + 20}" width="190" height="56" rx="28" fill="${c.text}" opacity="0.85"/>`);
      parts.push(textLines(['BEFORE'], 175, top + 59, 28, { anchor: 'middle', fill: '#ffffff', weight: 700 }));
      parts.push(`<rect x="${110 + w}" y="${top + 20}" width="170" height="56" rx="28" fill="${c.accent}" opacity="0.9"/>`);
      parts.push(textLines(['AFTER'], 195 + w, top + 59, 28, { anchor: 'middle', fill: '#ffffff', weight: 700 }));
    } else {
      const p = photos[0];
      parts.push(p ? photo('p0', p.href, 60, top, S - 120, photoH) : placeholder(60, top, S - 120, photoH, input.shopName || 'STYLE', c.accent));
    }
    parts.push(`<rect x="60" y="${top + photoH + 30}" width="${S - 120}" height="${S - top - photoH - 90}" rx="28" fill="${c.panel}"/>`);
    const caption = wrapText(input.caption?.trim() || '', 25, 2);
    parts.push(textLines(caption, 110, top + photoH + 100, 38, { fill: c.text, weight: 700, lineHeight: 52 }));
    if (tags.length) parts.push(textLines(wrapText(hashtagLine(tags), 38, 2), 110, top + photoH + 100 + caption.length * 52 + 10, 26, { fill: c.accent, lineHeight: 38 }));
    parts.push(textLines([footer], S - 100, S - 80, 26, { anchor: 'end', fill: c.text }));
  }

  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">${parts.join('')}</svg>\n`;
}
