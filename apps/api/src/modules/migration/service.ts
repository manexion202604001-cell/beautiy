import { sql } from 'kysely';
import { auditUserId, hasShopAccess, requirePermission, systemActor, type Ctx } from '../../auth/actor.js';
import { withSystem, withTenant } from '../../db/tenant.js';
import { enqueue, registerJob } from '../../jobs/queue.js';
import { audit } from '../../lib/audit.js';
import { sha256 } from '../../lib/crypto.js';
import { parseCsv, toCsv } from '../../lib/csv.js';
import { Errors } from '../../lib/errors.js';
import { normalizeEmail, normalizeKana, normalizeName, normalizePhone } from '../../lib/normalize.js';
import { addMinutes, localDate, zonedDateTime } from '../../lib/time.js';
import { createAppointment } from '../appointments/service.js';
import { effectiveMenus, type EffectiveMenu } from '../catalog/service.js';
import { cancelQueuedMessages } from '../messaging/api.js';
import { applyPoints } from '../pos/points.js';
import { recomputeCustomerStats } from '../customers/stats.js';
import {
  FIELDS,
  parseAmount,
  parseDate,
  parseDateTime,
  parseDuration,
  parseGender,
  parseTime,
  parseYesNo,
  splitList,
  splitName,
  suggestMapping,
  type ImportKind,
  type Mapping,
} from './fields.js';

/**
 * Data migration from the previous system (要件: 旧システムからの移行).
 *   preview  → column mapping (suggested or chosen), every row normalised, matches against existing
 *              customers, problems listed — nothing is written
 *   start    → import_jobs row + 'migration.import' job, processed in chunks (one transaction per row,
 *              so one bad row never rolls back the others), progress visible
 *   re-run   → import_keys make it idempotent (legacy customer number / slip number / reservation number,
 *              otherwise a hash of the row)
 *   undo     → removes what the job created when it is still untouched; restores filled fields
 * Imports never send messages to customers and never create "block this slot" tasks.
 */

export const IMPORT_JOB = 'migration.import';
export const MAX_ROWS = 20_000;
const CHUNK_ROWS = 250;
const CHUNK_MS = 60_000;

export interface CustomerOptions {
  /** existing customer found: fill only empty fields (default) or leave as is */
  onExisting?: 'fill' | 'skip';
  /** when the file has no DM column: allow marketing messages? (default false — consent must be explicit) */
  defaultMarketingOptIn?: boolean;
}
export interface VisitOptions {
  /** create a customer when the visit's customer cannot be found (default false: listed as errors) */
  createMissingCustomers?: boolean;
}
export interface ReservationOptions {
  createMissingCustomers?: boolean;
  /** used when the menu name cannot be matched */
  defaultMenuId?: string;
  /** send Salon OS reminders for imported reservations (default false: the old system may still send them) */
  sendReminders?: boolean;
}
export type ImportOptions = CustomerOptions & VisitOptions & ReservationOptions;

export interface ImportInput {
  kind: ImportKind;
  csv: string;
  shopId: string;
  mapping?: Mapping;
  options?: ImportOptions;
  fileName?: string;
  sourceLabel?: string;
}

// ------------------------------------------------------------------------------------------ rows

type Values = Record<string, string>;

export interface NormalizedRow {
  rowNo: number;
  values: Values;
  /** problems that make the row unusable */
  errors: string[];
  /** problems the row survives (value left empty, original kept in 旧システムの項目) */
  warnings: string[];
  /** non-empty columns that are not mapped — kept on the customer so nothing is lost */
  extra: Record<string, string>;
}

function readColumns(header: string[], row: string[], mapping: Mapping): { values: Values; extra: Record<string, string> } {
  const values: Values = {};
  const used = new Set<number>();
  for (const [key, cols] of Object.entries(mapping)) {
    const parts = cols.map((i) => (row[i] ?? '').trim()).filter(Boolean);
    cols.forEach((i) => used.add(i));
    if (parts.length) values[key] = parts.join(key === 'address' ? ' ' : key === 'menu' || key === 'memo' ? '\n' : '|');
  }
  const extra: Record<string, string> = {};
  header.forEach((h, i) => {
    const v = (row[i] ?? '').trim();
    if (!used.has(i) && v && h.trim()) extra[h.trim()] = v;
  });
  return { values, extra };
}

function names(v: Values) {
  let [lastName, firstName] = [v.lastName ?? '', v.firstName ?? ''];
  if (!lastName && !firstName && v.fullName) [lastName, firstName] = splitName(v.fullName);
  let [lastNameKana, firstNameKana] = [v.lastNameKana ?? '', v.firstNameKana ?? ''];
  if (!lastNameKana && !firstNameKana && v.fullKana) [lastNameKana, firstNameKana] = splitName(v.fullKana);
  return {
    lastName: lastName.normalize('NFKC').replace(/\s*(様|さま)$/, '').trim(),
    firstName: firstName.normalize('NFKC').trim(),
    lastNameKana: lastNameKana.trim(),
    firstNameKana: firstNameKana.trim(),
  };
}

export function normalizeRows(kind: ImportKind, csv: string, mapping?: Mapping) {
  const table = parseCsv(csv);
  if (table.length < 2) throw Errors.validation('CSVに見出し行とデータ行が必要です');
  if (table.length - 1 > MAX_ROWS) throw Errors.validation(`一度に取り込めるのは${MAX_ROWS.toLocaleString()}行までです。ファイルを分けてください`);
  const header = table[0]!.map((h) => h.trim());
  const used = mapping ?? suggestMapping(kind, header);
  for (const [key, cols] of Object.entries(used)) {
    if (!FIELDS[kind].some((f) => f.key === key)) throw Errors.validation(`不明な項目です: ${key}`);
    if (cols.some((i) => i < 0 || i >= header.length)) throw Errors.validation(`列の指定が範囲外です: ${key}`);
  }
  const rows: NormalizedRow[] = table.slice(1).map((r, i) => {
    const { values, extra } = readColumns(header, r, used);
    const out: NormalizedRow = { rowNo: i + 2, values, errors: [], warnings: [], extra };
    validateRow(kind, out);
    return out;
  });
  return { header, mapping: used, rows };
}

