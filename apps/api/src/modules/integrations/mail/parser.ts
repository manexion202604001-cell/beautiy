/**
 * Booking-notification email parser (Hot Pepper Beauty / SALON BOARD, LiME, ...).
 *
 * Neither SALON BOARD nor LiME offers a public API (要件 0.2: no dependency on private APIs), but both
 * e-mail the salon on every new booking / change / cancellation. Those mails are the salon's own data,
 * so forwarding them to Salon OS is a legitimate, near-real-time inbound channel.
 *
 * Parsing is label-based ("予約番号：…", "【来店日時】…", "■メニュー" + next line) after NFKC
 * normalization, so small template changes don't break it; every label list is overridable per
 * integration account (config.mail.labels) and can be verified with the parse-test endpoint.
 */
export const MAIL_FIELDS = [
  'reservationNo',
  'datetime',
  'date',
  'time',
  'end',
  'duration',
  'name',
  'kana',
  'phone',
  'email',
  'staff',
  'menu',
  'amount',
  'note',
] as const;
export type MailField = (typeof MAIL_FIELDS)[number];
export type LabelSet = Record<MailField, string[]>;

const COMMON_LABELS: LabelSet = {
  reservationNo: ['予約番号', '予約No', '予約NO', '予約ID', '受付番号', '予約コード'],
  datetime: ['来店日時', 'ご来店日時', '予約日時', 'ご予約日時', '来店予定日時', '日時'],
  date: ['来店日', 'ご来店日', '予約日'],
  time: ['来店時間', '来店時刻', '開始時間', '開始時刻', '予約時間'],
  end: ['終了予定時刻', '終了予定', '終了時刻', '終了時間'],
  duration: ['所要時間', '施術時間', '目安時間'],
  name: ['お客様名', '予約者名', '予約者', 'お名前', '氏名', '顧客名', 'お客様'],
  kana: ['フリガナ', 'お客様名(カナ)', '氏名(カナ)', 'カナ', 'ふりがな'],
  phone: ['電話番号', '携帯電話番号', '連絡先電話番号', '連絡先', 'TEL', 'Tel', '電話'],
  email: ['メールアドレス', 'E-mail', 'Email', 'メール'],
  staff: [
    '指名スタッフ',
    '担当スタッフ',
    'スタッフ指名',
    'スタイリスト',
    'スタッフ',
    '担当者',
    '担当',
    '指名',
  ],
  menu: ['予約メニュー', 'ご予約メニュー', '施術メニュー', '利用クーポン', 'クーポン', 'メニュー'],
  amount: ['お支払い予定金額', '合計金額', '予定金額', '料金合計', '合計', '金額', '料金'],
  note: ['ご要望・ご相談', 'ご要望', '要望', 'お客様からの要望', '備考', 'メッセージ', 'ご質問'],
};

/** Provider defaults (initial values — confirm with a real notification via the parse test) */
export const PROVIDER_PROFILES: Record<
  string,
  { label: string; labels: LabelSet; senderHints: string[] }
> = {
  hotpepper_mail: {
    label: 'ホットペッパービューティー（SALON BOARD 予約通知メール）',
    labels: COMMON_LABELS,
    senderHints: ['salonboard', 'hotpepper', 'beauty.hotpepper', 'recruit'],
  },
  lime_mail: {
    label: 'LiME（予約通知メール）',
    labels: COMMON_LABELS,
    senderHints: ['lime', 'limehair'],
  },
};

export interface ParsedMail {
  kind: 'booked' | 'changed' | 'cancelled' | 'unknown';
  fields: Partial<Record<MailField, string>>;
  reservationNo: string | null;
  start: Date | null;
  end: Date | null;
  durationMin: number | null;
  customer: {
    name: string | null;
    kana: string | null;
    phone: string | null;
    email: string | null;
  };
  /** null = 指名なし / フリー */
  staffName: string | null;
  menuNames: string[];
  amount: number | null;
  note: string | null;
  warnings: string[];
}

const NO_STAFF = /^(指名なし|指定なし|フリー|おまかせ|お任せ|なし|指名無し|-+|ー+)$/;

export function normalizeMailText(input: string): string {
  return input
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u00a0\u3000]/g, ' ')
    .replace(/[ \t]+$/gm, '');
}

