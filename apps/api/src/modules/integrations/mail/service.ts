import { sql } from 'kysely';
import {
  auditUserId,
  hasShopAccess,
  requirePermission,
  systemActor,
  type Ctx,
} from '../../../auth/actor.js';
import { withTenant } from '../../../db/tenant.js';
import { PermanentJobError } from '../../../jobs/queue.js';
import { audit } from '../../../lib/audit.js';
import { sha256 } from '../../../lib/crypto.js';
import { Errors } from '../../../lib/errors.js';
import { normalizeName } from '../../../lib/normalize.js';
import { effectiveMenus } from '../../catalog/service.js';
import {
  getVisibleAccount,
  loadAccountRow,
  parseIntegrationConfig,
  toAdapterAccount,
  type AccountRow,
} from '../accounts.js';
import { getAdapter } from '../adapters/registry.js';
import type { AdapterAccount, ExternalBooking } from '../adapters/types.js';
import { emptyStats, processExternalBooking, type ApplyOutcome } from '../sync.js';
import type { InboundMail } from './inbound.js';
import { mergeLabels, parseBookingMail, PROVIDER_PROFILES, type ParsedMail } from './parser.js';

const DEFAULT_PLACEHOLDER_MIN = 60;

export type MatchVia = 'map' | 'auto' | 'default' | null;

export interface MappingPreview {
  staff: { name: string | null; staffId: string | null; staffName: string | null; via: MatchVia };
  menus: { name: string; menuId: string | null; menuName: string | null; via: MatchVia }[];
  /** maps augmented with automatic matches, handed to the sync engine */
  account: AdapterAccount;
}

function labelsFor(acc: AccountRow) {
  const cfg = parseIntegrationConfig(acc.config);
  const profile = PROVIDER_PROFILES[acc.provider] ?? PROVIDER_PROFILES.hotpepper_mail!;
  return mergeLabels(profile.labels, cfg.mail?.labels);
}

/**
 * Resolve the staff / menu NAMES found in a mail to Salon OS ids:
 * explicit map (integration settings) → automatic name match (unique) → default menu.
 */
export async function resolveMappings(
  ctx: Ctx,
  acc: AccountRow,
  parsed: Pick<ParsedMail, 'staffName' | 'menuNames'>,
): Promise<MappingPreview> {
  const account = toAdapterAccount(acc);
  const cfg = account.config;
  const auto = cfg.mail?.autoMatchNames !== false;
  const staffMap = { ...cfg.staffMap };
  const menuMap = { ...cfg.menuMap };

  let staff: MappingPreview['staff'] = {
    name: parsed.staffName,
    staffId: null,
    staffName: null,
    via: null,
  };
  if (parsed.staffName && acc.shop_id) {
    const shopStaff = await ctx.trx
      .selectFrom('staffs')
      .innerJoin('staff_shop_assignments as a', 'a.staff_id', 'staffs.id')
      .select(['staffs.id', 'staffs.display_name', 'staffs.display_name_kana'])
      .where('a.shop_id', '=', acc.shop_id)
      .where('a.ended_on', 'is', null)
      .where('staffs.deleted_at', 'is', null)
      .execute();
    const byId = new Map(shopStaff.map((s) => [s.id, s.display_name]));
    if (staffMap[parsed.staffName]) {
      staff = {
        name: parsed.staffName,
        staffId: staffMap[parsed.staffName]!,
        staffName: byId.get(staffMap[parsed.staffName]!) ?? null,
        via: 'map',
      };
    } else if (auto) {
      const target = normalizeName(parsed.staffName);
      const exact = shopStaff.filter(
        (s) =>
          normalizeName(s.display_name) === target ||
          normalizeName(s.display_name_kana ?? '') === target,
      );
      // "佐藤" in the mail vs "佐藤 美咲" in Salon OS: accept a unique prefix match
      const prefix = exact.length
        ? exact
        : shopStaff.filter(
            (s) => target.length >= 2 && normalizeName(s.display_name).startsWith(target),
          );
      if (prefix.length === 1) {
        staffMap[parsed.staffName] = prefix[0]!.id;
        staff = {
          name: parsed.staffName,
          staffId: prefix[0]!.id,
          staffName: prefix[0]!.display_name,
          via: 'auto',
        };
      }
    }
  }

  const menus: MappingPreview['menus'] = [];
  const shopMenus = acc.shop_id ? await effectiveMenus(ctx, acc.shop_id) : [];
  const menuName = new Map(shopMenus.map((m) => [m.id, m.name]));
  for (const name of parsed.menuNames) {
    if (menuMap[name]) {
      menus.push({
        name,
        menuId: menuMap[name]!,
        menuName: menuName.get(menuMap[name]!) ?? null,
        via: 'map',
      });
      continue;
    }
    let match: (typeof shopMenus)[number] | undefined;
    if (auto) {
      const target = normalizeName(name);
      const exact = shopMenus.filter((m) => normalizeName(m.name) === target);
      // the mail line contains a menu name ("【全員】カット+カラー ¥12,000"): the longest one wins
      const contained = shopMenus
        .filter((m) => normalizeName(m.name) && target.includes(normalizeName(m.name)))
        .sort((a, b) => normalizeName(b.name).length - normalizeName(a.name).length);
      // the mail name is a fragment of a menu name ("カラー"): only when exactly one menu fits
      const containing = shopMenus.filter((m) => target && normalizeName(m.name).includes(target));
      if (exact.length === 1) match = exact[0];
      else if (exact.length === 0 && contained.length) {
        const [a, b] = contained;
        if (!b || normalizeName(a!.name).length > normalizeName(b.name).length) match = a;
      } else if (exact.length === 0 && containing.length === 1) match = containing[0];
    }
    if (match) {
      menuMap[name] = match.id;
      menus.push({ name, menuId: match.id, menuName: match.name, via: 'auto' });
    } else if (cfg.mail?.defaultMenuId) {
      menuMap[name] = cfg.mail.defaultMenuId;
      menus.push({
        name,
        menuId: cfg.mail.defaultMenuId,
        menuName: menuName.get(cfg.mail.defaultMenuId) ?? null,
        via: 'default',
      });
    } else {
      menus.push({ name, menuId: null, menuName: null, via: null });
    }
  }
  return { staff, menus, account: { ...account, config: { ...cfg, staffMap, menuMap } } };
}