function validateRow(kind: ImportKind, r: NormalizedRow) {
  const v = r.values;
  const n = names(v);
  const hasName = !!(n.lastName || n.firstName || n.lastNameKana || n.firstNameKana);
  const warnDate = (key: string, label: string) => {
    if (v[key] && !parseDate(v[key])) {
      r.warnings.push(`${label}「${v[key]}」を日付として読み取れません`);
      r.extra[label] = v[key]!;
      delete v[key];
    }
  };
  if (kind === 'customers') {
    if (!hasName) r.errors.push('氏名・フリガナがありません');
    warnDate('birthday', '生年月日');
    warnDate('firstVisit', '初回来店日');
    warnDate('lastVisit', '最終来店日');
    warnDate('registeredAt', '登録日');
    if (v.email && !normalizeEmail(v.email)?.match(/^[^@\s]+@[^@\s]+\.[^@\s]+$/)) {
      r.warnings.push(`メールアドレス「${v.email}」の形式が正しくありません`);
      r.extra['メールアドレス'] = v.email;
      delete v.email;
    }
    if (v.gender && !parseGender(v.gender)) r.warnings.push(`性別「${v.gender}」を判別できません`);
    for (const [key, label] of [['visitCount', '来店回数'], ['totalSales', '累計売上']] as const) {
      if (v[key] && (parseAmount(v[key]) === null || parseAmount(v[key])! < 0)) {
        r.warnings.push(`${label}「${v[key]}」を数値として読み取れません`);
        delete v[key];
      }
    }
    if (v.points && (parseAmount(v.points) === null || parseAmount(v.points)! < 0)) {
      r.warnings.push(`ポイント「${v.points}」を数値として読み取れません`);
      delete v.points;
    }
    warnDate('pointsExpireAt', 'ポイント有効期限');
    if (v.marketingOptIn && parseYesNo(v.marketingOptIn) === null) r.warnings.push(`DM・配信の可否「${v.marketingOptIn}」を判別できません（配信しない扱い）`);
    return;
  }
  if (!hasName && !v.customerNumber && !v.phone) r.errors.push('顧客を特定する項目（顧客番号・氏名・電話番号）がありません');
  const dt = v.datetime ? parseDateTime(v.datetime) : null;
  const date = dt?.date ?? parseDate(v.date);
  if (!date) r.errors.push(v.datetime || v.date ? `日付「${v.datetime ?? v.date}」を読み取れません` : '日付がありません');
  if (kind === 'visits') {
    if (v.amount && parseAmount(v.amount) === null) {
      r.warnings.push(`金額「${v.amount}」を数値として読み取れません`);
      delete v.amount;
    }
    return;
  }
  // reservations
  const minutes = dt?.minutes ?? parseTime(v.time);
  if (date && minutes === null) r.errors.push(v.time ? `開始時刻「${v.time}」を読み取れません` : '開始時刻がありません');
  if (!v.menu) r.errors.push('メニューがありません');
  if (v.status && /キャンセル|取消|取り消し|cancel/i.test(v.status)) r.errors.push('キャンセル済みの予約です（取り込みません）');
}

// ------------------------------------------------------------------------------------------ indexes

interface CustomerRef {
  id: string;
  name: string;
  kana: string;
}

/** In-memory lookup of the organisation's customers (one query instead of one per row) */
class CustomerIndex {
  byKey = new Map<string, string>();
  byNumber = new Map<string, string>();
  byPhone = new Map<string, CustomerRef[]>();
  byEmail = new Map<string, CustomerRef[]>();
  byNameKana = new Map<string, string[]>();

  static async load(ctx: Ctx): Promise<CustomerIndex> {
    const idx = new CustomerIndex();
    const [keys, customers] = await Promise.all([
      ctx.trx.selectFrom('import_keys').select(['key', 'resource_id']).where('kind', '=', 'customer').execute(),
      ctx.trx
        .selectFrom('customers')
        .select(['id', 'customer_number', 'phone_normalized', 'email', 'last_name', 'first_name', 'last_name_kana', 'first_name_kana', 'status', 'merged_into_id'])
        .where('deleted_at', 'is', null)
        .where('status', 'in', ['active', 'merged', 'blocked'])
        .execute(),
    ]);
    const merged = new Map(customers.filter((c) => c.status === 'merged' && c.merged_into_id).map((c) => [c.id, c.merged_into_id!]));
    const live = new Set(customers.filter((c) => c.status !== 'merged').map((c) => c.id));
    const follow = (id: string) => {
      let cur = id;
      for (let i = 0; i < 10 && merged.has(cur); i++) cur = merged.get(cur)!;
      return live.has(cur) ? cur : null;
    };
    for (const k of keys) {
      const id = follow(k.resource_id);
      if (id) idx.byKey.set(k.key, id);
    }
    for (const c of customers) {
      if (c.status === 'merged') continue;
      idx.add(c.id, { customerNumber: c.customer_number, phone: c.phone_normalized, email: c.email, ...{ lastName: c.last_name, firstName: c.first_name, lastNameKana: c.last_name_kana, firstNameKana: c.first_name_kana } });
    }
    return idx;
  }

  add(id: string, c: { customerNumber?: string | null; phone?: string | null; email?: string | null; lastName: string; firstName: string; lastNameKana: string; firstNameKana: string }) {
    const ref: CustomerRef = { id, name: normalizeName(c.lastName + c.firstName), kana: normalizeKana(c.lastNameKana + c.firstNameKana) };
    if (c.customerNumber) this.byNumber.set(c.customerNumber, id);
    const push = <T>(m: Map<string, T[]>, k: string | null | undefined, v: T) => {
      if (!k) return;
      const arr = m.get(k) ?? [];
      if (!arr.includes(v)) arr.push(v);
      m.set(k, arr);
    };
    push(this.byPhone, c.phone, ref);
    push(this.byEmail, c.email, ref);
    if (ref.name || ref.kana) push(this.byNameKana, `${ref.name}|${ref.kana}`, id);
  }

  /**
   * Find the customer a row refers to. Phone / e-mail alone never decide (families share a phone):
   * the name or kana must agree. Name + kana alone match only when exactly one customer has both.
   */
  find(v: Values, opts: { allowNameOnly: boolean }): { id: string; by: string } | null {
    const n = names(v);
    const name = normalizeName(n.lastName + n.firstName);
    const kana = normalizeKana(n.lastNameKana + n.firstNameKana);
    if (v.customerNumber) {
      const byKey = this.byKey.get(v.customerNumber.trim());
      if (byKey) return { id: byKey, by: '顧客番号（取り込み済み）' };
      const byNumber = this.byNumber.get(v.customerNumber.trim());
      if (byNumber) return { id: byNumber, by: '顧客番号' };
    }
    const agrees = (r: CustomerRef) => (!!name && r.name === name) || (!!kana && r.kana === kana);
    const phone = normalizePhone(v.phone);
    if (phone) {
      const hits = (this.byPhone.get(phone) ?? []).filter(agrees);
      if (hits.length === 1) return { id: hits[0]!.id, by: '電話番号＋氏名' };
    }
    const email = normalizeEmail(v.email);
    if (email) {
      const hits = (this.byEmail.get(email) ?? []).filter(agrees);
      if (hits.length === 1) return { id: hits[0]!.id, by: 'メール＋氏名' };
    }
    if (opts.allowNameOnly && name && kana) {
      const hits = this.byNameKana.get(`${name}|${kana}`) ?? [];
      if (hits.length === 1) return { id: hits[0]!, by: '氏名＋フリガナ' };
    }
    return null;
  }
}

class StaffIndex {
  constructor(private staff: { id: string; name: string; kana: string; inShop: boolean }[]) {}

  static async load(ctx: Ctx, shopId: string): Promise<StaffIndex> {
    const rows = await ctx.trx
      .selectFrom('staffs')
      .leftJoin('staff_shop_assignments as a', (j) => j.onRef('a.staff_id', '=', 'staffs.id').on('a.shop_id', '=', shopId).on('a.ended_on', 'is', null))
      .select(['staffs.id', 'staffs.display_name', 'staffs.display_name_kana', 'a.shop_id'])
      .where('staffs.deleted_at', 'is', null)
      .execute();
    return new StaffIndex(rows.map((r) => ({ id: r.id, name: normalizeName(r.display_name), kana: normalizeKana(r.display_name_kana ?? ''), inShop: !!r.shop_id })));
  }

