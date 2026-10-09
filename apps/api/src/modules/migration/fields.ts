/**
 * Data migration: field catalogue per import kind (with the column headings other salon systems
 * use), automatic column mapping and value normalisers (dates incl. 和暦 / Excel serials, times,
 * amounts, gender, yes/no). Pure functions — unit tested in fields.test.ts.
 */

export type ImportKind = 'customers' | 'visits' | 'reservations';

export interface FieldDef {
  key: string;
  label: string;
  /** headings seen in other systems' exports (compared after normalisation) */
  synonyms: string[];
  /** several columns may feed this field; values are joined (e.g. 都道府県 + 市区町村 + 番地) */
  multi?: boolean;
  hint?: string;
}

const CUSTOMER_ID: FieldDef = {
  key: 'customerNumber',
  label: '顧客番号（旧システム）',
  synonyms: ['顧客番号', '顧客ID', '顧客コード', '顧客No', '会員番号', '会員ID', '会員No', 'カルテ番号', 'カルテNo', 'お客様番号', 'お客様ID', 'customer_id', 'customerid', 'customer_no'],
  hint: '再取り込み時の重複防止と、来店履歴・予約との紐付けに使います',
};
const NAME_FIELDS: FieldDef[] = [
  { key: 'fullName', label: '氏名（姓名まとめて）', synonyms: ['氏名', '名前', 'お名前', 'お客様名', '顧客名', '顧客氏名', '会員名', 'name', 'フルネーム'], hint: '空白で姓と名に分けます' },
  { key: 'lastName', label: '姓', synonyms: ['姓', '苗字', '名字', 'last_name', 'lastname'] },
  { key: 'firstName', label: '名', synonyms: ['名', '下の名前', 'first_name', 'firstname'] },
  { key: 'fullKana', label: 'フリガナ（まとめて）', synonyms: ['フリガナ', 'ふりがな', 'カナ', 'かな', 'カナ氏名', '氏名カナ', '氏名（カナ）', '氏名(カナ)', 'お名前カナ', 'よみ', 'ヨミ', 'kana'] },
  { key: 'lastNameKana', label: 'セイ', synonyms: ['セイ', 'せい', '姓カナ', '姓（カナ）', '姓(カナ)', 'last_name_kana'] },
  { key: 'firstNameKana', label: 'メイ', synonyms: ['メイ', 'めい', '名カナ', '名（カナ）', '名(カナ)', 'first_name_kana'] },
];
const PHONE: FieldDef = { key: 'phone', label: '電話番号', synonyms: ['電話番号', '電話', '携帯', '携帯番号', '携帯電話', '携帯電話番号', '電話番号1', 'TEL', 'tel', 'phone', '連絡先'] };

