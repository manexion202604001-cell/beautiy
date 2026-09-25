// Customer identity normalization and duplicate detection.

export function toHalfWidth(s: string): string {
  return s.replace(/[０-９Ａ-Ｚａ-ｚ＋－＠．]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/　/g, ' ');
}

/** JP phone → digits only, +81 → 0. Returns null when too short to be a phone number. */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = toHalfWidth(raw).replace(/[^\d+]/g, '');
  if (s.startsWith('+81')) s = '0' + s.slice(3);
  else if (s.startsWith('81') && s.length >= 11) s = '0' + s.slice(2);
  s = s.replace(/\D/g, '');
  return s.length >= 10 && s.length <= 11 ? s : null;
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = toHalfWidth(raw).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
}

/** Hiragana → Katakana, full-width, spaces removed. */
export function normalizeKana(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw.normalize('NFKC').replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60)).replace(/\s/g, '');
}

export function normalizeName(raw: string | null | undefined): string {
  return (raw ?? '').normalize('NFKC').replace(/\s/g, '').toLowerCase();
}

export function maskPhone(p: string | null): string {
  if (!p) return '';
  return p.length <= 4 ? '****' : `${'*'.repeat(p.length - 4)}${p.slice(-4)}`;
}

export function maskEmail(e: string | null): string {
  if (!e) return '';
  const [u, d] = e.split('@');
  return `${u.slice(0, 1)}***@${d ?? ''}`;
}

export interface IdentityRecord {
  id: string;
  phoneHash?: string | null;
  emailHash?: string | null;
  lastName: string;
  firstName: string;
  lastNameKana?: string | null;
  firstNameKana?: string | null;
  birthday?: string | null;
}

export interface DuplicateMatch { score: number; reasons: string[] }

export function duplicateScore(a: IdentityRecord, b: IdentityRecord): DuplicateMatch {
  const reasons: string[] = [];
  let score = 0;
  if (a.phoneHash && a.phoneHash === b.phoneHash) { score = Math.max(score, 95); reasons.push('電話番号一致'); }
  if (a.emailHash && a.emailHash === b.emailHash) { score = Math.max(score, 90); reasons.push('メール一致'); }
  const kanaA = normalizeKana(`${a.lastNameKana ?? ''}${a.firstNameKana ?? ''}`);
  const kanaB = normalizeKana(`${b.lastNameKana ?? ''}${b.firstNameKana ?? ''}`);
  const nameEq = normalizeName(a.lastName + a.firstName) === normalizeName(b.lastName + b.firstName);
  const kanaEq = !!kanaA && kanaA === kanaB;
  if ((nameEq || kanaEq) && a.birthday && a.birthday === b.birthday) { score = Math.max(score, 85); reasons.push('氏名＋生年月日一致'); }
  else if (nameEq) { score = Math.max(score, 60); reasons.push('氏名一致'); }
  else if (kanaEq) { score = Math.max(score, 55); reasons.push('フリガナ一致'); }
  return { score, reasons };
}

export interface DuplicatePair { a: string; b: string; score: number; reasons: string[] }

/** O(n) bucketing by strong keys, then pairwise scoring inside buckets. */
export function findDuplicates(records: IdentityRecord[], minScore = 55): DuplicatePair[] {
  const buckets = new Map<string, IdentityRecord[]>();
  const add = (k: string | null | undefined, r: IdentityRecord) => {
    if (!k) return;
    const list = buckets.get(k) ?? [];
    list.push(r);
    buckets.set(k, list);
  };
  for (const r of records) {
    add(r.phoneHash && `p:${r.phoneHash}`, r);
    add(r.emailHash && `e:${r.emailHash}`, r);
    add(`n:${normalizeName(r.lastName + r.firstName)}`, r);
    const kana = normalizeKana(`${r.lastNameKana ?? ''}${r.firstNameKana ?? ''}`);
    add(kana && `k:${kana}`, r);
  }
  const seen = new Map<string, DuplicatePair>();
  for (const list of buckets.values()) {
    if (list.length < 2 || list.length > 50) continue;
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const [x, y] = list[i].id < list[j].id ? [list[i], list[j]] : [list[j], list[i]];
      const key = `${x.id}|${y.id}`;
      if (seen.has(key)) continue;
      const m = duplicateScore(x, y);
      if (m.score >= minScore) seen.set(key, { a: x.id, b: y.id, ...m });
    }
  }
  return [...seen.values()].sort((p, q) => q.score - p.score);
}