  /** exact name/kana, then a unique surname prefix ("佐藤" → "佐藤 美咲"); shop staff preferred */
  find(raw: string | undefined): string | null {
    if (!raw) return null;
    const cleaned = raw.normalize('NFKC').replace(/(さん|様|先生|\(指名\)|（指名）|指名)$/, '').trim();
    if (!cleaned || /^(指名なし|フリー|なし|-|未定|担当なし)$/.test(cleaned)) return null;
    const name = normalizeName(cleaned);
    const kana = normalizeKana(cleaned);
    for (const pool of [this.staff.filter((s) => s.inShop), this.staff]) {
      const exact = pool.filter((s) => s.name === name || (!!kana && s.kana === kana));
      if (exact.length === 1) return exact[0]!.id;
      if (exact.length > 1) return null;
      const prefix = name.length >= 2 ? pool.filter((s) => s.name.startsWith(name)) : [];
      if (prefix.length === 1) return prefix[0]!.id;
    }
    return null;
  }
}

function matchMenus(menus: EffectiveMenu[], text: string, defaultMenuId?: string): { ids: string[]; missing: string[] } {
  const lines = splitList(text.replace(/\n/g, '|'))
    .map((l) => l.replace(/[¥￥]?\s?[\d,]+\s*円?$/, '').replace(/^【[^】]*】/, '').trim())
    .filter(Boolean);
  const ids: string[] = [];
  const missing: string[] = [];
  for (const line of lines) {
    const t = normalizeName(line);
    const exact = menus.filter((m) => normalizeName(m.name) === t);
    let hit: EffectiveMenu | undefined = exact.length === 1 ? exact[0] : undefined;
    if (!hit && !exact.length) {
      const contained = menus.filter((m) => normalizeName(m.name) && t.includes(normalizeName(m.name))).sort((a, b) => b.name.length - a.name.length);
      if (contained.length === 1 || (contained.length > 1 && contained[0]!.name.length > contained[1]!.name.length)) hit = contained[0];
      if (!hit) {
        const containing = menus.filter((m) => t && normalizeName(m.name).includes(t));
        if (containing.length === 1) hit = containing[0];
      }
    }
    if (hit) {
      if (!ids.includes(hit.id)) ids.push(hit.id);
    } else missing.push(line);
  }
  if (missing.length && defaultMenuId && !ids.length) return { ids: [defaultMenuId], missing: [] };
  if (missing.length && defaultMenuId) return { ids, missing: [] };
  return { ids, missing };
}

// ------------------------------------------------------------------------------------------ keys

function rowKey(kind: ImportKind, v: Values, customerKey: string): string {
  if (kind === 'customers' && v.customerNumber) return v.customerNumber.trim();
  if (kind === 'visits' && v.slipNumber) return `slip:${v.slipNumber.trim()}`;
  if (kind === 'reservations' && v.reservationNo) return `no:${v.reservationNo.trim()}`;
  return `hash:${sha256([customerKey, v.datetime ?? '', v.date ?? '', v.time ?? '', v.menu ?? '', v.amount ?? '', v.staffName ?? ''].join('\u0001')).slice(0, 32)}`;
}
const KEY_KIND: Record<ImportKind, string> = { customers: 'customer', visits: 'visit', reservations: 'reservation' };

// ------------------------------------------------------------------------------------------ preview

async function loadShop(ctx: Ctx, shopId: string) {
  if (!hasShopAccess(ctx.actor, shopId)) throw Errors.forbidden('この店舗へのアクセス権がありません', 'SHOP_FORBIDDEN');
  const shop = await ctx.trx.selectFrom('shops').select(['id', 'name', 'timezone']).where('id', '=', shopId).where('deleted_at', 'is', null).executeTakeFirst();
  if (!shop) throw Errors.notFound('店舗', shopId);
  return { ...shop, timezone: shop.timezone ?? 'Asia/Tokyo' };
}

function requireImportPermission(ctx: Ctx, kind: ImportKind) {
  requirePermission(ctx.actor, 'ops.manage', 'customer.write');
  if (kind === 'reservations') requirePermission(ctx.actor, 'appointment.write');
}

export async function previewImport(ctx: Ctx, input: ImportInput) {
  requireImportPermission(ctx, input.kind);
  const shop = await loadShop(ctx, input.shopId);
  const { header, mapping, rows } = normalizeRows(input.kind, input.csv, input.mapping);
  const customers = await CustomerIndex.load(ctx);
  const staff = await StaffIndex.load(ctx, shop.id);
  const menus = input.kind === 'reservations' ? await effectiveMenus(ctx, shop.id) : [];
  const keys = new Set(
    (await ctx.trx.selectFrom('import_keys').select('key').where('kind', '=', KEY_KIND[input.kind]).execute()).map((k) => k.key),
  );
  const options = input.options ?? {};
  const counts = { total: rows.length, ready: 0, errors: 0, warnings: 0, existing: 0, newCustomers: 0, alreadyImported: 0, duplicateInFile: 0, unknownStaff: 0, unknownMenu: 0, past: 0 };
  const seenKeys = new Set<string>();
  const unknownStaff = new Map<string, number>();
  const unknownMenu = new Map<string, number>();
  let amountTotal = 0;
  const now = new Date();
  const preview = rows.map((r) => {
    const v = r.values;
    const match = customers.find(v, { allowNameOnly: input.kind !== 'customers' });
    const customerKey = v.customerNumber?.trim() || `${normalizeName(names(v).lastName + names(v).firstName)}|${normalizePhone(v.phone) ?? ''}`;
    const key = rowKey(input.kind, v, customerKey);
    const notes: string[] = [];
    if (!r.errors.length) {
      if (keys.has(key)) {
        counts.alreadyImported++;
        notes.push('取り込み済み（スキップ／更新）');
      } else if (seenKeys.has(key)) {
        counts.duplicateInFile++;
        notes.push('ファイル内で重複');
      }
      seenKeys.add(key);
      if (match) counts.existing++;
      else if (input.kind === 'customers' || (input.kind === 'visits' ? options.createMissingCustomers : options.createMissingCustomers !== false)) counts.newCustomers++;
      else r.errors.push('顧客が見つかりません（顧客を先に取り込むか「見つからない顧客を作成」を選んでください）');
      if (v.staffName && !staff.find(v.staffName) && !/^(指名なし|フリー|なし|-)$/.test(v.staffName.trim())) {
        counts.unknownStaff++;
        unknownStaff.set(v.staffName, (unknownStaff.get(v.staffName) ?? 0) + 1);
        if (input.kind === 'reservations') notes.push(`スタッフ「${v.staffName}」が見つかりません（空いているスタッフに割り当てます）`);
      }
      if (input.kind === 'reservations' && v.menu) {
        const mm = matchMenus(menus, v.menu, options.defaultMenuId);
        if (mm.missing.length || !mm.ids.length) {
          counts.unknownMenu++;
          for (const m of mm.missing) unknownMenu.set(m, (unknownMenu.get(m) ?? 0) + 1);
          r.errors.push(`メニュー「${mm.missing.join('、')}」が見つかりません（メニュー名をそろえるか既定メニューを選んでください）`);
        }
      }
      if (input.kind === 'reservations') {
        const at = reservationStart(v, shop.timezone);
        if (at && at < now) {
          counts.past++;
          r.errors.push('過去の予約です（来店履歴として取り込んでください）');
        }
      }
    }
    if (!r.errors.length) {
      if (input.kind === 'visits' && v.amount) amountTotal += parseAmount(v.amount) ?? 0;
      if (input.kind === 'customers' && v.totalSales) amountTotal += parseAmount(v.totalSales) ?? 0;
    }
    if (r.errors.length) counts.errors++;
    else counts.ready++;
    if (r.warnings.length) counts.warnings++;
    return { rowNo: r.rowNo, values: v, errors: r.errors, warnings: [...r.warnings, ...notes], match: match ? match.by : null, extraColumns: Object.keys(r.extra) };
  });
  const problems = preview.filter((p) => p.errors.length || p.warnings.length);
  return {
    kind: input.kind,
    header,
    mapping,
    fields: FIELDS[input.kind],
    counts,
    amountTotal,
    unmappedColumns: header.filter((_, i) => !Object.values(mapping).some((cols) => cols.includes(i))),
    unknownStaff: [...unknownStaff].map(([name, rows]) => ({ name, rows })).sort((a, b) => b.rows - a.rows),
    unknownMenus: [...unknownMenu].map(([name, rows]) => ({ name, rows })).sort((a, b) => b.rows - a.rows),
    /** first rows + every problem row (capped) so the screen can show them */
    sample: preview.slice(0, 20),
    problems: problems.slice(0, 500),
  };
}