function externalIdOf(parsed: ParsedMail): string {
  if (parsed.reservationNo) return parsed.reservationNo;
  // no booking number: stable identity from the booking's own facts
  return `mail:${sha256([parsed.start?.toISOString() ?? '', parsed.customer.phone ?? '', parsed.customer.name ?? ''].join('|')).slice(0, 24)}`;
}

async function previousTimes(ctx: Ctx, accountId: string, externalId: string) {
  const row = await ctx.trx
    .selectFrom('external_bookings')
    .select(['normalized'])
    .where('integration_account_id', '=', accountId)
    .where('external_booking_id', '=', externalId)
    .executeTakeFirst();
  const n = row?.normalized as
    | { start?: string; end?: string; menuExternalIds?: string[]; staffExternalId?: string | null }
    | undefined;
  return n?.start
    ? {
        start: new Date(n.start),
        end: new Date(n.end ?? n.start),
        menuExternalIds: n.menuExternalIds ?? [],
        staffExternalId: n.staffExternalId ?? null,
      }
    : null;
}

export interface MailApplyResult {
  outcome: ApplyOutcome | 'ignored';
  reason?: string;
  externalId?: string;
  parsed?: ParsedMail;
}

/** Apply one forwarded booking-notification mail (runs inside the webhook processing transaction) */
export async function applyInboundMail(
  ctx: Ctx,
  accountId: string,
  mail: InboundMail,
): Promise<MailApplyResult> {
  const acc = await loadAccountRow(ctx.trx, accountId);
  if (!acc || acc.status === 'disabled') return { outcome: 'ignored', reason: '連携が無効です' };
  const cfg = parseIntegrationConfig(acc.config);
  if (
    cfg.mail?.subjectIncludes?.length &&
    !cfg.mail.subjectIncludes.some((k) => mail.subject.includes(k))
  ) {
    return { outcome: 'ignored', reason: '件名フィルタに一致しません' };
  }
  const parsed = parseBookingMail(
    { subject: mail.subject, text: mail.text, html: mail.html, receivedAt: mail.receivedAt },
    labelsFor(acc),
  );
  if (parsed.kind === 'unknown')
    return { outcome: 'ignored', reason: '予約通知メールではありません', parsed };
  const externalId = externalIdOf(parsed);

  let start = parsed.start;
  let end = parsed.end;
  let staffName = parsed.staffName;
  let menuNames = parsed.menuNames;
  if (!start || (parsed.kind === 'cancelled' && !menuNames.length)) {
    const prev = await previousTimes(ctx, acc.id, externalId);
    if (prev) {
      start ??= prev.start;
      end ??= prev.end;
      if (!menuNames.length) menuNames = prev.menuExternalIds;
      staffName ??= prev.staffExternalId;
    }
  }
  if (!start) {
    if (parsed.kind === 'cancelled')
      return {
        outcome: 'ignored',
        reason: '取り込み済みでない予約のキャンセルです',
        externalId,
        parsed,
      };
    // surfaces in ops (dead webhook event) so staff can adjust the label settings and reprocess
    throw new PermanentJobError(
      `来店日時を読み取れませんでした（${parsed.warnings.join(' / ') || '件名: ' + mail.subject}）`,
    );
  }

  const mapping = await resolveMappings(ctx, acc, { staffName, menuNames });
  const nb: ExternalBooking = {
    externalId,
    status: parsed.kind === 'booked' ? 'booked' : parsed.kind,
    start,
    end: end ?? new Date(start.getTime() + (parsed.durationMin ?? DEFAULT_PLACEHOLDER_MIN) * 60000),
    staffExternalId: staffName,
    menuExternalIds: [...new Set(menuNames)],
    customer: {
      name: parsed.customer.name,
      kana: parsed.customer.kana,
      phone: parsed.customer.phone,
      email: parsed.customer.email,
      externalMemberId: null,
    },
    note: parsed.note,
    updatedAt: mail.receivedAt,
    raw: {
      source: 'email',
      subject: mail.subject,
      from: mail.from,
      messageId: mail.messageId,
      fields: parsed.fields,
      amount: parsed.amount,
    },
  };
  const outcome = await processExternalBooking(ctx, mapping.account, nb, emptyStats());
  await ctx.trx
    .updateTable('integration_accounts')
    .set({
      last_synced_at: new Date(),
      last_success_at: new Date(),
      last_error: null,
      consecutive_failures: 0,
    })
    .where('id', '=', acc.id)
    .execute();
  return { outcome, externalId, parsed };
}