export const FIELDS: Record<ImportKind, FieldDef[]> = {
  customers: [
    // in a customer export a bare "ID" / "No" is the customer's number
    { ...CUSTOMER_ID, synonyms: [...CUSTOMER_ID.synonyms, 'ID', 'No'] },
    ...NAME_FIELDS,
    PHONE,
    { key: 'phone2', label: '電話番号2', synonyms: ['電話番号2', '自宅電話', '自宅電話番号', '固定電話', 'TEL2', '電話2'] },
    { key: 'email', label: 'メールアドレス', synonyms: ['メールアドレス', 'メール', 'Eメール', 'E-mail', 'email', 'mail', 'PCメール', '携帯メール'] },
    { key: 'birthday', label: '生年月日', synonyms: ['生年月日', '誕生日', 'birthday', '生年月'] },
    { key: 'gender', label: '性別', synonyms: ['性別', 'gender', '男女'] },
    { key: 'postalCode', label: '郵便番号', synonyms: ['郵便番号', '〒', '郵便', 'zip', '郵便番号（〒）'] },
    { key: 'address', label: '住所', synonyms: ['住所', '都道府県', '市区町村', '番地', '住所1', '住所2', '建物名', 'address'], multi: true, hint: '複数の列を選ぶと順につなげます' },
    { key: 'occupation', label: '職業', synonyms: ['職業', '仕事'] },
    { key: 'acquisitionSource', label: '来店きっかけ', synonyms: ['来店きっかけ', 'きっかけ', '来店経路', '来店動機', '媒体', '集客経路', '紹介者', '紹介'] },
    { key: 'staffName', label: '担当スタッフ', synonyms: ['担当', '担当者', '担当スタッフ', '担当者名', '指名', '指名スタッフ', 'スタイリスト', 'メイン担当'] },
    { key: 'tags', label: 'タグ・区分', synonyms: ['タグ', '顧客区分', '区分', 'ランク', '会員ランク', 'グループ', '顧客分類'], multi: true, hint: '「|」「、」「,」区切りで複数タグ' },
    { key: 'memo', label: '顧客メモ', synonyms: ['メモ', '備考', '顧客メモ', '特記事項', 'コメント', '注意事項', '顧客備考', 'note', 'memo'], multi: true },
    { key: 'marketingOptIn', label: 'DM・配信の可否', synonyms: ['DM可否', 'DM', 'DM送付', '配信許可', 'メール配信', 'メルマガ', 'メール受信', 'お知らせ配信'] },
    { key: 'points', label: 'ポイント残高', synonyms: ['ポイント', '保有ポイント', 'ポイント残高', '残ポイント', '現在ポイント', 'pt'], hint: '顧客のポイント残高として引き継ぎます（1顧客につき1回）' },
    { key: 'pointsExpireAt', label: 'ポイント有効期限', synonyms: ['ポイント有効期限', '有効期限', 'ポイント期限'] },
    { key: 'visitCount', label: '来店回数', synonyms: ['来店回数', '来店数', '総来店回数', '累計来店回数', '来店回'] },
    { key: 'totalSales', label: '累計売上', synonyms: ['累計売上', '累計金額', '総売上', '売上累計', '累計利用金額', '総利用金額', '累計売上金額'] },
    { key: 'firstVisit', label: '初回来店日', synonyms: ['初回来店日', '初来店日', '初回来店', '初来店', '初回日'] },
    { key: 'lastVisit', label: '最終来店日', synonyms: ['最終来店日', '最終来店', '前回来店日', '前回来店', '最新来店日'] },
    { key: 'registeredAt', label: '登録日', synonyms: ['登録日', '登録日時', '入会日', '作成日', '作成日時'] },
  ],
  visits: [
    CUSTOMER_ID,
    ...NAME_FIELDS.filter((f) => ['fullName', 'fullKana', 'lastName', 'firstName'].includes(f.key)),
    PHONE,
    { key: 'slipNumber', label: '伝票・会計番号', synonyms: ['伝票番号', '会計番号', '伝票No', 'レシート番号', '売上番号', '取引番号', '来店ID', '会計ID'], hint: '再取り込み時の重複防止に使います' },
    { key: 'datetime', label: '来店日時', synonyms: ['来店日時', '会計日時', '売上日時', '施術日時', '日時'] },
    { key: 'date', label: '来店日', synonyms: ['来店日', '会計日', '売上日', '施術日', '日付', '利用日'] },
    { key: 'time', label: '来店時刻', synonyms: ['来店時刻', '開始時刻', '時刻', '時間', '会計時刻'] },
    { key: 'staffName', label: '担当スタッフ', synonyms: ['担当', '担当者', '担当スタッフ', '担当者名', 'スタイリスト', '施術者', '指名'] },
    { key: 'menu', label: 'メニュー・施術内容', synonyms: ['メニュー', 'メニュー名', '施術内容', '技術', '技術メニュー', '施術', 'コース', '内容', '商品', '明細'], multi: true },
    { key: 'amount', label: '金額', synonyms: ['金額', '合計', '合計金額', '売上', '売上金額', '会計金額', '税込金額', '税込合計', '請求金額', '利用金額'] },
    { key: 'shopName', label: '店舗', synonyms: ['店舗', '店舗名', '店名', 'サロン名'] },
    { key: 'memo', label: '施術メモ・カルテ', synonyms: ['メモ', '備考', 'カルテ', 'カルテメモ', '施術メモ', 'コメント', '薬剤', 'レシピ'], multi: true },
  ],
  reservations: [
    CUSTOMER_ID,
    ...NAME_FIELDS.filter((f) => ['fullName', 'fullKana', 'lastName', 'firstName', 'lastNameKana', 'firstNameKana'].includes(f.key)),
    PHONE,
    { key: 'email', label: 'メールアドレス', synonyms: ['メールアドレス', 'メール', 'email'] },
    { key: 'reservationNo', label: '予約番号', synonyms: ['予約番号', '予約ID', '予約No', '受付番号', '予約コード'], hint: '再取り込み時の重複防止に使います' },
    { key: 'datetime', label: '予約日時', synonyms: ['予約日時', '来店日時', '開始日時', '日時'] },
    { key: 'date', label: '予約日', synonyms: ['予約日', '来店日', '日付', '来店予定日'] },
    { key: 'time', label: '開始時刻', synonyms: ['開始時刻', '開始時間', '来店時刻', '予約時刻', '時刻', '時間'] },
    { key: 'endTime', label: '終了時刻', synonyms: ['終了時刻', '終了時間', '終了予定', '終了日時'] },
    { key: 'duration', label: '所要時間', synonyms: ['所要時間', '施術時間', '予約時間（分）', '時間（分）'] },
    { key: 'staffName', label: '担当スタッフ', synonyms: ['担当', '担当者', '担当スタッフ', '指名', '指名スタッフ', 'スタイリスト'] },
    { key: 'menu', label: 'メニュー', synonyms: ['メニュー', 'メニュー名', '施術内容', '予約メニュー', 'コース', '技術'], multi: true },
    { key: 'status', label: 'ステータス', synonyms: ['ステータス', '状態', '予約状態', '予約ステータス'] },
    { key: 'route', label: '予約経路', synonyms: ['予約経路', '経路', '予約元', '媒体', '受付方法'] },
    { key: 'memo', label: '予約メモ', synonyms: ['メモ', '備考', '要望', 'ご要望', 'コメント', '予約メモ'], multi: true },
  ],
};