function reservationStart(v: Values, tz: string): Date | null {
  const dt = v.datetime ? parseDateTime(v.datetime) : null;
  const date = dt?.date ?? parseDate(v.date);
  const minutes = dt?.minutes ?? parseTime(v.time);
  if (!date || minutes === null || minutes === undefined) return null;
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return zonedDateTime(date, `${hh}:${mm}`, tz);
}

// ------------------------------------------------------------------------------------------ start

export async function startImport(ctx: Ctx, input: ImportInput) {
  requireImportPermission(ctx, input.kind);
  await loadShop(ctx, input.shopId);
  const { mapping, rows } = normalizeRows(input.kind, input.csv, input.mapping);
  if (input.options?.defaultMenuId) {
    const m = await ctx.trx.selectFrom('menus').select('id').where('id', '=', input.options.defaultMenuId).where('deleted_at', 'is', null).executeTakeFirst();
    if (!m) throw Errors.validation('既定メニューが見つかりません');
  }
  const running = await ctx.trx.selectFrom('import_jobs').select('id').where('status', 'in', ['queued', 'running']).executeTakeFirst();
  if (running) throw Errors.conflict('IMPORT_RUNNING', '別の取り込みが実行中です。完了してから実行してください', { jobId: running.id });
  const staffId = ctx.actor.kind === 'staff' ? ctx.actor.staffId : null;
  const job = await ctx.trx
    .insertInto('import_jobs')
    .values({
      organization_id: ctx.actor.organizationId,
      shop_id: input.shopId,
      kind: input.kind,
      source_label: input.sourceLabel?.trim() || '旧システム',
      file_name: input.fileName ?? null,
      mapping: JSON.stringify(mapping),
      options: JSON.stringify({ ...(input.options ?? {}), staffId }),
      csv: input.csv,
      total_rows: rows.length,
      created_by: auditUserId(ctx.actor),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await enqueue(ctx, { type: IMPORT_JOB, payload: { importJobId: job.id }, dedupeKey: `import:${job.id}`, maxAttempts: 5 });
  await audit(ctx, { action: 'migration.import_start', resourceType: 'import_job', resourceId: job.id, shopId: input.shopId, metadata: { kind: input.kind, rows: rows.length, fileName: input.fileName ?? null } });
  return getImportJob(ctx, job.id);
}

// ------------------------------------------------------------------------------------------ job

interface JobRow {
  id: string;
  organization_id: string;
  shop_id: string | null;
  kind: ImportKind;
  source_label: string;
  mapping: Mapping;
  options: ImportOptions & { staffId?: string | null };
  csv: string;
}

interface RowResult {
  outcome: 'created' | 'updated' | 'matched' | 'skipped' | 'error';
  resourceType?: string;
  resourceId?: string;
  message?: string;
  data?: Record<string, unknown>;
}

export async function runImportChunk(importJobId: string): Promise<'done' | 'more'> {
  const job = await withSystemJob(importJobId);
  if (!job || !['queued', 'running'].includes(job.status)) return 'done';
  const orgId = job.organization_id;
  const actor = systemActor(orgId, 'import');
  const meta = { traceId: `import:${job.id}` };
  const j: JobRow = { ...job, kind: job.kind as ImportKind, mapping: job.mapping as Mapping, options: job.options as JobRow['options'] };
  const { header, rows } = normalizeRows(j.kind, j.csv, j.mapping);
  const shopId = j.shop_id!;

  const state = await withTenant(orgId, async (trx) => {
    const ctx: Ctx = { actor, trx, meta };
    await trx.updateTable('import_jobs').set({ status: 'running', started_at: sql`coalesce(started_at, now())` }).where('id', '=', j.id).execute();
    const done = await trx.selectFrom('import_job_rows').select(sql<number>`coalesce(max(row_no), 1)`.as('last')).where('job_id', '=', j.id).executeTakeFirstOrThrow();
    const shop = await trx.selectFrom('shops').select(['timezone']).where('id', '=', shopId).executeTakeFirstOrThrow();
    return {
      lastRow: Number(done.last),
      tz: shop.timezone ?? 'Asia/Tokyo',
      customers: await CustomerIndex.load(ctx),
      staff: await StaffIndex.load(ctx, shopId),
      menus: j.kind === 'reservations' ? await effectiveMenus(ctx, shopId) : [],
      shops: (await trx.selectFrom('shops').select(['id', 'name']).where('deleted_at', 'is', null).execute()).map((s) => ({ id: s.id, name: normalizeName(s.name) })),
      tags: new Map((await trx.selectFrom('tags').select(['id', 'name']).execute()).map((t) => [t.name, t.id])),
    };
  }, meta);

  const startedAt = Date.now();
  let processed = 0;
  for (const r of rows) {
    if (r.rowNo <= state.lastRow) continue;
    if (processed >= CHUNK_ROWS || Date.now() - startedAt > CHUNK_MS) break;
    let result: RowResult;
    try {
      result = await withTenant(orgId, (trx) => importRow({ actor, trx, meta }, j, header, r, state), meta);
    } catch (err) {
      result = { outcome: 'error', message: friendlyError(err) };
    }
    await withTenant(orgId, (trx) =>
      trx
        .insertInto('import_job_rows')
        .values({
          organization_id: orgId,
          job_id: j.id,
          row_no: r.rowNo,
          outcome: result.outcome,
          resource_type: result.resourceType ?? null,
          resource_id: result.resourceId ?? null,
          message: result.message ?? (r.warnings.length ? r.warnings.join(' / ') : null),
          data: JSON.stringify({ ...(result.data ?? {}), values: r.values }),
        })
        .onConflict((oc) => oc.columns(['job_id', 'row_no']).doNothing())
        .execute(),
    meta);
    processed++;
  }

  const remaining = rows.some((r) => r.rowNo > state.lastRow + processed);
  await withTenant(orgId, async (trx) => {
    const counts = await trx
      .selectFrom('import_job_rows')
      .select(['outcome', sql<number>`count(*)::int`.as('n')])
      .where('job_id', '=', j.id)
      .groupBy('outcome')
      .execute();
    const summary = Object.fromEntries(counts.map((c) => [c.outcome, c.n]));
    const processedRows = counts.reduce((s, c) => s + c.n, 0);
    const finished = !remaining;
    await trx
      .updateTable('import_jobs')
      .set({
        processed_rows: processedRows,
        summary: JSON.stringify(summary),
        ...(finished ? { status: 'completed', completed_at: new Date(), totals: JSON.stringify(await reconciliation(trx, j)) } : {}),
      })
      .where('id', '=', j.id)
      .execute();
    if (finished) {
      await audit({ actor, trx, meta }, { action: 'migration.import_complete', resourceType: 'import_job', resourceId: j.id, shopId, metadata: { kind: j.kind, summary } });
    } else {
      await enqueue(trx, { type: IMPORT_JOB, organizationId: orgId, payload: { importJobId: j.id }, dedupeKey: `import:${j.id}:${processedRows}`, maxAttempts: 5 });
    }
  }, meta);
  return remaining ? 'more' : 'done';
}

async function withSystemJob(id: string) {
  return withSystem((trx) => trx.selectFrom('import_jobs').selectAll().where('id', '=', id).executeTakeFirst());
}

function friendlyError(err: unknown): string {
  const e = err as { message?: string; code?: string; constraint?: string };
  if (e?.constraint === 'appointments_no_staff_overlap' || /no_staff_overlap|OVERLAP|重複/.test(e?.message ?? '')) return 'その時間は担当スタッフに別の予約があります（手動で登録してください）';
  if (e?.code === 'SLOT_UNAVAILABLE' || /空き|unavailable/i.test(e?.message ?? '')) return `予約できません: ${e.message}`;
  return (e?.message ?? String(err)).slice(0, 500);
}

type ChunkState = {
  tz: string;
  customers: CustomerIndex;
  staff: StaffIndex;
  menus: EffectiveMenu[];
  shops: { id: string; name: string }[];
  tags: Map<string, string>;
};

async function importRow(ctx: Ctx, j: JobRow, header: string[], r: { rowNo: number; values: Values; errors: string[]; warnings: string[]; extra: Record<string, string> }, s: ChunkState): Promise<RowResult> {
  void header;
  if (r.errors.length) return { outcome: 'error', message: r.errors.join(' / ') };
  const v = r.values;
  const customerKey = v.customerNumber?.trim() || `${normalizeName(names(v).lastName + names(v).firstName)}|${normalizePhone(v.phone) ?? ''}`;
  const key = rowKey(j.kind, v, customerKey);
  const existingKey = await ctx.trx.selectFrom('import_keys').select(['resource_id']).where('kind', '=', KEY_KIND[j.kind]).where('key', '=', key).executeTakeFirst();

  if (j.kind === 'customers') return importCustomer(ctx, j, r, s, key, existingKey?.resource_id ?? null);
  if (j.kind === 'reservations') {
    const at = reservationStart(v, s.tz);
    if (!at || at < new Date()) return { outcome: 'error', message: '過去の予約です（来店履歴として取り込んでください）' };
  }
  if (existingKey) return { outcome: 'skipped', resourceType: j.kind === 'visits' ? 'legacy_visit' : 'appointment', resourceId: existingKey.resource_id, message: '取り込み済みです' };

  // visits / reservations: find (or create) the customer
  let customer = s.customers.find(v, { allowNameOnly: true });
  let createdCustomer = false;
  const createMissing = j.kind === 'visits' ? !!j.options.createMissingCustomers : j.options.createMissingCustomers !== false;
  if (!customer) {
    if (!createMissing) return { outcome: 'error', message: '顧客が見つかりません' };
    const n = names(v);
    if (!(n.lastName || n.firstName || n.lastNameKana || n.firstNameKana)) return { outcome: 'error', message: '顧客が見つからず、氏名もないため作成できません' };
    const id = await insertCustomer(ctx, j, { ...v, ...n }, r.extra, s);
    customer = { id, by: '新規作成' };
    createdCustomer = true;
  }

  if (j.kind === 'visits') {
    const dt = v.datetime ? parseDateTime(v.datetime) : null;
    const date = dt?.date ?? parseDate(v.date)!;
    const minutes = dt?.minutes ?? parseTime(v.time) ?? 12 * 60;
    const shopId = v.shopName ? (s.shops.find((x) => x.name === normalizeName(v.shopName)) ?? null)?.id ?? j.shop_id : j.shop_id;
    const visit = await ctx.trx
      .insertInto('legacy_visits')
      .values({
        organization_id: ctx.actor.organizationId,
        customer_id: customer.id,
        shop_id: shopId,
        import_job_id: j.id,
        visited_at: zonedDateTime(date, `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`, s.tz),
        staff_id: s.staff.find(v.staffName),
        staff_name: v.staffName ?? null,
        menu_text: v.menu ?? null,
        amount: v.amount ? parseAmount(v.amount) : null,
        memo: v.memo ?? null,
        external_id: v.slipNumber ?? null,
        raw: JSON.stringify({ ...v, ...r.extra }),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await saveKey(ctx, j, key, visit.id);
    await recomputeCustomerStats(ctx, customer.id);
    return { outcome: 'created', resourceType: 'legacy_visit', resourceId: visit.id, message: createdCustomer ? '顧客を新規作成しました' : undefined, data: { customerId: customer.id, createdCustomer } };
  }

  // reservations
  const startAt = reservationStart(v, s.tz)!;
  const mm = matchMenus(s.menus, v.menu ?? '', j.options.defaultMenuId);
  if (!mm.ids.length || mm.missing.length) return { outcome: 'error', message: `メニュー「${mm.missing.join('、') || v.menu}」が見つかりません` };
  const staffId = s.staff.find(v.staffName);
  const notes = [v.memo, v.route ? `予約経路: ${v.route}` : null, v.staffName && !staffId ? `旧システムの担当: ${v.staffName}` : null].filter(Boolean).join('\n');
  const appt = await createAppointment(
    ctx,
    {
      shopId: j.shop_id!,
      customerId: customer.id,
      staffId,
      isNominated: !!staffId,
      startAt: startAt.toISOString(),
      menuIds: mm.ids,
      source: 'import',
      sourceDetail: { importJobId: j.id, reservationNo: v.reservationNo ?? null, sourceLabel: j.source_label, sendReminders: !!j.options.sendReminders },
      staffNote: notes || null,
      allowOutsideSchedule: true,
    },
    { trusted: true },
  );
  // keep the old system's end time when it is longer than the menus' total (e.g. long colour treatments)
  const endMin = v.endTime ? (parseDateTime(v.endTime)?.minutes ?? parseTime(v.endTime)) : null;
  const duration = v.duration ? parseDuration(v.duration) : null;
  const startMin = Math.round((startAt.getTime() - zonedDateTime(localDate(startAt, s.tz), '00:00', s.tz).getTime()) / 60_000);
  const wanted = endMin !== null && endMin !== undefined && endMin > startMin ? endMin - startMin : duration;
  const current = Math.round((new Date(appt.end_at).getTime() - startAt.getTime()) / 60_000);
  if (wanted && wanted > current && wanted <= 12 * 60) {
    const extra = wanted - current;
    await ctx.trx
      .updateTable('appointments')
      .set({ end_at: addMinutes(new Date(appt.end_at), extra), occupied_end_at: addMinutes(new Date(appt.occupied_end_at), extra) })
      .where('id', '=', appt.id)
      .execute();
  }
  await saveKey(ctx, j, key, appt.id);
  return {
    outcome: 'created',
    resourceType: 'appointment',
    resourceId: appt.id,
    message: [createdCustomer ? '顧客を新規作成しました' : null, v.staffName && !staffId ? `スタッフ「${v.staffName}」が見つからないため自動割当` : null].filter(Boolean).join(' / ') || undefined,
    data: { customerId: customer.id, createdCustomer, bookingReference: appt.booking_reference },
  };
}

async function saveKey(ctx: Ctx, j: JobRow, key: string, resourceId: string) {
  await ctx.trx
    .insertInto('import_keys')
    .values({ organization_id: ctx.actor.organizationId, kind: KEY_KIND[j.kind], key, resource_id: resourceId, job_id: j.id })
    .onConflict((oc) => oc.columns(['organization_id', 'kind', 'key']).doUpdateSet({ resource_id: resourceId, job_id: j.id }))
    .execute();
}

const FILLABLE = ['phone', 'email', 'birthday', 'gender', 'postal_code', 'address', 'occupation', 'acquisition_source', 'last_name_kana', 'first_name_kana'] as const;

function customerColumns(v: Values) {
  return {
    phone: v.phone?.trim() || null,
    email: normalizeEmail(v.email) ?? null,
    birthday: parseDate(v.birthday),
    gender: parseGender(v.gender),
    postal_code: v.postalCode?.normalize('NFKC').replace(/[^\d-]/g, '').slice(0, 10) || null,
    address: v.address?.slice(0, 300) || null,
    occupation: v.occupation?.slice(0, 100) || null,
    acquisition_source: v.acquisitionSource?.slice(0, 100) || null,
  };
}

async function insertCustomer(ctx: Ctx, j: JobRow, v: Values, extra: Record<string, string>, s: ChunkState): Promise<string> {
  const n = names(v);
  const cols = customerColumns(v);
  const number = v.customerNumber?.trim() || null;
  // keep the old number visible/searchable when it is free
  const numberFree = number ? !(await ctx.trx.selectFrom('customers').select('id').where('customer_number', '=', number).where('deleted_at', 'is', null).executeTakeFirst()) : false;
  const optIn = v.marketingOptIn ? parseYesNo(v.marketingOptIn) ?? false : !!j.options.defaultMarketingOptIn;
  const visitCount = v.visitCount ? Math.max(0, parseAmount(v.visitCount) ?? 0) : 0;
  const totalSales = v.totalSales ? Math.max(0, parseAmount(v.totalSales) ?? 0) : 0;
  const first = parseDate(v.firstVisit);
  const last = parseDate(v.lastVisit);
  const staffId = s.staff.find(v.staffName);
  const legacy = {
    source: j.source_label,
    importJobId: j.id,
    customerNumber: number,
    registeredAt: parseDate(v.registeredAt),
    phone2: v.phone2 ?? null,
    staffName: v.staffName ?? null,
    memo: v.memo ?? null,
    columns: extra,
  };
  const row = await ctx.trx
    .insertInto('customers')
    .values({
      organization_id: ctx.actor.organizationId,
      customer_number: numberFree ? number : null,
      last_name: n.lastName.slice(0, 50),
      first_name: n.firstName.slice(0, 50),
      last_name_kana: n.lastNameKana.slice(0, 50),
      first_name_kana: n.firstNameKana.slice(0, 50),
      ...cols,
      phone_normalized: normalizePhone(cols.phone),
      primary_shop_id: j.shop_id,
      primary_staff_id: staffId,
      marketing_opt_in: optIn,
      attributes: JSON.stringify({ legacy }),
      legacy_visit_count: visitCount,
      legacy_total_sales: totalSales,
      legacy_first_visit_at: first ? zonedDateTime(first, '12:00', s.tz) : null,
      legacy_last_visit_at: last ? zonedDateTime(last, '12:00', s.tz) : null,
      created_by: null,
      trace_id: ctx.meta.traceId ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  if (j.shop_id) {
    await ctx.trx
      .insertInto('customer_shop_relations')
      .values({ organization_id: ctx.actor.organizationId, customer_id: row.id, shop_id: j.shop_id, relation_type: 'visited' })
      .onConflict((oc) => oc.doNothing())
      .execute();
    if (staffId) {
      await ctx.trx
        .insertInto('customer_shop_relations')
        .values({ organization_id: ctx.actor.organizationId, customer_id: row.id, shop_id: j.shop_id, relation_type: 'primary_staff', staff_id: staffId })
        .onConflict((oc) => oc.doNothing())
        .execute();
    }
  }
  if (number) await ctx.trx.insertInto('import_keys').values({ organization_id: ctx.actor.organizationId, kind: 'customer', key: number, resource_id: row.id, job_id: j.id }).onConflict((oc) => oc.doNothing()).execute();
  await addTags(ctx, row.id, splitList(v.tags), s);
  if (v.memo && j.options.staffId) {
    await ctx.trx.insertInto('customer_memos').values({ organization_id: ctx.actor.organizationId, customer_id: row.id, staff_id: j.options.staffId, body: `【${j.source_label}より移行】\n${v.memo}`.slice(0, 5000), visibility: 'shared' }).execute();
  }
  await migratePoints(ctx, j, row.id, v, s);
  await recomputeCustomerStats(ctx, row.id);
  s.customers.add(row.id, { customerNumber: number, phone: normalizePhone(cols.phone), email: cols.email, ...n });
  if (number) s.customers.byKey.set(number, row.id);
  return row.id;
}

const POINT_NOTE = '旧システムからの移行';

/** carry the old point balance over once per customer (re-imports never add it twice) */
async function migratePoints(ctx: Ctx, j: JobRow, customerId: string, v: Values, s: ChunkState): Promise<number> {
  const points = v.points ? parseAmount(v.points) : null;
  if (!points || points <= 0) return 0;
  const carried = await ctx.trx
    .selectFrom('point_ledger')
    .select(sql<number>`coalesce(sum(delta), 0)::int`.as('n'))
    .where('customer_id', '=', customerId)
    .where('note', 'like', `${POINT_NOTE}%`)
    .executeTakeFirstOrThrow();
  if (carried.n > 0) return 0;
  const expires = parseDate(v.pointsExpireAt);
  return applyPoints(ctx, {
    customerId,
    delta: points,
    // with an expiry date the points expire like earned points; otherwise they are a plain adjustment
    reason: expires ? 'earn' : 'adjust',
    expiresAt: expires ? zonedDateTime(expires, '23:59', s.tz) : null,
    note: `${POINT_NOTE}（${j.source_label}）`,
  });
}

async function addTags(ctx: Ctx, customerId: string, tagNames: string[], s: ChunkState) {
  for (const raw of tagNames) {
    const name = raw.slice(0, 50);
    let id = s.tags.get(name);
    if (!id) {
      const t = await ctx.trx
        .insertInto('tags')
        .values({ organization_id: ctx.actor.organizationId, name })
        .onConflict((oc) => oc.columns(['organization_id', 'name']).doUpdateSet({ name }))
        .returning('id')
        .executeTakeFirstOrThrow();
      id = t.id;
      s.tags.set(name, id);
    }
    await ctx.trx.insertInto('customer_tags').values({ organization_id: ctx.actor.organizationId, customer_id: customerId, tag_id: id }).onConflict((oc) => oc.doNothing()).execute();
  }
}

async function importCustomer(ctx: Ctx, j: JobRow, r: { values: Values; extra: Record<string, string> }, s: ChunkState, key: string, keyResource: string | null): Promise<RowResult> {
  const v = r.values;
  const match = keyResource ? { id: s.customers.byKey.get(key) ?? keyResource, by: '顧客番号（取り込み済み）' } : s.customers.find(v, { allowNameOnly: false });
  if (!match) {
    const id = await insertCustomer(ctx, j, v, r.extra, s);
    return { outcome: 'created', resourceType: 'customer', resourceId: id };
  }
  if (j.options.onExisting === 'skip') return { outcome: 'matched', resourceType: 'customer', resourceId: match.id, message: `既存の顧客と一致（${match.by}）— 変更なし` };

  // fill empty fields only; never overwrite what staff already entered in Salon OS
  const cur = await ctx.trx.selectFrom('customers').selectAll().where('id', '=', match.id).executeTakeFirstOrThrow();
  const cols = customerColumns(v);
  const before: Record<string, unknown> = {};
  const set: Record<string, unknown> = {};
  const n = names(v);
  const candidates: Record<string, unknown> = { ...cols, last_name_kana: n.lastNameKana || null, first_name_kana: n.firstNameKana || null };
  for (const f of FILLABLE) {
    const empty = cur[f] === null || cur[f] === '';
    if (empty && candidates[f]) {
      before[f] = cur[f];
      set[f] = candidates[f];
    }
  }
  if (set.phone) set.phone_normalized = normalizePhone(set.phone as string);
  const visitCount = v.visitCount ? Math.max(0, parseAmount(v.visitCount) ?? 0) : 0;
  const totalSales = v.totalSales ? Math.max(0, parseAmount(v.totalSales) ?? 0) : 0;
  if (visitCount > cur.legacy_visit_count) {
    before.legacy_visit_count = cur.legacy_visit_count;
    set.legacy_visit_count = visitCount;
  }
  if (totalSales > cur.legacy_total_sales) {
    before.legacy_total_sales = cur.legacy_total_sales;
    set.legacy_total_sales = totalSales;
  }
  const first = parseDate(v.firstVisit);
  const last = parseDate(v.lastVisit);
  if (first && !cur.legacy_first_visit_at) {
    before.legacy_first_visit_at = null;
    set.legacy_first_visit_at = zonedDateTime(first, '12:00', s.tz);
  }
  if (last && !cur.legacy_last_visit_at) {
    before.legacy_last_visit_at = null;
    set.legacy_last_visit_at = zonedDateTime(last, '12:00', s.tz);
  }
  const attrs = (cur.attributes ?? {}) as Record<string, unknown>;
  if (!attrs.legacy) {
    set.attributes = JSON.stringify({ ...attrs, legacy: { source: j.source_label, importJobId: j.id, customerNumber: v.customerNumber ?? null, phone2: v.phone2 ?? null, staffName: v.staffName ?? null, columns: r.extra } });
    before.attributes = attrs;
  }
  if (v.customerNumber) await saveKey(ctx, j, v.customerNumber.trim(), match.id);
  await addTags(ctx, match.id, splitList(v.tags), s);
  const points = await migratePoints(ctx, j, match.id, v, s);
  if (points) before.__points = points;
  if (!Object.keys(set).length && !points) return { outcome: 'matched', resourceType: 'customer', resourceId: match.id, message: `既存の顧客と一致（${match.by}）— 追加する情報なし` };
  if (Object.keys(set).length) await ctx.trx.updateTable('customers').set(set).where('id', '=', match.id).execute();
  await recomputeCustomerStats(ctx, match.id);
  const filled = Object.keys(set).filter((k) => k !== 'phone_normalized' && k !== 'attributes');
  const what = [filled.length ? `空欄を補完: ${filled.join(', ')}` : null, points ? `ポイント ${points}pt を引き継ぎ` : null].filter(Boolean).join(' / ') || '旧システム情報を保存';
  return { outcome: 'updated', resourceType: 'customer', resourceId: match.id, message: `既存の顧客と一致（${match.by}）— ${what}`, data: { before } };
}

/** totals the file claims vs what is now in Salon OS — shown after the import so nothing silently goes missing */
async function reconciliation(trx: Ctx['trx'], j: JobRow) {
  const { rows } = normalizeRows(j.kind, j.csv, j.mapping);
  const fileRows = rows.length;
  const fileAmount = rows.reduce((s, r) => s + (parseAmount(j.kind === 'customers' ? r.values.totalSales : r.values.amount) ?? 0), 0);
  if (j.kind === 'visits') {
    const imported = await trx
      .selectFrom('legacy_visits')
      .select([sql<number>`count(*)::int`.as('n'), sql<number>`coalesce(sum(amount), 0)::int`.as('amount')])
      .where('import_job_id', '=', j.id)
      .executeTakeFirstOrThrow();
    return { fileRows, fileAmount, importedRows: imported.n, importedAmount: imported.amount };
  }
  if (j.kind === 'customers') {
    const ids = (await trx.selectFrom('import_job_rows').select('resource_id').where('job_id', '=', j.id).where('outcome', 'in', ['created', 'updated', 'matched']).execute()).map((r) => r.resource_id!).filter(Boolean);
    const sum = ids.length
      ? await trx.selectFrom('customers').select([sql<number>`count(DISTINCT id)::int`.as('n'), sql<number>`coalesce(sum(legacy_total_sales), 0)::int`.as('amount')]).where('id', 'in', [...new Set(ids)]).executeTakeFirstOrThrow()
      : { n: 0, amount: 0 };
    return { fileRows, fileAmount, importedRows: sum.n, importedAmount: sum.amount };
  }
  const n = await trx.selectFrom('import_job_rows').select(sql<number>`count(*)::int`.as('n')).where('job_id', '=', j.id).where('outcome', '=', 'created').executeTakeFirstOrThrow();
  return { fileRows, importedRows: n.n };
}

registerJob<{ importJobId: string }>(IMPORT_JOB, async (p) => {
  await runImportChunk(p.importJobId);
});

// ------------------------------------------------------------------------------------------ read

export async function listImportJobs(ctx: Ctx) {
  requirePermission(ctx.actor, 'ops.manage');
  return ctx.trx
    .selectFrom('import_jobs')
    .select(['id', 'shop_id', 'kind', 'source_label', 'file_name', 'status', 'total_rows', 'processed_rows', 'summary', 'totals', 'error', 'created_at', 'started_at', 'completed_at', 'undone_at'])
    .orderBy('created_at', 'desc')
    .limit(50)
    .execute();
}

export async function getImportJob(ctx: Ctx, id: string) {
  requirePermission(ctx.actor, 'ops.manage');
  const job = await ctx.trx
    .selectFrom('import_jobs')
    .select(['id', 'shop_id', 'kind', 'source_label', 'file_name', 'status', 'mapping', 'options', 'total_rows', 'processed_rows', 'summary', 'totals', 'error', 'created_at', 'started_at', 'completed_at', 'undone_at'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!job) throw Errors.notFound('取り込み', id);
  const problems = await ctx.trx
    .selectFrom('import_job_rows')
    .select(['row_no', 'outcome', 'message', 'resource_id'])
    .where('job_id', '=', id)
    .where((eb) => eb.or([eb('outcome', '=', 'error'), eb('message', 'is not', null)]))
    .orderBy('row_no')
    .limit(500)
    .execute();
  return { ...job, problems };
}

/** rows that failed, with the original columns + reason, to fix in Excel and import again */
export async function importErrorsCsv(ctx: Ctx, id: string) {
  requirePermission(ctx.actor, 'ops.manage');
  const job = await ctx.trx.selectFrom('import_jobs').select(['csv']).where('id', '=', id).executeTakeFirst();
  if (!job) throw Errors.notFound('取り込み', id);
  const table = parseCsv(job.csv);
  const header = table[0]!;
  const errs = await ctx.trx.selectFrom('import_job_rows').select(['row_no', 'message']).where('job_id', '=', id).where('outcome', '=', 'error').orderBy('row_no').execute();
  const headers = [{ key: '__row', label: '元の行番号' }, { key: '__reason', label: 'エラー内容' }, ...header.map((h, i) => ({ key: String(i), label: h }))];
  const rows = errs.map((e) => {
    const src = table[e.row_no - 1] ?? [];
    return { __row: e.row_no, __reason: e.message ?? '', ...Object.fromEntries(src.map((v, i) => [String(i), v])) };
  });
  return toCsv(headers, rows);
}

// ------------------------------------------------------------------------------------------ undo

export async function undoImport(ctx: Ctx, id: string) {
  requirePermission(ctx.actor, 'ops.manage', 'customer.write');
  const job = await ctx.trx.selectFrom('import_jobs').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
  if (!job) throw Errors.notFound('取り込み', id);
  if (job.status !== 'completed' && job.status !== 'failed') throw Errors.business('IMPORT_NOT_UNDOABLE', job.status === 'undone' ? 'この取り込みは取り消し済みです' : '実行中の取り込みは取り消せません');
  const rows = await ctx.trx.selectFrom('import_job_rows').select(['row_no', 'outcome', 'resource_type', 'resource_id', 'data']).where('job_id', '=', id).execute();
  const result = { removed: 0, restored: 0, kept: [] as { rowNo: number; reason: string }[] };
  const touchedCustomers = new Set<string>();
  const now = new Date();

  for (const r of rows) {
    if (!r.resource_id) continue;
    const data = (r.data ?? {}) as { before?: Record<string, unknown>; customerId?: string; createdCustomer?: boolean };
    if (r.resource_type === 'legacy_visit' && r.outcome === 'created') {
      await ctx.trx.deleteFrom('legacy_visits').where('id', '=', r.resource_id).execute();
      if (data.customerId) touchedCustomers.add(data.customerId);
      result.removed++;
    } else if (r.resource_type === 'appointment' && r.outcome === 'created') {
      const a = await ctx.trx.selectFrom('appointments').select(['status', 'version', 'customer_id']).where('id', '=', r.resource_id).executeTakeFirst();
      const paid = await ctx.trx.selectFrom('transactions').select('id').where('appointment_id', '=', r.resource_id).where('status', '!=', 'voided').executeTakeFirst();
      if (!a || a.version !== 1 || !['confirmed', 'tentative'].includes(a.status) || paid) {
        result.kept.push({ rowNo: r.row_no, reason: '予約が取り込み後に変更・来店処理されているため残しました' });
        continue;
      }
      await cancelQueuedMessages(ctx, { appointmentId: r.resource_id });
      await ctx.trx.updateTable('appointment_resources').set({ is_active: false }).where('appointment_id', '=', r.resource_id).execute();
      await ctx.trx
        .updateTable('appointments')
        .set({ status: 'cancelled', cancelled_at: now, cancelled_by_type: 'system', cancel_reason: '移行データの取り消し', deleted_at: now })
        .where('id', '=', r.resource_id)
        .execute();
      if (a.customer_id) touchedCustomers.add(a.customer_id);
      result.removed++;
    } else if (r.resource_type === 'customer' && r.outcome === 'updated' && data.before) {
      const { __points, ...fields } = data.before;
      if (Object.keys(fields).length) await ctx.trx.updateTable('customers').set(restorable(fields)).where('id', '=', r.resource_id).execute();
      if (typeof __points === 'number' && __points > 0) {
        await applyPoints(ctx, { customerId: r.resource_id, delta: -__points, reason: 'adjust', note: `${POINT_NOTE}の取り消し`, clampAtZero: true });
      }
      touchedCustomers.add(r.resource_id);
      result.restored++;
    }
    // customers created by this job (directly or for a visit/reservation)
    const createdCustomerId = r.resource_type === 'customer' && r.outcome === 'created' ? r.resource_id : data.createdCustomer ? data.customerId : null;
    if (createdCustomerId) {
      const reason = await customerInUse(ctx, createdCustomerId, id);
      if (reason) {
        result.kept.push({ rowNo: r.row_no, reason: `顧客を残しました: ${reason}` });
        continue;
      }
      await ctx.trx.updateTable('customers').set({ deleted_at: now, customer_number: null }).where('id', '=', createdCustomerId).execute();
      touchedCustomers.delete(createdCustomerId);
      if (r.resource_type === 'customer') result.removed++;
    }
  }
  await ctx.trx.deleteFrom('import_keys').where('job_id', '=', id).execute();
  for (const c of touchedCustomers) await recomputeCustomerStats(ctx, c);
  await ctx.trx.updateTable('import_jobs').set({ status: 'undone', undone_at: now, undone_by: auditUserId(ctx.actor) }).where('id', '=', id).execute();
  await audit(ctx, { action: 'migration.import_undo', resourceType: 'import_job', resourceId: id, shopId: job.shop_id, metadata: { removed: result.removed, restored: result.restored, kept: result.kept.length } });
  return result;
}

function restorable(before: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(before)) out[k] = k === 'attributes' ? JSON.stringify(v ?? {}) : v;
  if ('phone' in before) out.phone_normalized = normalizePhone((before.phone as string | null) ?? null);
  return out;
}

async function customerInUse(ctx: Ctx, customerId: string, jobId: string): Promise<string | null> {
  const c = await ctx.trx.selectFrom('customers').select(['status', 'deleted_at']).where('id', '=', customerId).executeTakeFirst();
  if (!c || c.deleted_at) return null;
  if (c.status === 'merged') return '他の顧客に統合済み';
  const [appt, tx, karte, visit, memo] = await Promise.all([
    ctx.trx
      .selectFrom('appointments')
      .select('id')
      .where('customer_id', '=', customerId)
      .where('deleted_at', 'is', null)
      .where((eb) => eb.or([eb('source', '!=', 'import'), eb(sql`source_detail->>'importJobId'`, '!=', jobId)]))
      .executeTakeFirst(),
    ctx.trx.selectFrom('transactions').select('id').where('customer_id', '=', customerId).executeTakeFirst(),
    ctx.trx.selectFrom('kartes').select('id').where('customer_id', '=', customerId).where('deleted_at', 'is', null).executeTakeFirst(),
    ctx.trx
      .selectFrom('legacy_visits')
      .select('id')
      .where('customer_id', '=', customerId)
      .where((eb) => eb.or([eb('import_job_id', 'is', null), eb('import_job_id', '!=', jobId)]))
      .executeTakeFirst(),
    ctx.trx.selectFrom('customer_memos').select('id').where('customer_id', '=', customerId).where('body', 'not like', '【%より移行】%').executeTakeFirst(),
  ]);
  if (appt) return '予約があります';
  if (tx) return '会計があります';
  if (karte) return 'カルテがあります';
  if (visit) return '別の取り込みの来店履歴があります（先にそちらを取り消してください）';
  if (memo) return 'スタッフが追加したメモがあります';
  const points = await ctx.trx.selectFrom('point_ledger').select('id').where('customer_id', '=', customerId).where('note', 'not like', `${POINT_NOTE}%`).executeTakeFirst();
  if (points) return 'ポイントの利用・付与があります';
  return null;
}