// ---------------------------------------------------------------- parse test (settings screen)

export async function parseTest(
  ctx: Ctx,
  accountId: string,
  input: { subject: string; text?: string; html?: string },
) {
  requirePermission(ctx.actor, 'integration.manage');
  const acc = await getVisibleAccount(ctx, accountId);
  if (!getAdapter(acc.provider)?.inboundEmail)
    throw Errors.validation('メール連携のアカウントではありません');
  const parsed = parseBookingMail(
    {
      subject: input.subject,
      text: input.text ?? null,
      html: input.html ?? null,
      receivedAt: new Date(),
    },
    labelsFor(acc),
  );
  const mapping = await resolveMappings(ctx, acc, parsed);
  const ready =
    parsed.kind !== 'unknown' &&
    !!parsed.start &&
    (parsed.kind === 'cancelled' ||
      (mapping.menus.length > 0 &&
        mapping.menus.every((m) => m.menuId) &&
        (!parsed.staffName || !!mapping.staff.staffId)));
  return {
    kind: parsed.kind,
    externalId: externalIdOf(parsed),
    start: parsed.start,
    end: parsed.end,
    durationMin: parsed.durationMin,
    customer: parsed.customer,
    staff: mapping.staff,
    menus: mapping.menus,
    amount: parsed.amount,
    note: parsed.note,
    fields: parsed.fields,
    warnings: [
      ...parsed.warnings,
      ...(parsed.staffName && !mapping.staff.staffId
        ? [`スタッフ「${parsed.staffName}」を特定できません（スタッフ対応表に登録してください）`]
        : []),
      ...mapping.menus
        .filter((m) => !m.menuId)
        .map(
          (m) =>
            `メニュー「${m.name}」を特定できません（メニュー対応表または既定メニューを設定してください）`,
        ),
    ],
    ready,
  };
}

// ---------------------------------------------------------------- CSV import (existing bookings)

/** RFC 4180 CSV parser (quotes, escaped quotes, CRLF, BOM) */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const s = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim()));
}

const CSV_COLUMNS: Record<string, string[]> = {
  reservationNo: ['予約番号', '予約no', '予約id', '受付番号', 'id'],
  datetime: ['来店日時', '予約日時', '日時'],
  date: ['来店日', '予約日', '日付'],
  time: ['開始時刻', '来店時刻', '開始時間', '時間', '時刻'],
  end: ['終了時刻', '終了時間', '終了予定'],
  duration: ['所要時間', '施術時間'],
  name: ['お客様名', '顧客名', '氏名', '名前', 'お名前'],
  kana: ['フリガナ', 'カナ', 'ふりがな'],
  phone: ['電話番号', '電話', 'tel', '携帯'],
  email: ['メールアドレス', 'メール', 'email'],
  menu: ['メニュー', '施術内容', 'コース', 'クーポン'],
  staff: ['担当', 'スタッフ', '担当スタッフ', '指名スタッフ', 'スタイリスト'],
  status: ['状態', 'ステータス', '予約状態'],
  note: ['備考', '要望', 'メモ', 'ご要望'],
};