/** field key → column indexes */
export type Mapping = Record<string, number[]>;

export function normalizeHeading(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/^\uFEFF/, '')
    .replace(/[\s_\-・:：]/g, '')
    .replace(/[（(].*?[）)]$/, (m) => m) // keep parenthesised qualifiers ("氏名(カナ)")
    .toLowerCase();
}

/** Suggest a mapping from the header row: exact synonym matches first, then "heading starts with synonym" */
export function suggestMapping(kind: ImportKind, header: string[]): Mapping {
  const norm = header.map(normalizeHeading);
  const used = new Set<number>();
  const mapping: Mapping = {};
  const fields = FIELDS[kind];
  for (const pass of ['exact', 'prefix'] as const) {
    for (const f of fields) {
      if (mapping[f.key]?.length && !f.multi) continue;
      const syn = f.synonyms.map(normalizeHeading);
      norm.forEach((h, i) => {
        if (used.has(i) || !h) return;
        const hit = pass === 'exact' ? syn.includes(h) : syn.some((s) => s.length >= 2 && h.startsWith(s) && !/\d$/.test(h.slice(s.length)));
        if (!hit) return;
        if (!f.multi && mapping[f.key]?.length) return;
        (mapping[f.key] ??= []).push(i);
        used.add(i);
      });
    }
  }
  // a full name column makes separate 姓/名 guesses ambiguous only when both exist; keep both — the
  // row normaliser prefers 姓/名 when they are filled
  return mapping;
}

// ------------------------------------------------------------------------------------------ values

const nfkc = (s: string) => s.normalize('NFKC').trim();

const ERAS: Record<string, number> = { 明治: 1867, 大正: 1911, 昭和: 1925, 平成: 1988, 令和: 2018, M: 1867, T: 1911, S: 1925, H: 1988, R: 2018 };