export function htmlToText(html: string): string {
  return html
    .replace(/<\s*(br|\/p|\/div|\/tr|\/li|\/h\d)\s*\/?>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const BULLET = '[\\s【\\[(<《「■□●○◆◇▼▽・*★☆#>-]*';
const CLOSE = '[\\s】\\])>》」]*';

/** Extract "label → value" pairs; a label alone on its line takes the following line(s) */
export function extractFields(text: string, labels: LabelSet): Partial<Record<MailField, string>> {
  const lines = normalizeMailText(text).split('\n');
  // longest labels first so "お客様名(カナ)" wins over "お客様名"
  const all = MAIL_FIELDS.flatMap((field) => labels[field].map((label) => ({ field, label }))).sort(
    (a, b) => b.label.length - a.label.length,
  );
  const matchers = all.map(({ field, label }) => ({
    field,
    re: new RegExp(`^${BULLET}${escapeRe(label.normalize('NFKC'))}${CLOSE}(?:[:=]|\\s|$)\\s*(.*)$`),
  }));
  const out: Partial<Record<MailField, string>> = {};
  const isLabelLine = (line: string) => matchers.some((m) => m.re.test(line));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const m of matchers) {
      const hit = m.re.exec(line);
      if (!hit) continue;
      if (out[m.field] !== undefined) break;
      let value = hit[1]!.trim();
      if (!value || m.field === 'menu') {
        // value on following lines (menus may span several lines)
        const extra: string[] = [];
        for (let j = i + 1; j < lines.length; j++) {
          const next = lines[j]!.trim();
          if (!next) {
            if (extra.length || value) break;
            continue;
          }
          if (isLabelLine(lines[j]!) || /^[-=_─━]{3,}$/.test(next)) break;
          extra.push(next.replace(/^[・*■□●○-]\s*/, ''));
          if (m.field !== 'menu' && m.field !== 'note') break;
        }
        value = [value, ...extra].filter(Boolean).join('\n');
      }
      if (value) out[m.field] = value;
      break;
    }
  }
  return out;
}

export function detectKind(subject: string, text: string): ParsedMail['kind'] {
  const s = normalizeMailText(subject);
  const head = normalizeMailText(text).slice(0, 400);
  if (
    /キャンセル|取消|取り消し/.test(s) ||
    /(予約|ご予約)が?キャンセル|キャンセルされました|キャンセルのお知らせ/.test(head)
  )
    return 'cancelled';
  if (/変更/.test(s) || /(予約|ご予約)(内容)?が?変更|変更されました|変更のお知らせ/.test(head))
    return 'changed';
  if (
    /予約|ご予約|受付|確定|新規/.test(s) ||
    /(予約|ご予約)(が入りました|を受け付けました|が確定|受付)/.test(head)
  )
    return 'booked';
  return 'unknown';
}

/** Wall-clock date/time in Asia/Tokyo (JST has no DST: fixed +09:00) → Date */
function jst(y: number, mo: number, d: number, h: number, mi: number): Date {
  return new Date(
    `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:00+09:00`,
  );
}

function parseDate(value: string, receivedAt: Date): { y: number; mo: number; d: number } | null {
  const full = /(\d{4})\s*[年/.-]\s*(\d{1,2})\s*[月/.-]\s*(\d{1,2})/.exec(value);
  if (full) return { y: Number(full[1]), mo: Number(full[2]), d: Number(full[3]) };
  const md = /(\d{1,2})\s*[月/]\s*(\d{1,2})\s*日?/.exec(value);
  if (!md) return null;
  const mo = Number(md[1]);
  const d = Number(md[2]);
  // no year: pick the year that puts the date closest to when the mail was received
  const ry = Number(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric' }).format(
      receivedAt,
    ),
  );
  const candidates = [ry - 1, ry, ry + 1].map((y) => ({
    y,
    diff: Math.abs(jst(y, mo, d, 12, 0).getTime() - receivedAt.getTime()),
  }));
  candidates.sort((a, b) => a.diff - b.diff);
  return { y: candidates[0]!.y, mo, d };
}

function parseTimes(value: string): { h: number; mi: number }[] {
  const out: { h: number; mi: number }[] = [];
  const re = /(午前|午後|AM|PM)?\s*(\d{1,2})\s*(?::|時)\s*(\d{2})?\s*分?/gi;
  for (let m = re.exec(value); m; m = re.exec(value)) {
    let h = Number(m[2]);
    const mi = Number(m[3] ?? 0);
    const ampm = (m[1] ?? '').toUpperCase();
    if ((ampm === '午後' || ampm === 'PM') && h < 12) h += 12;
    if ((ampm === '午前' || ampm === 'AM') && h === 12) h = 0;
    if (h <= 30 && mi < 60) out.push({ h, mi });
  }
  return out;
}

export function parseDurationMin(value: string | undefined): number | null {
  if (!value) return null;
  const h = /(\d+(?:\.\d+)?)\s*時間/.exec(value);
  const m = /(\d+)\s*分/.exec(value);
  if (!h && !m) {
    const bare = /^(\d{2,3})$/.exec(value.trim());
    return bare ? Number(bare[1]) : null;
  }
  return Math.round((h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0)) || null;
}