const LABEL_FOR: Record<string, string> = {
  reservationNo: '予約番号',
  datetime: '来店日時',
  date: '来店日',
  time: '来店時間',
  end: '終了時刻',
  duration: '所要時間',
  name: 'お客様名',
  kana: 'フリガナ',
  phone: '電話番号',
  email: 'メールアドレス',
  staff: '担当スタッフ',
  note: 'ご要望',
};

export interface CsvRowResult {
  row: number;
  externalId: string | null;
  status: 'booked' | 'cancelled' | 'error';
  start: Date | null;
  customerName: string | null;
  staff: MappingPreview['staff'] | null;
  menus: MappingPreview['menus'];
  outcome?: ApplyOutcome | 'ignored';
  error?: string;
}

export async function importCsv(
  ctx: Ctx,
  accountId: string,
  input: { csv: string; dryRun: boolean },
) {
  requirePermission(ctx.actor, 'integration.manage', 'appointment.write');
  const acc = await getVisibleAccount(ctx, accountId);
  if (!acc.shop_id || !hasShopAccess(ctx.actor, acc.shop_id))
    throw Errors.forbidden('この店舗へのアクセス権がありません', 'SHOP_FORBIDDEN');
  const rows = parseCsv(input.csv);
  if (rows.length < 2) throw Errors.validation('CSVにヘッダー行とデータ行が必要です');
  if (rows.length > 2001) throw Errors.validation('一度に取り込めるのは2,000件までです');
  const header = rows[0]!.map((h) => normalizeName(h));
  const col: Record<string, number> = {};
  for (const [key, names] of Object.entries(CSV_COLUMNS)) {
    const idx = header.findIndex((h) => names.some((n) => h === normalizeName(n)));
    if (idx >= 0) col[key] = idx;
  }
  if (col.datetime === undefined && col.date === undefined)
    throw Errors.validation('「来店日」または「来店日時」列が必要です', { header: rows[0] });
  if (col.menu === undefined)
    throw Errors.validation('「メニュー」列が必要です', { header: rows[0] });

  const results: CsvRowResult[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]!;
    const get = (k: string) => (col[k] !== undefined ? (r[col[k]!] ?? '').trim() : '');
    const cancelled = /キャンセル|取消|cancel/i.test(get('status'));
    // reuse the mail parser (dates, times, durations, names) by rendering the row as a labelled mail
    const lines = Object.entries(LABEL_FOR)
      .map(([k, label]) => (get(k) ? `${label}：${get(k)}` : null))
      .filter(Boolean) as string[];
    lines.push(
      'メニュー：',
      ...get('menu')
        .split(/[|/／、]/)
        .map((m) => m.trim())
        .filter(Boolean),
    );
    const parsed = parseBookingMail({
      subject: cancelled ? '予約キャンセル' : '予約連絡',
      text: lines.join('\n'),
      receivedAt: new Date(),
    });
    const externalId = parsed.reservationNo ?? `csv:${sha256(r.join('\u0001')).slice(0, 24)}`;
    const base: CsvRowResult = {
      row: i + 1,
      externalId,
      status: cancelled ? 'cancelled' : 'booked',
      start: parsed.start,
      customerName: parsed.customer.name,
      staff: null,
      menus: [],
    };
    if (!parsed.start) {
      results.push({ ...base, status: 'error', error: '来店日時を読み取れません' });
      continue;
    }
    const mapping = await resolveMappings(ctx, acc, parsed);
    base.staff = mapping.staff;
    base.menus = mapping.menus;
    if (input.dryRun) {
      results.push(base);
      continue;
    }
    const nb: ExternalBooking = {
      externalId,
      status: cancelled ? 'cancelled' : 'booked',
      start: parsed.start,
      end:
        parsed.end ??
        new Date(parsed.start.getTime() + (parsed.durationMin ?? DEFAULT_PLACEHOLDER_MIN) * 60000),
      staffExternalId: parsed.staffName,
      menuExternalIds: [...new Set(parsed.menuNames)],
      customer: { ...parsed.customer, externalMemberId: null },
      note: parsed.note,
      updatedAt: new Date(),
      raw: { source: 'csv', row: i + 1, values: r },
    };
    try {
      // one transaction per row: a bad row never rolls back the others
      const outcome = await withTenant(acc.organization_id, (trx) =>
        processExternalBooking(
          { actor: systemActor(acc.organization_id, 'csv-import'), trx, meta: ctx.meta },
          mapping.account,
          nb,
          emptyStats(),
        ),
      );
      results.push({ ...base, outcome });
    } catch (err) {
      results.push({
        ...base,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const summary = results.reduce<Record<string, number>>((acc2, r) => {
    const key = r.error ? 'error' : (r.outcome ?? 'preview');
    acc2[key] = (acc2[key] ?? 0) + 1;
    return acc2;
  }, {});
  if (!input.dryRun) {
    await audit(ctx, {
      action: 'integration.csv_import',
      resourceType: 'integration_account',
      resourceId: acc.id,
      shopId: acc.shop_id,
      metadata: { rows: results.length, summary },
    });
  }
  return { dryRun: input.dryRun, total: results.length, summary, results };
}

// ---------------------------------------------------------------- manual slot-block requests

export async function listManualBlocks(
  ctx: Ctx,
  input: { shopId?: string; state?: 'open' | 'all' },
) {
  requirePermission(ctx.actor, 'appointment.read');
  if (input.shopId && !hasShopAccess(ctx.actor, input.shopId))
    throw Errors.forbidden('この店舗へのアクセス権がありません', 'SHOP_FORBIDDEN');
  let q = ctx.trx
    .selectFrom('external_slot_blocks as b')
    .innerJoin('integration_accounts as ia', 'ia.id', 'b.integration_account_id')
    .innerJoin('appointments as a', 'a.id', 'b.appointment_id')
    .leftJoin('customers as c', 'c.id', 'a.customer_id')
    .leftJoin('staffs as s', 's.id', 'a.staff_id')
    .select([
      'b.id',
      'b.state',
      'b.block_start_at',
      'b.block_end_at',
      'b.last_error as message',
      'b.notified_at',
      'b.done_at',
      'b.created_at',
      'b.updated_at',
      'ia.id as integration_account_id',
      'ia.provider',
      'ia.display_name as integration_name',
      'ia.shop_id',
      'a.id as appointment_id',
      'a.booking_reference',
      'a.source',
      'a.status as appointment_status',
      's.display_name as staff_name',
      sql<string>`trim(coalesce(c.last_name, '') || ' ' || coalesce(c.first_name, ''))`.as(
        'customer_name',
      ),
    ])
    .where('b.manual', '=', true)
    .orderBy('b.block_start_at')
    .limit(500);
  if (input.state !== 'all') q = q.where('b.state', 'in', ['action_required', 'remove_required']);
  if (input.shopId) q = q.where('ia.shop_id', '=', input.shopId);
  else if (ctx.actor.kind === 'staff' && !ctx.actor.allShops)
    q = q.where(
      'ia.shop_id',
      'in',
      ctx.actor.shopIds.length ? [...ctx.actor.shopIds] : ['00000000-0000-0000-0000-000000000000'],
    );
  const rows = await q.execute();
  return rows.map((r) => ({
    ...r,
    providerLabel: PROVIDER_PROFILES[r.provider]?.label ?? r.provider,
  }));
}

export async function completeManualBlock(ctx: Ctx, blockId: string) {
  requirePermission(ctx.actor, 'appointment.write');
  const b = await ctx.trx
    .selectFrom('external_slot_blocks as b')
    .innerJoin('integration_accounts as ia', 'ia.id', 'b.integration_account_id')
    .select(['b.id', 'b.state', 'b.manual', 'ia.shop_id', 'b.appointment_id'])
    .where('b.id', '=', blockId)
    .forUpdate()
    .executeTakeFirst();
  if (!b || !b.manual) throw Errors.notFound('ブロック依頼', blockId);
  if (!hasShopAccess(ctx.actor, b.shop_id))
    throw Errors.forbidden('この店舗へのアクセス権がありません', 'SHOP_FORBIDDEN');
  if (b.state !== 'action_required' && b.state !== 'remove_required')
    throw Errors.business('BLOCK_NOT_OPEN', 'このブロック依頼は対応済みです');
  const next = b.state === 'action_required' ? 'pushed' : 'removed';
  await ctx.trx
    .updateTable('external_slot_blocks')
    .set({
      state: next,
      external_block_id: next === 'pushed' ? 'manual' : null,
      done_by: auditUserId(ctx.actor),
      done_at: new Date(),
      last_error: null,
    })
    .where('id', '=', blockId)
    .execute();
  await audit(ctx, {
    action: next === 'pushed' ? 'integration.manual_block_done' : 'integration.manual_unblock_done',
    resourceType: 'appointment',
    resourceId: b.appointment_id,
    shopId: b.shop_id,
    metadata: { blockId },
  });
  return { id: blockId, state: next };
}