function ymd(y: number, m: number, d: number): string | null {
  if (!(y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null; // 2月30日 etc.
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** → 'YYYY-MM-DD' or null. Accepts 2026/10/9, 2026-10-09, 2026年10月9日, 20261009, 昭和50年1月2日, S50.1.2, H2/3/4, Excel serial (45123). */
export function parseDate(input: string | null | undefined): string | null {
  if (!input) return null;
  const s = nfkc(input).replace(/\(.\)|（.）/g, '').replace(/\s+(午前|午後)?\d{1,2}[:時].*$/, '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})[/\-.年](\d{1,2})[/\-.月](\d{1,2})日?$/);
  if (m) return ymd(+m[1]!, +m[2]!, +m[3]!);
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return ymd(+m[1]!, +m[2]!, +m[3]!);
  m = s.match(/^(明治|大正|昭和|平成|令和|[MTSHR])\s*(元|\d{1,2})[/\-.年](\d{1,2})[/\-.月](\d{1,2})日?$/i);
  if (m) {
    const base = ERAS[m[1]!.toUpperCase()] ?? ERAS[m[1]!];
    if (base === undefined) return null;
    return ymd(base + (m[2] === '元' ? 1 : +m[2]!), +m[3]!, +m[4]!);
  }
  // Excel serial date (1900 system): 1 = 1900-01-01, with the 1900 leap-year bug
  if (/^\d{5}$/.test(s)) {
    const serial = +s;
    if (serial > 20000 && serial < 80000) {
      const d = new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000);
      return ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    }
  }
  return null;
}

/** → minutes after midnight or null. Accepts 14:00, 14時30分, 1400, 午後2時, 2:00PM, Excel fraction (0.5833) */
export function parseTime(input: string | null | undefined): number | null {
  if (!input) return null;
  let s = nfkc(input).replace(/\s+/g, '');
  if (!s) return null;
  let pm = false;
  let am = false;
  if (/^(午後|pm)/i.test(s) || /pm$/i.test(s)) pm = true;
  if (/^(午前|am)/i.test(s) || /am$/i.test(s)) am = true;
  s = s.replace(/^(午前|午後|am|pm)/i, '').replace(/(am|pm)$/i, '');
  let m = s.match(/^(\d{1,2})[:時](\d{2})?(?::\d{2})?分?$/);
  if (!m) m = s.match(/^(\d{1,2})(\d{2})$/);
  if (m) {
    let h = +m[1]!;
    const min = m[2] ? +m[2] : 0;
    if (pm && h < 12) h += 12;
    if (am && h === 12) h = 0;
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
  }
  if (/^0?\.\d+$/.test(s)) {
    const total = Math.round(parseFloat(s) * 24 * 60);
    return total >= 0 && total < 24 * 60 ? total : null;
  }
  return null;
}

/** "2026/10/09 14:00", "2026-10-09T14:00", "2026年10月9日 14時" → { date, minutes } */
export function parseDateTime(input: string | null | undefined): { date: string; minutes: number | null } | null {
  if (!input) return null;
  const s = nfkc(input).replace('T', ' ').replace(/\(.\)|（.）/g, ' ');
  const date = parseDate(s);
  if (!date) {
    // Excel serial with time fraction: 45123.5833
    const m = s.match(/^(\d{5})\.(\d+)$/);
    if (m) {
      const d = parseDate(m[1]!);
      return d ? { date: d, minutes: parseTime(`0.${m[2]}`) } : null;
    }
    return null;
  }
  const t = s.match(/(\d{1,2}[:時]\d{0,2}(?::\d{2})?分?)\s*$/);
  return { date, minutes: t ? parseTime(t[1]) : null };
}

/** "¥12,000" "12,000円" "12000" "-500" → integer yen */
export function parseAmount(input: string | null | undefined): number | null {
  if (!input) return null;
  const s = nfkc(input).replace(/[¥￥,円\s]/g, '').replace(/^\((\d+)\)$/, '-$1');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Math.round(parseFloat(s));
}

/** "90" "90分" "1時間30分" "1:30" "1.5時間" → minutes */
export function parseDuration(input: string | null | undefined): number | null {
  if (!input) return null;
  const s = nfkc(input).replace(/\s+/g, '');
  let m = s.match(/^(\d+)時間(?:(\d+)分)?$/);
  if (m) return +m[1]! * 60 + (m[2] ? +m[2] : 0);
  m = s.match(/^(\d+(?:\.\d+)?)(?:h|時間)$/i);
  if (m) return Math.round(parseFloat(m[1]!) * 60);
  m = s.match(/^(\d+):(\d{2})$/);
  if (m) return +m[1]! * 60 + +m[2]!;
  m = s.match(/^(\d+)(?:分|min|m)?$/i);
  if (m) return +m[1]!;
  return null;
}

export function parseGender(input: string | null | undefined): 'female' | 'male' | 'other' | null {
  if (!input) return null;
  const s = nfkc(input).toLowerCase();
  if (/^(女|女性|f|female|w|woman|レディース)$/.test(s)) return 'female';
  if (/^(男|男性|m|male|man|メンズ)$/.test(s)) return 'male';
  if (/^(その他|other|x)$/.test(s)) return 'other';
  return null;
}

/** yes/no columns (DM可否 etc.): null when the value says nothing */
export function parseYesNo(input: string | null | undefined): boolean | null {
  if (!input) return null;
  const s = nfkc(input).toLowerCase();
  if (/^(可|許可|はい|yes|y|true|1|○|〇|◯|希望する|希望|受け取る|送付|配信|ok|する)$/.test(s)) return true;
  if (/^(不可|拒否|いいえ|no|n|false|0|×|✕|希望しない|不要|受け取らない|送付しない|配信しない|停止|しない)$/.test(s)) return false;
  return null;
}

/** "山田 花子" → ["山田", "花子"]; no space → whole string as 姓 */
export function splitName(full: string): [string, string] {
  const s = nfkc(full).replace(/[様さま]+$/, '').trim();
  const parts = s.split(/[\s\u3000]+/).filter(Boolean);
  if (parts.length >= 2) return [parts[0]!, parts.slice(1).join(' ')];
  return [s, ''];
}

export function splitList(input: string | null | undefined): string[] {
  if (!input) return [];
  return nfkc(input)
    .split(/[|｜、,，;；\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** JST wall-clock date + minutes → UTC Date */
export function jstToDate(date: string, minutes: number): Date {
  const h = String(Math.floor(minutes / 60)).padStart(2, '0');
  const m = String(minutes % 60).padStart(2, '0');
  return new Date(`${date}T${h}:${m}:00+09:00`);
}