function parseAmount(value: string | undefined): number | null {
  if (!value) return null;
  const m = /([\d,]+)\s*円?/.exec(value.replace(/[¥￥]/g, ''));
  return m ? Number(m[1]!.replace(/,/g, '')) : null;
}

function cleanMenuLine(line: string): string {
  return line
    .replace(/[(（]?[\d,]+\s*円[)）]?/g, '')
    .replace(/[(（]?(所要)?(時間)?[:：]?\s*\d+\s*分[)）]?/g, '')
    .replace(/[¥￥][\d,]+/g, '')
    .replace(/^[【[].*?[】\]]\s*/, (m) => (/(クーポン|新規|再来|全員)/.test(m) ? '' : m))
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function parseBookingMail(
  input: { subject: string; text?: string | null; html?: string | null; receivedAt: Date },
  labels: LabelSet = COMMON_LABELS,
): ParsedMail {
  const text = input.text?.trim() ? input.text : input.html ? htmlToText(input.html) : '';
  const fields = extractFields(text, labels);
  const warnings: string[] = [];
  const kind = detectKind(input.subject, text);

  let start: Date | null = null;
  let end: Date | null = null;
  const dtSource = fields.datetime ?? [fields.date, fields.time].filter(Boolean).join(' ');
  const date = dtSource ? parseDate(dtSource, input.receivedAt) : null;
  const times = dtSource
    ? parseTimes(
        dtSource.replace(
          /(\d{4})\s*[年/.-]\s*\d{1,2}\s*[月/.-]\s*\d{1,2}日?|\d{1,2}\s*月\s*\d{1,2}\s*日/g,
          ' ',
        ),
      )
    : [];
  if (date && times[0]) {
    start = jst(date.y, date.mo, date.d, times[0].h, times[0].mi);
    if (times[1]) end = jst(date.y, date.mo, date.d, times[1].h, times[1].mi);
  } else if (kind !== 'cancelled') {
    warnings.push('来店日時を読み取れませんでした');
  }
  if (start && !end && fields.end) {
    const t = parseTimes(fields.end)[0];
    if (t && date) end = jst(date.y, date.mo, date.d, t.h, t.mi);
  }
  const durationMin =
    parseDurationMin(fields.duration) ??
    (start && end ? Math.round((end.getTime() - start.getTime()) / 60000) : null);
  if (start && !end && durationMin) end = new Date(start.getTime() + durationMin * 60000);

  const staffRaw =
    fields.staff
      ?.split('\n')[0]
      ?.replace(/\s*(さん|様)$/, '')
      .replace(/[(（].*?[)）]/g, '')
      .trim() ?? null;
  const staffName = staffRaw && !NO_STAFF.test(staffRaw) ? staffRaw : null;
  const menuNames = (fields.menu ?? '')
    .split('\n')
    .map(cleanMenuLine)
    .flatMap((line) => line.split(/、|(?<!\d),(?!\d)|\s[+＋]\s|\s\/\s/))
    .map((m) => m.trim())
    .filter((m) => m && !/^(合計|小計|計)/.test(m));
  if (!menuNames.length && kind !== 'cancelled') warnings.push('メニューを読み取れませんでした');

  const reservationNo = fields.reservationNo?.match(/[A-Za-z0-9-]{4,}/)?.[0] ?? null;
  if (!reservationNo) warnings.push('予約番号を読み取れませんでした（本文から識別子を生成します）');

  return {
    kind,
    fields,
    reservationNo,
    start,
    end,
    durationMin,
    customer: {
      name:
        fields.name
          ?.split('\n')[0]
          ?.replace(/\s*(様|さま)$/, '')
          .trim() || null,
      kana:
        fields.kana
          ?.split('\n')[0]
          ?.replace(/\s*(様|さま)$/, '')
          .trim() || null,
      phone: fields.phone?.match(/[+\d][\d-]{8,}/)?.[0] ?? null,
      email: fields.email?.match(/[^\s@]+@[^\s@]+\.[^\s@]+/)?.[0] ?? null,
    },
    staffName,
    menuNames,
    amount: parseAmount(fields.amount),
    note: fields.note?.trim() || null,
    warnings,
  };
}

export function mergeLabels(
  base: LabelSet,
  overrides?: Partial<Record<MailField, string[]>>,
): LabelSet {
  if (!overrides) return base;
  const out = { ...base };
  for (const f of MAIL_FIELDS) if (overrides[f]?.length) out[f] = [...overrides[f]!, ...base[f]];
  return out;
}
